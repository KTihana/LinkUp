import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { internetPublicKey, internetSecretKey } from '../src/messaging/internet/identity.ts';
import { InternetSession } from '../src/messaging/internet/session.ts';
import { Messenger, decodeMessaging, encodeMessaging } from '../src/messaging/messenger.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
const random = async size => new Uint8Array(randomBytes(size));
function identity() { const seed = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(seed)); return { seed, publicKey, sign: bytes => bytesToHex(ed25519.sign(bytes, seed)) }; }
function port(owner, friends, initial = null) {
  let state = initial, queue = Promise.resolve();
  return { transact(task) { const result = queue.then(async () => { const next = await task(state, owner, friends); state = next.state; return next.result; }); queue = result.catch(() => {}); return result; }, read: () => state };
}
function native() {
  const listeners = new Map();
  return { starts: 0, stops: 0, other: null, self: '', sent: [],
    addListener(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return { remove: () => set.delete(callback) }; },
    emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); },
    async start() { this.starts++; }, async stop() { this.stops++; },
    async send(peer, payload) { this.sent.push(payload); this.other?.emit('packet', { linkId: this.self, payload }); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  };
}
test('existing signed identities map to matching Tox public and secret keys', () => {
  const person = identity(), secret = internetSecretKey(person.seed);
  assert.equal(bytesToHex(x25519.getPublicKey(secret)), internetPublicKey(person.publicKey));
  assert.throws(() => internetPublicKey('00'.repeat(32)));
  assert.throws(() => internetPublicKey('bad'));
  secret.fill(0);
});
test('internet migration enables new accounts once and preserves pause and local-only preferences', async () => {
  const person = identity(), store = port(person, []), messenger = new Messenger(store, random);
  await messenger.initializeInternet(); assert.equal((await messenger.view()).enabled, true);
  await messenger.disconnect(); await messenger.initializeInternet(); assert.equal((await messenger.view()).enabled, false);
  await messenger.resumeInternet(); assert.equal((await messenger.view()).enabled, true);
  await messenger.setPolicy('nearby-only'); await messenger.initializeInternet(); assert.equal((await messenger.view()).policy, 'nearby-only');
  const data = decodeMessaging(null); data.endpoint = 'https://mail.example';
  const saved = new Messenger(port(person, [], encodeMessaging(data)), random);
  await saved.initializeInternet(); assert.equal((await saved.view()).enabled, false);
});
test('automatic internet transport delivers MLS messages and receipts without a mailbox', async t => {
  const a = identity(), b = identity(), na = native(), nb = native(); na.self = a.publicKey; nb.self = b.publicKey; na.other = nb; nb.other = na;
  let http = 0; const noHTTP = async () => { http++; throw new Error('No mailbox configured'); };
  const pa = port(a, [b]), pb = port(b, [a]);
  const alice = new Messenger(pa, random, Date.now, noHTTP, ensureMessagingCrypto), bob = new Messenger(pb, random, Date.now, noHTTP, ensureMessagingCrypto);
  const sa = new InternetSession({ native: na, port: pa, messenger: alice, randomBytes: random, isForeground: () => true });
  const sb = new InternetSession({ native: nb, port: pb, messenger: bob, randomBytes: random, isForeground: () => true });
  t.after(async () => { await sa.stop(); await sb.stop(); });
  await alice.initializeInternet(); await bob.initializeInternet();
  await sa.start(task => task(internetSecretKey(a.seed)), [b]); await sb.start(task => task(internetSecretKey(b.seed)), [a]);
  na.emit('link', { linkId: b.publicKey, state: 'connected', direct: true }); nb.emit('link', { linkId: a.publicKey, state: 'connected', direct: true });
  await alice.sync(); await bob.sync(); await alice.send(b.publicKey, 'Hello automatically over P2P');
  for (let i = 0; i < 4; i++) { await alice.sync(); await bob.sync(); }
  assert.equal((await bob.view()).conversations[a.publicKey].messages[0].content, 'Hello automatically over P2P');
  assert.equal((await alice.view()).conversations[b.publicKey].messages[0].status, 'delivered');
  assert.equal(http, 0); assert.equal(na.sent.some(packet => packet.includes('Hello automatically')), false);
  await alice.setPolicy('nearby-only'); await assert.rejects(alice.sync(), /Nearby only/); assert.equal(http, 0);
});
test('stop during identity access cannot start a native connection or retain listeners', async () => {
  const owner = identity(), store = port(owner, []), n = native(), attached = [];
  const session = new InternetSession({ native: n, port: store, messenger: { attachInternet: value => attached.push(value) }, randomBytes: random, isForeground: () => true });
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const starting = session.start(async task => { enter(); await gate; await task(internetSecretKey(owner.seed)); }, []);
  await entered; await session.stop(); release(); await starting;
  assert.equal(n.starts, 0); assert.equal(n.count(), 0); assert.equal(attached.at(-1), null); assert.equal(session.getSnapshot().phase, 'off');
});

test('an explicitly configured mailbox is never silently replaced by the internet packet channel', async () => {
  const owner = identity(), data = decodeMessaging(null); data.endpoint = 'https://mail.example'; data.enabled = true;
  let http = 0, direct = 0;
  const client = new Messenger(port(owner, [], encodeMessaging(data)), random, Date.now, async () => { http++; throw new Error('Expected mailbox request'); }, async () => {});
  client.attachInternet({ keyStatus() { direct++; throw new Error('Wrong route'); }, receive() { direct++; throw new Error('Wrong route'); } });
  await assert.rejects(client.sync());
  assert.ok(http > 0); assert.equal(direct, 0);
});
