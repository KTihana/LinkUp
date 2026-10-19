import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { MailboxClient, MailboxAdmissionError, mailboxURL, mailboxAddressInput, envelopeBytes, packageBytes, validateMailEnvelope, validatePublicPackage } from '../src/messaging/mailboxClient.ts';

const publicKeyFor = seed => Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
function signedEnvelope(seed, recipient, now) {
  const value = { version: 1, id: randomBytes(16).toString('hex'), sender: publicKeyFor(seed), recipient,
    createdAt: now, expiresAt: now + 60000, ciphertext: Buffer.from('opaque ciphertext fixture').toString('base64') };
  return { ...value, signature: Buffer.from(ed25519.sign(envelopeBytes(value), seed)).toString('hex') };
}

test('cached public verification never authorizes a changed payload, signature, key or recipient', () => {
  const now = Date.now(), seed = randomBytes(32), recipient = publicKeyFor(randomBytes(32));
  const envelope = signedEnvelope(seed, recipient, now);
  validateMailEnvelope(envelope, recipient, now);
  validateMailEnvelope(structuredClone(envelope), recipient, now + 1);
  const otherKey = publicKeyFor(randomBytes(32));
  const differentSignature = (envelope.signature[0] === '0' ? '1' : '0') + envelope.signature.slice(1);
  for (const changed of [
    { ...envelope, ciphertext: Buffer.from('changed ciphertext fixture').toString('base64') },
    { ...envelope, signature: differentSignature },
    { ...envelope, sender: otherKey },
    { ...envelope, recipient: otherKey },
    { ...envelope, expiresAt: envelope.expiresAt + 1000 },
  ]) {
    // A failure must remain a failure on repetition, never become a cached success.
    for (let repeat = 0; repeat < 2; repeat++) assert.throws(() => validateMailEnvelope(changed, changed.recipient, now), /unverified/);
  }
  assert.throws(() => validateMailEnvelope(envelope, otherKey, now), /Invalid mail envelope/);
  assert.throws(() => validateMailEnvelope({ ...envelope, extra: true }, recipient, now), /Invalid mailbox response/);
  assert.throws(() => validateMailEnvelope(envelope, recipient, envelope.expiresAt), /Expired/);
  validateMailEnvelope(envelope, recipient, now + 2);
});

test('cached key-package verification still binds its owner, exact signed contents, shape and lifetime', () => {
  const now = Date.now(), seed = randomBytes(32), owner = publicKeyFor(seed);
  const value = { id: randomBytes(16).toString('hex'), owner, createdAt: now, expiresAt: now + 60000, data: 'opaque public protocol fixture' };
  const bundle = { ...value, signature: Buffer.from(ed25519.sign(packageBytes(value), seed)).toString('hex') };
  validatePublicPackage(bundle, owner, now);
  validatePublicPackage(structuredClone(bundle), owner, now + 1);
  assert.throws(() => validatePublicPackage({ ...bundle, data: 'replacement protocol data' }, owner, now), /unverified/);
  const other = publicKeyFor(randomBytes(32));
  assert.throws(() => validatePublicPackage(bundle, other, now), /Invalid messaging key package/);
  assert.throws(() => validatePublicPackage({ ...bundle, owner: other }, other, now), /unverified/);
  assert.throws(() => validatePublicPackage({ ...bundle, signature: '0'.repeat(128) }, owner, now), /unverified/);
  assert.throws(() => validatePublicPackage({ ...bundle, extra: true }, owner, now), /Invalid mailbox response/);
  assert.throws(() => validatePublicPackage(bundle, owner, bundle.expiresAt), /Expired/);
});

