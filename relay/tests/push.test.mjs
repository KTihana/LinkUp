import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createECDH, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PushDelivery, publicAddress } from '../push.mjs';
import { MailboxStore } from '../store.mjs';
import { createRelay } from '../server.mjs';
import { requestBytes, envelopeBytes } from '../protocol.mjs';
function subscription(path = 'one') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: `https://push.example.org/${path}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
async function fixture(t, send) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linkup-push-')); let now = Date.now();
  const store = await MailboxStore.create(dataDir, { now: () => now });
  const delivery = new PushDelivery(store, { origins: ['https://push.example.org'], send }, () => now);
  t.after(async () => { await delivery.close(); await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { store, delivery, tick: ms => { now += ms; } };
}
test('push destinations reject private addresses, metadata services, invalid keys and unapproved origins', async t => {
  const f = await fixture(t, async () => {}), s = subscription();
  f.delivery.validate(s);
  for (const endpoint of ['https://127.0.0.1/a','http://push.example.org/a','https://other.example.org/a','https://push.example.org:8443/a','https://push.example.org/a#fragment','https://u:p@push.example.org/a']) assert.throws(() => f.delivery.validate({ ...s, endpoint }));
  assert.throws(() => f.delivery.validate({ ...s, keys: { p256dh: s.keys.p256dh, auth: 'bad' } }));
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.0.57','172.20.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
});
test('signed-owner registration is durable, retry backs off, expired endpoints are removed', async t => {
  let attempts = 0, failure = 503;
  const f = await fixture(t, async () => { attempts++; if (failure) throw { statusCode: failure }; });
  const owner = 'a'.repeat(64); await f.delivery.register(owner, subscription());
  await f.store.transact(state => { state.push[0].pending = true; });
  await f.delivery.flush(); assert.equal(attempts, 1); assert.equal(f.store.state.push[0].pending, true);
  await f.delivery.flush(); assert.equal(attempts, 1, 'backoff is respected');
  f.tick(5000); failure = 0; await f.delivery.flush(); assert.equal(attempts, 2); assert.equal(f.store.state.push[0].pending, false);
  await f.store.transact(state => { state.push[0].pending = true; });
  f.tick(11000); failure = 410; await f.delivery.flush(); assert.equal(f.store.state.push.length, 0);
});
test('unregister isolates identities and subscription expiry is bounded', async t => {
  const f = await fixture(t, async () => {});
  await f.delivery.register('a'.repeat(64), subscription()); await f.delivery.register('b'.repeat(64), subscription('two'));
  await f.delivery.unregister('a'.repeat(64)); assert.deepEqual(f.store.state.push.map(p => p.owner), ['b'.repeat(64)]);
  f.tick(31 * 86400000); await f.store.transact(() => {}); assert.equal(f.store.state.push.length, 0);
});
test('new mail arriving during an in-flight push remains pending for another wakeup', async t => {
  let f;
  f = await fixture(t, async () => { await f.store.transact(state => { state.push[0].revision = 'f'.repeat(32); state.push[0].pending = true; }); });
  await f.delivery.register('a'.repeat(64), subscription());
  await f.store.transact(state => { state.push[0].pending = true; });
  await f.delivery.flush(); assert.equal(f.store.state.push[0].pending, true);
});
test('revoking the last queued sender clears pending wakeups in the same durable write', async t => {
  let sent = 0;
  const f = await fixture(t, async () => { sent++; });
  const sender = generateKeyPairSync('ed25519'), recipient = generateKeyPairSync('ed25519');
  const senderKey = sender.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const recipientKey = recipient.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  await f.delivery.register(recipientKey, subscription());
  await f.store.setAdmission(recipientKey, [senderKey], 1);
  const envelope = { version: 1, id: randomBytes(16).toString('hex'), sender: senderKey, recipient: recipientKey,
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, ciphertext: Buffer.from('opaque encrypted packet').toString('base64') };
  envelope.signature = sign(null, envelopeBytes(envelope), sender.privateKey).toString('hex');
  await f.store.publish(senderKey, envelope);
  assert.equal(f.store.state.push[0].pending, true);
  await f.store.setAdmission(recipientKey, [], 2);
  assert.equal(f.store.state.push[0].pending, false);
  assert.equal(f.store.state.envelopes[0].envelope, null);
  await f.delivery.flush(); assert.equal(sent, 0);
});
test('real signed HTTP APIs register only the caller, dispatch an opaque wake and preserve queued mail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkup-push-http-'));
  let wake;
  const woke = new Promise(resolve => { wake = resolve; });
  const relay = await createRelay({ dataDir: directory, push: { origins: ['https://push.example.org'], send: async value => { wake(value); } } });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${relay.server.address().port}`;
  function identity() { const pair = generateKeyPairSync('ed25519'); return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), sign: bytes => sign(null, bytes, pair.privateKey).toString('hex') }; }
  const a = identity(), b = identity();
  const post = (path, body) => fetch(endpoint + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function request(owner, action, value) {
    const challenge = await (await post('/v1/challenge', { publicKey: owner.publicKey, action })).json(), payload = JSON.stringify(value), path = `/v1/${action}`;
    const response = await post(path, { publicKey: owner.publicKey, challenge: challenge.challenge, payload, signature: owner.sign(requestBytes(path, challenge.challenge, payload)) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await post('/v1/push-register', {})).status, 400);
  assert.equal((await request(a, 'push-config', {})).body.enabled, true);
  const s = subscription(); assert.equal((await request(a, 'push-register', { subscription: s })).body.registered, true);
  await request(b, 'push-unregister', {});
  const unsigned = { version: 1, id: randomBytes(16).toString('hex'), sender: b.publicKey, recipient: a.publicKey, createdAt: Date.now(), expiresAt: Date.now() + 60000, ciphertext: Buffer.from('opaque packet fixture').toString('base64') };
  const envelope = { ...unsigned, signature: b.sign(envelopeBytes(unsigned)) };
  assert.equal((await request(b, 'publish', { envelope })).status, 403);
  assert.equal((await request(a, 'receive', { limit: 1 })).body.envelopes.length, 0);
  assert.equal((await request(a, 'admission-set', { peers: [b.publicKey], revision: 1 })).status, 200);
  assert.equal((await request(b, 'publish', { envelope })).status, 200);
  const timeout = setTimeout(() => wake(null), 5000);
  assert.deepEqual(await woke, s); clearTimeout(timeout);
  assert.equal((await request(a, 'receive', { limit: 1 })).body.envelopes.length, 1, 'push never consumes ciphertext');
  assert.equal((await request(a, 'push-unregister', {})).body.removed, true);
});
