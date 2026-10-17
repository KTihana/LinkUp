// SPDX-License-Identifier: GPL-3.0-only
// Replace QuickCrypto's stale Maven OpenSSL 3.6.2 with official 3.6.5 sources.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, '.native-deps/openssl');
const version = '3.6.5', revision = `${version}-1`, ndkVersion = '27.1.12297006';
const sourceUrl = `https://github.com/openssl/openssl/releases/download/openssl-${version}/openssl-${version}.tar.gz`;
// Obtained from the official release's .sha256 file, not a mirror.
const sourceSha256 = 'a2157c2830efdec3788939b00c9b0638306d3f0bbb76dc4832ee503bb397df98';
const coordinate = `org.linkup.security:openssl-static:${revision}`;
const artifact = `maven/org/linkup/security/openssl-static/${revision}/openssl-static-${revision}`;
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), 'Library/Android/sdk');
const ndk = path.join(sdk, 'ndk', ndkVersion);
if (!['darwin', 'linux'].includes(os.platform())) throw new Error('Build patched OpenSSL on macOS or Linux.');
const prebuilt = os.platform() === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const bin = path.join(ndk, 'toolchains/llvm/prebuilt', prebuilt, 'bin');
const sha = value => createHash('sha256').update(value).digest('hex');
async function hash(file) { return sha(await readFile(file)); }
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...extra }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}).`);
}
const recipeSha256 = await hash(fileURLToPath(import.meta.url));
const packageScript = path.join(app, 'scripts/package-openssl.py');
const packageSha256 = await hash(packageScript);
const inputHash = sha(JSON.stringify({ sourceSha256, recipeSha256, packageSha256, ndkVersion, abi: 'arm64-v8a' }));
const marker = path.join(output, 'provenance.json');
const expectedFiles = [`${artifact}.aar`, `${artifact}.pom`];
try {
  const prior = JSON.parse(await readFile(marker, 'utf8'));
  if (prior.inputHash === inputHash && Object.keys(prior.outputs).length === expectedFiles.length &&
      (await Promise.all(expectedFiles.map(async name => await hash(path.join(output, name)) === prior.outputs[name]))).every(Boolean)) {
    console.log('OpenSSL 3.6.5: verified cached source build.'); process.exit(0);
  }
} catch { /* Rebuild missing or mismatched source-build outputs. */ }

await access(path.join(bin, 'aarch64-linux-android21-clang'));
await mkdir(output, { recursive: true });
const archive = path.join(output, `openssl-${version}.tar.gz`);
if (await hash(archive).catch(() => '') !== sourceSha256) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error('Official OpenSSL source download failed.');
  let size = 0;
  const limit = new Transform({ transform(chunk, _, next) { size += chunk.length; next(size > 100 * 1024 * 1024 ? new Error('Source archive is too large.') : null, chunk); } });
  const part = `${archive}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(part, { mode: 0o600 }));
    if (await hash(part) !== sourceSha256) throw new Error('OpenSSL source checksum mismatch.');
    await rename(part, archive);
  } finally { await rm(part, { force: true }); }
}

// OpenSSL's makefiles require a source path without spaces. A disposable build
// directory also prevents an interrupted build from reusing stale object files.
const work = await mkdtemp(path.join(os.tmpdir(), 'linkup-openssl-'));
try {
  run('tar', ['-xzf', archive, '-C', work], work);
  const source = path.join(work, `openssl-${version}`);
  const environment = {
    ANDROID_NDK_ROOT: ndk, ANDROID_NDK: ndk,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    SOURCE_DATE_EPOCH: '1790686800', // Fixed source-release date; no wall-clock build time.
    LC_ALL: 'C', TZ: 'UTC',
  };
  // Same static/PIC prefab interface as the upstream ndkports package. OpenSSL
  // remains unmodified. QuickCrypto continues to localize its static symbols.
  const configure = ['Configure', 'android-arm64', '-D__ANDROID_API__=21',
    '--prefix=/usr/local/linkup-openssl', '--openssldir=/etc/linkup-openssl',
    'no-sctp', 'no-shared', '-fPIC', '-Wl,-z,max-page-size=16384',
    '-Wl,-z,common-page-size=16384', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2'];
  run('perl', configure, source, environment);
  run('make', ['-j2', 'build_libs'], source, environment);
  const installed = path.join(work, 'installed');
  run('make', ['install_dev', `DESTDIR=${installed}`], source, environment);
  const prefix = path.join(installed, 'usr/local/linkup-openssl');
  const aar = path.join(output, `${artifact}.aar`), pom = path.join(output, `${artifact}.pom`);
  await mkdir(path.dirname(aar), { recursive: true });
  run('python3', [packageScript, prefix, path.join(source, 'LICENSE.txt'), aar, version], work);
  // Packaging is deterministic: sorted entries, fixed timestamps/modes and no
  // host directory names. Verify a second packaging of the same build inputs.
  const again = path.join(work, 'again.aar');
  run('python3', [packageScript, prefix, path.join(source, 'LICENSE.txt'), again, version], work);
  if (await hash(aar) !== await hash(again)) throw new Error('OpenSSL AAR packaging was not deterministic.');
  await writeFile(pom, `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>org.linkup.security</groupId><artifactId>openssl-static</artifactId><version>${revision}</version><packaging>aar</packaging><name>LinkUp source-built OpenSSL</name><url>https://openssl-library.org/</url><licenses><license><name>Apache License 2.0</name><url>https://www.apache.org/licenses/LICENSE-2.0</url></license></licenses></project>\n`);
  await mkdir(path.join(output, 'include'), { recursive: true });
  await cp(path.join(prefix, 'include'), path.join(output, 'include'), { recursive: true });
  const outputs = Object.fromEntries(await Promise.all(expectedFiles.map(async name => [name, await hash(path.join(output, name))])));
  await writeFile(marker, JSON.stringify({ schema: 1, coordinate, version, sourceUrl, sourceSha256, recipeSha256, packageSha256,
    inputHash, ndkVersion, abi: 'arm64-v8a', androidApi: 21, configure, outputs,
    limits: 'Source-built and deterministic AAR packaging checked; independent cross-host binary reproducibility and physical-phone runtime validation remain open.' }, null, 2) + '\n');
  console.log(`OpenSSL ${version} source build complete: ${coordinate}`);
} finally { await rm(work, { recursive: true, force: true }); }
