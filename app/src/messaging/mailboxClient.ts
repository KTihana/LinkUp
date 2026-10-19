// SPDX-License-Identifier: GPL-3.0-only
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

export type MailEnvelope = { version: 1; id: string; sender: string; recipient: string; createdAt: number; expiresAt: number; ciphertext: string; signature: string };
export type PublicPackage = { id: string; owner: string; createdAt: number; expiresAt: number; data: string; signature: string };
export type MailSigner = { publicKey: string; sign: (message: Uint8Array) => string };
type Action = 'publish' | 'receive' | 'ack' | 'keys-publish' | 'keys-claim' | 'keys-status' | 'keys-retire' | 'admission-set' | 'wait' | 'call-config' | 'push-config' | 'push-register' | 'push-unregister';
export class MailboxAdmissionError extends Error { constructor() { super('Your friend must accept your invitation and connect to this mailbox before delivery. Your message stays queued.'); } }
export class NoKeyPackageError extends Error { constructor() { super('Your friend needs to connect once to make messaging available. Your message stays queued.'); } }
export class MailboxBackpressureError extends Error { constructor() { super('The mailbox is full or busy. Your message stays queued.'); } }
class FetchConnectionError extends Error {
  constructor(cause: unknown) { super('The mailbox connection was interrupted.', { cause }); }
}
const ttl = 7 * 24 * 60 * 60 * 1000;
const key = /^[a-f0-9]{64}$/, id = /^[a-f0-9]{32}$/, signature = /^[a-f0-9]{128}$/;
const verifiedSignatures = new Set<string>();
const verificationCacheLimit = 512;
const verificationCacheContext = utf8ToBytes('linkup/public-signature-cache/v1\n');
/** Accept a pasted service hostname without relaxing stored URL validation. */
export function mailboxAddressInput(value: string): string {
  const address = value.trim();
  if (!address || /\s/.test(address)) throw new Error('Enter the mailbox address shared with you.');
  return mailboxURL(address.includes('://') ? address : `https://${address}`);
}
export function mailboxURL(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid HTTPS mailbox address.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use an HTTPS mailbox URL, or HTTP localhost for development.');
  return url.origin;
}
function shape(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error('Invalid mailbox response.');
}
function verify(owner: string, sig: string, bytes: Uint8Array) {
  if (typeof owner !== 'string' || typeof sig !== 'string' || !key.test(owner) || !signature.test(sig)) throw new Error('Invalid signed mailbox data.');
  const publicBytes = hexToBytes(owner), signatureBytes = hexToBytes(sig);
  // Fixed 32-byte key + 64-byte signature + exact signed bytes, under a fixed
  // domain. Keep only bounded digests of successful public verifications.
  // Shape, recipient/owner, freshness and admission checks stay outside this
  // cache and must still run every time the caller validates an object.
  const fingerprint = bytesToHex(sha256.create().update(verificationCacheContext).update(publicBytes).update(signatureBytes).update(bytes).digest());
  if (verifiedSignatures.has(fingerprint)) return;
  try { const point = ed25519.Point.fromBytes(publicBytes, false); if (point.isSmallOrder() || !point.isTorsionFree() || bytesToHex(point.toBytes()) !== owner || !ed25519.verify(signatureBytes, bytes, publicBytes, { zip215: false })) throw new Error(); } catch { throw new Error('The mailbox returned unverified data.'); }
  if (verifiedSignatures.size >= verificationCacheLimit) verifiedSignatures.delete(verifiedSignatures.values().next().value!);
  verifiedSignatures.add(fingerprint);
}
function dates(createdAt: number, expiresAt: number, now: number) {
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) || createdAt < 0 || createdAt > now + 60000 || expiresAt <= now || expiresAt <= createdAt || expiresAt - createdAt > ttl) throw new Error('Expired or invalid mailbox data.');
}
export function envelopeBytes(e: Omit<MailEnvelope, 'signature'> | MailEnvelope) { return utf8ToBytes('common/mailbox-envelope/v1\n' + JSON.stringify([1, e.id, e.sender, e.recipient, e.createdAt, e.expiresAt, e.ciphertext])); }
export function packageBytes(p: Omit<PublicPackage, 'signature'> | PublicPackage) { return utf8ToBytes('common/key-package/v1\n' + JSON.stringify([1, p.id, p.owner, p.createdAt, p.expiresAt, p.data])); }
export function requestBytes(path: string, challenge: string, payload: string) { return utf8ToBytes(`common/mailbox-request/v1\n${path}\n${challenge}\n${bytesToHex(sha256(utf8ToBytes(payload)))}`); }
export function validateMailEnvelope(value: unknown, recipient: string, now: number): asserts value is MailEnvelope {
  shape(value, ['version', 'id', 'sender', 'recipient', 'createdAt', 'expiresAt', 'ciphertext', 'signature']);
  const e = value as MailEnvelope;
  if (e.version !== 1 || !id.test(e.id) || !key.test(e.sender) || e.recipient !== recipient || e.sender === recipient || typeof e.ciphertext !== 'string' || e.ciphertext.length > 87384) throw new Error('Invalid mail envelope.');
  dates(e.createdAt, e.expiresAt, now);
  const decoded = base64.decode(e.ciphertext);
  if (!decoded.length || decoded.length > 65536 || base64.encode(decoded) !== e.ciphertext) throw new Error('Invalid ciphertext.');
  verify(e.sender, e.signature, envelopeBytes(e));
}
export function validatePublicPackage(value: unknown, owner: string, now: number): asserts value is PublicPackage {
  shape(value, ['id', 'owner', 'createdAt', 'expiresAt', 'data', 'signature']);
  const p = value as PublicPackage;
  if (!id.test(p.id) || p.owner !== owner || typeof p.data !== 'string' || !p.data.length || utf8ToBytes(p.data).length > 16384) throw new Error('Invalid messaging key package.');
  dates(p.createdAt, p.expiresAt, now); verify(p.owner, p.signature, packageBytes(p));
}
export class MailboxClient {
  readonly endpoint: string;
  private fetcher: typeof fetch;
  private now: () => number;
  private controllers = new Set<AbortController>();
  private revision = 0;
  constructor(endpoint: string, fetcher: typeof fetch = fetch, now: () => number = Date.now) { this.endpoint = mailboxURL(endpoint); this.fetcher = fetcher; this.now = now; }
  cancel(): void { this.revision += 1; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
  private async post(path: string, body: unknown, timeoutMs = 10000) {
    const token = this.revision, controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    this.controllers.add(controller);
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      } catch (error) {
        // Fetch rejects network failures as TypeError. Only retry that boundary;
        // malformed responses, timeouts, cancellation, and HTTP errors keep
        // their existing failure behavior.
        if (error instanceof TypeError && !controller.signal.aborted) throw new FetchConnectionError(error);
        throw error;
      }
      if (!response.ok) { if (response.status === 429) throw new MailboxBackpressureError(); if (response.status === 403 && (path === '/v1/publish' || path === '/v1/keys-claim')) throw new MailboxAdmissionError(); throw new Error(`Mailbox request failed (${response.status}).`); }
      const limit = 6 * 1024 * 1024;
      const length = response.headers.get('Content-Length');
      if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { controller.abort(); throw new Error('Mailbox response too large.'); }
      // Expo 57 fetch streams on native as well as web. Fail closed if replaced with a non-streaming implementation.
      if (!response.body?.getReader) throw new Error('A streaming fetch implementation is required for messaging.');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > limit) { controller.abort(); void reader.cancel().catch(() => {}); throw new Error('Mailbox response too large.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return JSON.parse(text);
    } catch (error) {
      if (token !== this.revision) throw new Error('Messaging was disconnected. Pending messages remain saved.');
      throw error;
    } finally {
      clearTimeout(timeout); this.controllers.delete(controller);
      // HTTP errors and malformed/non-streaming responses may leave an unread
      // body. Keep no untracked network work alive after the request finishes.
      controller.abort();
    }
  }
  async request(action: Action, payloadValue: unknown, signer: MailSigner, timeoutMs = 10000) {
    const payload = JSON.stringify(payloadValue), path = `/v1/${action}`, token = this.revision;
    for (let attempt = 0; ; attempt++) {
      if (token !== this.revision) throw new Error('Messaging was disconnected. Pending messages remain saved.');
      try {
        const challenge = await this.post('/v1/challenge', { publicKey: signer.publicKey, action });
        shape(challenge, ['challenge', 'expiresAt']);
        if (typeof challenge.challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge.challenge) || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= this.now() || challenge.expiresAt > this.now() + 60000) throw new Error('Invalid mailbox challenge.');
        if (token !== this.revision) throw new Error('Messaging was disconnected. Pending messages remain saved.');
        return await this.post(path, { publicKey: signer.publicKey, challenge: challenge.challenge, payload, signature: signer.sign(requestBytes(path, challenge.challenge, payload)) }, timeoutMs);
      } catch (error) {
        // Retry a broken/reused socket once, with a fresh one-use challenge and
        // the identical payload. Publish/ack/admission updates are idempotent. An uncertain key
        // claim may consume one extra public package; private keys stay saved.
        if (!(error instanceof FetchConnectionError) || attempt !== 0 || token !== this.revision) throw error;
      }
    }
  }
  async wait(signer: MailSigner): Promise<boolean> {
    const result = await this.request('wait', {}, signer, 30_000); shape(result, ['ready']);
    if (typeof result.ready !== 'boolean') throw new Error('Invalid delivery wakeup.'); return result.ready;
  }
  async callConfiguration(signer: MailSigner): Promise<{ expiresAt: number; iceServers: { urls: string[]; username?: string; credential?: string }[] }> {
    const result = await this.request('call-config', {}, signer); shape(result, ['expiresAt', 'iceServers']);
    if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= this.now() || result.expiresAt > this.now() + 660_000
      || !Array.isArray(result.iceServers) || result.iceServers.length > 2) throw new Error('Invalid call relay configuration.');
    for (const server of result.iceServers) {
      shape(server, ['urls', 'username', 'credential']);
      if (!Array.isArray(server.urls) || !server.urls.length || server.urls.length > 4
        || server.urls.some((url: unknown) => typeof url !== 'string' || !/^(?:turn|turns):[a-zA-Z0-9.-]+:\d{1,5}(?:\?transport=(?:udp|tcp))?$/.test(url))
        || typeof server.username !== 'string' || !/^[a-zA-Z0-9:]{1,128}$/.test(server.username)
        || typeof server.credential !== 'string' || !/^[a-zA-Z0-9+/=]{1,128}$/.test(server.credential)) throw new Error('Invalid call relay credentials.');
    }
    return result;
  }
  async receive(signer: MailSigner): Promise<MailEnvelope[]> {
    const result = await this.request('receive', { limit: 50 }, signer); shape(result, ['envelopes']);
    if (!Array.isArray(result.envelopes) || result.envelopes.length > 50) throw new Error('Invalid mailbox messages.');
    for (const e of result.envelopes) validateMailEnvelope(e, signer.publicKey, this.now());
    return result.envelopes;
  }
  async claim(owner: string, signer: MailSigner): Promise<PublicPackage> {
    const result = await this.request('keys-claim', { owner }, signer); shape(result, ['package']);
    if (!result.package) throw new NoKeyPackageError();
    validatePublicPackage(result.package, owner, this.now()); return result.package;
  }
  async publish(e: MailEnvelope, signer: MailSigner) { const result = await this.request('publish', { envelope: e }, signer); shape(result, ['accepted', 'duplicate']); if (result.accepted !== true || typeof result.duplicate !== 'boolean') throw new Error('The mailbox did not confirm storage.'); }
  async acknowledge(messages: { sender: string; id: string }[], signer: MailSigner) { const result = await this.request('ack', { messages }, signer); shape(result, ['acknowledged']); if (!Number.isSafeInteger(result.acknowledged)) throw new Error('The mailbox did not acknowledge delivery.'); }
  async publishKeys(packages: PublicPackage[], signer: MailSigner) { const result = await this.request('keys-publish', { packages }, signer); shape(result, ['added']); if (!Number.isSafeInteger(result.added)) throw new Error('The mailbox did not accept messaging keys.'); }
  async retireKeys(ids: string[], signer: MailSigner): Promise<void> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(value => typeof value !== 'string' || !id.test(value)) || new Set(ids).size !== ids.length) throw new Error('Invalid messaging key retirement.');
    const result = await this.request('keys-retire', { ids: [...ids] }, signer); shape(result, ['retired']);
    if (!Number.isSafeInteger(result.retired) || result.retired < 0 || result.retired > ids.length) throw new Error('The mailbox did not confirm messaging key retirement.');
  }
  async setAdmission(peers: string[], revision: number, signer: MailSigner): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(peers) || peers.length > 100
      || peers.some(peer => typeof peer !== 'string' || !key.test(peer) || peer === signer.publicKey) || new Set(peers).size !== peers.length) throw new Error('Invalid mailbox admission settings.');
    const result = await this.request('admission-set', { peers: [...peers].sort(), revision }, signer);
    shape(result, ['accepted', 'revision']);
    if (result.accepted !== true || result.revision !== revision) throw new Error('The mailbox did not confirm friend permissions.');
  }
  async keyStatus(signer: MailSigner): Promise<string[]> { const result = await this.request('keys-status', {}, signer); shape(result, ['available']); if (!Array.isArray(result.available) || result.available.length > 100 || result.available.some((value: unknown) => typeof value !== 'string' || !id.test(value)) || new Set(result.available).size !== result.available.length) throw new Error('Invalid messaging key availability.'); return result.available; }
}
