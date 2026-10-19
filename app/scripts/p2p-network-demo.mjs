// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library/Android/sdk');
const temp = await mkdtemp(path.join(os.tmpdir(), 'linkup-p2p-test-'));
const adb = path.join(sdk, 'platform-tools/adb');
const remote = `/data/local/tmp/linkup-p2p-${path.basename(temp)}`;
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)));
});
try {
  const nodes = JSON.parse(await readFile(path.join(root, 'native/tox/bootstrap.json'), 'utf8'));
  const rows = nodes.map(node => `{${JSON.stringify(node.host)}, ${node.port}, ${JSON.stringify(node.publicKey)}, {${[...node.tcpPorts.slice(0, 3), 0].join(',')}}}`);
  await writeFile(path.join(temp, 'bootstrap.h'), `static const struct { const char *host; int port; const char *key; int tcp[4]; } nodes[] = {${rows.join(',')}};\n`);
  const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const clang = path.join(sdk, 'ndk/27.1.12297006/toolchains/llvm/prebuilt', host, 'bin/aarch64-linux-android24-clang');
  await run(clang, [path.join(root, 'tests/native/internet-smoke.c'), '-I', temp, '-I', path.join(root, '.native-deps/tox/toxcore-android-arm64-v8a/include'), '-L', path.join(root, '.native-deps/tox/jni/arm64-v8a'), '-ltoxcore', '-o', path.join(temp, 'probe')]);
  await run(adb, ['shell', 'mkdir', '-p', remote]);
  await run(adb, ['push', path.join(temp, 'probe'), path.join(root, '.native-deps/tox/jni/arm64-v8a/libtoxcore.so'), remote]);
  await run(adb, ['shell', `chmod 700 ${remote}/probe && LD_LIBRARY_PATH=${remote} ${remote}/probe`]);
} finally {
  await run(adb, ['shell', 'rm', '-rf', remote]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
