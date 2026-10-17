// SPDX-License-Identifier: GPL-3.0-only
// Verify artifacts locally, then upload a draft release with the official GitHub CLI.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
const repo = process.argv[2];
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo ?? '')) throw new Error('Specify owner/repository.');
const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await readFile(resolve(root, 'app.json'), 'utf8')).expo;
const trust = JSON.parse(await readFile(resolve(root, 'src/updates/releaseTrust.json'), 'utf8'));
const manifestFile = resolve(root, 'artifacts/tiho-update-v1.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
if (!ed25519.verify(hexToBytes(manifest.signature), utf8ToBytes('Tiho Android release v1\n' + manifest.payload), hexToBytes(trust.publicKey))) throw new Error('Release signature verification failed.');
const release = JSON.parse(manifest.payload), version = config.version;
if (release.version !== version || release.versionCode !== config.android.versionCode || release.packageName !== config.android.package) throw new Error('Rebuild artifacts for the configured version.');
const apk = resolve(root, `artifacts/tiho-${version}-arm64.apk`);
const bytes = await readFile(apk);
if (bytes.length !== release.bytes || createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('APK differs from the signed release.');
const files = [apk, `${apk}.sha256`, resolve(root, `artifacts/tiho-${version}-source.zip`), manifestFile];
for (const file of files) if (!(await stat(file)).size) throw new Error('A release file is empty.');
console.log(`Verified LinkUp ${version} (${release.versionCode}): APK, checksum, source and signed manifest for ${repo}.`);
if (!process.argv.includes('--prepare')) {
  const run = (args) => new Promise((ok, fail) => { const p = spawn('gh', args, { cwd: root, stdio: 'inherit' }); p.once('error', fail); p.once('exit', code => code === 0 ? ok() : fail(new Error('GitHub CLI failed. Sign in with gh auth login, then retry.'))); });
  await run(['auth', 'status']);
  await run(['release', 'create', `v${version}`, ...files, '--repo', repo, '--draft', '--title', `LinkUp ${version}`, '--notes', release.notes]);
  console.log('Draft uploaded. Review it in GitHub and publish it when ready.');
}
