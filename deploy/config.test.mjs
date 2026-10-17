// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuration } from './prepare.mjs';
const run = promisify(execFile);
const input = { mailbox: 'mailbox.example.org', turn: 'turn.example.org', publicIp: '203.0.113.20' };
const secret = 'a'.repeat(64);

test('deployment config rejects injection, private addresses, and ambiguous origins', () => {
  for (const mailbox of ['localhost', 'mailbox.example.org\nno-auth', '-bad.example.org']) {
    assert.throws(() => configuration({ ...input, mailbox }, secret));
  }
  for (const publicIp of ['10.0.0.1', '100.64.0.1', '169.254.1.1', '127.0.0.1', '192.168.1.1', '172.31.0.1', '224.0.0.1', '01.2.3.4', '256.2.3.4', '198.18.0.1']) {
    assert.throws(() => configuration({ ...input, publicIp }, secret));
  }
  for (const origin of ['http://example.org', 'https://example.org/', 'https://user:password@example.org', 'https://example.org\nTURN_SECRET=oops']) {
    assert.throws(() => configuration({ ...input, origin }, secret));
  }
  const config = configuration({ ...input, origin: 'https://chat.example.org' }, secret);
  assert.match(config.mailbox, /^ALLOWED_ORIGINS=https:\/\/chat.example.org\n/);
  assert.match(config.turn, /use-auth-secret\n/);
  assert.match(config.turn, /denied-peer-ip=127\.0\.0\.0-127\.255\.255\.255/);
  assert.equal(config.environment.includes(secret), false);
});

test('preparation protects secrets, supports the nonroot TURN container, and refuses replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tiho-deploy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL('./prepare.mjs', import.meta.url), join(dir, 'prepare.mjs'));
  const args = [join(dir, 'prepare.mjs'), input.mailbox, input.turn, input.publicIp];
  const result = await run(process.execPath, args);
  const mailbox = await readFile(join(dir, '.private/mailbox.env'), 'utf8');
  const generated = mailbox.match(/TURN_SECRET=([a-f0-9]{64})/)[1];
  assert.equal(result.stdout.includes(generated), false);
  for (const [path, mode] of [['.private', 0o700], ['.private/certificates', 0o700], ['.private/mailbox.env', 0o600], ['.private/turnserver.conf', 0o444], ['.env', 0o600]]) {
    assert.equal((await stat(join(dir, path))).mode & 0o777, mode);
  }
  await assert.rejects(run(process.execPath, args), /Refusing to overwrite/);
  assert.equal(await readFile(join(dir, '.private/mailbox.env'), 'utf8'), mailbox);
});
