// SPDX-License-Identifier: GPL-3.0-only
// Build a standalone APK locally and sign it with a private, reusable local key.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
const env = { ...process.env, ANDROID_HOME: sdk, CI: '1', NODE_ENV: 'production' };
const architecture = 'arm64-v8a';
const config = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo;
const version = config.version;
const signing = join(root, '.signing'), artifacts = join(root, 'artifacts');
const keyFile = join(signing, 'common-local.p12'), passwordFile = join(signing, 'password');
const apk = join(artifacts, `tiho-${version}-arm64.apk`);
const candidateApk = join(artifacts, `.tiho-${version}-candidate.apk`);
const toolsVersion = (await readdir(join(sdk, 'build-tools'))).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
if (!toolsVersion) throw new Error('Install Android SDK Build Tools first.');
const signer = join(sdk, 'build-tools', toolsVersion, 'apksigner');
const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/keytool') : 'keytool';

function run(command, args, cwd = root, quiet = false) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit' });
    let errorText = '';
    if (quiet) child.stderr.on('data', value => { errorText += value; });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? ok() : fail(new Error(`${command} failed (${code}). ${errorText}`)));
  });
}
function capture(command, args, binary = false) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorText = ''; const chunks = [];
    child.stdout.on('data', value => { if (binary) chunks.push(value); else output += value; });
    child.stderr.on('data', value => { errorText += value; });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? ok(binary ? Buffer.concat(chunks) : output) : fail(new Error(`${command} failed (${code}). ${errorText}`)));
  });
}
async function exists(path) { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

await mkdir(signing, { recursive: true, mode: 0o700 });
await chmod(signing, 0o700);
await mkdir(artifacts, { recursive: true });
if (!(await exists(keyFile))) {
  // Refuse to silently replace an orphaned signing password/key pair.
  if (await exists(passwordFile)) throw new Error('Signing password exists without its key. Restore the key before building an update.');
  await writeFile(passwordFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  await run(keytool, ['-genkeypair', '-keystore', keyFile, '-storetype', 'PKCS12', '-storepass:file', passwordFile,
    '-keypass:file', passwordFile, '-alias', 'common-local', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
    '-dname', 'CN=Common Local Test Build', '-noprompt'], root, true);
  await chmod(keyFile, 0o600);
}
if (!(await exists(passwordFile))) throw new Error('Signing key exists without its password. Restore the password before building.');
await chmod(keyFile, 0o600); await chmod(passwordFile, 0o600);

await run(process.execPath, [join(root, 'scripts/prepare-release.mjs'), '--init']);
await run(process.execPath, [join(root, 'scripts/build-wireguard.mjs')]);
await run(process.execPath, [join(root, 'scripts/build-openssl.mjs')]);
if (!process.argv.includes('--sign-existing')) {
  await run(join(root, 'node_modules/.bin/expo'), ['prebuild', '--platform', 'android', '--no-install']);
  await run('./gradlew', [':app:assembleRelease', `-PreactNativeArchitectures=${architecture}`, '-I', join(root, 'scripts/android-build-limits.gradle'), '--max-workers=1', '--console=plain', '--no-daemon'], join(root, 'android'));
}
const built = join(root, 'android/app/build/outputs/apk/release/app-release.apk');
// A successful Gradle build can still bundle an obsolete entry point (e.g. a
// sibling index.ts shadowing index.js), silently dropping headless tasks.
const sourceMap = JSON.parse(await readFile(join(root, 'android/app/build/intermediates/sourcemaps/react/release/index.android.bundle.packager.map'), 'utf8'));
const entry = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).main;
for (const file of [entry, 'src/notifications/register.android.ts', 'src/notifications/backgroundCore.ts',
  'src/notifications/native.ts', 'src/notifications/NotificationsPanel.tsx', 'src/messaging/groups.ts',
  'src/messaging/messenger.ts', 'src/messaging/removeFriend.ts', 'src/messaging/MessagingProvider.tsx', 'src/messaging/nearbyTransport.ts', 'src/messaging/nearbySession.ts', 'src/messaging/NearbyPanel.tsx', 'src/security/VaultProvider.tsx', 'src/security/vaultCore.ts',
  'modules/common-nearby/index.ts', 'src/calls/CallsProvider.tsx', 'src/vpn/VpnProvider.tsx', 'src/vpn/VpnPanel.tsx', 'src/vpn/native.ts', 'src/vpn/enrollment.ts', 'src/vpn/account.ts', 'src/messaging/mlsEngine.ts', 'src/messaging/mailboxClient.ts', 'src/messaging/nearbyOffer.ts', 'src/calls/mediaCore.ts', 'src/calls/protocol.ts', 'src/updates/release.ts',
  'src/app/_layout.tsx', 'src/CommonApp.tsx', 'src/appearance/palette.ts', 'src/messaging/ConnectionUI.tsx', 'src/security/eraseAccountCaches.ts', 'src/security/pinUnlock.android.ts', 'src/security/pinUnlockCore.ts', 'src/security/PinPad.tsx', 'src/security/deviceKey.android.ts', 'src/security/passwordUnlock.ts', 'src/security/VaultPanel.tsx']) {
  const index = sourceMap.sources.findIndex(source => source === `/${file}` || source === file || source === join(root, file));
  if (index < 0 || sourceMap.sourcesContent[index] !== await readFile(join(root, file), 'utf8')) {
    throw new Error(`APK bundle omits or differs from current ${file}. Rebuild before signing.`);
  }
}
const analyzer = join(sdk, 'cmdline-tools/latest/bin/apkanalyzer');
const builtManifest = await capture(analyzer, ['manifest', 'print', built]);
if (!builtManifest.includes(`android:versionName="${version}"`) || !builtManifest.includes(`android:versionCode="${config.android.versionCode}"`)
  || !builtManifest.includes(`package="${config.android.package}"`)) {
  throw new Error('Built APK version/package differs from app.json. Rebuild before signing; do not relabel an older APK.');
}
// Re-signing removes the generated template's debug signature. The distributable
// uses only the private local certificate. Never distribute the template APK.
// PKCS12 uses the same store/key password. apksigner tries that password for
// the key automatically; passing the same password file twice consumes it twice.
await run(signer, ['sign', '--ks', keyFile, '--ks-key-alias', 'common-local', '--ks-pass', `file:${passwordFile}`, '--v4-signing-enabled', 'false',
  '--out', candidateApk, built]);
await run(signer, ['verify', '--verbose', '--print-certs', candidateApk]);
const manifest = await capture(analyzer, ['manifest', 'print', candidateApk]);
if (/android:debuggable="true"/.test(manifest) || !/android:allowBackup="false"/.test(manifest)
  || /android\.permission\.SYSTEM_ALERT_WINDOW/.test(manifest) || !/android\.permission\.RECORD_AUDIO/.test(manifest)) {
  throw new Error('APK inspection failed: debug/backup/overlay policy or required call microphone permission is incorrect. The candidate is not a distributable.');
}
const fileList = await capture(analyzer, ['files', 'list', candidateApk]);
if (!fileList.includes('/assets/index.android.bundle') || !/\/lib\/arm64-v8a\/libhermes(vm)?\.so/.test(fileList)) {
  throw new Error('APK inspection failed: embedded app bundle or Hermes library is missing.');
}
const embeddedBundle = await capture('unzip', ['-p', candidateApk, 'assets/index.android.bundle'], true);
const generatedBundle = await readFile(join(root, 'android/app/build/generated/assets/react/release/index.android.bundle'));
if (!embeddedBundle.equals(generatedBundle)) throw new Error('APK embeds a different JavaScript bundle from the verified build output.');
const nativeBytecode = await capture('unzip', ['-p', candidateApk, 'classes*.dex'], true);
if (!nativeBytecode.includes(Buffer.from('LinkUpVpnModule')) || !fileList.includes('/lib/arm64-v8a/libwg-go.so') || !manifest.includes('android.permission.BIND_VPN_SERVICE')) throw new Error('APK omits the private-network backend or Android VPN permission.');
// Match the shipped engine and legal assets to the verified build, not just filenames.
const vpnService = manifest.match(/<service\b[^>]*android:name="com\.wireguard\.android\.backend\.GoBackend\$VpnService"[^>]*>[\s\S]*?<\/service>/)?.[0] ?? '';
if (!/android:exported="false"/.test(vpnService) || !/android:permission="android.permission.BIND_VPN_SERVICE"/.test(vpnService)
  || !/android:name="android.net.VpnService"/.test(vpnService) || !/<meta-data[^>]*android:name="android.net.VpnService.SUPPORTS_ALWAYS_ON"[^>]*android:value="false"/.test(vpnService)) throw new Error('APK VPN service consent/always-on declaration differs from the reviewed configuration.');
if (/\/lib\/[^/]+\/libwg(?:-quick)?\.so/.test(fileList) || fileList.split('\n').some(line => /^\/lib\/[^/]+\//.test(line.trim()) && !line.trim().startsWith('/lib/arm64-v8a/'))) throw new Error('APK contains an unreviewed WireGuard helper or architecture.');
const wireguardBuild = JSON.parse(await readFile(join(root, '.native-deps/wireguard/provenance.json'), 'utf8'));
const enginePath = join(root, '.native-deps/wireguard/jni/arm64-v8a/libwg-go.so');
const engine = await readFile(enginePath);
if (createHash('sha256').update(engine).digest('hex') !== wireguardBuild.outputs['jni/arm64-v8a/libwg-go.so']) throw new Error('WireGuard build provenance mismatch.');
const packagedEngine = await capture('unzip', ['-p', candidateApk, 'lib/arm64-v8a/libwg-go.so'], true);
if (!packagedEngine.equals(engine)) {
  const temporary = await mkdtemp(join(artifacts, 'verify-native-'));
  try {
    const stripped = join(temporary, 'libwg-go.so');
    const host = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
    await run(join(sdk, 'ndk', wireguardBuild.ndkVersion, 'toolchains/llvm/prebuilt', host, 'bin/llvm-strip'), ['--strip-unneeded', '-o', stripped, enginePath]);
    if (!packagedEngine.equals(await readFile(stripped))) throw new Error('APK WireGuard engine differs from the verified native build, including expected stripping.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
for (const name of await readdir(join(root, 'legal/wireguard'))) {
  const bundled = await capture('unzip', ['-p', candidateApk, `assets/wireguard/${name}`], true);
  if (!bundled.equals(await readFile(join(root, 'legal/wireguard', name)))) throw new Error(`APK WireGuard notice differs: ${name}`);
}
await writeFile(join(artifacts, `wireguard-${version}-build-provenance.json`), JSON.stringify({ ...wireguardBuild, packagedEngineSha256: createHash('sha256').update(packagedEngine).digest('hex') }, null, 2) + '\n');
const opensslBuild = JSON.parse(await readFile(join(root, '.native-deps/openssl/provenance.json'), 'utf8'));
const quickCrypto = await capture('unzip', ['-p', candidateApk, 'lib/arm64-v8a/libQuickCrypto.so'], true);
if (!quickCrypto.includes(Buffer.from(`OpenSSL ${opensslBuild.version}`)) || quickCrypto.includes(Buffer.from('OpenSSL 3.6.2'))) throw new Error('APK QuickCrypto does not contain the patched OpenSSL build.');
for (const name of await readdir(join(root, 'legal/openssl'))) {
  const bundled = await capture('unzip', ['-p', candidateApk, `assets/openssl/${name}`], true);
  if (!bundled.equals(await readFile(join(root, 'legal/openssl', name)))) throw new Error(`APK OpenSSL notice differs: ${name}`);
}
await writeFile(join(artifacts, `openssl-${version}-build-provenance.json`), JSON.stringify({ ...opensslBuild, packagedQuickCryptoSha256: createHash('sha256').update(quickCrypto).digest('hex') }, null, 2) + '\n');
if (!nativeBytecode.includes(Buffer.from('NativeCompletionKt'))) throw new Error('APK omits the native cleanup bridge fix.');
if (!nativeBytecode.includes(Buffer.from('LinkUpPinUnlockModule'))) throw new Error('APK omits native device-bound app PIN protection.');
if (!nativeBytecode.includes(Buffer.from('LinkUpPhoneUnlockModule')) || !manifest.includes('android.permission.USE_BIOMETRIC')) throw new Error('APK omits the native protected phone-unlock implementation or permission.');
await rename(candidateApk, apk);
// V2/V3 authenticate the distributed APK. Incremental-install sidecars are not
// distributed; never leave a stale sidecar associated with a rebuilt APK.
await rm(`${apk}.idsig`, { force: true });
await rm(`${candidateApk}.idsig`, { force: true });
await writeFile(join(artifacts, 'AndroidManifest.xml'), manifest);
const bytes = await readFile(apk);
const checksum = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${apk}.sha256`, `${checksum}  ${apk.split('/').at(-1)}\n`);
await run(process.execPath, [join(root, 'scripts/prepare-release.mjs')]);
const sourceDir = await mkdtemp(join(artifacts, 'source-'));
const sourceName = `tiho-${version}-source.zip`;
try {
  await run('zip', ['-q', '-r', join(sourceDir, sourceName), 'app', 'relay', 'deploy', 'docs', 'LICENSE', 'README.md', 'IMPLEMENTATION.md', 'PRODUCT-NOTES.md', 'READINESS.md',
    '-x', 'app/node_modules/*', 'relay/node_modules/*', 'app/android/*', 'app/ios/*', 'app/.expo/*', 'app/.signing/*',
    'app/.native-deps/*', 'app/artifacts/*', 'app/dist/*', 'app/dist-android/*', 'app/.env*', 'relay/.env*', 'relay/data/*',
    'deploy/.private/*', 'deploy/.env', 'deploy/certificates/*', 'deploy/vpn-output*/*', 'deploy/vpn/policy*.json',
    'app/modules/*/android/build/*', 'app/modules/*/android/.gradle/*', 'app/modules/*/android/.cxx/*',
    'app/credentials.json', '*.keystore', '*.jks', '*.p12', '*.key', '*.pem', '*.tsbuildinfo', '*.DS_Store'], resolve(root, '..'));
  await rename(join(sourceDir, sourceName), join(artifacts, sourceName));
} finally { await rm(sourceDir, { recursive: true, force: true }); }
console.log(`Standalone signed APK: ${apk}\nSHA-256: ${checksum}\nKeep .signing private and backed up to sign compatible future updates.`);
