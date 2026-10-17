// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { assetUrl, latestRelease, migrateReleaseRepository, verifyRelease, validRepository, RELEASE_DOMAIN } from '../src/updates/release.ts';
const key = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(key));
const good = { schema: 1, packageName: 'org.commonchat.app', version: '0.1.1', versionCode: 2, minSdk: 24, abi: 'arm64-v8a', file: 'tiho-0.1.1-arm64.apk', sha256: 'a'.repeat(64), bytes: 65000000, publishedAt: '2026-10-14T12:00:00Z', notes: 'Test release' };
function signed(data = good, signer = key, domain = RELEASE_DOMAIN) { const payload = JSON.stringify(data); return JSON.stringify({ payload, signature: bytesToHex(ed25519.sign(utf8ToBytes(domain + payload), signer)) }); }
test('publisher repository rename preserves custom and disabled update sources', () => {
  for (const old of ['KTihana/Tiho', 'ktihana/tiho', 'KTIHANA/TIHO']) assert.equal(migrateReleaseRepository(old), 'KTihana/LinkUp');
  for (const source of ['KTihana/LinkUp', 'other/LinkUp', 'KTihana/Tiho-fork', '']) assert.equal(migrateReleaseRepository(source), source);
});
test('authentic release identifies the exact APK and version', () => {
  assert.deepEqual(verifyRelease(signed(), publicKey, good.packageName, 'v0.1.1'), good);
  assert.equal(assetUrl('KTihana/LinkUp', good.version, good.file), 'https://github.com/KTihana/LinkUp/releases/download/v0.1.1/tiho-0.1.1-arm64.apk');
});
test('altered, unsigned, foreign-key and cross-protocol release information fails closed', () => {
  assert.throws(() => verifyRelease(signed().replace('Test release', 'Changed release'), publicKey, good.packageName, 'v0.1.1'));
  for (const raw of [JSON.stringify(good), signed(good, randomBytes(32)), signed(good, key, 'another protocol\n'), '{', 'x'.repeat(16385)]) assert.throws(() => verifyRelease(raw, publicKey, good.packageName, 'v0.1.1'));
});
test('even correctly signed unsupported packages, tags, paths and sizes are refused', () => {
  const invalid = [{packageName:'evil.app'}, {file:'../other.apk'}, {bytes:209715201}, {bytes:-1}, {bytes:1.5}, {versionCode:2147483648}, {versionCode:1.5}, {minSdk:23}, {abi:'x86'}, {notes:'x'.repeat(2001)}, {sha256:'bad'}, {publishedAt:'bad'}];
  for (const patch of invalid) assert.throws(() => verifyRelease(signed({...good,...patch}), publicKey, good.packageName, 'v0.1.1'));
  assert.throws(() => verifyRelease(signed(), publicKey, good.packageName, 'v0.1.2'));
});
test('repository and asset paths cannot redirect update downloads to another host', () => {
  for (const repo of ['https://evil.test/a', 'owner/name/extra', '../name', 'a/b?x', 'a/b#x', 'a/b.git', 'a\\b', '']) assert.equal(validRepository(repo), false, repo);
  assert.throws(() => assetUrl('a/b', '0.1.1', '../other.apk'));
  assert.throws(() => assetUrl('a/b', '../0.1.1', good.file));
});

function listing() { return { tag_name: 'v0.1.1', assets: [{ name: 'tiho-update-v1.json', size: signed().length }, { name: good.file, size: good.bytes }] }; }
const check = signal => latestRelease('KTihana/LinkUp', publicKey, good.packageName, signal ?? new AbortController().signal);
function streamResponse(chunks, onCancel, headers = {}) {
  return new Response(new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); },
    cancel: onCancel,
  }, { highWaterMark: 0 }), { headers });
}
test('update checks stream authenticated releases without credentials or cached metadata', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(requests.length === 1 ? JSON.stringify(listing()) : signed());
  });
  assert.deepEqual(await check(), good);
  assert.equal(requests.length, 2);
  for (const { options } of requests) { assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); }
});
test('oversized declared update responses are cancelled before reading their bodies', async t => {
  let pulled = 0, cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull() { pulled++; }, cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': '262145' } }));
  await assert.rejects(check(), /too large/);
  assert.equal(pulled, 0); assert.equal(cancelled, 1);
});
test('update response limits count streamed UTF-8 bytes even with a misleading length', async t => {
  let cancelled = 0;
  const chunks = [utf8ToBytes(' '.repeat(131072)), utf8ToBytes('é'.repeat(65537)), utf8ToBytes('unread tail')];
  t.mock.method(globalThis, 'fetch', async () => streamResponse(chunks, () => { cancelled++; }, { 'Content-Length': '1' }));
  await assert.rejects(check(), /too large/);
  assert.equal(cancelled, 1); assert.equal(chunks.length, 1, 'stop before reading the tail');
});
test('signed manifest downloads have their own streaming byte limit', async t => {
  let requests = 0, cancelled = 0;
  const chunks = [utf8ToBytes('é'.repeat(8193)), utf8ToBytes('unread tail')];
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? new Response(JSON.stringify(listing())) : streamResponse(chunks, () => { cancelled++; }));
  await assert.rejects(check(), /too large/);
  assert.equal(cancelled, 1); assert.equal(chunks.length, 1);
});
test('update checks refuse a non-streaming fetch implementation', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, headers: new Headers(), text() { throw new Error('Unbounded text must never be called.'); } }));
  await assert.rejects(check(), /streaming fetch/);
});
test('cancelling an update check stops a response stalled after its headers', async t => {
  const abort = new AbortController(); let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull() { abort.abort(); }, cancel() { cancelled++; },
  }, { highWaterMark: 0 })));
  await assert.rejects(check(abort.signal), /cancelled/i);
  assert.equal(cancelled, 1);
});
test('missing releases and HTTP errors cancel unused bodies without consuming them', async t => {
  for (const target of ['missing', 'listing-error', 'manifest-error']) {
    let requests = 0, cancelled = 0, pulled = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      if (++requests === 1 && target === 'manifest-error') return new Response(JSON.stringify(listing()));
      return new Response(new ReadableStream({ pull() { pulled++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { status: target === 'missing' ? 404 : 503 });
    });
    try {
      if (target === 'missing') assert.equal(await check(), null);
      else await assert.rejects(check(), /update information|update check failed/);
      assert.equal(pulled, 0); assert.equal(cancelled, 1);
    } finally { mock.mock.restore(); }
  }
});
