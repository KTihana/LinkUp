import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.mjs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Messenger, decodeMessaging, encodeMessaging } from '../src/messaging/messenger.ts';
import { NearbyTransport, NearbyKeysUnavailableError } from '../src/messaging/nearbyTransport.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
const random = async size => new Uint8Array(randomBytes(size));
function identity() { const seed = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(seed)); return { publicKey, sign: bytes => bytesToHex(ed25519.sign(bytes, seed)) }; }
function port(owner, friends, initial = null) {
  let state = initial, queue = Promise.resolve();
  const contacts = friends.map(friend => ({ publicKey: friend.publicKey, name: 'Friend' }));
  return { transact(task) { const result = queue.then(async () => { const next = await task(state, owner, contacts); state = next.state; return next.result; }); queue = result.catch(() => {}); return result; } };
}
// Routes packets between friends; a dropped friend still looks connected but never answers.
function network() {
  const listeners = new Map(), drop = new Set();
  return { drop, channel(self) { return {
    subscribe(listener) { listeners.set(self, listener); return () => listeners.delete(self); },
    async send(peer, payload) { if (drop.has(peer)) return; const listener = listeners.get(peer); if (listener) queueMicrotask(() => listener({ linkId: self, payload })); },
  }; } };
}
const noMailbox = async () => { throw new Error('No mailbox configured'); };
async function client(net, self, friends, now = Date.now, { fetcher = noMailbox, endpoint = '', linked = friends, saved = null } = {}) {
  const store = port(self, friends, saved);
  const transport = new NearbyTransport({ port: store, channel: net.channel(self.publicKey), randomBytes: random, maxLinks: 100, timeoutMs: 300, now });
  await transport.start(); for (const friend of linked) transport.attachLink(friend.publicKey, friend.publicKey);
  const messenger = new Messenger(store, random, now, fetcher, ensureMessagingCrypto);
  if (endpoint) await messenger.connect(endpoint);
  await messenger.initializeInternet(); messenger.attachInternet(transport);
  return { messenger, transport };
}
async function relay(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linkup-hybrid-'));
  const server = await createRelay({ dataDir, rateLimits: { requestsPerMinute: 10000, globalRequestsPerMinute: 10000 } });
  await new Promise((resolve, reject) => { server.server.once('error', reject); server.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.server.address().port}`;
}
const syncAll = async (rounds, ...clients) => { for (let i = 0; i < rounds; i++) for (const x of clients) await x.messenger.sync().catch(() => {}); };
const received = async (owner, peer) => ((await owner.messenger.view()).conversations[peer]?.messages ?? []).filter(m => !m.mine).map(m => m.content);
async function connected(net, a, b, c) {
  const A = await client(net, a, [b, c]), B = await client(net, b, [a]), C = await client(net, c, [a]);
  for (const x of [A, B, C]) await x.messenger.sync().catch(() => {});
  await A.messenger.send(b.publicKey, 'hi bob'); await A.messenger.send(c.publicKey, 'hi carol');
  for (let i = 0; i < 3; i++) for (const x of [A, B, C]) await x.messenger.sync().catch(() => {});
  return { A, B, C };
}

test('a friend whose clock runs ahead can still answer P2P requests', async () => {
  const net = network(), a = identity(), b = identity();
  const A = await client(net, a, [b]); await client(net, b, [a], () => Date.now() + 90_000);
  await assert.rejects(A.transport.claim(b.publicKey, a), NearbyKeysUnavailableError);
});

test('an unresponsive friend does not stall delivery to other friends', async () => {
  const net = network(), a = identity(), b = identity(), c = identity();
  const { A, C } = await connected(net, a, b, c);
  assert.deepEqual(await received(C, a.publicKey), ['hi carol']);
  net.drop.add(b.publicKey);
  await A.messenger.send(b.publicKey, 'second bob'); await A.messenger.send(c.publicKey, 'second carol');
  for (let i = 0; i < 2; i++) { await A.messenger.sync().catch(() => {}); await C.messenger.sync().catch(() => {}); }
  assert.deepEqual(await received(C, a.publicKey), ['hi carol', 'second carol']);
  assert.equal((await A.messenger.view()).conversations[b.publicKey].messages.find(m => m.content === 'second bob').status, 'queued');
});

test('an unresponsive friend does not hide messages already received from others', async () => {
  const net = network(), a = identity(), b = identity(), c = identity();
  const { A, C } = await connected(net, a, b, c);
  net.drop.add(b.publicKey);
  await A.messenger.send(b.publicKey, 'second bob'); await A.messenger.sync().catch(() => {});
  await C.messenger.send(a.publicKey, 'from carol'); await C.messenger.sync().catch(() => {});
  await A.messenger.sync().catch(() => {});
  assert.deepEqual(await received(A, c.publicKey), ['from carol']);
});

test('a mailbox account reaches P2P-only friends directly and mailbox friends through the mailbox', async t => {
  const endpoint = await relay(t), net = network(), a = identity(), b = identity(), c = identity();
  // Alice uses a mailbox and P2P; Bob only P2P; Carol only the mailbox (no P2P link to Alice).
  const A = await client(net, a, [b, c], Date.now, { fetcher: fetch, endpoint, linked: [b] });
  const B = await client(net, b, [a]);
  const C = await client(network(), c, [a], Date.now, { fetcher: fetch, endpoint, linked: [] });
  await syncAll(1, C, B, A);
  await A.messenger.send(b.publicKey, 'to bob over p2p'); await A.messenger.send(c.publicKey, 'to carol by mailbox');
  await syncAll(3, A, B, C);
  assert.deepEqual(await received(B, a.publicKey), ['to bob over p2p']);
  assert.deepEqual(await received(C, a.publicKey), ['to carol by mailbox']);
  await B.messenger.send(a.publicKey, 'bob replies'); await C.messenger.send(a.publicKey, 'carol replies');
  await syncAll(3, B, C, A);
  assert.deepEqual(await received(A, b.publicKey), ['bob replies']);
  assert.deepEqual(await received(A, c.publicKey), ['carol replies']);
  const view = (await A.messenger.view()).conversations;
  assert.equal(view[b.publicKey].messages.find(m => m.mine).status, 'delivered');
  assert.equal(view[c.publicKey].messages.find(m => m.mine).status, 'delivered');
});

test('an unreachable mailbox does not stop P2P delivery', async () => {
  const net = network(), a = identity(), b = identity();
  const saved = decodeMessaging(null); saved.endpoint = 'https://mail.example'; saved.enabled = true;
  const A = await client(net, a, [b], Date.now, { saved: encodeMessaging(saved) }), B = await client(net, b, [a]);
  await B.messenger.sync().catch(() => {});
  await A.messenger.send(b.publicKey, 'mailbox is down');
  for (let i = 0; i < 3; i++) { await assert.rejects(A.messenger.sync(), /No mailbox configured/); await B.messenger.sync().catch(() => {}); }
  assert.deepEqual(await received(B, a.publicKey), ['mailbox is down']);
  await B.messenger.send(a.publicKey, 'got it'); await B.messenger.sync().catch(() => {}); await A.messenger.sync().catch(() => {});
  assert.deepEqual(await received(A, b.publicKey), ['got it']);
});

test('sending while the P2P route reconnects still queues the message', async () => {
  const net = network(), a = identity(), b = identity();
  const A = await client(net, a, [b]);
  const sending = A.messenger.send(b.publicKey, 'tapped during reconnect');
  A.messenger.attachInternet(null); A.messenger.attachInternet(A.transport);
  await sending;
  assert.equal((await A.messenger.view()).conversations[b.publicKey].messages[0].status, 'queued');
  A.messenger.suspend();
  await assert.rejects(Promise.all([A.messenger.send(b.publicKey, 'after lock'), Promise.resolve().then(() => A.messenger.suspend())]), /disconnected/);
});
