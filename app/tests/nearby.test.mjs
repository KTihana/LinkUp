import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { Messenger, decodeMessaging } from '../src/messaging/messenger.ts';
import { NearbyTransport } from '../src/messaging/nearbyTransport.ts';
import { decodeNearbyPacket, MAX_NEARBY_PACKET_BYTES } from '../src/messaging/nearbyProtocol.ts';
import { envelopeBytes, packageBytes } from '../src/messaging/mailboxClient.ts';
import { createPackage, startSession } from '../src/messaging/mlsEngine.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
import { VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
const secureRandom = async length => new Uint8Array(randomBytes(length));
const ttl = 7 * 24 * 60 * 60 * 1000;
function peer() {
  const seed = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(seed));
  return { publicKey, signer: { publicKey, sign: bytes => bytesToHex(ed25519.sign(bytes, seed)) } };
}
function memoryPort(owner, contacts, initial = null) {
  let state = initial, queue = Promise.resolve(), failure = null, locked = false;
  return {
    transact(task) {
      const result = queue.then(async () => {
        if (locked) throw new Error('Vault locked');
        const next = await task(state, { publicKey: owner.publicKey, sign: bytes => { if (locked) throw new Error('Vault locked'); return owner.signer.sign(bytes); } }, contacts);
        if (locked) throw new Error('Vault locked');
        if (next.state !== state) { if (failure?.(next.state)) { failure = null; throw new Error('Storage write failed'); } state = next.state; }
        return next.result;
      }); queue = result.catch(() => {}); return result;
    }, read: () => state, failNext: predicate => { failure = predicate; }, lock: () => { locked = true; },
  };
}
function channels({ singleFlight = false } = {}) {
  const listeners = [new Set(), new Set()], packets = [], interceptors = [null, null], sending = [false, false];
  let overlaps = 0;
  const values = [0, 1].map(side => ({
    subscribe(listener) { listeners[side].add(listener); return () => listeners[side].delete(listener); },
    async send(linkId, payload) {
      if (singleFlight && sending[side]) { overlaps += 1; throw new Error('A Bluetooth packet is still sending.'); }
      sending[side] = true;
      try {
        packets.push({ side, linkId, payload });
        if (interceptors[side] && await interceptors[side]({ linkId, payload })) return;
        if (singleFlight) await new Promise(resolve => setTimeout(resolve, 5));
        for (const listener of listeners[1 - side]) listener({ linkId, payload });
        // Delivery can precede the final native fragment-completion callback.
        if (singleFlight) await new Promise(resolve => setTimeout(resolve, 5));
      } finally { sending[side] = false; }
    },
  }));
  return { values, packets, overlaps: () => overlaps, intercept: (side, callback) => { interceptors[side] = callback; }, inject: (side, payload) => { for (const listener of listeners[side]) listener({ linkId: 'friend-link', payload }); } };
}
async function setup(t, options = {}) {
  const a = options.a ?? peer(), b = options.b ?? peer();
  const portA = options.portA ?? memoryPort(a, [{ publicKey: b.publicKey, name: 'Bob' }]);
  const portB = options.portB ?? memoryPort(b, [{ publicKey: a.publicKey, name: 'Alice' }]);
  const wire = channels(options); let requests = 0, incoming = 0;
  const fetcher = async () => { requests += 1; throw new Error('HTTP is forbidden'); };
  const alice = new Messenger(portA, secureRandom, Date.now, fetcher, ensureMessagingCrypto);
  const bob = new Messenger(portB, secureRandom, Date.now, fetcher, ensureMessagingCrypto);
  const serviceA = new NearbyTransport({ port: portA, channel: wire.values[0], randomBytes: secureRandom, timeoutMs: options.timeoutMs ?? 1000 });
  const serviceB = new NearbyTransport({ port: portB, channel: wire.values[1], randomBytes: secureRandom, timeoutMs: options.timeoutMs ?? 1000, onIncoming: () => { incoming += 1; } });
  await Promise.all([serviceA.start(), serviceB.start()]);
  serviceA.attachLink('friend-link', b.publicKey); serviceB.attachLink('friend-link', a.publicKey);
  alice.attachNearby(serviceA); bob.attachNearby(serviceB);
  await alice.setPolicy('nearby-only'); await bob.setPolicy('nearby-only');
  await bob.sync(); await alice.sync();
  t.after(() => { serviceA.stop(); serviceB.stop(); });
  return { a, b, portA, portB, wire, alice, bob, serviceA, serviceB, http: () => requests, incoming: () => incoming };
}
const history = async (messenger, publicKey) => (await messenger.view()).conversations[publicKey]?.messages ?? [];
function opaqueEnvelope(a, b, now = Date.now()) {
  const unsigned = { version: 1, id: bytesToHex(randomBytes(16)), sender: a.publicKey, recipient: b.publicKey, createdAt: now, expiresAt: now + ttl, ciphertext: base64.encode(new Uint8Array([1, 2, 3])) };
  return { ...unsigned, signature: a.signer.sign(envelopeBytes(unsigned)) };
}
function publicPackage(b, now = Date.now()) {
  const unsigned = { id: bytesToHex(randomBytes(16)), owner: b.publicKey, createdAt: now, expiresAt: now + ttl, data: 'opaque public material' };
  return { ...unsigned, signature: b.signer.sign(packageBytes(unsigned)) };
}

