import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { Messenger, decodeMessaging, MLS_ROTATION_INTERVAL, MLS_ROTATION_MESSAGES } from '../src/messaging/messenger.ts';
import { MailboxClient, MailboxAdmissionError, envelopeBytes, validateMailEnvelope } from '../src/messaging/mailboxClient.ts';
import { sessionEpoch, encryptMessage } from '../src/messaging/mlsEngine.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
import { VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
import { createRelay } from '../../relay/server.mjs';

const secureRandom = async length => new Uint8Array(randomBytes(length));
const ttl = 7 * 24 * 60 * 60 * 1000;
function peer() {
  const seed = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(seed));
  return { publicKey, signer: { publicKey, sign: bytes => bytesToHex(ed25519.sign(bytes, seed)) } };
}
function memoryPort(owner, contacts, saved = null) {
  let serialized = saved, queue = Promise.resolve(), failWrite = null, locked = false;
  const port = {
    transact(task) {
      const work = queue.then(async () => {
        if (locked) throw new Error('Vault locked');
        const signer = { publicKey: owner.publicKey, sign: bytes => {
          if (locked) throw new Error('Vault locked');
          return owner.signer.sign(bytes);
        } };
        const next = await task(serialized, signer, contacts);
        if (locked) throw new Error('Vault locked');
        if (next.state !== serialized) {
          if (failWrite?.(next.state, serialized)) { failWrite = null; throw new Error('Storage write failed'); }
          serialized = next.state;
        }
        return next.result;
      });
      queue = work.catch(() => {}); return work;
    },
    read: () => serialized,
    failNext: predicate => { failWrite = predicate; },
    lock: () => { locked = true; },
    setContacts: next => { contacts = next; },
  };
  return port;
}
const messenger = (port, fetcher = fetch, now = Date.now, random = secureRandom) => new Messenger(port, random, now, fetcher, ensureMessagingCrypto);
async function relayFixture(t, now = Date.now, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'common-messaging-'));
  const relay = await createRelay({ dataDir, now, rateLimits: { requestsPerMinute: 10000, globalRequestsPerMinute: 10000 }, ...options });
  await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await relay.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { endpoint: `http://127.0.0.1:${relay.server.address().port}`, snapshot: async () => JSON.parse(await readFile(join(dataDir, 'mailbox-v1.json'), 'utf8')) };
}
async function pair(t, fetchA = fetch, fetchB = fetch, now = Date.now) {
  const relay = await relayFixture(t, now), a = peer(), b = peer();
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Friend B' }]);
  const portB = memoryPort(b, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const alice = messenger(portA, fetchA, now), bob = messenger(portB, fetchB, now);
  await bob.connect(relay.endpoint); await alice.connect(relay.endpoint);
  return { ...relay, a, b, portA, portB, alice, bob };
}
const wire = envelope => JSON.parse(new TextDecoder().decode(base64.decode(envelope.ciphertext)));
const histories = async (client, peerKey) => (await client.view()).conversations[peerKey]?.messages ?? [];
const deliver = async (client, ...args) => { await client.send(...args); await client.sync(); };


const conversation = (port, key) => decodeMessaging(port.read()).conversations[key];
async function establish(t, fetchA = fetch, fetchB = fetch) {
  let clock = Date.now();
  const now = () => clock;
  const f = await pair(t, fetchA, fetchB, now);
  await deliver(f.alice, f.b.publicKey, 'Before rotation');
  await f.bob.sync(); await f.alice.sync();
  return { ...f, now, advance: milliseconds => { clock += milliseconds; } };
}
async function finishCycle(f, alice = f.alice, bob = f.bob) {
  for (let index = 0; index < 6; index++) {
    await alice.sync(); await bob.sync();
    const a = (await alice.view()).conversations[f.b.publicKey], b = (await bob.view()).conversations[f.a.publicKey];
    if (a.security === 'ready' && b.security === 'ready' && a.messages.every(message => !message.mine || message.status === 'delivered')) break;
  }
}

test('durable two-member rotation completes before queued user text and survives reversed control delivery', async t => {
  const reverse = async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith('/v1/receive')) return response;
    const body = await response.json(); body.envelopes.reverse();
    return new Response(JSON.stringify(body), { status: response.status });
  };
  const f = await establish(t, reverse, reverse);
  f.advance(MLS_ROTATION_INTERVAL + 1);
  await f.alice.sync();
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 2);
  assert.ok(conversation(f.portA, f.b.publicKey).rotation.pending);
  await f.alice.send(f.b.publicKey, 'Held until refreshed');
  await f.alice.sync();
  assert.equal(decodeMessaging(f.portA.read()).pending.length, 1);
  await finishCycle(f);
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 3);
  assert.equal(sessionEpoch(conversation(f.portB, f.a.publicKey).state), 3);
  assert.equal(conversation(f.portA, f.b.publicKey).rotation.cycle, false);
  assert.equal(conversation(f.portB, f.a.publicKey).rotation.cycle, false);
  assert.equal((await histories(f.bob, f.a.publicKey)).filter(row => row.content === 'Held until refreshed').length, 1);
  assert.equal((await histories(f.alice, f.b.publicKey)).at(-1).status, 'delivered');
});

