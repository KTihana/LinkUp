import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { Messenger, decodeMessaging, encodeMessaging } from '../src/messaging/messenger.ts';
import { createPackage } from '../src/messaging/mlsEngine.ts';
import { MailboxClient, MailboxAdmissionError, envelopeBytes, packageBytes, validateMailEnvelope } from '../src/messaging/mailboxClient.ts';
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
async function pair(t, fetchA = fetch, fetchB = fetch) {
  const relay = await relayFixture(t), a = peer(), b = peer();
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Friend B' }]);
  const portB = memoryPort(b, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const alice = messenger(portA, fetchA), bob = messenger(portB, fetchB);
  await bob.connect(relay.endpoint); await alice.connect(relay.endpoint);
  return { ...relay, a, b, portA, portB, alice, bob };
}
const wire = envelope => JSON.parse(new TextDecoder().decode(base64.decode(envelope.ciphertext)));
const histories = async (client, peerKey) => (await client.view()).conversations[peerKey]?.messages ?? [];
const deliver = async (client, ...args) => { await client.send(...args); await client.sync(); };

test('two HTTP clients deliver a first message to an offline recipient, resume and exchange authenticated receipts', async t => {
  const fixture = await pair(t);
  await fixture.bob.disconnect();
  await deliver(fixture.alice, fixture.b.publicKey, 'Hello while you are offline 🌿');
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'stored');
  const disk = await fixture.snapshot();
  assert.equal(disk.envelopes.filter(row => row.envelope !== null).length, 2);
  assert.equal(JSON.stringify(disk).includes('Hello while you are offline'), false);

  const restartedPort = memoryPort(fixture.b, [{ publicKey: fixture.a.publicKey, name: 'Friend A' }], fixture.portB.read());
  const restartedBob = messenger(restartedPort);
  await restartedBob.connect(fixture.endpoint);
  assert.equal((await histories(restartedBob, fixture.a.publicKey))[0].content, 'Hello while you are offline 🌿');
  assert.equal(decodeMessaging(restartedPort.read()).packages.length, 10);
  await deliver(restartedBob, fixture.a.publicKey, 'cat-mint', 'sticker');
  await fixture.alice.sync();
  const aliceHistory = await histories(fixture.alice, fixture.b.publicKey);
  assert.equal(aliceHistory[0].status, 'delivered');
  assert.equal(aliceHistory[1].kind, 'sticker');
  assert.equal(aliceHistory[1].content, 'cat-mint');
  await restartedBob.sync();
  assert.equal((await histories(restartedBob, fixture.a.publicKey))[1].status, 'delivered');
  assert.equal((await fixture.alice.view()).queued, 0);
  assert.equal((await restartedBob.view()).queued, 0);
});

test('failed state persistence prevents publication; retry resumes the queued message safely', async t => {
  const fixture = await pair(t);
  fixture.portA.failNext(next => decodeMessaging(next).outbox.length > 0);
  await fixture.alice.send(fixture.b.publicKey, 'Save before send');
  await assert.rejects(fixture.alice.sync(), /Storage write failed/);
  assert.equal((await fixture.snapshot()).envelopes.length, 0);
  const queued = decodeMessaging(fixture.portA.read());
  assert.equal(queued.pending.length, 1);
  assert.equal(queued.conversations[fixture.b.publicKey].state, '');
  await fixture.alice.sync(); await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 1);
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'delivered');
});

test('uncertain publish is retried with the identical signed ciphertext and ID after restart', async t => {
  let loseResponse = true, published = [];
  const flaky = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/publish')) {
      const envelope = JSON.parse(JSON.parse(init.body).payload).envelope;
      if (wire(envelope).type === 'application') {
        published.push(envelope);
        if (loseResponse) { loseResponse = false; throw new Error('Response lost after storage'); }
      }
    }
    return response;
  };
  const fixture = await pair(t, flaky);
  await fixture.alice.send(fixture.b.publicKey, 'Retry exact bytes');
  await assert.rejects(fixture.alice.sync(), /Response lost/);
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'queued');
  const restarted = messenger(memoryPort(fixture.a, [{ publicKey: fixture.b.publicKey, name: 'Friend B' }], fixture.portA.read()), flaky);
  await restarted.sync();
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], published[0]);
  await fixture.bob.sync(); await restarted.sync();
  assert.equal((await histories(restarted, fixture.b.publicKey))[0].status, 'delivered');
});

