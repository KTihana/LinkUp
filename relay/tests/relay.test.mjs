// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRelay, readConfiguration } from '../server.mjs';
import { requestBytes, envelopeBytes, packageBytes, MAX_TTL_MS } from '../protocol.mjs';

function identity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };
}
function envelope(sender, recipient, now, changes = {}) {
  const value = { version: 1, id: randomBytes(16).toString('hex'), sender: sender.publicKey, recipient: recipient.publicKey, createdAt: now, expiresAt: now + 60_000, ciphertext: Buffer.from('opaque test protocol ciphertext').toString('base64'), ...changes };
  value.signature = sign(null, envelopeBytes(value), sender.privateKey).toString('hex'); return value;
}
function keyPackage(owner, now, changes = {}) {
  const value = { id: randomBytes(16).toString('hex'), owner: owner.publicKey, createdAt: now, expiresAt: now + 60_000, data: '{"publicPrekey":"opaque protocol public material"}', ...changes };
  value.signature = sign(null, packageBytes(value), owner.privateKey).toString('hex'); return value;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'common-relay-test-'));
  const state = { now: Date.now(), directory, relay: null, base: '' };
  state.start = async () => {
    state.relay = await createRelay({ dataDir: directory, now: () => state.now, ...options });
    state.relay.server.listen(0, '127.0.0.1'); await once(state.relay.server, 'listening');
    state.base = `http://127.0.0.1:${state.relay.server.address().port}`;
  };
  t.after(async () => { await state.relay?.close(); await rm(directory, { recursive: true, force: true }); });
  await state.start(); return state;
}
async function post(f, path, body, headers = {}) {
  const response = await fetch(f.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function signedBody(f, who, action, value) {
  const challenge = await post(f, '/v1/challenge', { publicKey: who.publicKey, action });
  assert.equal(challenge.status, 200);
  const payload = JSON.stringify(value);
  return { publicKey: who.publicKey, challenge: challenge.body.challenge, payload, signature: sign(null, requestBytes(`/v1/${action}`, challenge.body.challenge, payload), who.privateKey).toString('hex') };
}
async function send(f, who, action, value) { return post(f, `/v1/${action}`, await signedBody(f, who, action, value)); }
async function admit(f, owner, peers, revision = 1) {
  const result = await send(f, owner, 'admission-set', { peers: peers.map(peer => peer.publicKey).sort(), revision });
  assert.equal(result.status, 200); return result;
}

test('strangers cannot consume public packages or fill an unconfigured recipient mailbox', async t => {
  const f = await fixture(t), stranger = identity(), recipient = identity();
  const material = keyPackage(recipient, f.now), message = envelope(stranger, recipient, f.now);
  await send(f, recipient, 'keys-publish', { packages: [material] });
  const before = await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8');
  const claim = await send(f, stranger, 'keys-claim', { owner: recipient.publicKey });
  assert.equal(claim.status, 403); assert.equal(claim.body.error, 'recipient_not_accepting');
  const publish = await send(f, stranger, 'publish', { envelope: message });
  assert.equal(publish.status, 403); assert.equal(publish.body.error, 'recipient_not_accepting');
  assert.equal(await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8'), before);
  assert.deepEqual((await send(f, recipient, 'keys-status', {})).body.available, [material.id]);
  assert.deepEqual((await send(f, recipient, 'receive', { limit: 50 })).body.envelopes, []);
  await admit(f, recipient, [stranger]);
  assert.equal((await send(f, stranger, 'keys-claim', { owner: recipient.publicKey })).body.package.id, material.id);
  assert.equal((await send(f, stranger, 'publish', { envelope: message })).status, 200);
});

test('recipient revisions prevent delayed reauthorization; revocation survives restart and tombstones queued mail', async t => {
  const f = await fixture(t), sender = identity(), recipient = identity();
  await admit(f, recipient, [sender]);
  const message = envelope(sender, recipient, f.now);
  assert.equal((await send(f, sender, 'publish', { envelope: message })).status, 200);
  const delayed = await signedBody(f, recipient, 'admission-set', { peers: [sender.publicKey], revision: 1 });
  await admit(f, recipient, [], 2);
  assert.equal((await post(f, '/v1/admission-set', delayed)).status, 409);
  assert.equal((await send(f, recipient, 'admission-set', { peers: [sender.publicKey], revision: 2 })).status, 409);
  assert.equal((await send(f, sender, 'publish', { envelope: message })).status, 403, 'revocation applies before duplicate handling');
  assert.equal((await send(f, sender, 'keys-claim', { owner: recipient.publicKey })).status, 403);
  await f.relay.close(); await f.start();
  assert.equal((await send(f, sender, 'publish', { envelope: message })).status, 403);
  assert.deepEqual((await send(f, recipient, 'receive', { limit: 1 })).body.envelopes, []);
  await admit(f, recipient, [sender], 3);
  assert.deepEqual((await send(f, sender, 'publish', { envelope: message })).body, { accepted: true, duplicate: true });
  assert.deepEqual((await send(f, recipient, 'receive', { limit: 1 })).body.envelopes, [], 'reacceptance cannot resurrect revoked ciphertext');
  assert.equal((await send(f, sender, 'publish', { envelope: envelope(sender, recipient, f.now) })).status, 200);
});

test('only the recipient can change its allowlist and admission inputs are bounded and canonical', async t => {
  const f = await fixture(t), sender = identity(), recipient = identity(), stranger = identity();
  await admit(f, stranger, [sender]);
  assert.equal((await send(f, sender, 'publish', { envelope: envelope(sender, recipient, f.now) })).status, 403);
  const forged = await signedBody(f, stranger, 'admission-set', { peers: [sender.publicKey], revision: 1 });
  assert.equal((await post(f, '/v1/admission-set', { ...forged, publicKey: recipient.publicKey })).status, 401);
  const sorted = [sender.publicKey, stranger.publicKey].sort();
  for (const value of [
    { peers: [sender.publicKey], revision: 0 }, { peers: [sender.publicKey], revision: 1.5 },
    { peers: [sender.publicKey], revision: Number.MAX_SAFE_INTEGER + 1 },
    { peers: [recipient.publicKey], revision: 1 }, { peers: [sender.publicKey, sender.publicKey], revision: 1 },
    { peers: [...sorted].reverse(), revision: 1 }, { peers: ['not a key'], revision: 1 },
    { peers: null, revision: 1 }, { peers: Array(101).fill(sender.publicKey), revision: 1 },
    { peers: [], revision: 1, owner: recipient.publicKey },
  ]) assert.equal((await send(f, recipient, 'admission-set', value)).status, 400);
  assert.deepEqual((await admit(f, recipient, [sender])).body, { accepted: true, revision: 1 });
  assert.deepEqual((await admit(f, recipient, [sender])).body, { accepted: true, revision: 1 });
});

test('legacy snapshots migrate to default deny without reviving queued ciphertext or claimed packages', async t => {
  const f = await fixture(t), sender = identity(), recipient = identity();
  await admit(f, recipient, [sender]);
  const claimed = keyPackage(recipient, f.now), available = keyPackage(recipient, f.now);
  await send(f, recipient, 'keys-publish', { packages: [claimed, available] });
  await send(f, sender, 'keys-claim', { owner: recipient.publicKey });
  const message = envelope(sender, recipient, f.now);
  await send(f, sender, 'publish', { envelope: message });
  await f.relay.close();
  const path = join(f.directory, 'mailbox-v1.json'), legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.version = 1; delete legacy.admissions;
  await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
  await f.start();
  assert.equal((await send(f, sender, 'keys-claim', { owner: recipient.publicKey })).status, 403);
  assert.equal((await send(f, sender, 'publish', { envelope: message })).status, 403);
  assert.deepEqual((await send(f, recipient, 'receive', { limit: 50 })).body.envelopes, []);
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(migrated.version, 2); assert.deepEqual(migrated.admissions, []); assert.equal(migrated.envelopes[0].envelope, null);
  await admit(f, recipient, [sender]);
  assert.equal((await send(f, recipient, 'keys-publish', { packages: [claimed] })).body.added, 0);
  assert.equal((await send(f, sender, 'keys-claim', { owner: recipient.publicKey })).body.package.id, available.id);
  assert.equal((await send(f, sender, 'keys-claim', { owner: recipient.publicKey })).body.package, null);
  assert.deepEqual((await send(f, recipient, 'receive', { limit: 50 })).body.envelopes, []);
});

test('failed durable revocation is never acknowledged and admission owner storage is bounded', async t => {
  const f = await fixture(t, { limits: { admissionOwners: 1 } }), sender = identity(), recipient = identity();
  await admit(f, recipient, [sender]);
  assert.equal((await send(f, sender, 'admission-set', { peers: [], revision: 1 })).status, 429);
  const original = await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8'), moved = `${f.directory}.moved`;
  await rename(f.directory, moved);
  try {
    assert.equal((await send(f, recipient, 'admission-set', { peers: [], revision: 2 })).status, 503);
    assert.equal((await send(f, sender, 'publish', { envelope: envelope(sender, recipient, f.now) })).status, 503);
    assert.equal(await readFile(join(moved, 'mailbox-v1.json'), 'utf8'), original);
  } finally { await rename(moved, f.directory); }
  await f.relay.close(); await f.start();
  await admit(f, recipient, [], 2);
  assert.equal((await send(f, sender, 'publish', { envelope: envelope(sender, recipient, f.now) })).status, 403);
});

test('corrupt permission snapshots fail closed instead of resetting grants or their revisions', async t => {
  const f = await fixture(t), recipient = identity(), sender = identity();
  await admit(f, recipient, [sender], 2);
  await f.relay.close();
  const path = join(f.directory, 'mailbox-v1.json'), original = JSON.parse(await readFile(path, 'utf8'));
  for (const change of [
    state => { state.admissions[0].revision = 0; },
    state => { state.admissions[0].peers.push(sender.publicKey); },
    state => { state.admissions[0].peers = [recipient.publicKey]; },
    state => { state.admissions.push(structuredClone(state.admissions[0])); },
    state => { delete state.admissions; },
  ]) {
    const corrupted = structuredClone(original); change(corrupted);
    const serialized = JSON.stringify(corrupted); await writeFile(path, serialized, { mode: 0o600 });
    await assert.rejects(createRelay({ dataDir: f.directory }), /admission|shape/);
    assert.equal(await readFile(path, 'utf8'), serialized);
  }
});

test('real HTTP stores opaque messages while recipient is offline, across restart', async t => {
  const f = await fixture(t), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const message = envelope(alice, bob, f.now);
  assert.deepEqual((await send(f, alice, 'publish', { envelope: message })).body, { accepted: true, duplicate: false });
  const disk = await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8');
  assert.ok(disk.includes(message.ciphertext));
  assert.equal((await stat(join(f.directory, 'mailbox-v1.json'))).mode & 0o777, 0o600);
  await f.relay.close(); await f.start();
  const received = await send(f, bob, 'receive', { limit: 50 });
  assert.equal(received.status, 200); assert.deepEqual(received.body.envelopes, [message]);
  assert.deepEqual((await send(f, alice, 'receive', { limit: 50 })).body.envelopes, []);
});

test('only the recipient may acknowledge; repeated fetches and duplicate sends are safe', async t => {
  const f = await fixture(t), alice = identity(), bob = identity(), attacker = identity();
  await admit(f, bob, [alice]);
  const message = envelope(alice, bob, f.now);
  await send(f, alice, 'publish', { envelope: message });
  assert.equal((await send(f, attacker, 'ack', { messages: [{ sender: message.sender, id: message.id }] })).body.acknowledged, 0);
  assert.equal((await send(f, bob, 'receive', { limit: 1 })).body.envelopes.length, 1);
  assert.equal((await send(f, bob, 'receive', { limit: 1 })).body.envelopes.length, 1);
  assert.deepEqual((await send(f, alice, 'publish', { envelope: message })).body, { accepted: true, duplicate: true });
  assert.equal((await send(f, bob, 'ack', { messages: [{ sender: message.sender, id: message.id }] })).body.acknowledged, 1);
  await f.relay.close(); await f.start();
  assert.equal((await send(f, alice, 'publish', { envelope: message })).body.duplicate, true);
  assert.deepEqual((await send(f, bob, 'receive', { limit: 1 })).body.envelopes, []);
});

test('acknowledgement binds both sender and ID when two senders choose the same ID', async t => {
  const f = await fixture(t), alice = identity(), bob = identity(), charlie = identity();
  await admit(f, bob, [alice, charlie]);
  const first = envelope(alice, bob, f.now), second = envelope(charlie, bob, f.now, { id: first.id });
  await send(f, alice, 'publish', { envelope: first });
  await send(f, charlie, 'publish', { envelope: second });
  const ack = await send(f, bob, 'ack', { messages: [{ sender: first.sender, id: first.id }] });
  assert.equal(ack.body.acknowledged, 1);
  assert.deepEqual((await send(f, bob, 'receive', { limit: 50 })).body.envelopes, [second]);
  assert.equal((await send(f, bob, 'ack', { ids: [first.id] })).status, 400);
  assert.equal((await send(f, bob, 'ack', { messages: [{ sender: second.sender, id: second.id }, { sender: second.sender, id: second.id }] })).status, 400);
  assert.equal((await send(f, bob, 'ack', { messages: [{ sender: second.sender, id: '../../secret' }] })).status, 400);
});

test('request authentication binds key, endpoint, exact payload and one-use challenge', async t => {
  const f = await fixture(t), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const correct = await signedBody(f, alice, 'receive', { limit: 1 });
  assert.equal((await post(f, '/v1/receive', correct)).status, 200);
  assert.equal((await post(f, '/v1/receive', correct)).status, 401);
  const tampered = await signedBody(f, alice, 'receive', { limit: 1 });
  assert.equal((await post(f, '/v1/receive', { ...tampered, payload: '{"limit":2}' })).status, 401);
  assert.equal((await post(f, '/v1/receive', tampered)).status, 401);
  const wrongKey = await signedBody(f, alice, 'receive', { limit: 1 });
  assert.equal((await post(f, '/v1/receive', { ...wrongKey, publicKey: bob.publicKey })).status, 401);
  const wrongAction = await signedBody(f, alice, 'receive', { limit: 1 });
  assert.equal((await post(f, '/v1/ack', wrongAction)).status, 401);
  const incorrectSignature = await signedBody(f, alice, 'receive', { limit: 1 });
  incorrectSignature.signature = sign(null, requestBytes('/v1/receive', incorrectSignature.challenge, incorrectSignature.payload), bob.privateKey).toString('hex');
  assert.equal((await post(f, '/v1/receive', incorrectSignature)).status, 401);
});

test('challenge expires and is not usable after server restart', async t => {
  const f = await fixture(t), alice = identity();
  const expired = await signedBody(f, alice, 'receive', { limit: 1 });
  f.now += 30_001;
  assert.equal((await post(f, '/v1/receive', expired)).status, 401);
  const old = await signedBody(f, alice, 'receive', { limit: 1 });
  await f.relay.close(); await f.start();
  assert.equal((await post(f, '/v1/receive', old)).status, 401);
});

test('sender signature cannot be forged, reassigned or reused for changed envelope content', async t => {
  const f = await fixture(t), alice = identity(), bob = identity(), attacker = identity();
  await admit(f, bob, [alice]);
  const message = envelope(alice, bob, f.now);
  assert.equal((await send(f, attacker, 'publish', { envelope: message })).status, 403);
  assert.equal((await send(f, alice, 'publish', { envelope: { ...message, ciphertext: Buffer.from('changed').toString('base64') } })).status, 401);
  const forged = { ...message, signature: sign(null, envelopeBytes(message), attacker.privateKey).toString('hex') };
  assert.equal((await send(f, alice, 'publish', { envelope: forged })).status, 401);
  await send(f, alice, 'publish', { envelope: message });
  const conflict = envelope(alice, bob, f.now, { id: message.id, ciphertext: Buffer.from('new encrypted bytes').toString('base64') });
  assert.equal((await send(f, alice, 'publish', { envelope: conflict })).status, 409);
  assert.deepEqual((await send(f, bob, 'receive', { limit: 1 })).body.envelopes, [message]);
});

test('expired envelopes and tombstones are pruned, and TTL is bounded', async t => {
  const f = await fixture(t), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const message = envelope(alice, bob, f.now, { expiresAt: f.now + 1000 });
  await send(f, alice, 'publish', { envelope: message }); f.now += 1001;
  assert.deepEqual((await send(f, bob, 'receive', { limit: 1 })).body.envelopes, []);
  assert.equal((await send(f, alice, 'publish', { envelope: message })).status, 400);
  const longLived = envelope(alice, bob, f.now, { expiresAt: f.now + MAX_TTL_MS + 1 });
  assert.equal((await send(f, alice, 'publish', { envelope: longLived })).status, 400);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8')).envelopes, []);
});

test('mailbox quotas refuse new data without damaging already durable messages', async t => {
  const f = await fixture(t, { limits: { pendingPerRecipient: 1, pendingPerSender: 1 } }), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const first = envelope(alice, bob, f.now), second = envelope(alice, bob, f.now);
  await send(f, alice, 'publish', { envelope: first });
  const before = await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8');
  assert.equal((await send(f, alice, 'publish', { envelope: second })).status, 429);
  assert.equal(await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8'), before);
  await send(f, bob, 'ack', { messages: [{ sender: first.sender, id: first.id }] });
  assert.equal((await send(f, alice, 'publish', { envelope: second })).status, 200);
});

test('store byte quota and bounded tombstone quota survive acknowledgement', async t => {
  const f = await fixture(t, { limits: { maxStoreBytes: 1500, maxRecords: 1 } }), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const tooLarge = envelope(alice, bob, f.now, { ciphertext: Buffer.alloc(1000, 7).toString('base64') });
  assert.equal((await send(f, alice, 'publish', { envelope: tooLarge })).status, 507);
  const first = envelope(alice, bob, f.now);
  assert.equal((await send(f, alice, 'publish', { envelope: first })).status, 200);
  await send(f, bob, 'ack', { messages: [{ sender: first.sender, id: first.id }] });
  assert.equal((await send(f, alice, 'publish', { envelope: envelope(alice, bob, f.now) })).status, 429);
  f.now += 60_001;
  assert.equal((await send(f, alice, 'publish', { envelope: envelope(alice, bob, f.now) })).status, 200);
});

test('ciphertext and public package size, encoding and shape checks fail closed', async t => {
  const f = await fixture(t), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  for (const ciphertext of ['a', 'YQ', 'YR==', 'AA-_', '', Buffer.alloc(65537).toString('base64')]) {
    assert.equal((await send(f, alice, 'publish', { envelope: envelope(alice, bob, f.now, { ciphertext }) })).status, 400);
  }
  assert.equal((await send(f, alice, 'receive', { limit: 51 })).status, 400);
  assert.equal((await send(f, alice, 'receive', { limit: 1, recipient: bob.publicKey })).status, 400);
  const badPackage = keyPackage(alice, f.now, { data: 'x'.repeat(16385) });
  assert.equal((await send(f, alice, 'keys-publish', { packages: [badPackage] })).status, 400);
});

test('signed public key packages persist while recipient is offline and are atomically claimed once', async t => {
  const f = await fixture(t), alice = identity(), bob = identity(), charlie = identity();
  await admit(f, bob, [alice, charlie]);
  const packageValue = keyPackage(bob, f.now);
  assert.deepEqual((await send(f, bob, 'keys-publish', { packages: [packageValue] })).body, { added: 1 });
  await f.relay.close(); await f.start();
  const requests = await Promise.all([signedBody(f, alice, 'keys-claim', { owner: bob.publicKey }), signedBody(f, charlie, 'keys-claim', { owner: bob.publicKey })]);
  const responses = await Promise.all(requests.map(body => post(f, '/v1/keys-claim', body)));
  assert.deepEqual(responses.map(value => value.body.package).filter(Boolean), [packageValue]);
  await f.relay.close(); await f.start();
  assert.equal((await send(f, alice, 'keys-claim', { owner: bob.publicKey })).body.package, null);
  assert.equal((await send(f, bob, 'keys-publish', { packages: [packageValue] })).body.added, 0);
  assert.equal((await send(f, alice, 'keys-claim', { owner: bob.publicKey })).body.package, null);
});

test('owner-authenticated key status isolates owners and follows durable claims across restart', async t => {
  const f = await fixture(t), alice = identity(), bob = identity(), third = identity();
  await admit(f, bob, [alice]);
  assert.deepEqual((await send(f, bob, 'keys-status', {})).body, { available: [] });
  const first = keyPackage(bob, f.now), second = keyPackage(bob, f.now), otherOwner = keyPackage(third, f.now);
  await send(f, bob, 'keys-publish', { packages: [first, second] });
  await send(f, third, 'keys-publish', { packages: [otherOwner] });
  assert.deepEqual((await send(f, bob, 'keys-status', {})).body, { available: [first.id, second.id] });
  assert.deepEqual((await send(f, third, 'keys-status', {})).body, { available: [otherOwner.id] });
  assert.deepEqual((await send(f, alice, 'keys-status', {})).body, { available: [] });
  assert.equal((await send(f, alice, 'keys-status', { owner: bob.publicKey })).status, 400);
  assert.equal((await send(f, bob, 'keys-status', { limit: 50 })).status, 400);
  const claimed = await send(f, alice, 'keys-claim', { owner: bob.publicKey });
  assert.equal(claimed.body.package.id, first.id);
  await f.relay.close(); await f.start();
  const status = await send(f, bob, 'keys-status', {});
  assert.equal(status.status, 200); assert.deepEqual(status.body, { available: [second.id] });
  assert.equal(JSON.stringify(status.body).includes(first.data), false);
  const forged = await signedBody(f, alice, 'keys-status', {});
  assert.equal((await post(f, '/v1/keys-status', { ...forged, publicKey: bob.publicKey })).status, 401);
});

test('key status prunes expired packages and remains serialized with concurrent claims', async t => {
  const f = await fixture(t), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const packageValue = keyPackage(bob, f.now, { expiresAt: f.now + 1000 });
  await send(f, bob, 'keys-publish', { packages: [packageValue] });
  const [claimBody, statusBody] = await Promise.all([
    signedBody(f, alice, 'keys-claim', { owner: bob.publicKey }), signedBody(f, bob, 'keys-status', {}),
  ]);
  const [claim, status] = await Promise.all([
    post(f, '/v1/keys-claim', claimBody), post(f, '/v1/keys-status', statusBody),
  ]);
  assert.equal(claim.body.package.id, packageValue.id);
  assert.ok(JSON.stringify(status.body) === JSON.stringify({ available: [] }) || JSON.stringify(status.body) === JSON.stringify({ available: [packageValue.id] }));
  assert.deepEqual((await send(f, bob, 'keys-status', {})).body, { available: [] });
  const expiring = keyPackage(bob, f.now, { expiresAt: f.now + 1000 });
  await send(f, bob, 'keys-publish', { packages: [expiring] });
  f.now += 1001;
  assert.deepEqual((await send(f, bob, 'keys-status', {})).body, { available: [] });
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8')).packages, []);
});

test('only a package owner may retire its public material, durably and without resurrection', async t => {
  const f = await fixture(t), owner = identity(), friend = identity(), other = identity();
  await admit(f, owner, [friend]);
  const legacy = keyPackage(owner, f.now), current = keyPackage(owner, f.now), separate = keyPackage(other, f.now, { id: legacy.id });
  await send(f, owner, 'keys-publish', { packages: [legacy, current] });
  await send(f, other, 'keys-publish', { packages: [separate] });
  assert.deepEqual((await send(f, friend, 'keys-retire', { ids: [legacy.id] })).body, { retired: 0 });
  assert.deepEqual((await send(f, owner, 'keys-status', {})).body.available, [legacy.id, current.id]);
  assert.deepEqual((await send(f, owner, 'keys-retire', { ids: [legacy.id] })).body, { retired: 1 });
  assert.deepEqual((await send(f, owner, 'keys-retire', { ids: [legacy.id] })).body, { retired: 0 });
  assert.deepEqual((await send(f, other, 'keys-status', {})).body.available, [legacy.id]);
  await f.relay.close(); await f.start();
  assert.deepEqual((await send(f, owner, 'keys-publish', { packages: [legacy] })).body, { added: 0 });
  assert.equal((await send(f, friend, 'keys-claim', { owner: owner.publicKey })).body.package.id, current.id);
  assert.equal((await send(f, friend, 'keys-claim', { owner: owner.publicKey })).body.package, null);
  for (const ids of [[], ['bad'], [legacy.id, legacy.id], Array(101).fill(legacy.id)]) {
    assert.equal((await send(f, owner, 'keys-retire', { ids })).status, 400);
  }
  assert.equal((await send(f, friend, 'keys-retire', { ids: [legacy.id], owner: owner.publicKey })).status, 400);
});

test('key packages enforce owner signatures, domain separation, quotas and expiry', async t => {
  const f = await fixture(t, { limits: { packagesPerOwner: 1 } }), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const packageValue = keyPackage(bob, f.now, { expiresAt: f.now + 1000 });
  assert.equal((await send(f, alice, 'keys-publish', { packages: [packageValue] })).status, 403);
  assert.equal((await send(f, bob, 'keys-publish', { packages: [{ ...packageValue, data: 'changed' }] })).status, 401);
  const wrongSignature = { ...packageValue, signature: sign(null, packageBytes(packageValue), alice.privateKey).toString('hex') };
  assert.equal((await send(f, bob, 'keys-publish', { packages: [wrongSignature] })).status, 401);
  await send(f, bob, 'keys-publish', { packages: [packageValue] });
  assert.equal((await send(f, bob, 'keys-claim', { owner: bob.publicKey })).status, 403);
  assert.equal((await send(f, bob, 'keys-publish', { packages: [keyPackage(bob, f.now)] })).status, 429);
  const conflict = keyPackage(bob, f.now, { id: packageValue.id, data: 'new material' });
  assert.equal((await send(f, bob, 'keys-publish', { packages: [conflict] })).status, 409);
  f.now += 1001;
  assert.equal((await send(f, alice, 'keys-claim', { owner: bob.publicKey })).body.package, null);
  assert.equal((await send(f, bob, 'keys-publish', { packages: [packageValue] })).status, 400);
});

test('failed durable key-package claim returns failure and leaves the package available after restart', async t => {
  const f = await fixture(t), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const packageValue = keyPackage(bob, f.now);
  await send(f, bob, 'keys-publish', { packages: [packageValue] });
  const original = await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8');
  const moved = `${f.directory}.moved`;
  await rename(f.directory, moved);
  try {
    assert.equal((await send(f, alice, 'keys-claim', { owner: bob.publicKey })).status, 503);
    assert.equal((await fetch(f.base + '/health')).status, 503);
    assert.equal(await readFile(join(moved, 'mailbox-v1.json'), 'utf8'), original);
  } finally { await rename(moved, f.directory); }
  await f.relay.close(); await f.start();
  assert.deepEqual((await send(f, alice, 'keys-claim', { owner: bob.publicKey })).body.package, packageValue);
});

test('origins are exact, only JSON is accepted, and URL paths never become storage paths', async t => {
  const f = await fixture(t), alice = identity();
  const allowed = await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' }, { origin: 'http://127.0.0.1:8081' });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8081');
  assert.equal((await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' }, { origin: 'null' })).status, 403);
  assert.equal((await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' }, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await post(f, '/v1/receive?recipient=../../private', {})).status, 404);
  const tooLarge = await post(f, '/v1/challenge', { padding: 'a'.repeat(300_000) });
  assert.equal(tooLarge.status, 413);
  const preflight = await fetch(f.base + '/v1/receive', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8081', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal((await fetch(f.base + '/health')).status, 200);
});

test('challenge memory and unauthenticated request rates are bounded', async t => {
  const f = await fixture(t, { maxChallenges: 1 }), alice = identity();
  const first = await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' });
  assert.equal(first.status, 200);
  assert.equal((await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' })).status, 429);
  f.now += 30_001;
  assert.equal((await post(f, '/v1/challenge', { publicKey: alice.publicKey, action: 'receive' })).status, 200);
  const limited = await fixture(t, { rateLimits: { requestsPerMinute: 1 } });
  assert.equal((await fetch(limited.base + '/health')).status, 200);
  assert.equal((await fetch(limited.base + '/health')).status, 429);
});

test('unsigned challenge requests cannot reserve another identity’s per-key capacity', async t => {
  const f = await fixture(t), victim = identity();
  // Knowing a public invitation key must not let a stranger exhaust a tiny
  // identity-specific bucket before the real owner has authenticated.
  for (let index = 0; index < 8; index++) {
    assert.equal((await post(f, '/v1/challenge', { publicKey: victim.publicKey, action: 'receive' })).status, 200);
  }
  const response = await send(f, victim, 'receive', { limit: 1 });
  assert.equal(response.status, 200); assert.deepEqual(response.body.envelopes, []);
});

test('one writer per data directory, corrupt snapshots fail closed, public binding is explicit', async t => {
  const f = await fixture(t);
  await assert.rejects(createRelay({ dataDir: f.directory }), /writer.lock/);
  await f.relay.close();
  await writeFile(join(f.directory, 'mailbox-v1.json'), '{broken', { mode: 0o600 });
  await assert.rejects(createRelay({ dataDir: f.directory }), /JSON/);
  assert.equal(await readFile(join(f.directory, 'mailbox-v1.json'), 'utf8'), '{broken');
  assert.equal(readConfiguration({}).host, '127.0.0.1');
  assert.throws(() => readConfiguration({ HOST: '0.0.0.0' }), /ALLOW_PUBLIC_BIND/);
  assert.equal(readConfiguration({ HOST: '0.0.0.0', ALLOW_PUBLIC_BIND: 'true' }).host, '0.0.0.0');
  assert.throws(() => readConfiguration({ PORT: '0' }), /PORT/);
  assert.throws(() => readConfiguration({ ALLOWED_ORIGINS: '*' }), /exact/);
});

test('authenticated wait wakes only the recipient and does not consume queued mail', async t => {
  const f = await fixture(t, { waitMs: 3000 }), alice = identity(), bob = identity(), outsider = identity();
  await admit(f, bob, [alice]);
  const waitingBob = send(f, bob, 'wait', {});
  const waitingOutsider = send(f, outsider, 'wait', {});
  const message = envelope(alice, bob, f.now);
  await send(f, alice, 'publish', { envelope: message });
  assert.deepEqual((await waitingBob).body, { ready: true });
  assert.equal((await send(f, bob, 'receive', { limit: 1 })).body.envelopes.length, 1);
  assert.deepEqual((await waitingOutsider).body, { ready: false });
});

test('waiting clients release short-request capacity and are closed during server shutdown', async t => {
  const f = await fixture(t, { maxActiveRequests: 1, waitMs: 3000 }), alice = identity(), bob = identity();
  await admit(f, bob, [alice]);
  const body = await signedBody(f, bob, 'wait', {});
  // Send the initial authenticated wait before probing its owner quota. Racing
  // both challenge requests could reject the initial wait at the one-request
  // limit, leaving the probe itself waiting until timeout.
  const arrived = new Promise(resolve => f.relay.server.once('request', request => request.once('end', () => setImmediate(resolve))));
  const waiting = post(f, '/v1/wait', body);
  await arrived;
  const duplicate = await send(f, bob, 'wait', {});
  assert.equal(duplicate.status, 429);
  assert.equal(duplicate.body.error, 'wait_quota');
  assert.equal((await send(f, alice, 'keys-status', {})).status, 200);
  await f.relay.close();
  assert.deepEqual((await waiting).body, { ready: false });
});

test('call relay credentials require authentication, expire, and never contain the long-term shared secret', async t => {
  const secret = randomBytes(32).toString('hex');
  const f = await fixture(t, { calls: { urls: ['turn:relay.example.org:3478?transport=udp'], secret } });
  const alice = identity();
  assert.equal((await post(f, '/v1/call-config', {})).status, 400);
  const result = await send(f, alice, 'call-config', {});
  assert.equal(result.status, 200); assert.ok(result.body.expiresAt > f.now && result.body.expiresAt <= f.now + 600000);
  assert.equal(result.body.iceServers.length, 1);
  assert.equal(JSON.stringify(result.body).includes(secret), false);
  assert.equal(JSON.stringify(result.body).includes(alice.publicKey), false);
  assert.equal((await send(f, alice, 'call-config', {})).status, 429);
  f.now += 11000;
  assert.equal((await send(f, alice, 'call-config', {})).status, 200);
});