test('a failed commit write never publishes; lost publish responses retry identical commit after restart', async t => {
  let lose = false, commits = [];
  const flaky = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/publish')) {
      const envelope = JSON.parse(JSON.parse(init.body).payload).envelope;
      if (wire(envelope).type === 'epoch') {
        commits.push(envelope);
        if (lose) { lose = false; throw new Error('Commit response lost'); }
      }
    }
    return response;
  };
  const f = await establish(t, flaky);
  f.advance(MLS_ROTATION_INTERVAL + 1);
  f.portA.failNext(next => !!decodeMessaging(next).conversations[f.b.publicKey].rotation.pending);
  await assert.rejects(f.alice.sync(), /Storage write failed/);
  assert.equal(commits.length, 0);
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 1);
  lose = true;
  await assert.rejects(f.alice.sync(), /Commit response lost/);
  const saved = f.portA.read(), first = commits[0];
  assert.ok(conversation(f.portA, f.b.publicKey).rotation.pending);
  const newPort = memoryPort(f.a, [{ publicKey: f.b.publicKey, name: 'B' }], saved);
  const restarted = messenger(newPort, flaky, f.now);
  await restarted.sync();
  assert.deepEqual(commits[1], first);
  await finishCycle(f, restarted);
  assert.equal(sessionEpoch(conversation(newPort, f.b.publicKey).state), 3);
  assert.equal(conversation(newPort, f.b.publicKey).rotation.pending, undefined);
});

test('expired unacknowledged update fails closed without deleting history or reverting the epoch', async t => {
  const f = await establish(t);
  f.advance(MLS_ROTATION_INTERVAL + 1);
  await f.alice.sync();
  const pending = conversation(f.portA, f.b.publicKey).rotation.pending;
  f.advance(ttl + 1);
  await f.alice.send(f.b.publicKey, 'Keep queued after expiry');
  await assert.rejects(f.alice.sync(), /key update expired/);
  const current = conversation(f.portA, f.b.publicKey);
  assert.equal(sessionEpoch(current.state), 2);
  assert.equal(current.rotation.pending.commitId, pending.commitId);
  assert.equal(current.rotation.failed, true);
  assert.equal(current.messages[0].content, 'Before rotation');
  assert.equal(current.messages[1].status, 'queued');
  assert.equal((await f.alice.view()).conversations[f.b.publicKey].security, 'blocked');
  await f.alice.reconnect(f.b.publicKey);
  assert.equal(conversation(f.portA, f.b.publicKey).rotation, undefined);
  assert.equal(conversation(f.portA, f.b.publicKey).messages[0].content, 'Before rotation');
});


test('failed received-update persistence emits no ACK and restarts from the prior authenticated epoch', async t => {
  let controls = 0;
  const observe = async (url, init) => {
    if (String(url).endsWith('/v1/publish')) {
      const envelope = JSON.parse(JSON.parse(init.body).payload).envelope;
      if (wire(envelope).type === 'epoch-ack') controls += 1;
    }
    return fetch(url, init);
  };
  const f = await establish(t, fetch, observe);
  f.advance(MLS_ROTATION_INTERVAL + 1);
  await f.alice.sync();
  f.portB.failNext(next => decodeMessaging(next).conversations[f.a.publicKey].rotation.received.length > 0);
  await assert.rejects(f.bob.sync(), /Storage write failed/);
  assert.equal(controls, 0);
  assert.equal(sessionEpoch(conversation(f.portB, f.a.publicKey).state), 1);
  await f.bob.sync();
  assert.ok(controls > 0);
  await finishCycle(f);
  assert.equal(sessionEpoch(conversation(f.portB, f.a.publicKey).state), 3);
});