test('a verified receipt clears an uncertain outbox even when retries report a busy mailbox', async t => {
  let applicationPublishes = 0;
  const misleading = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/publish')) {
      const envelope = JSON.parse(JSON.parse(init.body).payload).envelope;
      if (wire(envelope).type === 'application' && ++applicationPublishes >= 2) {
        // The server accepted it; the return path reports a busy response.
        return new Response(JSON.stringify({ error: 'mailbox_quota' }), { status: 429 });
      }
    }
    return response;
  };
  const fixture = await pair(t, misleading);
  await deliver(fixture.alice, fixture.b.publicKey, 'First confirmed publication');
  await fixture.alice.send(fixture.b.publicKey, 'Peer receipt resolves uncertain storage');
  await assert.rejects(fixture.alice.sync(), /full or busy/);
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[1].status, 'queued');
  await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[1].status, 'delivered');
  assert.equal((await fixture.alice.view()).queued, 0);
  assert.equal(decodeMessaging(fixture.portA.read()).outbox.length, 0);
});

test('acknowledgement failure replays envelopes without duplicating history or receipts', async t => {
  let failAck = true, receiptPublishes = 0;
  const flaky = async (url, init) => {
    if (String(url).endsWith('/v1/ack') && failAck) { failAck = false; throw new Error('Offline during acknowledgement'); }
    if (String(url).endsWith('/v1/publish')) receiptPublishes += 1;
    return fetch(url, init);
  };
  const fixture = await pair(t, fetch, flaky);
  await deliver(fixture.alice, fixture.b.publicKey, 'Only once');
  await assert.rejects(fixture.bob.sync(), /acknowledgement/);
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 1);
  await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 1);
  assert.equal(receiptPublishes, 1);
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'delivered');
});

test('an application arriving before its Welcome waits and then decrypts without being lost', async t => {
  let reorder = true;
  const reversed = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/receive') && reorder) {
      const result = await response.json();
      if (result.envelopes.length >= 2) { result.envelopes.reverse(); reorder = false; }
      return new Response(JSON.stringify(result), { status: 200 });
    }
    return response;
  };
  const fixture = await pair(t, fetch, reversed);
  await deliver(fixture.alice, fixture.b.publicKey, 'Welcome may arrive later');
  await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey))[0].content, 'Welcome may arrive later');
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'delivered');
});

test('tampered signed mail and wrong-recipient mail fail before entering a conversation', async t => {
  let mutation = null;
  const hostile = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/receive') && mutation) {
      const result = await response.json();
      if (result.envelopes.length) mutation(result.envelopes[0]);
      return new Response(JSON.stringify(result), { status: 200 });
    }
    return response;
  };
  const fixture = await pair(t, fetch, hostile);
  await deliver(fixture.alice, fixture.b.publicKey, 'Verified before display');
  mutation = envelope => { envelope.signature = (envelope.signature[0] === '0' ? '1' : '0') + envelope.signature.slice(1); };
  await assert.rejects(fixture.bob.sync(), /unverified/);
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 0);
  mutation = envelope => { envelope.recipient = fixture.a.publicKey; };
  await assert.rejects(fixture.bob.sync(), /envelope/);
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 0);
  mutation = null;
  await fixture.bob.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 1);
});

test('strangers are rejected by the relay and a hostile relay cannot silently create friends', async t => {
  let injected = null; const acknowledgements = [];
  const hostile = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/v1/ack')) acknowledgements.push(...JSON.parse(JSON.parse(init.body).payload).messages);
    if (String(url).endsWith('/v1/receive') && injected) {
      const result = await response.json(); result.envelopes.push(injected); injected = null;
      return Response.json(result);
    }
    return response;
  };
  const fixture = await pair(t, fetch, hostile), outsider = peer(), now = Date.now();
  const value = { version: 1, id: bytesToHex(randomBytes(16)), sender: outsider.publicKey, recipient: fixture.b.publicKey,
    createdAt: now, expiresAt: now + ttl, ciphertext: base64.encode(new TextEncoder().encode('Untrusted protocol bytes')) };
  const envelope = { ...value, signature: outsider.signer.sign(envelopeBytes(value)) };
  await assert.rejects(new MailboxClient(fixture.endpoint).publish(envelope, outsider.signer), MailboxAdmissionError);
  injected = envelope;
  await fixture.bob.sync();
  assert.equal((await fixture.bob.view()).conversations[outsider.publicKey], undefined);
  assert.equal((await fixture.snapshot()).envelopes.find(row => row.sender === outsider.publicKey), undefined);
  assert.ok(acknowledgements.some(row => row.sender === outsider.publicKey && row.id === envelope.id));
});

