import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { NearbySession } from '../src/messaging/nearbySession.ts';
import { NearbyTransport } from '../src/messaging/nearbyTransport.ts';
import { Messenger } from '../src/messaging/messenger.ts';
import { BLE_SERVICE, createNearbyOffer, inspectNearbyOffer, NEARBY_OFFER_TTL } from '../src/messaging/nearbyOffer.ts';
import { VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
const secureRandom = async length => new Uint8Array(randomBytes(length));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const wifi = { host: '192.168.1.20', port: 23456, pin: '11'.repeat(32) };
function identity() { const seed = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(seed)); return { seed, publicKey, sign: bytes => bytesToHex(ed25519.sign(bytes, seed)) }; }
function nativeFixture() {
  const listeners = new Map(), calls = [], hooks = {};
  const native = {
    addListener(name, listener) {
      const values = listeners.get(name) ?? new Set(); values.add(listener); listeners.set(name, values);
      return { remove: () => values.delete(listener) };
    },
    async startWifi(hotspot) { calls.push(['startWifi', hotspot]); return hooks.startWifi ? hooks.startWifi(hotspot) : { ...wifi }; },
    async startPrivateNetwork() { calls.push(['startPrivateNetwork']); return { host: '10.203.0.2', port: 47443, pin: wifi.pin }; },
    async connectPrivateNetwork(...args) { calls.push(['connectPrivateNetwork', ...args]); return { linkId: 'vpn-link' }; },
    async startBluetooth() { calls.push(['startBluetooth']); return hooks.startBluetooth ? hooks.startBluetooth() : { service: BLE_SERVICE }; },
    async connectWifi(...args) { calls.push(['connectWifi', ...args]); return hooks.connectWifi ? hooks.connectWifi(...args) : { linkId: 'wifi-link' }; },
    async connectBluetooth(deviceId) { calls.push(['connectBluetooth', deviceId]); return hooks.connectBluetooth ? hooks.connectBluetooth(deviceId) : { linkId: 'ble-link' }; },
    async send(...args) { calls.push(['send', ...args]); },
    async close(...args) { calls.push(['close', ...args]); },
    async stop() { calls.push(['stop']); if (hooks.stop) await hooks.stop(); },
  };
  return { native, calls, hooks, emit: (event, value) => { for (const listener of listeners.get(event) ?? []) listener(value); }, count: () => [...listeners.values()].reduce((count, values) => count + values.size, 0) };
}
async function fixture(t, wrapper) {
  let now = Date.now(), foreground = true, syncs = 0;
  const values = new Map(); let deviceKey = null;
  const controller = new VaultController({
    store: { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); } },
    recordKey: 'vault', randomBytes: secureRandom, readDeviceKey: async () => deviceKey, saveDeviceKey: async value => { deviceKey = value; },
    withWrite: async task => task(), now: () => now, signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
  });
  await controller.start(); await controller.beginSetup(); await controller.commitSetup();
  const friend = identity(), other = identity(), self = controller.getSnapshot().identity.slice(7);
  await controller.acceptInvite(createInvitation(friend.seed, 'Friend', randomBytes(16), now));
  const actualPort = { transact: controller.transactMessaging }, port = wrapper ? wrapper(actualPort) : actualPort;
  const messenger = new Messenger(port, secureRandom, () => now, async () => { throw new Error('No HTTP in lifecycle tests'); }, async () => {});
  const native = nativeFixture();
  const session = new NearbySession({ native: native.native, port, messenger, randomBytes: secureRandom, ensureCrypto: async () => {},
    sync: () => { syncs += 1; }, now: () => now, isForeground: () => foreground });
  t.after(async () => { await session.stop(); controller.stop(); });
  const offer = (kind = 'wifi', recipient = self) => createNearbyOffer({ version: 1, publicKey: friend.publicKey, peer: recipient, issuedAt: now,
    expiresAt: now + NEARBY_OFFER_TTL, nonce: bytesToHex(randomBytes(16)), ...(kind === 'wifi' ? { kind, ...wifi } : { kind, service: BLE_SERVICE }) }, friend);
  return { controller, port, actualPort, session, messenger, friend, other, self, native, offer, values,
    setForeground: value => { foreground = value; }, advance: duration => { now += duration; }, syncs: () => syncs };
}

test('Stop during authorization prevents transport attachment, native startup and QR resurrection', async t => {
  const gate = deferred(), entered = deferred(); let first = true;
  const f = await fixture(t, actual => ({ transact: async task => { if (first) { first = false; entered.resolve(); await gate.promise; } return actual.transact(task); } }));
  const hosting = f.session.host(f.friend.publicKey, 'wifi'); await entered.promise;
  await f.session.stop(); gate.resolve(); await assert.rejects(hosting, /stopped/);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.equal(f.session.getSnapshot().offer, '');
  assert.equal(f.native.calls.some(([name]) => name === 'startWifi'), false); assert.equal(f.native.count(), 0);
});

