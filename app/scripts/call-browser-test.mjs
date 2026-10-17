// SPDX-License-Identifier: GPL-3.0-only
// A loopback-only browser check of the production controller/media adapter.
// It generates synthetic media and never opens the microphone or camera.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const pages = new Map([
  ['/test.js', new URL('../tests/browser/calls.js', import.meta.url)],
  ...['controller', 'protocol', 'mediaCore'].map(name => [`/${name}.js`, new URL(`../src/calls/${name}.ts`, import.meta.url)]),
]);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:");
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Tiho call transport check</title><style>body{font:16px system-ui;background:#f5f4ef;color:#17241e;padding:40px;max-width:840px;margin:auto}button{padding:14px 22px;border:0;border-radius:8px;background:#173c2b;color:white;font:inherit}pre{white-space:pre-wrap;line-height:1.6}</style><h1>Tiho call transport check</h1><p>Two browser peers exchange synthetic audio and video using the app’s call controller. No microphone or camera is accessed.</p><button id="run">Run voice and video checks</button><pre id="result" aria-live="polite">Ready</pre><script type="module" src="/test.js"></script></html>'); return;
  }
  const path = pages.get(request.url);
  if (!path) { response.writeHead(404); response.end(); return; }
  try {
    const source = await readFile(path, 'utf8');
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(path.pathname.endsWith('.ts') ? ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replaceAll(".ts'", ".js'") : source);
  } catch { response.writeHead(500); response.end('Test source unavailable'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Call check: http://127.0.0.1:${server.address().port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