test('duplicate IDs from different authenticated senders are independently accepted', async t => {
  const fixture = await pair(t), third = peer();
  await deliver(fixture.alice, fixture.b.publicKey, 'From A'); await fixture.bob.sync();
  const reusedId = (await histories(fixture.bob, fixture.a.publicKey))[0].id;
  const expandedPortB = memoryPort(fixture.b, [
    { publicKey: fixture.a.publicKey, name: 'Friend A' }, { publicKey: third.publicKey, name: 'Friend C' },
  ], fixture.portB.read());
  const expandedBob = messenger(expandedPortB);
  const thirdPort = memoryPort(third, [{ publicKey: fixture.b.publicKey, name: 'Friend B' }]);
  let nextID = null;
  const random = async length => {
    if (length === 16 && nextID) { const result = hexToBytes(nextID); nextID = null; return result; }
    return secureRandom(length);
  };
  const charlie = messenger(thirdPort, fetch, Date.now, random);
  await expandedBob.sync(); // Recipient grants the newly accepted friend's relay permission.
  await charlie.connect(fixture.endpoint); nextID = reusedId;
  await deliver(charlie, fixture.b.publicKey, 'From C'); await expandedBob.sync();
  assert.equal((await histories(expandedBob, third.publicKey))[0].id, reusedId);
  assert.equal((await histories(expandedBob, third.publicKey))[0].content, 'From C');
  assert.equal(decodeMessaging(expandedPortB.read()).seen.filter(row => row.id === reusedId).length, 2);
});