test('simultaneous host starts have distinct generations and only the latest can publish a code', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(); let first = true;
  f.native.hooks.stop = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const older = f.session.host(f.friend.publicKey, 'wifi'); await entered.promise;
  const newer = f.session.host(f.friend.publicKey, 'hotspot'); gate.resolve();
  await assert.rejects(older, /stopped/); await newer;
  assert.equal(f.session.getSnapshot().kind, 'hotspot'); assert.equal(f.session.getSnapshot().phase, 'waiting');
  assert.equal(inspectNearbyOffer(f.session.getSnapshot().offer, Date.now()).peer, f.friend.publicKey);
  assert.deepEqual(f.native.calls.filter(([name]) => name === 'startWifi'), [['startWifi', true]]);
  assert.equal(f.native.count(), 4);
});

test('Stop while native Wi-Fi startup is delayed cannot recreate a QR or active session', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.native.hooks.startWifi = async () => { entered.resolve(); return gate.promise; };
  const hosting = f.session.host(f.friend.publicKey, 'wifi'); await entered.promise;
  await f.session.stop(); gate.resolve({ ...wifi }); await assert.rejects(hosting, /stopped/);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.equal(f.session.getSnapshot().offer, ''); assert.equal(f.native.count(), 0);
  assert.equal(f.syncs(), 0); assert.equal(f.native.calls.filter(([name]) => name === 'stop').length, 2);
});

test('wrong-recipient and unaccepted-friend codes fail before any native connection or listener starts', async t => {
  const f = await fixture(t);
  await assert.rejects(f.session.join(f.offer('wifi', f.other.publicKey)), /different identity/);
  const issuedAt = Date.now();
  const unaccepted = createNearbyOffer({ version: 1, publicKey: f.other.publicKey, peer: f.self, issuedAt, expiresAt: issuedAt + NEARBY_OFFER_TTL,
    nonce: bytesToHex(randomBytes(16)), kind: 'wifi', ...wifi }, f.other);
  await assert.rejects(f.session.join(unaccepted), /friends/);
  assert.equal(f.native.calls.length, 0); assert.equal(f.native.count(), 0); assert.equal(f.session.getSnapshot().phase, 'idle');
});

test('a late failure from an older host cannot stop or overwrite a newer successful session', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(); let first = true;
  f.native.hooks.startWifi = async () => { if (first) { first = false; entered.resolve(); return gate.promise; } return { ...wifi, pin: '22'.repeat(32) }; };
  const older = f.session.host(f.friend.publicKey, 'wifi'); await entered.promise;
  await f.session.host(f.friend.publicKey, 'hotspot'); const successful = f.session.getSnapshot();
  gate.reject(new Error('Old native startup failed')); await assert.rejects(older, /Old native/);
  assert.deepEqual(f.session.getSnapshot(), successful); assert.equal(f.session.getSnapshot().problem, ''); assert.equal(f.native.count(), 4);
});

test('Bluetooth rechecks signed-code expiry after async native connect and closes the stale session', async t => {
  const f = await fixture(t); await f.session.join(f.offer('bluetooth'));
  f.native.emit('bluetoothPeer', { deviceId: 'nearby-device', label: 'Untrusted advertisement name' });
  assert.equal(f.session.getSnapshot().devices[0].label, 'Nearby phone 1');
  const gate = deferred(), entered = deferred();
  f.native.hooks.connectBluetooth = async () => { entered.resolve(); return gate.promise; };
  const connecting = f.session.connectBluetooth('nearby-device'); await entered.promise; f.advance(NEARBY_OFFER_TTL);
  gate.resolve({ linkId: 'expired-ble-link' }); await assert.rejects(connecting, /expired/);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.match(f.session.getSnapshot().problem, /expired/);
  assert.equal(f.native.count(), 0); assert.equal(f.syncs(), 0);
});