const signer = { publicKey: 'a'.repeat(64), sign: () => { throw new Error('No signature should be requested.'); } };
test('mailbox URLs require TLS except literal loopback development addresses', () => {
  assert.equal(mailboxURL('https://mail.example/'), 'https://mail.example');
  assert.equal(mailboxURL('http://localhost:8787'), 'http://localhost:8787');
  for (const url of ['http://192.168.1.10:8787', 'http://localhost.example', 'https://user:secret@mail.example', 'https://mail.example/path', 'https://mail.example?secret=yes']) assert.throws(() => mailboxURL(url));
});
test('mailbox response limits are enforced during streaming, including dishonest content lengths', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const client = new MailboxClient('https://mail.example', async () => new Response(stream, { headers: { 'Content-Length': '1' } }));
  await assert.rejects(client.receive(signer), /response too large/);
  assert.equal(cancelled, true);
});
test('declared oversized and non-streaming mailbox responses fail before parsing or signing', async () => {
  const declared = new MailboxClient('https://mail.example', async () => new Response('{}', { headers: { 'Content-Length': '9000000' } }));
  await assert.rejects(declared.receive(signer), /response too large/);
  const nonstreaming = new MailboxClient('https://mail.example', async () => ({ ok: true, status: 200, headers: new Headers(), body: null }));
  await assert.rejects(nonstreaming.receive(signer), /streaming fetch/);
});

