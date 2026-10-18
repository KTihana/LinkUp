import { customSticker } from './fixtures/customSticker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Messenger, decodeMessaging } from '../src/messaging/messenger.ts';
import { readGroupPacket, createGroupDescriptor, validateGroup } from '../src/messaging/groups.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
import { createRelay } from '../../relay/server.mjs';
const random = async n => new Uint8Array(randomBytes(n));
function person(name) {
  const seed = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(seed));
  return { name, publicKey, sign: data => bytesToHex(ed25519.sign(data, seed)) };
}
function port(person, contacts, saved = null) {
  let state = saved, queue = Promise.resolve();
  return { read: () => state, transact(task) { const result = queue.then(async () => { const next = await task(state, person, contacts); state = next.state; return next.result; }); queue = result.catch(() => {}); return result; } };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'linkup-group-'));
  const relay = await createRelay({ dataDir: directory, rateLimits: { requestsPerMinute: 100000, globalRequestsPerMinute: 100000 } });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });
  const people = ['Ana', 'Boris', 'Cora', 'Dino'].map(person);
  const ports = people.map(p => port(p, people.filter(c => c !== p).map(({ publicKey, name }) => ({ publicKey, name }))));
  const clients = ports.map(p => new Messenger(p, random, Date.now, fetch, ensureMessagingCrypto));
  const endpoint = `http://127.0.0.1:${relay.server.address().port}`;
  for (const client of clients) await client.connect(endpoint);
  const rounds = async (count = 2) => { for (let n = 0; n < count; n++) for (const client of clients) await client.sync(); };
  return { people, ports, clients, endpoint, rounds, disk: () => readFile(join(directory, 'mailbox-v1.json'), 'utf8') };
}
test('owner signature binds a fixed unique roster, title and group ID', () => {
  const a = person('Ana'), b = person('Boris'), c = person('Cora');
  const group = createGroupDescriptor('a'.repeat(32), 'Weekend', [a,b,c].map(({name, publicKey}) => ({name, publicKey})), Date.now(), a);
  validateGroup(group);
  for (const changed of [{ ...group, name: 'Other' }, { ...group, owner: b.publicKey }, { ...group, members: group.members.slice(0,2) }]) assert.throws(() => validateGroup(changed));
  assert.throws(() => createGroupDescriptor('a'.repeat(32), 'Duplicate', [{ name:a.name, publicKey:a.publicKey },{ name:b.name,publicKey:b.publicKey },{ name:b.name,publicKey:b.publicKey }], Date.now(), a));
});
test('three clients invite, explicitly join, exchange encrypted group text/stickers, restart and leave', async t => {
  const f = await fixture(t), [a,b,c] = f.people, [alice,bob,cora] = f.clients;
  const id = await alice.createGroup('Secret picnic', [b.publicKey,c.publicKey], a.name);
  await f.rounds();
  assert.equal((await bob.view()).groups[id].status, 'invited');
  await assert.rejects(bob.sendGroup(id, 'not joined'), /Join/);
  await alice.sendGroup(id, 'waiting for you to join'); await f.rounds();
  assert.equal((await bob.view()).groups[id].messages.length, 0, 'pending group contents are hidden until Join');
  await bob.answerGroup(id, true); await cora.answerGroup(id, true); await f.rounds();
  await Promise.all([alice.sendGroup(id, 'bring cake'), bob.sendGroup(id, customSticker, 'sticker'), cora.sendGroup(id, 'I will bring tea')]);
  await f.rounds(3);
  for (const client of [alice,bob,cora]) {
    const view = await client.view(), messages = view.groups[id].messages;
    assert.equal(messages.length, 4);
    assert.deepEqual(new Set(messages.map(m => m.content)), new Set(['bring cake',customSticker,'I will bring tea','waiting for you to join']));
    assert.equal(Object.values(view.conversations).flatMap(c => c.messages).length, 0, 'group packets stay out of private-chat history');
    assert.ok(messages.filter(m => m.mine).every(m => m.status === 'delivered'));
  }
  const disk = await f.disk();
  assert.ok(!disk.includes('Secret picnic') && !disk.includes('bring cake') && !disk.includes('I will bring tea'));
  const restored = new Messenger(port(b, f.people.filter(p => p !== b), f.ports[1].read()), random, Date.now, fetch, ensureMessagingCrypto);
  assert.equal((await restored.view()).groups[id].messages.length, 4);
  const requestId = 'f'.repeat(32);
  await restored.sendGroup(id, 'one notification reply', 'text', requestId);
  await restored.sendGroup(id, 'one notification reply', 'text', requestId);
  assert.equal((await restored.view()).groups[id].messages.filter(m => m.id === requestId).length, 1);
  await cora.answerGroup(id, false); await f.rounds();
  assert.equal((await cora.view()).groups[id].status, 'left');
  await assert.rejects(cora.sendGroup(id, 'left'), /Join/);
  assert.ok((await alice.view()).groups[id].departed.includes(c.publicKey));
});
test('a known friend outside the signed roster cannot inject a group message', async t => {
  const f = await fixture(t), [a,b,c,d] = f.people, [alice,bob,cora,dino] = f.clients;
  const id = await alice.createGroup('Members only', [b.publicKey,c.publicKey], a.name);
  await f.rounds(); await bob.answerGroup(id, true); await cora.answerGroup(id, true); await f.rounds();
  const descriptor = decodeMessaging(f.ports[0].read()).groups[id].descriptor;
  const forged = JSON.stringify({ group: descriptor, event: 'message', kind: 'text', text: 'not a member' });
  readGroupPacket(forged);
  await dino.send(a.publicKey, forged, 'group'); await dino.sync();
  await assert.rejects(alice.sync(), /unauthorized group/);
  assert.equal((await alice.view()).groups[id].messages.length, 0);
  assert.ok(!descriptor.members.some(m => m.publicKey === d.publicKey));
});