test('background cleanup stops established resources; a delayed startup cannot resume after foreground loss', async t => {
  const f = await fixture(t); await f.session.host(f.friend.publicKey, 'wifi');
  f.native.emit('link', { linkId: 'friend-link', state: 'connected', kind: 'wifi' });
  assert.equal(f.session.getSnapshot().phase, 'connected');
  const stopped = deferred(); const unsubscribe = f.session.subscribe(() => { if (f.session.getSnapshot().phase === 'idle') stopped.resolve(); });
  f.setForeground(false); f.session.background(); await stopped.promise; unsubscribe(); await f.session.stop();
  assert.equal(f.native.count(), 0); assert.equal(f.session.getSnapshot().phase, 'idle');
  f.native.emit('link', { linkId: 'late-link', state: 'connected', kind: 'wifi' }); assert.equal(f.session.getSnapshot().phase, 'idle');
  f.setForeground(true); const gate = deferred(), entered = deferred();
  f.native.hooks.startWifi = async () => { entered.resolve(); return gate.promise; };
  const starting = f.session.host(f.friend.publicKey, 'wifi'); await entered.promise;
  f.setForeground(false); f.session.background(); gate.resolve({ ...wifi }); await assert.rejects(starting, /stopped/);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.equal(f.native.count(), 0);
});

test('a stale NearbyTransport.start failure cannot disable a newer successful start', async t => {
  const f = await fixture(t), old = deferred(); let first = true;
  const transport = new NearbyTransport({ port: { transact: task => { if (first) { first = false; return old.promise; } return f.actualPort.transact(task); } },
    randomBytes: secureRandom, channel: { send: async () => {}, subscribe: () => () => {} } });
  const previous = transport.start(); transport.stop(); await transport.start();
  old.reject(new Error('Old encrypted storage start failed')); await assert.rejects(previous, /Old encrypted/);
  assert.doesNotThrow(() => transport.attachLink('friend-link', f.friend.publicKey));
  t.after(() => transport.stop());
});


test('a native link event during pending startup cannot activate or sync after foreground loss', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.native.hooks.startWifi = async () => { entered.resolve(); return gate.promise; };
  const starting = f.session.host(f.friend.publicKey, 'wifi'); await entered.promise;
  f.setForeground(false); f.session.background();
  f.native.emit('link', { linkId: 'background-link', state: 'connected', kind: 'wifi' });
  // Finish the operation even if the assertion catches a lifecycle regression.
  const activated = f.session.getSnapshot().phase === 'connected', syncs = f.syncs();
  gate.resolve({ ...wifi }); await assert.rejects(starting, /stopped/);
  assert.equal(activated, false); assert.equal(syncs, 0);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.equal(f.native.count(), 0);
});

test('Wi-Fi join preserves the signed TLS pin and refuses expiry after asynchronous connect', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  const code = f.offer('wifi');
  f.native.hooks.connectWifi = async () => { entered.resolve(); return gate.promise; };
  const joining = f.session.join(code); await entered.promise;
  assert.deepEqual(f.native.calls.find(([name]) => name === 'connectWifi'), ['connectWifi', wifi.host, wifi.port, wifi.pin]);
  f.advance(NEARBY_OFFER_TTL); gate.resolve({ linkId: 'expired-wifi-link' });
  await assert.rejects(joining, /expired/);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.match(f.session.getSnapshot().problem, /expired/);
  assert.equal(f.native.count(), 0); assert.equal(f.syncs(), 0);
});


test('private network hosting signs an explicit VPN offer and never starts LAN discovery', async t => {
  const f = await fixture(t);
  await f.session.host(f.friend.publicKey, 'vpn');
  const offered = inspectNearbyOffer(f.session.getSnapshot().offer, Date.now());
  assert.equal(offered.kind, 'vpn'); assert.equal(offered.host, '10.203.0.2'); assert.equal(offered.port, 47443);
  assert.equal(offered.peer, f.friend.publicKey); assert.equal(f.session.getSnapshot().kind, 'vpn');
  assert.equal(f.native.calls.some(([name]) => name === 'startWifi' || name === 'startBluetooth'), false);
  assert.equal((await f.messenger.view()).policy, 'nearby-only');
  f.native.emit('error', {kind:'vpn',message:'Private network disconnected.'});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.session.getSnapshot().phase, 'idle');
  assert.equal((await f.messenger.view()).policy, 'nearby-only');
});

test('joining signed VPN offers invokes only the dedicated overlay connector', async t => {
  const f = await fixture(t), issuedAt = Date.now();
  const offer = createNearbyOffer({version:1,publicKey:f.friend.publicKey,peer:f.self,issuedAt,expiresAt:issuedAt+NEARBY_OFFER_TTL,nonce:'22'.repeat(16),kind:'vpn',host:'10.203.0.3',port:47443,pin:wifi.pin},f.friend);
  await f.session.join(offer);
  assert.equal(f.session.getSnapshot().kind,'vpn'); assert.equal(f.session.getSnapshot().phase,'connected');
  assert.deepEqual(f.native.calls.filter(([name])=>name==='connectPrivateNetwork'),[['connectPrivateNetwork','10.203.0.3',47443,wifi.pin]]);
  assert.equal(f.native.calls.some(([name])=>name==='connectWifi'||name==='startWifi'||name==='startBluetooth'),false);
});
