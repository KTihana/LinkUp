// SPDX-License-Identifier: GPL-3.0-only
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MailboxStore } from './store.mjs';
import { ACTIONS, HEX_ID, isKey, requestBytes, validSignature, RelayError, requireShape } from './protocol.mjs';
import { PushDelivery, readPushConfiguration } from './push.mjs';
import { issueCallConfiguration, readCallConfiguration } from './call-config.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 192 * 1024;
const CHALLENGE_TTL_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const DEFAULT_ORIGINS = ['http://127.0.0.1:8081', 'http://localhost:8081'];

function validateOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('ALLOWED_ORIGINS must contain exact http(s) origins.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('ALLOWED_ORIGINS must contain exact http(s) origins.');
  return origin;
}
function jsonResponse(response, status, value) {
  const serialized = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(serialized), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(serialized);
}
async function readJson(request) {
  if (request.headers['content-encoding'] !== undefined) throw new RelayError(415, 'content_encoding_not_supported');
  if (typeof request.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) throw new RelayError(415, 'json_required');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new RelayError(413, 'body_too_large');
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new RelayError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new RelayError(400, 'invalid_json'); }
}
class RateLimits {
  constructor(now, { requestsPerMinute = 180, maxPeers = 2048, globalRequestsPerMinute = 2400 } = {}) {
    this.now = now; this.requestsPerMinute = requestsPerMinute; this.maxPeers = maxPeers;
    this.globalRequestsPerMinute = globalRequestsPerMinute; this.peers = new Map(); this.global = null;
  }
  take(peer) {
    const now = this.now();
    for (const [key, bucket] of this.peers) if (bucket.until <= now) this.peers.delete(key);
    if (!this.global || this.global.until <= now) this.global = { until: now + 60_000, count: 0 };
    if (this.global.count >= this.globalRequestsPerMinute) throw new RelayError(429, 'request_rate');
    this.global.count += 1;
    let bucket = this.peers.get(peer);
    if (!bucket) {
      if (this.peers.size >= this.maxPeers) throw new RelayError(429, 'peer_quota');
      bucket = { until: now + 60_000, count: 0 }; this.peers.set(peer, bucket);
    }
    if (bucket.count >= this.requestsPerMinute) throw new RelayError(429, 'request_rate');
    bucket.count += 1;
  }
}
export async function createRelay({ dataDir, now = Date.now, allowedOrigins = DEFAULT_ORIGINS, limits, rateLimits, maxChallenges = 2048, maxActiveRequests = 16, maxWaiters = 64, waitMs = 20_000, calls = { urls: [], secret: '' }, push = { origins: [] } } = {}) {
  if (!dataDir) throw new Error('A dataDir is required.');
  const origins = new Set(allowedOrigins.map(validateOrigin));
  const store = await MailboxStore.create(dataDir, { now, limits });
  const pushDelivery = new PushDelivery(store, push, now);
  await pushDelivery.start();
  const challenges = new Map(), rate = new RateLimits(now, rateLimits);
  const waiters = new Map(), callIssued = new Map();
  let activeRequests = 0, pruning = false;
  const expirySweep = setInterval(async () => {
    if (pruning || store.closed) return;
    pruning = true;
    try { await store.transact(() => {}); } catch {} finally { pruning = false; }
  }, 60_000);
  expirySweep.unref();
  const pruneChallenges = () => { for (const [nonce, value] of challenges) if (value.expiresAt <= now()) challenges.delete(nonce); };
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000, connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 }, async (request, response) => {
    try {
      request.socket.setTimeout(15_000);
      const origin = request.headers.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !origins.has(origin))) throw new RelayError(403, 'origin_not_allowed');
      if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      rate.take(request.socket.remoteAddress ?? 'unknown');
      if (activeRequests >= maxActiveRequests) throw new RelayError(429, 'active_request_quota');
      activeRequests += 1;
      let released = false;
      const release = () => { if (!released) { released = true; activeRequests -= 1; } };
      response.once('finish', release); response.once('close', release);
      if (request.method === 'OPTIONS') {
        if (!origin || !['/v1/challenge', ...[...ACTIONS].map(action => `/v1/${action}`)].includes(request.url) || request.headers['access-control-request-method'] !== 'POST' || (request.headers['access-control-request-headers'] && request.headers['access-control-request-headers'].toLowerCase() !== 'content-type')) throw new RelayError(403, 'preflight_not_allowed');
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }); response.end(); return;
      }
      if (request.url === '/health' && request.method === 'GET') { jsonResponse(response, store.closed ? 503 : 200, { ok: !store.closed, version: 1 }); return; }
      if (request.method !== 'POST' || (request.url !== '/v1/challenge' && ![...ACTIONS].some(action => request.url === `/v1/${action}`))) throw new RelayError(404, 'not_found');
      const body = await readJson(request);
      pruneChallenges();
      if (request.url === '/v1/challenge') {
        requireShape(body, ['publicKey', 'action']);
        if (!isKey(body.publicKey) || !ACTIONS.has(body.action)) throw new RelayError(400, 'invalid_challenge_request');
        // The claimed public key is not authenticated yet. A per-key quota
        // here would let anyone reserve a victim's entire challenge capacity.
        // Bound allocation globally and by source requests instead.
        if (challenges.size >= maxChallenges) throw new RelayError(429, 'challenge_quota');
        const challenge = randomBytes(24).toString('hex'), expiresAt = now() + CHALLENGE_TTL_MS;
        challenges.set(challenge, { publicKey: body.publicKey, action: body.action, expiresAt });
        jsonResponse(response, 200, { challenge, expiresAt }); return;
      }
      requireShape(body, ['publicKey', 'challenge', 'signature', 'payload']);
      if (!isKey(body.publicKey) || typeof body.challenge !== 'string' || !/^[a-f0-9]{48}$/.test(body.challenge) || typeof body.payload !== 'string' || Buffer.byteLength(body.payload) > MAX_PAYLOAD_BYTES) throw new RelayError(400, 'invalid_signed_request');
      const challenge = challenges.get(body.challenge);
      // A nonce is consumed on every authentication attempt, including invalid signatures.
      challenges.delete(body.challenge);
      const action = request.url.slice('/v1/'.length);
      if (!challenge || challenge.expiresAt <= now() || challenge.publicKey !== body.publicKey || challenge.action !== action || !validSignature(body.publicKey, body.signature, requestBytes(request.url, body.challenge, body.payload))) throw new RelayError(401, 'authentication_failed');
      let payload;
      try { payload = JSON.parse(body.payload); } catch { throw new RelayError(400, 'invalid_payload'); }
      let result;
      if (action === 'publish') {
        requireShape(payload, ['envelope']); result = await store.publish(body.publicKey, payload.envelope);
        waiters.get(payload.envelope.recipient)?.(true);
      } else if (action === 'receive') {
        requireShape(payload, ['limit']);
        if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 50) throw new RelayError(400, 'invalid_limit');
        result = await store.receive(body.publicKey, payload.limit);
      } else if (action === 'ack') {
        requireShape(payload, ['messages']);
        if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 50) throw new RelayError(400, 'invalid_messages');
        for (const message of payload.messages) {
          requireShape(message, ['sender', 'id']);
          if (!isKey(message.sender) || typeof message.id !== 'string' || !HEX_ID.test(message.id)) throw new RelayError(400, 'invalid_messages');
        }
        if (new Set(payload.messages.map(message => `${message.sender}:${message.id}`)).size !== payload.messages.length) throw new RelayError(400, 'invalid_messages');
        result = await store.ack(body.publicKey, payload.messages);
      } else if (action === 'keys-publish') {
        requireShape(payload, ['packages']);
        if (!Array.isArray(payload.packages) || !payload.packages.length || payload.packages.length > 10 || new Set(payload.packages.map(value => value?.id)).size !== payload.packages.length) throw new RelayError(400, 'invalid_packages');
        result = await store.publishPackages(body.publicKey, payload.packages);
      } else if (action === 'keys-claim') {
        requireShape(payload, ['owner']);
        if (!isKey(payload.owner)) throw new RelayError(400, 'invalid_owner');
        result = await store.claimPackage(body.publicKey, payload.owner);
      } else if (action === 'keys-status') {
        requireShape(payload, []);
        result = await store.packageStatus(body.publicKey);
      } else if (action === 'keys-retire') {
        requireShape(payload, ['ids']);
        result = await store.retirePackages(body.publicKey, payload.ids);
      } else if (action === 'admission-set') {
        requireShape(payload, ['peers', 'revision']);
        result = await store.setAdmission(body.publicKey, payload.peers, payload.revision);
      } else if (action === 'push-config') {
        requireShape(payload, []); result = pushDelivery.configuration();
      } else if (action === 'push-register') {
        requireShape(payload, ['subscription']); result = await pushDelivery.register(body.publicKey, payload.subscription);
      } else if (action === 'push-unregister') {
        requireShape(payload, []); result = await pushDelivery.unregister(body.publicKey);
      } else if (action === 'call-config') {
        requireShape(payload, []);
        for (const [key, until] of callIssued) if (until <= now()) callIssued.delete(key);
        if (callIssued.has(body.publicKey) || callIssued.size >= 2048) throw new RelayError(429, 'call_configuration_rate');
        callIssued.set(body.publicKey, now() + 10_000);
        result = issueCallConfiguration(calls, now());
      } else if (action === 'wait') {
        requireShape(payload, []);
        if (waiters.has(body.publicKey) || waiters.size >= maxWaiters) throw new RelayError(429, 'wait_quota');
        // Long polls have their own quota and never hold the storage serializer
        // or the short-request quota while waiting for new ciphertext.
        release(); request.socket.setTimeout(waitMs + 5000);
        await new Promise((resolveWait, rejectWait) => {
          let done = false;
          const finish = ready => {
            if (done) return; done = true; clearTimeout(timer);
            waiters.delete(body.publicKey); response.off('close', closed);
            if (!response.destroyed) jsonResponse(response, 200, { ready });
            resolveWait();
          };
          const closed = () => { if (!done) { done = true; clearTimeout(timer); waiters.delete(body.publicKey); resolveWait(); } };
          const timer = setTimeout(() => finish(false), waitMs);
          waiters.set(body.publicKey, finish); response.once('close', closed);
          // Register before checking storage so publish cannot race the poll.
          void store.receive(body.publicKey, 1).then(value => { if (value.envelopes.length) finish(true); }).catch(error => {
            if (!done) { done = true; clearTimeout(timer); waiters.delete(body.publicKey); response.off('close', closed); rejectWait(error); }
          });
        });
        return;
      }
      jsonResponse(response, 200, result);
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const known = error instanceof RelayError;
      response.setHeader('Connection', 'close');
      jsonResponse(response, known ? error.status : 503, { error: known ? error.code : 'storage_unavailable' });
      request.resume();
    }
  });
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  let closing = null;
  const close = () => closing ??= (async () => {
    clearInterval(expirySweep); await pushDelivery.close();
    for (const finish of waiters.values()) finish(false);
    if (server.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    challenges.clear(); await store.close();
  })();
  return { server, close };
}

export function readConfiguration(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && env.ALLOW_PUBLIC_BIND !== 'true') throw new Error('Binding outside loopback requires ALLOW_PUBLIC_BIND=true. Use TLS and upstream abuse controls before internet exposure.');
  const portText = env.PORT ?? '8787';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('PORT must be an integer from 1 through 65535.');
  const allowedOrigins = env.ALLOWED_ORIGINS === undefined ? DEFAULT_ORIGINS : env.ALLOWED_ORIGINS.split(',').filter(Boolean).map(validateOrigin);
  return { host, port: Number(portText), dataDir: resolve(env.DATA_DIR ?? './data'), allowedOrigins, calls: readCallConfiguration(env), push: readPushConfiguration(env) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configuration = readConfiguration();
    const relay = await createRelay(configuration);
    relay.server.on('error', async error => { console.error(`Relay failed: ${error.code ?? 'server_error'}`); await relay.close(); process.exitCode = 1; });
    relay.server.listen(configuration.port, configuration.host, () => { console.log(`Common mailbox relay listening at ${configuration.host}:${configuration.port}`); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
