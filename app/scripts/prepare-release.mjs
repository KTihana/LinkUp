// SPDX-License-Identifier: GPL-3.0-only
// Run --init before building; run without flags after build to sign metadata.
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const keyFile = resolve(root, '.signing/update-ed25519.key');
const trustFile = resolve(root, 'src/updates/releaseTrust.json');
const repoIndex = process.argv.indexOf('--repository');
const repository = repoIndex < 0 ? undefined : process.argv[repoIndex + 1];
if (repoIndex >= 0 && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository ?? '')) throw new Error('Specify a valid owner/repository.');
await mkdir(resolve(root, '.signing'), { recursive: true, mode: 0o700 });
await chmod(resolve(root, '.signing'), 0o700);
let key;
try { key = hexToBytes((await readFile(keyFile, 'utf8')).trim()); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  try { await readFile(trustFile); throw new Error('Release public key exists without its private key. Restore the private key; do not replace it.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  key = randomBytes(32);
  await writeFile(keyFile, bytesToHex(key), { flag: 'wx', mode: 0o600 });
}
await chmod(keyFile, 0o600);
const publicKey = bytesToHex(ed25519.getPublicKey(key));
try {
  const old = JSON.parse(await readFile(trustFile, 'utf8'));
  if (old.publicKey !== publicKey) throw new Error('Release trust key mismatch. Restore the original key.');
  if (repository !== undefined) await writeFile(trustFile, JSON.stringify({ ...old, repository }, null, 2) + '\n');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  await writeFile(trustFile, JSON.stringify({ publicKey, ...(repository ? { repository } : {}) }, null, 2) + '\n');
}
if (!process.argv.includes('--init')) {
  const config = JSON.parse(await readFile(resolve(root, 'app.json'), 'utf8')).expo;
  const file = `tiho-${config.version}-arm64.apk`;
  const apk = await readFile(resolve(root, 'artifacts', file));
  const payload = JSON.stringify({ schema: 1, packageName: config.android.package, version: config.version,
    versionCode: config.android.versionCode, minSdk: 24, abi: 'arm64-v8a', file, sha256: createHash('sha256').update(apk).digest('hex'),
    bytes: apk.length, publishedAt: new Date().toISOString(), notes: 'A refreshed blue LinkUp app with clearer chats and navigation, larger controls, and polished dark mode.' });
  const signature = bytesToHex(ed25519.sign(utf8ToBytes('Tiho Android release v1\n' + payload), key));
  await writeFile(resolve(root, 'artifacts/tiho-update-v1.json'), JSON.stringify({ payload, signature }) + '\n');
  console.log(`Prepared signed release v${config.version}. Publish APK, signed manifest, checksum and corresponding source together.`);
} else console.log('Publisher trust initialized. Private release key stays in .signing.');
key.fill(0);