test('simultaneous nearby publications and signed replies respect a one-packet Bluetooth pipe', async t => {
  // This checks packet serialization, not latency. Parallel MLS test workers
  // can starve its one-second fixture budget; production allows 60 seconds.
  const f = await setup(t, { singleFlight: true, timeoutMs: 10000 });
  const fromA = [opaqueEnvelope(f.a, f.b), opaqueEnvelope(f.a, f.b)];
  const fromB = [opaqueEnvelope(f.b, f.a), opaqueEnvelope(f.b, f.a)];
  await Promise.all([
    ...fromA.map(envelope => f.serviceA.publish(envelope, f.a.signer)),
    ...fromB.map(envelope => f.serviceB.publish(envelope, f.b.signer)),
  ]);
  assert.equal(f.wire.overlaps(), 0);
  assert.deepEqual(new Set((await f.serviceA.receive(f.a.signer)).map(m => m.id)), new Set(fromB.map(m => m.id)));
  assert.deepEqual(new Set((await f.serviceB.receive(f.b.signer)).map(m => m.id)), new Set(fromA.map(m => m.id)));
  assert.equal(f.http(), 0);
});

test('two nearby clients establish MLS and exchange text, emoji, stickers and authenticated receipts without HTTP', async t => {
  const f = await setup(t, { singleFlight: true });
  await f.alice.send(f.b.publicKey, 'Nearby hello 🌿'); await f.alice.sync();
  assert.equal((await history(f.alice, f.b.publicKey))[0].status, 'stored');
  assert.equal(decodeMessaging(f.portB.read()).nearby.inbox.length, 2);
  await f.bob.sync(); await f.alice.sync();
  assert.equal((await history(f.bob, f.a.publicKey))[0].content, 'Nearby hello 🌿');
  assert.equal((await history(f.alice, f.b.publicKey))[0].status, 'delivered');
  await f.bob.send(f.a.publicKey, 'cat-mint', 'sticker'); await f.bob.sync(); await f.alice.sync(); await f.bob.sync();
  assert.equal((await history(f.alice, f.b.publicKey))[1].content, 'cat-mint');
  assert.equal((await history(f.bob, f.a.publicKey))[1].status, 'delivered');
  assert.equal(f.http(), 0); assert.equal((await f.alice.view()).policy, 'nearby-only');
  assert.ok(f.wire.packets.every(packet => !packet.payload.includes('Nearby hello')));
  assert.ok(decodeMessaging(f.portA.read()).packages.every(item => item.location === 'nearby'));
  assert.equal(f.wire.overlaps(), 0);
});