test('a friend without first-use keys does not block a ready friend or verified receipts', async t => {
  const relay = await relayFixture(t), a = peer(), offline = peer(), ready = peer();
  const portA = memoryPort(a, [
    { publicKey: offline.publicKey, name: 'Not connected yet' }, { publicKey: ready.publicKey, name: 'Ready friend' },
  ]);
  const portReady = memoryPort(ready, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const alice = messenger(portA), charlie = messenger(portReady);
  await charlie.connect(relay.endpoint); await alice.connect(relay.endpoint);
  await new MailboxClient(relay.endpoint).setAdmission([a.publicKey], 1, offline.signer);
  await alice.send(offline.publicKey, 'Waiting for first-use keys');
  await assert.rejects(alice.sync(), /connect once/);
  await alice.send(ready.publicKey, 'This friend can receive now');
  await assert.rejects(alice.sync(), /connect once/);
  assert.equal((await histories(alice, offline.publicKey))[0].status, 'queued');
  assert.equal((await histories(alice, ready.publicKey))[0].status, 'stored');
  await charlie.sync();
  await assert.rejects(alice.sync(), /connect once/);
  assert.equal((await histories(alice, ready.publicKey))[0].status, 'delivered');
  assert.equal((await alice.view()).queued, 1);
});

test('a missing recipient permission keeps that friend queued while another friend receives', async t => {
  const relay = await relayFixture(t), a = peer(), unconfirmed = peer(), ready = peer();
  const alice = messenger(memoryPort(a, [
    { publicKey: unconfirmed.publicKey, name: 'Has not accepted yet' }, { publicKey: ready.publicKey, name: 'Ready friend' },
  ]));
  const charlie = messenger(memoryPort(ready, [{ publicKey: a.publicKey, name: 'Friend A' }]));
  await charlie.connect(relay.endpoint); await alice.connect(relay.endpoint);
  await alice.send(unconfirmed.publicKey, 'Wait for consent'); await alice.send(ready.publicKey, 'Delivery continues');
  await assert.rejects(alice.sync(), /accept your invitation/);
  assert.equal((await histories(alice, unconfirmed.publicKey))[0].status, 'queued');
  assert.equal((await histories(alice, ready.publicKey))[0].status, 'stored');
  await charlie.sync(); await assert.rejects(alice.sync(), /accept your invitation/);
  assert.equal((await histories(alice, ready.publicKey))[0].status, 'delivered');
  assert.equal((await relay.snapshot()).envelopes.some(row => row.recipient === unconfirmed.publicKey), false);
});

test('a delayed background permission request cannot reauthorize a removed friend', { timeout: 120000 }, async t => {
  let hold = false, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const held = async (url, init) => {
    if (hold && String(url).endsWith('/v1/admission-set')) { entered(); await gate; }
    return fetch(url, init);
  };
  const fixture = await pair(t, fetch, held);
  await deliver(fixture.alice, fixture.b.publicKey, 'Pending before removal');
  hold = true;
  const stale = fixture.bob.sync();
  // Attach the rejection handler before allowing concurrent workers to run.
  const rejected = assert.rejects(stale, /409/);
  try {
    await waiting;
    fixture.portB.setContacts([]);
    const foreground = messenger(fixture.portB);
    await foreground.sync();
    const admission = (await fixture.snapshot()).admissions.find(row => row.owner === fixture.b.publicKey);
    assert.deepEqual(admission.peers, []); assert.equal(admission.revision, 2);
  } finally { release(); }
  await rejected;
  const disk = await fixture.snapshot();
  assert.deepEqual(disk.admissions.find(row => row.owner === fixture.b.publicKey).peers, []);
  assert.ok(disk.envelopes.filter(row => row.recipient === fixture.b.publicKey).every(row => row.envelope === null));
  await assert.rejects(new MailboxClient(fixture.endpoint).claim(fixture.b.publicKey, fixture.a.signer), MailboxAdmissionError);
});

test('a full recipient mailbox does not block receiving or another recipient', async t => {
  const relay = await relayFixture(t, Date.now, { limits: { pendingPerRecipient: 2 } });
  const a = peer(), b = peer(), c = peer();
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Friend B' }, { publicKey: c.publicKey, name: 'Friend C' }]);
  const portB = memoryPort(b, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const portC = memoryPort(c, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const alice = messenger(portA), bob = messenger(portB), charlie = messenger(portC);
  await bob.connect(relay.endpoint); await charlie.connect(relay.endpoint); await alice.connect(relay.endpoint);
  // The Welcome and first application fill B's mailbox. B stays offline.
  await deliver(alice, b.publicKey, 'First stored message');
  await alice.send(b.publicKey, 'Queued because B is full');
  await assert.rejects(alice.sync(), /full or busy/);
  assert.equal((await histories(alice, b.publicKey))[1].status, 'queued');
  await deliver(charlie, a.publicKey, 'Incoming still progresses');
  await assert.rejects(alice.sync(), /full or busy/);
  assert.equal((await histories(alice, c.publicKey))[0].content, 'Incoming still progresses');
  await charlie.sync();
  assert.equal((await histories(charlie, a.publicKey))[0].status, 'delivered');
  assert.equal((await histories(alice, b.publicKey))[1].status, 'queued');
  await bob.sync();
  await alice.sync(); await bob.sync(); await alice.sync();
  assert.equal((await histories(alice, b.publicKey))[1].status, 'delivered');
});

test('Pause during an outstanding challenge prevents the signed request and preserves queued data', async t => {
  let paused = false, waiting = null, ready = null, signedPublishes = 0;
  const waitEntered = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { waiting = resolve; });
  const held = async (url, init) => {
    const response = await fetch(url, init);
    if (paused && String(url).endsWith('/v1/challenge')) { ready(); await gate; }
    if (paused && String(url).endsWith('/v1/publish')) signedPublishes += 1;
    return response;
  };
  const fixture = await pair(t, held);
  paused = true;
  await fixture.alice.send(fixture.b.publicKey, 'Pause must revoke this request');
  const syncing = fixture.alice.sync();
  await waitEntered;
  const disconnecting = fixture.alice.disconnect(); waiting();
  await assert.rejects(syncing, /disconnected/); await disconnecting;
  assert.equal(signedPublishes, 0);
  assert.equal((await fixture.alice.view()).enabled, false);
  assert.equal((await fixture.alice.view()).queued, 1);
});

test('Send persists immediately while an earlier poll is awaiting its network challenge', async t => {
  let hold = false, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const held = async (url, init) => {
    const response = await fetch(url, init);
    if (hold && String(url).endsWith('/v1/challenge')) { hold = false; entered(); await gate; }
    return response;
  };
  const fixture = await pair(t, held);
  hold = true;
  const syncing = fixture.alice.sync(); await started;
  let timer;
  try {
    await Promise.race([
      fixture.alice.send(fixture.b.publicKey, 'Local queue does not wait for HTTP'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Send waited for the network')), 1500); timer.unref(); }),
    ]);
    assert.equal((await fixture.alice.view()).queued, 1);
  } finally { clearTimeout(timer); release(); }
  await syncing; await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'delivered');
});

test('session suspension cancels an active HTTP challenge without clearing encrypted delivery preferences', async t => {
  let held = false, entered, release, aborts = 0, publishes = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async (url, init) => {
    if (held && String(url).endsWith('/v1/publish')) publishes += 1;
    const response = await fetch(url, init);
    if (held && String(url).endsWith('/v1/challenge')) {
      init.signal.addEventListener('abort', () => { aborts += 1; }, { once: true });
      entered(); await gate;
    }
    return response;
  };
  const fixture = await pair(t, fetcher);
  await fixture.alice.send(fixture.b.publicKey, 'Stay queued after hiding Common');
  held = true;
  const syncing = fixture.alice.sync(), rejected = assert.rejects(syncing, /disconnected/);
  await started; fixture.alice.suspend(); release(); await rejected;
  assert.equal(aborts, 1); assert.equal(publishes, 0);
  assert.equal((await fixture.alice.view()).enabled, true);
  assert.equal((await fixture.alice.view()).queued, 1);
  held = false;
  await fixture.alice.sync();
  await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'delivered');
});

test('expiry preserves local history with an explicit error and removes unsendable jobs', async t => {
  let now = Date.now();
  const relay = await relayFixture(t, () => now), a = peer(), b = peer();
  const port = memoryPort(a, [{ publicKey: b.publicKey, name: 'Offline friend' }]);
  const client = messenger(port, async () => { throw new Error('Offline'); }, () => now);
  await assert.rejects(client.connect(relay.endpoint), /Offline/);
  await client.send(b.publicKey, 'Expires while offline');
  now += ttl + 1;
  await assert.rejects(client.sync(), /Offline/);
  const history = await histories(client, b.publicKey);
  assert.equal(history[0].error, 'Expired before delivery');
  assert.equal((await client.view()).queued, 0);
  assert.equal(decodeMessaging(port.read()).pending.length, 0);
});

test('reject oversized payloads, invalid saved records and messaging after lock', async t => {
  const fixture = await pair(t);
  await assert.rejects(fixture.alice.send(fixture.b.publicKey, 'x'.repeat(8192)), /8 KiB/);
  const beforeEscapedMessage = fixture.portA.read();
  await assert.rejects(fixture.alice.send(fixture.b.publicKey, '\0'.repeat(1600)), /8 KiB/);
  assert.equal(fixture.portA.read(), beforeEscapedMessage);
  await assert.rejects(fixture.alice.send(fixture.b.publicKey, 'https://example.com/sticker.svg', 'sticker'), /built-in/);
  assert.throws(() => decodeMessaging('{"version":1}'));
  assert.throws(() => decodeMessaging(' '.repeat(900001)), /large/);
  fixture.portA.lock();
  await assert.rejects(fixture.alice.sync(), /locked/);
});

test('ten lost authorized package claims retain private material and replenish usable first-use keys', async t => {
  const fixture = await pair(t);
  const mailbox = new MailboxClient(fixture.endpoint);
  const claimed = [];
  for (let index = 0; index < 10; index += 1) claimed.push((await mailbox.claim(fixture.b.publicKey, fixture.a.signer)).id);
  assert.equal((await mailbox.keyStatus(fixture.b.signer)).length, 0);
  await fixture.bob.sync();
  const saved = decodeMessaging(fixture.portB.read());
  assert.equal(saved.packages.length, 20);
  assert.ok(claimed.every(id => saved.packages.some(item => item.package.id === id)));
  assert.equal((await mailbox.keyStatus(fixture.b.signer)).length, 10);
  await deliver(fixture.alice, fixture.b.publicKey, 'Fresh key after lost claims');
  await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey))[0].content, 'Fresh key after lost claims');
  assert.equal((await histories(fixture.alice, fixture.b.publicKey))[0].status, 'delivered');
});

