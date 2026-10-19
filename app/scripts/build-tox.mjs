// SPDX-License-Identifier: GPL-3.0-only
// Build the messaging-only Tox engine from pinned sources, with Android 16 KB page alignment.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)), out = path.join(root, '.native-deps/tox');
const sources = [
  { name: 'c-toxcore-0.2.23', url: 'https://github.com/TokTok/c-toxcore/releases/download/v0.2.23/c-toxcore-0.2.23.tar.gz', sha256: 'b0349f4829d3d1699a77e199850f870f48d376e2baaf2c69d27b28571c498cfe' },
  { name: 'libsodium-1.0.22', url: 'https://github.com/jedisct1/libsodium/releases/download/1.0.22-RELEASE/libsodium-1.0.22.tar.gz', sha256: 'adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349' },
  { name: 'cmp-52bfcfa17d2eb4322da2037ad625f5575129cece', url: 'https://codeload.github.com/TokTok/cmp/tar.gz/52bfcfa17d2eb4322da2037ad625f5575129cece', sha256: '4abfd641dd5ccba04b6e0ced04a79755fa70709290b3ba15dbd4b4a2de345ed0' },
];
const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library/Android/sdk');
const ndkVersion = '27.1.12297006', ndk = path.join(sdk, 'ndk', ndkVersion);
const bin = path.join(ndk, 'toolchains/llvm/prebuilt', process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64', 'bin');
const cmake = process.env.CMAKE ?? path.join(sdk, 'cmake/3.22.1/bin/cmake');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inputHash = sha(JSON.stringify({ sources, ndkVersion, recipe: sha(await readFile(fileURLToPath(import.meta.url))) }));
const engine = path.join(out, 'jni/arm64-v8a/libtoxcore.so');
try {
  const previous = JSON.parse(await readFile(path.join(out, 'provenance.json'), 'utf8'));
  if (previous.inputHash === inputHash && previous.engineSha256 === sha(await readFile(engine))) { console.log('Verified cached Tox source build.'); process.exit(0); }
} catch {}
await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(os.tmpdir(), 'linkup-tox-'));
function run(command, args, cwd = out, extra = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...extra }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
for (const source of sources) {
  const archive = path.join(out, `${source.name}.tar.gz`);
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes || sha(bytes) !== source.sha256) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Could not download ${source.name}.`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== source.sha256) throw new Error(`${source.name} checksum mismatch.`);
    await writeFile(archive, bytes);
  }
  run('tar', ['-xzf', archive, '-C', work]);
}
await cp(path.join(work, sources[2].name), path.join(work, sources[0].name, 'third_party/cmp'), { recursive: true });
const prefix = path.join(work, 'prefix');
const env = { CC: path.join(bin, 'aarch64-linux-android24-clang'), AR: path.join(bin, 'llvm-ar'), RANLIB: path.join(bin, 'llvm-ranlib'), CFLAGS: '-O2 -fPIC', LDFLAGS: '-Wl,-z,max-page-size=16384' };
run('./configure', [`--prefix=${prefix}`, '--host=aarch64-linux-android', '--disable-shared', '--enable-static', '--disable-pie'], path.join(work, sources[1].name), env);
run('make', ['-j2', 'install'], path.join(work, sources[1].name), env);
const build = path.join(work, 'build'); await rm(build, { recursive: true, force: true });
run(cmake, ['-S', path.join(work, sources[0].name), '-B', build, `-DCMAKE_TOOLCHAIN_FILE=${ndk}/build/cmake/android.toolchain.cmake`, '-DANDROID_ABI=arm64-v8a', '-DANDROID_PLATFORM=android-24', '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_INSTALL_PREFIX=${work}/install`, `-DCMAKE_PREFIX_PATH=${prefix}`, '-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384', '-DENABLE_STATIC=OFF', '-DENABLE_SHARED=ON', '-DBUILD_TOXAV=OFF', '-DDHT_BOOTSTRAP=OFF', '-DBOOTSTRAP_DAEMON=OFF', '-DUNITTEST=OFF', '-DMIN_LOGGER_LEVEL=ERROR'], out, { PKG_CONFIG_PATH: path.join(prefix, 'lib/pkgconfig') });
run(cmake, ['--build', build, '--target', 'toxcore_shared', '-j', '2']);
run(cmake, ['--install', build]);
await mkdir(path.dirname(engine), { recursive: true });
await cp(path.join(work, 'install'), path.join(out, 'toxcore-android-arm64-v8a'), { recursive: true });
await cp(path.join(work, 'install/lib/libtoxcore.so'), engine);
const legal = path.join(root, 'legal/tox'); await mkdir(legal, { recursive: true });
for (const source of sources) await cp(path.join(work, source.name, 'LICENSE'), path.join(legal, `${source.name}-LICENSE.txt`));
await writeFile(path.join(out, 'provenance.json'), JSON.stringify({ inputHash, sources, ndkVersion, engineSha256: sha(await readFile(engine)) }, null, 2) + '\n');
await writeFile(path.join(legal, 'sources.json'), JSON.stringify({ sources, ndkVersion, recipe: 'scripts/build-tox.mjs', audioVideoIncluded: false }, null, 2) + '\n');
console.log('Built Tox 0.2.23 with libsodium 1.0.22 from verified sources.');

await rm(work, { recursive: true, force: true });