test('canceling nearby requests drops packets waiting behind an active native transfer', async t => {
  const f = await setup(t, { singleFlight: true });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { entered = resolve; });
  f.wire.intercept(0, async () => { entered(); await gate; return true; });
  const packetsBefore = f.wire.packets.length;
  const attempts = Promise.allSettled([
    f.serviceA.claim(f.b.publicKey, f.a.signer),
    f.serviceA.claim(f.b.publicKey, f.a.signer),
  ]);
  await sending; await new Promise(resolve => setImmediate(resolve));
  f.serviceA.cancel(); release();
  const results = await attempts;
  assert.ok(results.every(result => result.status === 'rejected' && /stopped/.test(result.reason.message)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.wire.packets.length - packetsBefore, 1);
  assert.equal(f.wire.overlaps(), 0);
  assert.equal(decodeMessaging(f.portB.read()).nearby.claimed.length, 0);
});

test('replacing a nearby link cannot send queued packets from its previous connection', async t => {
  const f = await setup(t, { singleFlight: true });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { entered = resolve; });
  f.wire.intercept(0, async () => { entered(); await gate; return true; });
  const packetsBefore = f.wire.packets.length;
  const attempts = Promise.allSettled([
    f.serviceA.claim(f.b.publicKey, f.a.signer),
    f.serviceA.claim(f.b.publicKey, f.a.signer),
  ]);
  await sending; await new Promise(resolve => setImmediate(resolve));
  f.serviceA.detachLink('friend-link'); f.serviceA.attachLink('friend-link', f.b.publicKey); release();
  const results = await attempts;
  assert.ok(results.every(result => result.status === 'rejected' && /disconnected/.test(result.reason.message)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.wire.packets.length - packetsBefore, 1);
  assert.equal(f.wire.overlaps(), 0);
});

test('nearby receiver storage is durable before confirmation; failed writes keep sender retries and deduplicate', async t => {
  const f = await setup(t), envelope = opaqueEnvelope(f.a, f.b);
  f.portB.failNext(state => decodeMessaging(state).nearby.inbox.length > 0);
  await assert.rejects(f.serviceA.publish(envelope, f.a.signer), /rejected/);
  assert.equal(decodeMessaging(f.portB.read()).nearby.inbox.length, 0); assert.equal(f.incoming(), 0);
  await f.serviceA.publish(envelope, f.a.signer); await f.serviceA.publish(envelope, f.a.signer);
  assert.equal(decodeMessaging(f.portB.read()).nearby.inbox.length, 1);
  await f.serviceB.acknowledge([{ sender: f.a.publicKey, id: envelope.id }], f.b.signer);
  await f.serviceA.publish(envelope, f.a.signer);
  assert.equal(decodeMessaging(f.portB.read()).nearby.inbox.length, 0);
  assert.equal(decodeMessaging(f.portB.read()).nearby.accepted.length, 1); assert.equal(f.incoming(), 1);
});

test('one-use claims survive restart, failed claim persistence and replayed signed requests', async t => {
  const f = await setup(t), before = await f.serviceB.keyStatus(f.b.signer);
  f.portB.failNext(state => decodeMessaging(state).nearby.claimed.length > 0);
  await assert.rejects(f.serviceA.claim(f.b.publicKey, f.a.signer), /rejected/);
  assert.deepEqual(await f.serviceB.keyStatus(f.b.signer), before);
  const claimed = await f.serviceA.claim(f.b.publicKey, f.a.signer);
  const request = f.wire.packets.filter(item => item.side === 0 && JSON.parse(item.payload).type === 'request').at(-1).payload;
  f.wire.inject(1, request);
  await f.serviceB.keyStatus(f.b.signer); // Await the queued replay transaction.
  assert.equal(decodeMessaging(f.portB.read()).nearby.claimed.length, 1);
  f.serviceB.stop();
  const restartedPort = memoryPort(f.b, [{ publicKey: f.a.publicKey, name: 'Alice' }], f.portB.read());
  const restarted = new NearbyTransport({ port: restartedPort, channel: f.wire.values[1], randomBytes: secureRandom });
  await restarted.start(); restarted.attachLink('friend-link', f.a.publicKey); t.after(() => restarted.stop());
  assert.ok(!(await restarted.keyStatus(f.b.signer)).includes(claimed.id));
  // Retrying the original public package cannot resurrect a consumed key.
  const original = decodeMessaging(f.portB.read()).packages.find(item => item.package.id === claimed.id).package;
  await restarted.publishKeys([original], f.b.signer);
  assert.ok(!(await restarted.keyStatus(f.b.signer)).includes(claimed.id));
});