test('a full legacy public pool upgrades to fresh packages without deleting retained private material', async t => {
  const relay = await relayFixture(t), a = peer(), b = peer(), mailbox = new MailboxClient(relay.endpoint);
  await ensureMessagingCrypto();
  const saved = decodeMessaging(null); saved.endpoint = relay.endpoint; saved.enabled = true;
  for (let index = 0; index < 10; index++) {
    const material = await createPackage(`common:${b.publicKey}`);
    const publicData = JSON.stringify({ ...JSON.parse(material.publicData), version: 1 });
    const privateData = JSON.stringify({ ...JSON.parse(material.privateData), version: 1, publicData });
    const value = { id: bytesToHex(randomBytes(16)), owner: b.publicKey, createdAt: Date.now(), expiresAt: Date.now() + ttl, data: publicData };
    saved.packages.push({ package: { ...value, signature: b.signer.sign(packageBytes(value)) }, privateData, published: true });
  }
  const legacyIds = saved.packages.map(item => item.package.id);
  await mailbox.publishKeys(saved.packages.map(item => item.package), b.signer);
  const portB = memoryPort(b, [{ publicKey: a.publicKey, name: 'Friend A' }], encodeMessaging(saved)), bob = messenger(portB);
  await bob.connect(relay.endpoint);
  const upgraded = decodeMessaging(portB.read()), available = await mailbox.keyStatus(b.signer);
  assert.equal(available.length, 10); assert.ok(available.every(id => !legacyIds.includes(id)));
  assert.ok(upgraded.packages.filter(item => available.includes(item.package.id)).every(item => JSON.parse(item.package.data).version === 2));
  assert.ok(legacyIds.every(id => upgraded.packages.some(item => item.package.id === id && item.privateData.length > 0)));
  assert.ok((await relay.snapshot()).packages.filter(item => legacyIds.includes(item.id)).every(item => item.package === null));
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Friend B' }]), alice = messenger(portA);
  await alice.connect(relay.endpoint); await alice.reconnect(b.publicKey); await bob.reconnect(a.publicKey);
  await deliver(alice, b.publicKey, 'Fresh setup after upgrading'); await bob.sync(); await alice.sync();
  assert.equal(JSON.parse(decodeMessaging(portA.read()).conversations[b.publicKey].state).version, 2);
  assert.equal(JSON.parse(decodeMessaging(portB.read()).conversations[a.publicKey].state).version, 2);
  assert.equal((await histories(bob, a.publicKey))[0].content, 'Fresh setup after upgrading');
});

