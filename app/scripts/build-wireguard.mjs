// SPDX-License-Identifier: GPL-3.0-only
// Rebuild upstream WireGuard with a maintained Go toolchain. Maven's January
// 2026 AAR still bundles Go 1.24.3; only its verified Java classes are reused.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(app, 'native/wireguard');
const output = path.join(app, '.native-deps/wireguard');
const toolchainVersion = '1.27.2';
const ndkVersion = '27.1.12297006';
const toolchainHashes = {
  'darwin-amd64': '587b59182488b23aa6e5fc25110405a3e0e5b38ed2f5b2f46ed13c32aee356fe',
  'darwin-arm64': '76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5',
  'linux-amd64': 'ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5',
  'linux-arm64': '94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8',
};
const aarHash = '2b9c16db026496123e4db695d26d03d1958a201096c7c4c89b21077dc70f3119';
const aarUrl = 'https://repo.maven.apache.org/maven2/com/wireguard/android/tunnel/1.0.20260102/tunnel-1.0.20260102.aar';
const abis = (process.argv.find(value => value.startsWith('--abis='))?.slice(7) ?? 'arm64-v8a').split(',');
const architectures = { 'arm64-v8a': ['arm64', 'aarch64-linux-android24-clang'], x86_64: ['amd64', 'x86_64-linux-android24-clang'] };
if (!abis.length || abis.some(abi => !architectures[abi]) || new Set(abis).size !== abis.length) throw new Error('Supported ABIs: arm64-v8a,x86_64');
const host = `${os.platform()}-${os.arch() === 'x64' ? 'amd64' : os.arch()}`;
if (!toolchainHashes[host]) throw new Error('Use a supported macOS/Linux build host.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) { return sha(await readFile(file)); }
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: source, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}).`);
}
async function download(url, file, expected) {
  if (await hashFile(file).catch(() => '') === expected) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error('Dependency download failed.');
  let count = 0;
  const limit = new Transform({ transform(chunk, _, next) { count += chunk.length; next(count > 256 * 1024 * 1024 ? new Error('Dependency archive exceeded its size limit.') : null, chunk); } });
  const temporary = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary, { mode: 0o600 }));
    if (await hashFile(temporary) !== expected) throw new Error('Dependency SHA-256 mismatch.');
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

await mkdir(output, { recursive: true });
// A previous multi-ABI build must not leave an outdated engine available for
// Gradle to package after a later arm64-only rebuild, including a cache hit.
for (const abi of Object.keys(architectures)) {
  if (!abis.includes(abi)) await rm(path.join(output, 'jni', abi), { recursive: true, force: true });
}
const inputs = {};
for (const file of ['api-android.go', 'stats.go', 'stats_test.go', 'jni.c', 'go.mod', 'go.sum']) inputs[file] = await hashFile(path.join(source, file));
inputs.recipe = await hashFile(fileURLToPath(import.meta.url));
const inputHash = sha(JSON.stringify({ inputs, toolchainVersion, ndkVersion, aarHash, abis }));
const marker = path.join(output, 'provenance.json');
try {
  const prior = JSON.parse(await readFile(marker, 'utf8'));
  const expected = new Set(['classes.jar', ...abis.map(abi => `jni/${abi}/libwg-go.so`)]);
  const valid = prior.inputHash === inputHash && Object.keys(prior.outputs).length === expected.size && (await Promise.all(Object.entries(prior.outputs).map(async ([file, hash]) =>
    expected.has(file) &&
    path.resolve(output, file).startsWith(output + path.sep) && await hashFile(path.join(output, file)) === hash))).every(Boolean);
  if (valid) { console.log('WireGuard JNI: verified cached build with Go 1.27.2.'); process.exit(0); }
} catch { /* Build from pinned inputs when the cache is absent or invalid. */ }

const aar = path.join(output, 'tunnel-1.0.20260102.aar');
await download(aarUrl, aar, aarHash);
const extracted = path.join(output, 'maven-classes');
await mkdir(extracted, { recursive: true });
run('unzip', ['-qo', aar, 'classes.jar', '-d', extracted]);
await copyFile(path.join(extracted, 'classes.jar'), path.join(output, 'classes.jar'));

const archive = path.join(output, `go${toolchainVersion}.${host}.tar.gz`);
await download(`https://go.dev/dl/go${toolchainVersion}.${host}.tar.gz`, archive, toolchainHashes[host]);
const tools = path.join(output, `go-${toolchainVersion}-${host}`);
await rm(tools, { recursive: true, force: true });
await mkdir(tools, { recursive: true });
run('tar', ['-xzf', archive, '-C', tools]);
const go = path.join(tools, 'go/bin/go');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), 'Library/Android/sdk');
const ndk = path.join(sdk, 'ndk', ndkVersion);
const prebuilt = os.platform() === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const compilerDirectory = path.join(ndk, 'toolchains/llvm/prebuilt', prebuilt, 'bin');
const baseEnv = { GOTOOLCHAIN: 'local', GOCACHE: path.join(output, 'go-cache'), GOMODCACHE: path.join(output, 'go-mod'), GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org' };
run(go, ['mod', 'download'], baseEnv);
run(go, ['mod', 'verify'], baseEnv);
run(go, ['test', 'stats.go', 'stats_test.go'], baseEnv);
const outputs = { 'classes.jar': await hashFile(path.join(output, 'classes.jar')) };
for (const abi of abis) {
  const [architecture, compiler] = architectures[abi];
  const cc = path.join(compilerDirectory, compiler); await access(cc);
  const directory = path.join(output, 'jni', abi); await mkdir(directory, { recursive: true });
  const destination = path.join(directory, 'libwg-go.so');
  console.log(`Building WireGuard JNI for ${abi} with Go ${toolchainVersion}...`);
  run(go, ['build', '-mod=readonly', '-tags', 'linux', '-ldflags=-s -w -buildid=', '-trimpath', '-buildvcs=false', '-buildmode=c-shared', '-o', destination, '.'], {
    ...baseEnv, GOOS: 'android', GOARCH: architecture, CGO_ENABLED: '1', CC: cc,
    CGO_CFLAGS: '-O2 -g0', CGO_LDFLAGS: '-Wl,-z,max-page-size=16384 -Wl,-soname,libwg-go.so',
  });
  outputs[`jni/${abi}/libwg-go.so`] = await hashFile(destination);
  run(go, ['version', '-m', destination], baseEnv);
}
await writeFile(marker, JSON.stringify({ schema: 1, inputHash, inputs, toolchainVersion, toolchainArchiveSha256: toolchainHashes[host], ndkVersion, aarUrl, aarSha256: aarHash, outputs }, null, 2) + '\n');
console.log('WireGuard JNI built and checksummed. No tunnel was activated.');
