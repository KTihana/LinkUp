// SPDX-License-Identifier: GPL-3.0-only
// Local UI test bench. Both clients use the unmodified exported application.
// Separate origins isolate their browser storage; no keys or identities are seeded.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../relay/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
await stat(resolve(root, 'index.html'));
const port = 8082;
const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const relay = await createRelay({
  dataDir: resolve(dirname(fileURLToPath(import.meta.url)), '../.expo/browser-pair-relay'),
  allowedOrigins: origins,
});
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const bench = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Common · Two-client test</title>
<style>body{margin:0;background:#eeeaf7;color:#272334;font:15px system-ui}header{max-width:940px;margin:auto;padding:18px 20px}h1{font-size:24px;margin:0 0 8px}p{margin:6px 0;line-height:1.5}main{display:flex;gap:24px;justify-content:center;padding:0 20px 24px;flex-wrap:wrap}section{width:390px}h2{font-size:17px}iframe{width:100%;height:760px;border:0;border-radius:24px;background:white;box-shadow:0 8px 30px #27233418}code{user-select:all}button{border:0;border-radius:8px;background:#7160ea;color:white;padding:9px 12px;font:inherit;cursor:pointer}</style>
<header><h1>Common · Two-client test</h1><p>Two independent local identities, using the actual app. Set up each local vault and keep both private keys yourself.</p><p>Mailbox address for both clients: <code>http://127.0.0.1:8787</code>. Use only disposable test profiles here.</p><p>Both panels stay visible so background locking does not interrupt live testing. “Close client” unloads its app to test offline delivery; reopening requires its saved vault key.</p></header>
<main>${origins.map((origin, i) => `<section><h2>Client ${i === 0 ? 'A' : 'B'} <button type="button" data-client="${i}">Close client ${i === 0 ? 'A' : 'B'}</button></h2><iframe id="client-${i}" title="Client ${i === 0 ? 'A' : 'B'}" src="${origin}/?screen=Local%20vault"></iframe></section>`).join('')}</main>
<script>const origins=${JSON.stringify(origins)};document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{const i=Number(button.dataset.client);const frame=document.getElementById('client-'+i);const closed=frame.getAttribute('src')==='about:blank';frame.src=closed?origins[i]+'/?screen=Local%20vault':'about:blank';button.textContent=(closed?'Close':'Reopen')+' client '+(i===0?'A':'B')}));</script></html>`;
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const url = new URL(request.url, origins[0]);
    if (url.pathname === '/__pair') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.method === 'HEAD' ? undefined : bench); return; }
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    let selected = path;
    try { if (!(await stat(selected)).isFile()) selected = resolve(root, 'index.html'); }
    catch { if (extname(url.pathname)) { response.writeHead(404); response.end(); return; } selected = resolve(root, 'index.html'); }
    const data = await readFile(selected);
    response.setHeader('Content-Type', types[extname(selected)] ?? 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(500); response.end('Local preview unavailable.'); }
});
await new Promise((ok, fail) => { relay.server.once('error', fail); relay.server.listen(8787, '127.0.0.1', ok); });
try { await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); }); }
catch (error) { await relay.close(); throw error; }
console.log(`Two-client UI: ${origins[0]}/__pair\nMailbox: http://127.0.0.1:8787\nLoopback only. Ctrl+C stops both servers. Private keys are not read or logged.`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise(ok => server.close(ok));
  await relay.close();
});
