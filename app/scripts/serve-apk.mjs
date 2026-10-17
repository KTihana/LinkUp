// SPDX-License-Identifier: GPL-3.0-only
// Serve only the named distributable files, never source-tree or signing files.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(root, 'app.json'), 'utf8')).expo.version;
// Keep the publisher protocol's legacy asset name compatible with Tiho, while
// presenting the renamed app to people downloading it directly.
const legacyFilename = `tiho-${version}-arm64.apk`;
const filename = `linkup-${version}-arm64.apk`;
const apk = await readFile(join(root, 'artifacts', legacyFilename));
const checksum = createHash('sha256').update(apk).digest('hex');
const host = process.env.COMMON_DOWNLOAD_HOST ?? '127.0.0.1';
const local = Object.values(networkInterfaces()).flat().some(entry => entry?.address === host);
const privateV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(host);
if (host !== '127.0.0.1' && !(local && privateV4)) throw new Error('Choose loopback or a private IPv4 address belonging to this computer. Public/wildcard binds are refused.');
const port = 8084;
const url = `http://${host}:${port}/`;
const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
const legacySourceName = `tiho-${version}-source.zip`;
const sourceName = `linkup-${version}-source.zip`;
let source;
try { source = await readFile(join(root, 'artifacts', legacySourceName)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const testGuide = (await readFile(join(root, 'ANDROID-TESTING.md'), 'utf8')).split('\n## Previous ')[0];
const vpnGuide = await readFile(join(root, '../deploy/vpn/README.md'), 'utf8');
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LinkUp · Android download</title>
<style>body{margin:0;background:#f3f5f9;color:#182033;font:16px system-ui;line-height:1.6}main{max-width:720px;margin:40px auto;padding:30px}h1{font-size:40px;line-height:1.15;margin:0 0 15px}.card{background:white;padding:24px;border-radius:24px;margin:22px 0}a.button{display:inline-block;background:#335cff;color:white;padding:14px 22px;border-radius:15px;text-decoration:none;font-weight:600}svg{max-width:240px;height:auto;display:block;margin:15px auto}code{font-size:12px;overflow-wrap:anywhere}.muted{color:#737d90}li{margin:8px 0}</style>
<main><h1>LinkUp for Android</h1><p>A little closer, wherever you are.</p><div class="card"><p><strong>Local test build ${version}</strong> · ${(apk.length / 1048576).toFixed(1)} MB<br>Android 7 or later · 64-bit ARM phones<br>Runs without Expo Go or a development server.</p><a class="button" href="/${filename}" download>Download Android APK</a><p class="muted">Scan this code with a phone on the same Wi-Fi as this computer.</p>${qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true })}<p><code>${url}</code></p></div>
<div class="card"><h2>Test with a friend today</h2><ol><li>Install this same ${version} APK on both phones. Install over the existing app; do not uninstall. New users choose their own six-digit LinkUp PIN (Android 8+), or a longer password. Creating a new account deletes previous local LinkUp data and old archives after a warning.</li><li>Set different names under You → Edit profile. Under You → Invite a friend, create an invitation. The other person scans and adds it from Friends. Reverse roles so both people have added each other.</li><li>Try Wi-Fi first: on phone A open You → Connection → Wi-Fi &amp; hotspot, select your friend and tap Host on this Wi-Fi. On phone B, scan A’s nearby QR from Connection, review it and choose Join nearby Wi-Fi. Both phones must be on the same Wi-Fi. Send messages and replies.</li><li>Then Stop nearby on both phones. Turn Wi-Fi and mobile data off and Bluetooth on. Phone A selects the friend in Connection → Bluetooth and taps Start Bluetooth. Phone B scans A’s nearby QR, reviews it, taps Find friend over Bluetooth and selects the nearby phone. Phone B does not start a second host session.</li><li>Keep LinkUp open and unlocked on both phones. Exchange messages, emojis and stickers, then try sending at the same time. Require decrypted messages and Delivered receipts. Stop and connect again to check that history stays and messages do not duplicate.</li></ol><p>Nearby sessions stop when LinkUp goes into the background, locks or reaches ten minutes. Unlock and start a new session to continue. Android 11 or earlier may also require system Location services for Bluetooth discovery.</p><p class="muted">This security test build adds key renewal, friend-only relay access, screenshot protection and a self-hosted WireGuard prototype. After upgrading both phones, reconnect old chats from Chat options to enable key renewal. Physical two-phone radio testing and independent security review are still pending. No public mailbox is included. Bluetooth is for messages; foreground calls can be tried over Wi-Fi. Notifications and inline replies require a separately configured UnifiedPush provider and push-enabled mailbox.</p><p><a href="/test-guide">Detailed two-phone instructions</a> · <a href="/test-guide" download="LinkUp-two-phone-test.txt">Save instructions</a><br><span class="muted">Record both phone models, Android versions, connection type, the failing step and exact error. Keep your PIN and keys private.</span></p></div>
<div class="card"><h2>Private network prototype</h2><p>Open You → Connection → Private network in Android 9+. A reachable self-hosted WireGuard hub is required; no server is included or running. Calls are disabled in this mode. <a href="/vpn-guide">Self-hosted server setup guide</a> · also included in the source archive at deploy/vpn/README.md.</p></div><div class="card"><h2>Free software</h2><p>LinkUp is GPL-3.0-only. ${source ? `<a href="/${sourceName}" download>Download build source</a> · ` : ''}<a href="/LICENSE">License</a></p><p>APK SHA-256:<br><code>${checksum}</code></p></div></main></html>`;
const files = new Map([
  ['/', { type: 'text/html; charset=utf-8', data: page }],
  [`/${filename}`, { type: 'application/vnd.android.package-archive', data: apk, name: filename }],
  [`/${filename}.sha256`, { type: 'text/plain', data: `${checksum}  ${filename}\n` }],
  ['/LICENSE', { type: 'text/plain; charset=utf-8', data: await readFile(join(root, '../LICENSE')) }],
  ['/test-guide', { type: 'text/plain; charset=utf-8', data: testGuide }],
  ['/vpn-guide', { type: 'text/plain; charset=utf-8', data: vpnGuide }],
]);
if (source) files.set(`/${sourceName}`, { type: 'application/zip', data: source, name: sourceName });
files.set(`/${legacyFilename}`, { type: 'application/vnd.android.package-archive', data: apk, name: legacyFilename });
files.set(`/${legacyFilename}.sha256`, { type: 'text/plain', data: `${checksum}  ${legacyFilename}\n` });
if (source) files.set(`/${legacySourceName}`, { type: 'application/zip', data: source, name: legacySourceName });
const server = createServer((request, response) => {
  const item = files.get(request.url);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(request.method) || !item) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', item.type);
  response.setHeader('Content-Length', Buffer.byteLength(item.data));
  if (item.name) response.setHeader('Content-Disposition', `attachment; filename="${item.name}"`);
  response.end(request.method === 'HEAD' ? undefined : item.data);
});
server.listen(port, host, () => console.log(`Android download: ${url}\nOnly the APK, checksum, guides, licence and optional source archive are served. Ctrl+C stops sharing.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
