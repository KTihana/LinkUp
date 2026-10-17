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
const buildGuide = await readFile(join(root, 'BUILD.md'), 'utf8');
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LinkUp · Android download</title>
<style>body{margin:0;background:#f3f5f9;color:#182033;font:16px system-ui;line-height:1.6}main{max-width:640px;margin:40px auto;padding:24px}.card{background:white;padding:24px;border-radius:10px;margin:22px 0}a.button{display:inline-block;background:#335cff;color:white;padding:14px 22px;border-radius:6px;text-decoration:none;font-weight:600}svg{max-width:240px;height:auto;display:block;margin:18px auto}code{font-size:12px;overflow-wrap:anywhere}</style>
<main><h1>LinkUp for Android</h1><p>Chat, call, and connect with friends.</p>
<div class="card"><p><strong>LinkUp ${version}</strong> · ${(apk.length / 1048576).toFixed(1)} MB<br>Android 7+ · ARM64</p>
<a class="button" href="/${filename}" download>Download LinkUp</a>
<p>Scan with a phone on the same Wi-Fi as this computer.</p>${qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true })}<p><code>${url}</code></p>
<p>Update without uninstalling to keep your chats.</p></div>
<p><a href="/build-guide">Build and setup instructions</a> · ${source ? `<a href="/${sourceName}" download>Source code</a> · ` : ''}<a href="/LICENSE">License</a></p>
<p>SHA-256<br><code>${checksum}</code></p></main></html>`;
const files = new Map([
  ['/', { type: 'text/html; charset=utf-8', data: page }],
  [`/${filename}`, { type: 'application/vnd.android.package-archive', data: apk, name: filename }],
  [`/${filename}.sha256`, { type: 'text/plain', data: `${checksum}  ${filename}\n` }],
  ['/LICENSE', { type: 'text/plain; charset=utf-8', data: await readFile(join(root, '../LICENSE')) }],
  ['/build-guide', { type: 'text/plain; charset=utf-8', data: buildGuide }],
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
