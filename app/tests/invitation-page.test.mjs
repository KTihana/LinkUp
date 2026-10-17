// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const script = readFileSync(new URL('../../docs/invite.js', import.meta.url), 'utf8');
function page(hash, userAgent = 'Android') {
  const elements = new Map(); let copied;
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', addEventListener(name, fn) { this[name] = fn; } }); return elements.get(id); } };
  const location = Object.freeze({ hash });
  runInNewContext(script, { window: { location }, document, navigator: { userAgent, platform: 'Linux', maxTouchPoints: 0, clipboard: { async writeText(value) { copied = value; } } } });
  return { elements, copied: () => copied };
}
test('opening or revisiting a QR link never launches or redirects before an explicit action', async () => {
  const token = `test-payload.${'a'.repeat(128)}`;
  for (let visit=0;visit<2;visit++) {
    const p=page(`#${token}`);
    assert.equal(p.elements.get('invitation').hidden, false);
    assert.equal(p.elements.get('open').href, `common://invite?token=${token}`);
    assert.equal(p.elements.get('code').value, `common://invite?token=${token}`);
    assert.equal(p.copied(), undefined);
    await p.elements.get('copy').click();
    assert.equal(p.copied(), `common://invite?token=${token}`);
  }
});
test('invalid or missing invitations cannot construct an app launch link', () => {
  for (const value of ['', '#javascript:alert(1)', '#abc&token=more', `#${'x'.repeat(2049)}`]) {
    const p=page(value);
    assert.equal(p.elements.has('open'), false);
    if (value) assert.equal(p.elements.get('error').hidden, false);
  }
});
test('iPhone visitors see availability instead of an Android install button', () => {
  const p=page('', 'iPhone');
  assert.equal(p.elements.get('download').hidden, true);
  assert.match(p.elements.get('availability').textContent, /iPhone support is still being built/);
});
