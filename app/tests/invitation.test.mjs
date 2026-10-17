import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createInvitation, inspectInvitation, invitationShareUrl, INVITATION_WEB_URL, fingerprint, isValidDisplayName, INVITATION_TTL_MS, INVITATION_FUTURE_SKEW_MS } from '../src/security/invitation.ts';

const now = 1791907200000;
const seed = randomBytes(32);
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const details = { version: 1, publicKey: publicHex, name: 'Ana 🌿', issuedAt: now, expiresAt: now + INVITATION_TTL_MS, nonce: randomBytes(16).toString('hex') };
const domain = 'common/invitation/v1\0';

// Sign deliberately unusual inputs independently, so validation tests do not merely exercise a bad signature.
function signed(value, options = {}) {
  const json = options.json ?? JSON.stringify(value);
  return `${Buffer.from(json).toString('base64url')}.${sign(null, Buffer.from((options.domain ?? domain) + json), privateKey).toString('hex')}`;
}

test('invitations match independent Node Ed25519 and disclose only public contact details', () => {
  const nonce = randomBytes(16);
  const token = createInvitation(seed, 'Ana 🌿', nonce, now);
  const [payload, signature] = token.split('.');
  const json = Buffer.from(payload, 'base64url').toString();
  assert.equal(verify(null, Buffer.from(domain + json), publicKey, Buffer.from(signature, 'hex')), true);
  assert.equal(signature, sign(null, Buffer.from(domain + json), privateKey).toString('hex'));
  const parsed = inspectInvitation(token, now);
  assert.deepEqual(parsed, { ...details, nonce: nonce.toString('hex') });
  assert.deepEqual(Object.keys(parsed), ['version', 'publicKey', 'name', 'issuedAt', 'expiresAt', 'nonce']);
  assert.equal(json.includes(seed.toString('hex')), false);
  assert.equal(parsed.expiresAt - parsed.issuedAt, 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(inspectInvitation(signed(details), now), details);
});

test('only raw tokens and exact invite routes with one token parameter are accepted', () => {
  const token = signed(details);
  for (const input of [invitationShareUrl(token), token, `common://invite?token=${token}`, `https://common.example/invite?token=${token}`, `http://127.0.0.1:8081/invite?token=${token}`, `  ${token}\n`]) assert.deepEqual(inspectInvitation(input, now), details);
  for (const input of [
    `common://invite?token=${token}&token=${token}`,
    `common://invite?token=${token}&name=Alice`,
    `common://invite?other=${token}`,
    `common://profile?token=${token}`,
    `common://invite/?token=${token}`,
    `https://common.example/chat?token=${token}`,
    `https://common.example/a/../invite?token=${token}`,
    `https://user:password@common.example/invite?token=${token}`,
    `https://common.example/invite?token=${token}#extra`,
    `https://common.example/invite?token=${token}&token=${token}`,
    `https://common.\nexample/invite?token=${token}`,
    `https://common.example\\/invite?token=${token}`,
    `https://common.example/invite?token=${token.replace('.', '%2E')}`,
    `javascript:alert(1)?token=${token}`,
    `//common.example/invite?token=${token}`,
    `common://invite?token=${token}\nextra`,
    `${'x'.repeat(2049)}${token}`,
  ]) assert.throws(() => inspectInvitation(input, now), undefined, input.slice(0, 100));
});

test('public installation links preserve the exact signed invitation without sending it in the request URL', () => {
  const token = signed(details), link = invitationShareUrl(token), url = new URL(link);
  assert.equal(link, `${INVITATION_WEB_URL}#${token}`);
  assert.equal(url.search, '');
  assert.equal(url.hash, `#${token}`);
  assert.deepEqual(inspectInvitation(link, now), details);
  assert.equal(invitationShareUrl(`common://invite?token=${token}`), link);
  for (const bad of [link.replace('ktihana.github.io', 'evil.test'), link + '&extra=1', link.replace('#', '?token='), link.replace('/LinkUp/', '/x/../LinkUp/'), link.replace('.', '%2E'), link + '#extra']) assert.throws(() => inspectInvitation(bad, now));
  assert.throws(() => inspectInvitation(link.slice(0,-1) + (link.endsWith('0') ? '1' : '0'), now));
});

test('tampering and signatures from another domain or identity fail verification', () => {
  const token = signed(details);
  const [payload, signature] = token.split('.');
  const changedName = Buffer.from(JSON.stringify({ ...details, name: 'Someone else' })).toString('base64url');
  assert.throws(() => inspectInvitation(`${changedName}.${signature}`, now));
  assert.throws(() => inspectInvitation(`${payload}.${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`, now));
  assert.throws(() => inspectInvitation(signed({ ...details, publicKey: createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), randomBytes(32)]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') }), now));
  assert.throws(() => inspectInvitation(signed(details, { domain: 'common/local-vault/v1\0' }), now));
  assert.throws(() => inspectInvitation(signed(details, { domain: '' }), now));
});

test('time bounds reject expired, future, fractional, unsafe, and nonstandard lifetime invitations', () => {
  assert.deepEqual(inspectInvitation(signed(details), details.expiresAt - 1), details);
  assert.throws(() => inspectInvitation(signed(details), details.expiresAt), /expired/);
  assert.deepEqual(inspectInvitation(signed(details), now - INVITATION_FUTURE_SKEW_MS), details);
  assert.throws(() => inspectInvitation(signed(details), now - INVITATION_FUTURE_SKEW_MS - 1), /future/);
  for (const value of [
    { ...details, expiresAt: details.expiresAt + 1 },
    { ...details, issuedAt: now + 0.5, expiresAt: details.expiresAt + 0.5 },
    { ...details, issuedAt: -1, expiresAt: INVITATION_TTL_MS - 1 },
    { ...details, issuedAt: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER + INVITATION_TTL_MS },
    { ...details, issuedAt: String(now) },
    { ...details, expiresAt: null },
  ]) assert.throws(() => inspectInvitation(signed(value), now));
  for (const time of [NaN, Infinity, -1, now + 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => inspectInvitation(signed(details), time));
    assert.throws(() => createInvitation(seed, details.name, randomBytes(16), time));
  }
});

test('signed metadata must use the exact schema, name bounds, and canonical JSON', () => {
  for (const value of [
    { ...details, version: 2 },
    { ...details, name: '' },
    { ...details, name: '  ' },
    { ...details, name: ' Ana' },
    { ...details, name: 'A'.repeat(51) },
    { ...details, name: 'Ana\nAdmin' },
    { ...details, name: 'Ana\u202eAdmin' },
    { ...details, name: '\ud800' },
    { ...details, name: '\udc00' },
    { ...details, nonce: '0'.repeat(31) },
    { ...details, nonce: 'G'.repeat(32) },
    { ...details, publicKey: 'x'.repeat(64) },
    { ...details, photo: 'https://tracker.example/photo' },
    { ...details, seed: seed.toString('hex') },
    null, [], 'not an object',
  ]) assert.throws(() => inspectInvitation(signed(value), now));
  const canonical = JSON.stringify(details);
  for (const json of [
    ` ${canonical}`,
    JSON.stringify(details, null, 2),
    JSON.stringify({ name: details.name, ...details }),
    canonical.replace('"version":1', '"version":1,"version":1'),
    canonical.replace('"version":1', '"version":1.0'),
    canonical.replace('Ana', '\\u0041na'),
  ]) assert.throws(() => inspectInvitation(signed(details, { json }), now));
  assert.deepEqual(inspectInvitation(signed({ ...details, name: 'A'.repeat(50) }), now).name, 'A'.repeat(50));
});

test('base64url and signatures reject alternate encodings and malformed UTF-8', () => {
  const [payload, signature] = signed(details).split('.');
  for (const token of [`${payload}=.${signature}`, `${payload}.${signature.toUpperCase()}`, `${payload}.${signature.slice(2)}`, `${payload}.${signature}.${signature}`, `A.${signature}`, `${Buffer.from([255, 254, 253]).toString('base64url')}.${signature}`]) assert.throws(() => inspectInvitation(token, now));
  let alternateDetails = details;
  while (Buffer.byteLength(JSON.stringify(alternateDetails)) % 3 === 0) alternateDetails = { ...alternateDetails, name: `${alternateDetails.name}x` };
  const [encoded, sig] = signed(alternateDetails).split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const changedTail = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)) + 1];
  assert.deepEqual(Buffer.from(changedTail, 'base64url'), Buffer.from(encoded, 'base64url'));
  assert.throws(() => inspectInvitation(`${changedTail}.${sig}`, now));
});