test('all unconfirmed packets use the first-use key deadline; explicit reconnect recovers after expiry', async t => {
  let now = Date.now();
  const relay = await relayFixture(t, () => now), a = peer(), b = peer();
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Friend B' }]);
  const portB = memoryPort(b, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const alice = messenger(portA, fetch, () => now), bob = messenger(portB, fetch, () => now);
  await bob.connect(relay.endpoint); await bob.disconnect(); await alice.connect(relay.endpoint);
  await deliver(alice, b.publicKey, 'First packet before confirmation');
  const deadline = decodeMessaging(portA.read()).conversations[b.publicKey].setupExpiresAt;
  now += 24 * 60 * 60 * 1000;
  await deliver(alice, b.publicKey, 'Another packet before confirmation');
  const awaiting = (await relay.snapshot()).envelopes.filter(row => row.sender === a.publicKey);
  assert.equal(awaiting.length, 3);
  assert.ok(awaiting.every(row => row.expiresAt <= deadline));
  now = deadline + 1;
  await assert.rejects(alice.sync(), /setup expired/);
  assert.ok((await histories(alice, b.publicKey)).every(message => message.error === 'Expired before delivery'));
  await alice.reconnect(b.publicKey); await bob.reconnect(a.publicKey);
  assert.equal((await histories(alice, b.publicKey)).length, 2);
  assert.ok((await histories(alice, b.publicKey)).every(message => message.error === 'Chat reconnected; send this message again'));
  await bob.connect(relay.endpoint);
  await deliver(alice, b.publicKey, 'A fresh conversation after recovery');
  await bob.sync(); await alice.sync();
  assert.equal((await histories(bob, a.publicKey))[0].content, 'A fresh conversation after recovery');
  assert.equal((await histories(alice, b.publicKey))[2].status, 'delivered');
  assert.equal(decodeMessaging(portA.read()).conversations[b.publicKey].setupExpiresAt, undefined);
});

test('mail already stored for a confirmed chat is explicitly marked expired after its delivery deadline', async t => {
  let now = Date.now();
  const relay = await relayFixture(t, () => now), a = peer(), b = peer();
  const portA = memoryPort(a, [{ publicKey: b.publicKey, name: 'Friend B' }]);
  const portB = memoryPort(b, [{ publicKey: a.publicKey, name: 'Friend A' }]);
  const alice = messenger(portA, fetch, () => now), bob = messenger(portB, fetch, () => now);
  await bob.connect(relay.endpoint); await alice.connect(relay.endpoint);
  await deliver(alice, b.publicKey, 'Establish and confirm'); await bob.sync(); await alice.sync();
  await bob.disconnect(); await deliver(alice, b.publicKey, 'Stored until deadline');
  assert.equal((await histories(alice, b.publicKey))[1].status, 'stored');
  now += ttl + 1;
  await alice.sync();
  const rows = await histories(alice, b.publicKey);
  assert.equal(rows[0].status, 'delivered');
  assert.equal(rows[0].error, undefined);
  assert.equal(rows[1].error, 'Expired before delivery');
  assert.equal((await alice.view()).queued, 0);
});

for (const order of ['alice-first', 'bob-first']) test(`simultaneous first messages converge without resetting or losing either message (${order})`, async t => {
  const fixture = await pair(t);
  const hideInbox = async (url, init) => String(url).endsWith('/v1/receive')
    ? new Response(JSON.stringify({ envelopes: [] }), { status: 200 }) : fetch(url, init);
  const competingBob = messenger(fixture.portB, hideInbox);
  await deliver(fixture.alice, fixture.b.publicKey, 'Alice starts first');
  await deliver(competingBob, fixture.a.publicKey, 'Bob also starts first');
  const normalBob = messenger(fixture.portB);
  const clients = order === 'alice-first' ? [fixture.alice, normalBob] : [normalBob, fixture.alice];
  for (let round = 0; round < 3; round += 1) for (const client of clients) await client.sync();
  for (const [client, peerKey] of [[fixture.alice, fixture.b.publicKey], [normalBob, fixture.a.publicKey]]) {
    const messages = await histories(client, peerKey);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map(m => m.content).sort(), ['Alice starts first', 'Bob also starts first']);
    assert.ok(messages.every(m => m.status === 'delivered' && !m.error));
  }
  assert.equal(decodeMessaging(fixture.portA.read()).conversations[fixture.b.publicKey].groupId,
    decodeMessaging(fixture.portB.read()).conversations[fixture.a.publicKey].groupId);
});