test('local package retirement is owner-bound, durable, idempotent and cannot be republished', async t => {
  const f = await setup(t), available = await f.serviceB.keyStatus(f.b.signer), id = available[0];
  const original = decodeMessaging(f.portB.read()).packages.find(item => item.package.id === id).package;
  await assert.rejects(f.serviceB.retireKeys([id], f.a.signer), /identity changed/);
  f.portB.failNext(state => decodeMessaging(state).nearby.claimed.some(item => item.id === id));
  await assert.rejects(f.serviceB.retireKeys([id], f.b.signer), /Storage write failed/);
  assert.deepEqual(await f.serviceB.keyStatus(f.b.signer), available);
  await f.serviceB.retireKeys([id], f.b.signer); await f.serviceB.retireKeys([id], f.b.signer);
  const saved = decodeMessaging(f.portB.read());
  assert.equal(saved.nearby.claimed.filter(item => item.id === id).length, 1);
  assert.ok(saved.packages.some(item => item.package.id === id), 'private MLS record stays available for an already delivered Welcome');
  f.serviceB.stop();
  const restored = new NearbyTransport({ port: memoryPort(f.b, [{ publicKey: f.a.publicKey, name: 'Alice' }], f.portB.read()), channel: f.wire.values[1], randomBytes: secureRandom });
  await restored.start(); t.after(() => restored.stop());
  await restored.publishKeys([original], f.b.signer);
  assert.ok(!(await restored.keyStatus(f.b.signer)).includes(id));
});

test('a forged pinned response cannot replace the signed challenge or confirm storage', async t => {
  const f = await setup(t); let injected = false;
  f.wire.intercept(1, ({ payload }) => {
    const response = JSON.parse(payload);
    if (!injected && response.type === 'response') {
      injected = true; f.wire.inject(0, JSON.stringify({ ...response, signature: '00'.repeat(64) }));
    }
    return false;
  });
  await f.serviceA.publish(opaqueEnvelope(f.a, f.b), f.a.signer);
  assert.equal(injected, true); assert.equal(decodeMessaging(f.portB.read()).nearby.inbox.length, 1);
});

test('Stop cancels outstanding RPC immediately and a locked vault refuses inbound storage', async t => {
  const f = await setup(t); let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.wire.intercept(1, () => { entered(); return true; });
  const pending = f.serviceA.claim(f.b.publicKey, f.a.signer); await waiting;
  f.serviceA.stop(); await assert.rejects(pending, /stopped/);
  assert.equal(decodeMessaging(f.portB.read()).nearby.claimed.length, 0);
  f.wire.intercept(1, null); await f.serviceA.start(); f.serviceA.attachLink('friend-link', f.b.publicKey);
  f.portB.lock();
  await assert.rejects(f.serviceA.publish(opaqueEnvelope(f.a, f.b), f.a.signer), /did not respond/);
  assert.equal(decodeMessaging(f.portB.read()).nearby.inbox.length, 0);
});