test('an authentic old-epoch ACK cannot confirm a fresh epoch even with the correct commit hash', async t => {
  const f = await establish(t);
  const oldBobState = conversation(f.portB, f.a.publicKey).state;
  f.advance(MLS_ROTATION_INTERVAL + 1);
  await f.alice.sync();
  const pending = conversation(f.portA, f.b.publicKey).rotation.pending;
  const encrypted = await encryptMessage(oldBobState, new TextEncoder().encode(JSON.stringify({
    version: 1, type: 'epoch-ack', epoch: pending.epoch, commitId: pending.commitId,
  })));
  const value = { version: 1, id: bytesToHex(randomBytes(16)), sender: f.b.publicKey, recipient: f.a.publicKey,
    createdAt: f.now(), expiresAt: f.now() + ttl,
    ciphertext: base64.encode(new TextEncoder().encode(JSON.stringify({ type: 'epoch-ack',
      groupId: conversation(f.portA, f.b.publicKey).groupId, body: encrypted.ciphertext }))) };
  const envelope = { ...value, signature: f.b.signer.sign(envelopeBytes(value)) };
  await new MailboxClient(f.endpoint, fetch, f.now).publish(envelope, f.b.signer);
  await assert.rejects(f.alice.sync(), /unrelated key-update acknowledgement/);
  assert.equal(conversation(f.portA, f.b.publicKey).rotation.pending.commitId, pending.commitId);
  assert.equal(conversation(f.portA, f.b.publicKey).rotation.cycle, true);
});

test('the non-initiating member requests a refresh without waiting for the other phone clock or chat counter', async t => {
  const f = await establish(t);
  f.advance(MLS_ROTATION_INTERVAL - 1000);
  const slightlyAheadBob = messenger(f.portB, fetch, () => f.now() + 2000);
  await slightlyAheadBob.sync();
  assert.ok(conversation(f.portB, f.a.publicKey).rotation.request);
  assert.equal(sessionEpoch(conversation(f.portB, f.a.publicKey).state), 1);
  await finishCycle(f, f.alice, slightlyAheadBob);
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 3);
  assert.equal(conversation(f.portB, f.a.publicKey).rotation.request, undefined);
});


test('64 real chat messages trigger a complete fresh-key cycle before the next queued message', async t => {
  const f = await establish(t);
  for (let index = 1; index < MLS_ROTATION_MESSAGES; index++) {
    await f.alice.send(f.b.publicKey, `Threshold message ${index}`);
  }
  await f.alice.sync();
  assert.equal(conversation(f.portA, f.b.publicKey).rotation.messages, MLS_ROTATION_MESSAGES);
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 1);
  // The mailbox delivers at most 50 packets per poll.
  await f.bob.sync(); await f.bob.sync();
  await f.alice.send(f.b.publicKey, 'After 64 messages');
  await f.alice.sync();
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 2);
  assert.equal(decodeMessaging(f.portA.read()).pending.length, 1);
  await finishCycle(f);
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 3);
  assert.equal(sessionEpoch(conversation(f.portB, f.a.publicKey).state), 3);
  assert.equal((await histories(f.bob, f.a.publicKey)).length, MLS_ROTATION_MESSAGES + 1);
  assert.equal((await histories(f.alice, f.b.publicKey)).at(-1).status, 'delivered');
});

test('direct call signaling cannot bypass the 24-hour key-renewal deadline', async t => {
  const f = await establish(t);
  f.advance(MLS_ROTATION_INTERVAL + 1);
  const signal = { version: 1, callId: 'c'.repeat(32), createdAt: f.now(), type: 'invite', mode: 'voice' };
  await assert.rejects(f.alice.sendCall(f.b.publicKey, signal), /keys are updating/);
  assert.ok(conversation(f.portA, f.b.publicKey).rotation.pending);
  assert.equal(sessionEpoch(conversation(f.portA, f.b.publicKey).state), 2);
  const disk = await f.snapshot();
  assert.ok(disk.envelopes.some(row => row.envelope && wire(row.envelope).type === 'epoch'));
  assert.equal(disk.envelopes.filter(row => row.envelope && wire(row.envelope).type === 'application').length, 0);
  await finishCycle(f);
  let received;
  f.bob.subscribeCalls((_peer, value) => { received = value; });
  await f.alice.sendCall(f.b.publicKey, signal);
  await f.bob.sync();
  assert.deepEqual(received, signal);
});