test('strict Ed25519 rejects low-order and noncanonical public keys', () => {
  // R = base point, S = 1 would satisfy permissive verification for the identity point A.
  const forged = { ...details, publicKey: `01${'00'.repeat(31)}` };
  const signature = `58${'66'.repeat(31)}01${'00'.repeat(31)}`;
  assert.throws(() => inspectInvitation(`${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`, now));
  assert.throws(() => inspectInvitation(signed({ ...details, publicKey: 'ff'.repeat(32) }), now));
});

test('invitations reject mixed-torsion identities even when strict Ed25519 verifies their signatures', () => {
  // Deliberately construct an unusual key/signature using a fixed throwaway test seed.
  // Adding an order-two point puts A outside the subgroup generated by normal identity creation.
  const fixtureSeed = new Uint8Array(32).fill(42);
  const extended = ed25519.utils.getExtendedPublicKey(fixtureSeed);
  const torsion = ed25519.Point.fromBytes(hexToBytes(`ec${'ff'.repeat(30)}7f`), false);
  const mixed = extended.point.add(torsion);
  assert.equal(mixed.isSmallOrder(), false);
  assert.equal(mixed.isTorsionFree(), false);
  const a = mixed.toBytes();
  const value = { ...details, publicKey: bytesToHex(a), name: 'Test', nonce: '00'.repeat(16) };
  const json = JSON.stringify(value), message = utf8ToBytes(domain + json);
  const r = ed25519.Point.BASE.toBytes(); // Fixed scalar r = 1, only for this adversarial fixture.
  const order = 2n ** 252n + 27742317777372353535851937790883648493n;
  const k = bytesToNumberLE(sha512(concatBytes(r, a, message))) % order;
  const signature = concatBytes(r, numberToBytesLE((1n + k * extended.scalar) % order, 32));
  assert.equal(ed25519.verify(signature, message, a, { zip215: false }), true);
  assert.throws(() => inspectInvitation(`${Buffer.from(json).toString('base64url')}.${bytesToHex(signature)}`, now));
});

test('fingerprints preserve every key digit and invitation creation requires valid parameters', () => {
  assert.equal(isValidDisplayName('Ana 🌿'), true);
  assert.equal(isValidDisplayName('Ana\u202eAdmin'), false);
  const result = fingerprint(publicHex);
  assert.match(result, /^[A-F0-9]{8}( [A-F0-9]{8}){7}$/);
  assert.equal(result.replaceAll(' ', '').toLowerCase(), publicHex);
  assert.equal(fingerprint(publicHex.toUpperCase()), result);
  assert.throws(() => fingerprint('abcdef'));
  for (const [key, name, nonce] of [[randomBytes(31), details.name, randomBytes(16)], [seed, details.name, randomBytes(15)], [seed, 'A'.repeat(51), randomBytes(16)], [seed, '', randomBytes(16)], [seed, 'Ana\nAdmin', randomBytes(16)]]) assert.throws(() => createInvitation(key, name, nonce, now));
  assert.notEqual(createInvitation(seed, details.name, randomBytes(16), now), createInvitation(seed, details.name, randomBytes(16), now));
});