test('unaccepted contacts, wrong link identity, malformed and oversized packets cannot store or claim', async t => {
  const a = peer(), b = peer(), outsider = peer(), portB = memoryPort(b, []);
  const f = await setup(t, { a, b, portB });
  const before = portB.read();
  await assert.rejects(f.serviceA.claim(b.publicKey, a.signer), /did not respond/);
  f.wire.inject(1, JSON.stringify({ version: 1, id: bytesToHex(randomBytes(16)), type: 'challenge', publicKey: outsider.publicKey, action: 'keys-claim' }));
  f.wire.inject(1, '{}'); f.wire.inject(1, 'x'.repeat(MAX_NEARBY_PACKET_BYTES + 1));
  assert.equal(portB.read(), before);
  assert.throws(() => decodeNearbyPacket('x'.repeat(MAX_NEARBY_PACKET_BYTES + 1)), /large/);
  assert.throws(() => decodeNearbyPacket(JSON.stringify({ version: 1, id: 'a'.repeat(32), type: 'challenge', publicKey: a.publicKey, action: 'keys-claim', privateData: 'no' })));
});

test('nearby-only persists across restart and never falls back to a configured mailbox', async t => {
  const f = await setup(t);
  await f.portA.transact(async (state) => { const data = JSON.parse(state); data.endpoint = 'https://mailbox.example'; return { state: JSON.stringify(data), result: null }; });
  f.alice.attachNearby(null);
  await f.alice.send(f.b.publicKey, 'Wait for local connection');
  await assert.rejects(f.alice.sync(), /Nearby only/);
  let calls = 0;
  const restarted = new Messenger(f.portA, secureRandom, Date.now, async () => { calls += 1; throw new Error('HTTP forbidden'); }, ensureMessagingCrypto);
  assert.equal((await restarted.view()).policy, 'nearby-only');
  await assert.rejects(restarted.sync(), /Nearby only/);
  assert.equal(calls, 0); assert.equal(f.http(), 0);
  assert.equal((await restarted.view()).queued, 1);
  restarted.attachNearby(f.serviceA); await restarted.sync(); await f.bob.sync(); await restarted.sync();
  assert.equal((await history(restarted, f.b.publicKey))[0].status, 'delivered');
});

test('mailbox and nearby use different one-use public package pools', async t => {
  const a = peer(), b = peer(), portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Bob' }]);
  const old = publicPackage(a);
  await portA.transact(async () => ({ state: JSON.stringify({ version: 1, endpoint: 'https://mailbox.example', enabled: true, conversations: {}, pending: [], outbox: [], packages: [{ package: old, privateData: 'old private package', published: true }], seen: [] }), result: null }));
  const f = await setup(t, { a, b, portA });
  const saved = decodeMessaging(portA.read());
  assert.equal(saved.packages.length, 11);
  assert.equal(saved.nearby.packages.some(item => item.id === old.id), false);
  assert.equal(saved.packages.filter(item => item.location === 'nearby').length, 10);
  assert.equal(f.http(), 0);
});