test('more than one poll of retired-group envelopes cannot hide a fresh Welcome after reconnect', async t => {
  const fixture = await pair(t);
  await deliver(fixture.alice, fixture.b.publicKey, 'Established conversation');
  await fixture.bob.sync(); await fixture.alice.sync();
  // Queue a backlog in the established group, without polling B.
  for (let index = 0; index < 51; index += 1) await fixture.alice.send(fixture.b.publicKey, `Retired backlog ${index}`);
  await fixture.alice.sync();
  const oldGroup = decodeMessaging(fixture.portA.read()).conversations[fixture.b.publicKey].groupId;
  await fixture.alice.reconnect(fixture.b.publicKey); await fixture.bob.reconnect(fixture.a.publicKey);
  assert.ok(decodeMessaging(fixture.portB.read()).conversations[fixture.a.publicKey].retiredGroups.some(item => item.groupId === oldGroup));
  await deliver(fixture.alice, fixture.b.publicKey, 'Fresh Welcome beyond the old backlog');
  await fixture.bob.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).length, 1);
  await fixture.bob.sync(); await fixture.alice.sync();
  assert.equal((await histories(fixture.bob, fixture.a.publicKey)).at(-1).content, 'Fresh Welcome beyond the old backlog');
  assert.equal((await histories(fixture.alice, fixture.b.publicKey)).at(-1).status, 'delivered');
});

async function encryptedVault(record = null, deviceKey = null) {
  const store = new Map(record ? [['vault', record]] : []);
  const dependencies = {
    store: { getItem: async key => store.get(key) ?? null, setItem: async (key, value) => { store.set(key, value); } },
    recordKey: 'vault', randomBytes: secureRandom, readDeviceKey: async () => deviceKey,
    saveDeviceKey: async value => { deviceKey = value; }, withWrite: async task => task(), now: Date.now,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
  };
  const controller = new VaultController(dependencies);
  await controller.start();
  if (!record) { await controller.beginSetup(); deviceKey = controller.getSnapshot().pendingKey; await controller.commitSetup(); }
  else await controller.unlock(deviceKey);
  return { controller, store, deviceKey: () => deviceKey };
}
test('real VaultController signers survive encrypted writes, offline delivery and a device-store restart', async t => {
  const relay = await relayFixture(t), a = await encryptedVault(), b = await encryptedVault();
  await a.controller.acceptInvite(await b.controller.createInvite());
  await b.controller.acceptInvite(await a.controller.createInvite());
  const publicA = a.controller.getSnapshot().identity.slice('common:'.length);
  const publicB = b.controller.getSnapshot().identity.slice('common:'.length);
  const alice = messenger({ transact: a.controller.transactMessaging });
  const bob = messenger({ transact: b.controller.transactMessaging });
  await bob.connect(relay.endpoint); await bob.disconnect();
  await alice.connect(relay.endpoint);
  await deliver(alice, publicB, 'Encrypted vault survives restart');
  assert.equal((await histories(alice, publicB))[0].status, 'stored');
  assert.equal(a.store.get('vault').includes('Encrypted vault survives restart'), false);
  const restarted = await encryptedVault(b.store.get('vault'), b.deviceKey());
  const resumedBob = messenger({ transact: restarted.controller.transactMessaging });
  await resumedBob.connect(relay.endpoint);
  assert.equal((await histories(resumedBob, publicA))[0].content, 'Encrypted vault survives restart');
  await deliver(resumedBob, publicA, 'A real encrypted reply'); await alice.sync(); await resumedBob.sync();
  assert.equal((await histories(alice, publicB))[0].status, 'delivered');
  assert.equal((await histories(resumedBob, publicA))[1].status, 'delivered');
  restarted.controller.lock();
  await assert.rejects(resumedBob.sync(), /locked|cancelled|Unlock/);
});

