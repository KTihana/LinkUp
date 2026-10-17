import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BackgroundPort } from '../src/notifications/backgroundCore.ts';
import { makeVault, openVault, sealVault, VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
import { decodeMessaging, encodeMessaging, Messenger } from '../src/messaging/messenger.ts';
import { withVaultWrite } from '../src/security/withVaultWrite.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
import { createRelay } from '../../relay/server.mjs';
const random = async n => new Uint8Array(randomBytes(n));
function fixture({ policy = 'automatic', enabled = true, endpoint = 'https://mailbox.example.org' } = {}) {
  const key = randomBytes(32), data = makeVault(randomBytes(32), { name: 'Anon', about: '' }, false);
  const messaging = decodeMessaging(null); messaging.endpoint = endpoint; messaging.enabled = enabled; messaging.policy = policy;
  data.messaging = encodeMessaging(messaging);
  let disk = sealVault(data, key, randomBytes(24)), allowed = true, writes = 0;
  const store = { getItem: async () => disk, setItem: async (_k, value) => { writes++; disk = value; } };
  const port = new BackgroundPort(bytesToHex(key), store, withVaultWrite, random, () => allowed);
  return { key, store, port, read: () => openVault(disk, key), record: () => disk, writes: () => writes, revoke: () => { allowed = false; } };
}
test('background port preserves profile and persists only authenticated encrypted vault records', async () => {
  const f = fixture();
  await f.port.transact(async (state, signer) => {
    const data = decodeMessaging(state); data.enabled = false;
    assert.match(signer.sign(new TextEncoder().encode('common/mailbox-request/v1\ntest')), /^[a-f0-9]{128}$/);
    return { state: encodeMessaging(data), result: true };
  });
  assert.equal(f.read().profile.name, 'Anon');
  assert.equal(decodeMessaging(f.read().messaging).enabled, false);
  assert.ok(!f.record().includes('mailbox.example.org') && !f.record().includes('Anon'));
  assert.equal(f.writes(), 1); f.port.close();
});
test('Nearby only and paused delivery refuse background operations before signing or network', async () => {
  for (const preferences of [{ policy: 'nearby-only' }, { enabled: false }]) {
    const f = fixture(preferences); let called = false;
    await assert.rejects(f.port.transact(async state => { called = true; return { state, result: null }; }), /paused/);
    assert.equal(called, false); assert.equal(f.writes(), 0); f.port.close();
  }
});
test('device-lock revocation and timeout/close revoke retained signers and prevent late writes', async () => {
  const f = fixture(); let signer;
  await f.port.transact(async (state, retained) => { signer = retained; return { state, result: null }; });
  f.revoke();
  assert.throws(() => signer.sign(new TextEncoder().encode('common/mailbox-request/v1\ntest')), /locked/);
  await assert.rejects(f.port.transact(async state => ({ state, result: null })), /locked/);
  f.port.close(); assert.equal(f.writes(), 0);
  const g = fixture();
  await assert.rejects(g.port.transact(async state => { g.port.close(); return { state, result: null }; }), /locked/);
  assert.equal(g.writes(), 0);
});
test('background signing is limited to transport contexts and newest policy is read for every transaction', async () => {
  const f = fixture();
  await f.port.transact(async (state, signer) => {
    assert.throws(() => signer.sign(new TextEncoder().encode('common/invitation/v1\nunauthorized')), /Unsupported/);
    assert.throws(() => signer.sign(new TextEncoder().encode('common/group/v1\nunauthorized')), /Unsupported/);
    const data = decodeMessaging(state); data.policy = 'nearby-only'; return { state: encodeMessaging(data), result: null };
  });
  await assert.rejects(f.port.transact(async state => ({ state, result: null })), /paused/); f.port.close();
});
test('notification reply retries use one durable message ID', async () => {
  const f = fixture();
  // This test needs a real accepted identity to exercise queue deduplication.
  const friend = makeVault(randomBytes(32), { name: 'Friend', about: '' }, false).identity.publicKey;
  const data = f.read(); data.contacts = [{ publicKey: friend, name: 'Friend', addedAt: Date.now() }];
  await f.store.setItem('common.encrypted-vault.v1', sealVault(data, f.key, randomBytes(24)));
  const messenger = new Messenger(f.port, random);
  const id = 'f'.repeat(32);
  await messenger.send(friend, 'reply from notification', 'text', id);
  await messenger.send(friend, 'reply from notification', 'text', id);
  const messages = (await messenger.view()).conversations[friend].messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].id, id); assert.equal(messages[0].status, 'queued'); f.port.close();
});
test('foreground edits merge background messaging writes without losing profile or chat state', async () => {
  const f = fixture();
  const controller = new VaultController({ store: f.store, recordKey: 'common.encrypted-vault.v1', randomBytes: random, withWrite: withVaultWrite, now: Date.now, signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName, isForeground: () => true, reloadExternalWrites: true });
  await controller.start(); await controller.unlock(bytesToHex(f.key));
  await f.port.transact(async state => { const data = decodeMessaging(state); data.enabled = false; return { state: encodeMessaging(data), result: null }; });
  await controller.saveProfile({ name: 'Changed foreground name', about: 'Both changes survive' });
  assert.equal(f.read().profile.name, 'Changed foreground name');
  assert.equal(decodeMessaging(f.read().messaging).enabled, false);
  controller.stop(); f.port.close();
});
test('background clients receive authenticated MLS messages and send one durable reply across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkup-background-http-'));
  const relay = await createRelay({ dataDir: directory, rateLimits: { requestsPerMinute: 10000, globalRequestsPerMinute: 10000 } });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${relay.server.address().port}`;
  const a = fixture({ endpoint }), b = fixture({ endpoint });
  for (const [self, friend] of [[a,b],[b,a]]) {
    const data = self.read(); data.contacts = [{ publicKey: friend.read().identity.publicKey, name: 'Friend', addedAt: Date.now() }];
    await self.store.setItem('common.encrypted-vault.v1', sealVault(data, self.key, randomBytes(24)));
  }
  const alice = new Messenger(a.port, random, Date.now, fetch, ensureMessagingCrypto);
  const bob = new Messenger(b.port, random, Date.now, fetch, ensureMessagingCrypto);
  t.after(() => { alice.suspend(); bob.suspend(); a.port.close(); b.port.close(); });
  await alice.sync(); await bob.sync();
  const bobKey = b.read().identity.publicKey, aliceKey = a.read().identity.publicKey;
  await alice.send(bobKey, 'private background delivery'); await alice.sync();
  const disk = await readFile(join(directory, 'mailbox-v1.json'), 'utf8');
  assert.ok(!disk.includes('private background delivery'));
  await bob.sync();
  assert.equal((await bob.view()).conversations[aliceKey].messages[0].content, 'private background delivery');
  const replyId = 'e'.repeat(32);
  await bob.send(aliceKey, 'reply from the notification shade', 'text', replyId);
  bob.suspend(); b.port.close();
  const restoredPort = new BackgroundPort(bytesToHex(b.key), b.store, withVaultWrite, random, () => true);
  const restored = new Messenger(restoredPort, random, Date.now, fetch, ensureMessagingCrypto);
  t.after(() => { restored.suspend(); restoredPort.close(); });
  await restored.send(aliceKey, 'reply from the notification shade', 'text', replyId);
  await restored.sync(); await alice.sync(); await restored.sync();
  const rows = (await alice.view()).conversations[bobKey].messages.filter(m => !m.mine && m.id === replyId);
  assert.equal(rows.length, 1); assert.equal(rows[0].content, 'reply from the notification shade');
  assert.ok(!b.record().includes('private background delivery') && !b.record().includes('reply from the notification shade'));
});

test('durable deletion intent blocks a restarted background job even with stale native permission', async () => {
  const f=fixture();const get=f.store.getItem;let called=false;
  f.store.getItem=async name=>name==='common.encrypted-vault.v1.reset.v1'?'1':get(name);
  await assert.rejects(f.port.transact(async state=>{called=true;return {state,result:null};}),/being deleted/);
  assert.equal(called,false);assert.equal(f.writes(),0);
  await assert.rejects(f.port.transact(async state=>({state,result:null})),/locked/);
});