async function encryptedVault(record = null, deviceKey = null) {
  const store = new Map(record ? [['vault', record]] : []);
  const controller = new VaultController({
    store: { getItem: async key => store.get(key) ?? null, setItem: async (key, value) => { store.set(key, value); } },
    recordKey: 'vault', randomBytes: secureRandom, readDeviceKey: async () => deviceKey,
    saveDeviceKey: async value => { deviceKey = value; }, withWrite: async task => task(), now: Date.now,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
  });
  await controller.start();
  if (!record) { await controller.beginSetup(); deviceKey = controller.getSnapshot().pendingKey; await controller.commitSetup(); }
  else await controller.unlock(deviceKey);
  return { controller, store, deviceKey: () => deviceKey };
}
test('real encrypted vault restart restores nearby inbox, MLS session and receipt without HTTP', async t => {
  const va = await encryptedVault(), vb = await encryptedVault();
  await va.controller.acceptInvite(await vb.controller.createInvite()); await vb.controller.acceptInvite(await va.controller.createInvite());
  const a = { publicKey: va.controller.getSnapshot().identity.slice(7) }, b = { publicKey: vb.controller.getSnapshot().identity.slice(7) };
  const f = await setup(t, { a, b, portA: { transact: va.controller.transactMessaging }, portB: { transact: vb.controller.transactMessaging } });
  await f.alice.send(b.publicKey, 'Keep this across local restart'); await f.alice.sync();
  assert.equal((await history(f.alice, b.publicKey))[0].status, 'stored');
  assert.equal(vb.store.get('vault').includes('Keep this'), false); f.serviceB.stop(); vb.controller.stop();
  const resumed = await encryptedVault(vb.store.get('vault'), vb.deviceKey());
  const port = { transact: resumed.controller.transactMessaging };
  const service = new NearbyTransport({ port, channel: f.wire.values[1], randomBytes: secureRandom });
  await service.start(); service.attachLink('friend-link', a.publicKey); t.after(() => service.stop());
  const bob = new Messenger(port, secureRandom, Date.now, async () => { throw new Error('No HTTP'); }, ensureMessagingCrypto);
  bob.attachNearby(service); await bob.sync(); await f.alice.sync();
  assert.equal((await history(bob, a.publicKey))[0].content, 'Keep this across local restart');
  assert.equal((await history(f.alice, b.publicKey))[0].status, 'delivered');
  assert.equal(f.http(), 0);
});


test('an established out-of-range friend cannot block the connected friend or incoming receipts', async t => {
  const a = peer(), b = peer(), c = peer();
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Bob' }, { publicKey: c.publicKey, name: 'Out of range' }]);
  const f = await setup(t, { a, b, portA });
  await f.alice.send(b.publicKey, 'Confirm connected chat'); await f.alice.sync(); await f.bob.sync(); await f.alice.sync();
  const material = await createPackage(`common:${c.publicKey}`);
  const established = await startSession(`common:${a.publicKey}`, `common:${c.publicKey}`, material.publicData, await secureRandom(32));
  await portA.transact(async serialized => {
    const data = decodeMessaging(serialized); data.conversations[c.publicKey] = { state: established.state, groupId: established.groupId, messages: [] };
    return { state: JSON.stringify(data), result: null };
  });
  await f.alice.send(c.publicKey, 'Queued for the absent friend');
  await assert.rejects(f.alice.sync(), /out of range/);
  await f.bob.send(a.publicKey, 'Incoming connected friend'); await f.bob.sync();
  await f.alice.send(b.publicKey, 'Ready friend still progresses');
  await assert.rejects(f.alice.sync(), /out of range/);
  assert.ok((await history(f.alice, b.publicKey)).some(message => !message.mine && message.content === 'Incoming connected friend'));
  await f.bob.sync(); await assert.rejects(f.alice.sync(), /out of range/);
  assert.equal((await history(f.alice, b.publicKey)).find(message => message.content === 'Ready friend still progresses').status, 'delivered');
  assert.equal((await history(f.alice, c.publicKey))[0].status, 'queued');
  assert.equal(f.http(), 0);
});

test('switching to nearby-only aborts an outstanding HTTP challenge and revokes its signer', async () => {
  const a = peer(), b = peer(), port = memoryPort(a, [{ publicKey: b.publicKey, name: 'Bob' }]);
  let entered, aborted = false, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blockedHTTP = async (_url, options) => {
    calls += 1; entered();
    return new Promise((_, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }); });
  };
  const messenger = new Messenger(port, secureRandom, Date.now, blockedHTTP, ensureMessagingCrypto);
  const connecting = messenger.connect('https://mailbox.example'); await started;
  const selecting = messenger.setPolicy('nearby-only');
  await assert.rejects(connecting, /disconnected/); await selecting;
  assert.equal(aborted, true); assert.equal(calls, 1);
  await assert.rejects(messenger.sync(), /Nearby only/); assert.equal(calls, 1);
  assert.equal((await messenger.view()).policy, 'nearby-only');
});