test('a reset during publish retries identical payload with a fresh authenticated challenge', async () => {
  let challenges = 0; const posts = [], signed = [];
  const client = new MailboxClient('https://mail.example', async (url, init) => {
    if (url.endsWith('/challenge')) return Response.json({ challenge: String(++challenges).repeat(48), expiresAt: Date.now() + 30000 });
    posts.push(JSON.parse(init.body));
    if (posts.length === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return Response.json({ accepted: true, duplicate: true });
  });
  const owner = { publicKey: signer.publicKey, sign: bytes => { signed.push(new TextDecoder().decode(bytes)); return 'f'.repeat(128); } };
  const envelope = { opaqueFixture: 'same ciphertext and envelope ID' };
  await client.publish(envelope, owner);
  assert.equal(challenges, 2); assert.equal(posts.length, 2);
  assert.equal(posts[0].payload, posts[1].payload);
  assert.notEqual(posts[0].challenge, posts[1].challenge); assert.notEqual(signed[0], signed[1]);
});

test('connection retry is bounded and cancellation prevents another attempt', async () => {
  let requests = 0;
  const unavailable = new MailboxClient('https://mail.example', async () => { requests++; throw new TypeError('fetch failed'); });
  await assert.rejects(unavailable.receive(signer), /connection was interrupted/); assert.equal(requests, 2);
  requests = 0;
  const cancelled = new MailboxClient('https://mail.example', async () => { requests++; cancelled.cancel(); throw new TypeError('fetch failed'); });
  await assert.rejects(cancelled.receive(signer), /disconnected/); assert.equal(requests, 1);
});

test('HTTP rejection and malformed responses never trigger a connection retry', async () => {
  for (const response of [() => new Response('{}', { status: 403 }), () => new Response('not json')]) {
    let requests = 0;
    const client = new MailboxClient('https://mail.example', async () => { requests++; return response(); });
    await assert.rejects(client.receive(signer)); assert.equal(requests, 1);
  }
});

test('admission requests bind the complete sorted list and durable revision to the signed action', async () => {
  const signed = [], posts = [], owner = { publicKey: 'a'.repeat(64), sign: bytes => { signed.push(new TextDecoder().decode(bytes)); return 'f'.repeat(128); } };
  const client = new MailboxClient('https://mail.example', async (url, init) => {
    const body = JSON.parse(init.body); posts.push({ url, body });
    if (url.endsWith('/challenge')) return Response.json({ challenge: '1'.repeat(48), expiresAt: Date.now() + 30000 });
    return Response.json({ accepted: true, revision: 3 });
  });
  await client.setAdmission(['c'.repeat(64), 'b'.repeat(64)], 3, owner);
  assert.deepEqual(posts[0].body, { publicKey: owner.publicKey, action: 'admission-set' });
  assert.ok(posts[1].url.endsWith('/v1/admission-set'));
  assert.deepEqual(JSON.parse(posts[1].body.payload), { peers: ['b'.repeat(64), 'c'.repeat(64)], revision: 3 });
  assert.match(signed[0], /^common\/mailbox-request\/v1\n\/v1\/admission-set\n/);
});

test('admission validation fails before network access and requires an exact server acknowledgement', async () => {
  let requests = 0;
  const owner = { publicKey: 'a'.repeat(64), sign: () => 'f'.repeat(128) };
  const client = new MailboxClient('https://mail.example', async url => {
    requests++;
    if (url.endsWith('/challenge')) return Response.json({ challenge: '1'.repeat(48), expiresAt: Date.now() + 30000 });
    return Response.json({ accepted: true, revision: 1 });
  });
  for (const [peers, revision] of [[[owner.publicKey], 1], [['b'.repeat(64), 'b'.repeat(64)], 1], [['bad'], 1], [[], 0], [[], 1.5], [[], Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(client.setAdmission(peers, revision, owner), /Invalid mailbox admission/);
  }
  assert.equal(requests, 0);
  await assert.rejects(client.setAdmission([], 2, owner), /did not confirm friend permissions/);
});

test('recipient refusal is a bounded admission error, never successful storage or an automatic retry', async () => {
  let requests = 0;
  const owner = { publicKey: 'a'.repeat(64), sign: () => 'f'.repeat(128) };
  const client = new MailboxClient('https://mail.example', async url => {
    requests++;
    if (url.endsWith('/challenge')) return Response.json({ challenge: '1'.repeat(48), expiresAt: Date.now() + 30000 });
    return Response.json({ error: 'recipient_not_accepting' }, { status: 403 });
  });
  await assert.rejects(client.publish({}, owner), MailboxAdmissionError);
  await assert.rejects(client.claim('b'.repeat(64), owner), MailboxAdmissionError);
  assert.equal(requests, 4);
});

test('a refused response aborts its unread network body before releasing request tracking', async () => {
  let signal;
  const client = new MailboxClient('https://mail.example', async (_url, init) => {
    signal = init.signal; return new Response('unused error body', { status: 403 });
  });
  await assert.rejects(client.receive(signer), /403/);
  assert.equal(signal.aborted, true);
});

test('key retirement validates exact IDs and requires a bounded owner-only acknowledgement', async () => {
  const owner = { publicKey: 'a'.repeat(64), sign: () => 'f'.repeat(128) }, posts = [];
  let retired = 1;
  const client = new MailboxClient('https://mail.example', async (url, init) => {
    const body = JSON.parse(init.body); posts.push({ url, body });
    if (url.endsWith('/challenge')) return Response.json({ challenge: '1'.repeat(48), expiresAt: Date.now() + 30000 });
    return Response.json({ retired });
  });
  for (const ids of [[], ['bad'], ['b'.repeat(32), 'b'.repeat(32)]]) await assert.rejects(client.retireKeys(ids, owner), /Invalid messaging key retirement/);
  assert.equal(posts.length, 0);
  await client.retireKeys(['b'.repeat(32)], owner);
  assert.deepEqual(posts[0].body, { publicKey: owner.publicKey, action: 'keys-retire' });
  assert.deepEqual(JSON.parse(posts[1].body.payload), { ids: ['b'.repeat(32)] });
  retired = 0; await client.retireKeys(['b'.repeat(32)], owner);
  retired = 2; await assert.rejects(client.retireKeys(['b'.repeat(32)], owner), /did not confirm messaging key retirement/);
});


test('pasted mailbox hostnames use HTTPS without accepting email, credentials or website paths', () => {
  assert.equal(mailboxAddressInput('  mail.example.org  '), 'https://mail.example.org');
  assert.equal(mailboxAddressInput('mail.example.org:8443/'), 'https://mail.example.org:8443');
  assert.equal(mailboxAddressInput('https://mail.example.org/'), 'https://mail.example.org');
  for (const value of ['', '  ', 'user@mail.example.org', 'mail.example.org/path', 'http://mail.example.org', 'mail.example.org?token=x', 'mail example.org']) assert.throws(() => mailboxAddressInput(value));
});