test('envelope authentication binds recipient and signed contents independently of the relay', () => {
  const a = peer(), b = peer(), now = Date.now();
  const unsigned = { version: 1, id: bytesToHex(randomBytes(16)), sender: a.publicKey, recipient: b.publicKey,
    createdAt: now, expiresAt: now + ttl, ciphertext: base64.encode(new Uint8Array([1, 2, 3])) };
  const envelope = { ...unsigned, signature: a.signer.sign(envelopeBytes(unsigned)) };
  validateMailEnvelope(envelope, b.publicKey, now);
  assert.throws(() => validateMailEnvelope(envelope, a.publicKey, now));
  assert.throws(() => validateMailEnvelope({ ...envelope, ciphertext: base64.encode(new Uint8Array([1, 2, 4])) }, b.publicKey, now));
});

test('call signaling travels inside MLS, commits before notification, and never appears as chat text', async t => {
  const f = await pair(t), received = [];
  f.bob.subscribeCalls((peer, signal) => {
    assert.ok(decodeMessaging(f.portB.read()).seen.length > 0);
    received.push({ peer, signal });
  });
  const signal = { version: 1, callId: 'a'.repeat(32), createdAt: Date.now(), type: 'invite', mode: 'voice' };
  await f.alice.sendCall(f.b.publicKey, signal);
  const disk = await f.snapshot();
  assert.equal(JSON.stringify(disk).includes(signal.callId), false);
  assert.equal(JSON.stringify(disk).includes('"mode":"voice"'), false);
  for (const record of disk.envelopes) if (record.envelope && wire(record.envelope).type === 'application') {
    assert.ok(record.envelope.expiresAt - record.envelope.createdAt <= 90000);
  }
  await f.bob.sync(); await f.bob.sync();
  assert.deepEqual(received, [{ peer: f.a.publicKey, signal }]);
  assert.deepEqual(await histories(f.bob, f.a.publicKey), []);
  const renegotiation = { version: 1, callId: signal.callId, createdAt: Date.now(), type: 'offer', generation: 1,
    sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=fingerprint:sha-256 ' + Array(32).fill('AB').join(':') + '\r\na=setup:actpass\r\n' };
  await f.alice.sendCall(f.b.publicKey, renegotiation);
  const recoveryDisk = JSON.stringify(await f.snapshot());
  assert.equal(recoveryDisk.includes('a=fingerprint:sha-256'), false);
  assert.equal(recoveryDisk.includes('generation'), false);
  await f.bob.sync(); await f.bob.sync();
  assert.deepEqual(received, [{ peer: f.a.publicKey, signal }, { peer: f.a.publicKey, signal: renegotiation }]);
  assert.deepEqual(await histories(f.bob, f.a.publicKey), []);
});

test('simultaneous first call invitations survive competing MLS setup and a sender restart', async t => {
  let armed = false, arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const bothReceiveFirst = async (url, init) => {
    const response = await fetch(url, init);
    if (armed && String(url).endsWith('/v1/receive') && arrivals < 2) {
      arrivals += 1; if (arrivals === 2) release(); await barrier;
    }
    return response;
  };
  const f = await pair(t, bothReceiveFirst, bothReceiveFirst), receivedA = [], receivedB = [];
  const aSignal = { version: 1, callId: 'a'.repeat(32), createdAt: Date.now(), type: 'invite', mode: 'voice' };
  const bSignal = { ...aSignal, callId: 'b'.repeat(32) };
  armed = true;
  await Promise.all([f.alice.sendCall(f.b.publicKey, aSignal), f.bob.sendCall(f.a.publicKey, bSignal)]);
  const alice = messenger(memoryPort(f.a, [{ publicKey: f.b.publicKey, name: 'Friend B' }], f.portA.read()));
  alice.subscribeCalls((_peer, signal) => receivedA.push(signal));
  f.bob.subscribeCalls((_peer, signal) => receivedB.push(signal));
  await alice.sync(); await f.bob.sync(); await alice.sync(); await f.bob.sync();
  assert.deepEqual(receivedA, [bSignal]); assert.deepEqual(receivedB, [aSignal]);
});
