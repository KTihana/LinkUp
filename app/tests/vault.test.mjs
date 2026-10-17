import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, createPublicKey, createPrivateKey, verify } from 'node:crypto';
import { makeVault, sealVault, openVault, parseKey, persistVaultRecord, publicIdentity, addContact, validateData, MAX_CONTACTS, VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, invitationShareUrl, isValidDisplayName, INVITATION_TTL_MS } from '../src/security/invitation.ts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeMessaging, encodeMessaging } from '../src/messaging/messenger.ts';
import { createPackage, startSession } from '../src/messaging/mlsEngine.ts';
import { envelopeBytes } from '../src/messaging/mailboxClient.ts';
const profile = { name: 'Test 🌿', about: 'Private test fixture' };
test('encrypted round trip does not leak profile text', () => {
  const data = makeVault(randomBytes(32), profile, false), key = randomBytes(32);
  const sealed = sealVault(data, key, randomBytes(24));
  assert.equal(sealed.includes(profile.about), false);
  assert.deepEqual(openVault(sealed, key), data);
});
test('wrong keys, modified ciphertext and modified nonce fail closed', () => {
  const key = randomBytes(32), data = makeVault(randomBytes(32), profile, false);
  const sealed = sealVault(data, key, randomBytes(24));
  assert.throws(() => openVault(sealed, randomBytes(32)));
  for (const field of ['ciphertext', 'nonce']) { const tampered = JSON.parse(sealed); tampered[field] = (tampered[field][0] === '0' ? '1' : '0') + tampered[field].slice(1); assert.throws(() => openVault(JSON.stringify(tampered), key)); }
});
test('identity survives profile edits and matches independent Node Ed25519 implementation', () => {
  const seed = randomBytes(32), data = makeVault(seed, profile, false);
  const nativePrivate = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const nativePublic = createPublicKey(nativePrivate).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  assert.equal(data.identity.publicKey, nativePublic);
  assert.equal(publicIdentity({ ...data, profile: { name: 'New name', about: '' } }), publicIdentity(data));
});
test('writes use distinct ciphertext and recovery input is strictly validated', () => {
  const key = randomBytes(32), data = makeVault(randomBytes(32), profile, false);
  assert.notEqual(sealVault(data, key, randomBytes(24)), sealVault(data, key, randomBytes(24)));
  assert.deepEqual(parseKey(key.toString('hex').match(/.{8}/g).join('-')), new Uint8Array(key));
  assert.throws(() => parseKey('password'));
  assert.throws(() => openVault(JSON.stringify({ version: 2 }), key));
  assert.throws(() => sealVault({ ...data, identity: { ...data.identity, publicKey: '0'.repeat(64) } }, key, randomBytes(24)));
});
test('encrypted profile survives a store restart, with stale writes refused', async () => {
  const values = new Map();
  const store = { getItem: async name => values.get(name) ?? null, setItem: async (name, value) => { values.set(name, value); } };
  const key = randomBytes(32), data = makeVault(randomBytes(32), profile, false);
  const first = await persistVaultRecord(store, 'vault', data, key, randomBytes(24), null);
  const edited = { ...data, profile: { name: 'Updated name', about: 'Persisted privately' } };
  const saved = await persistVaultRecord(store, 'vault', edited, key, randomBytes(24), first);
  assert.deepEqual(openVault(await store.getItem('vault'), key).profile, edited.profile);
  await assert.rejects(persistVaultRecord(store, 'vault', data, key, randomBytes(24), first));
  assert.equal(await store.getItem('vault'), saved);
  await assert.rejects(persistVaultRecord(store, 'vault', data, key, randomBytes(24), null));
});
test('a failed write preserves the old encrypted profile', async () => {
  const key = randomBytes(32), data = makeVault(randomBytes(32), profile, false);
  const old = sealVault(data, key, randomBytes(24));
  const store = { getItem: async () => old, setItem: async () => { throw new Error('Storage full'); } };
  await assert.rejects(persistVaultRecord(store, 'vault', { ...data, profile: { name: 'New', about: '' } }, key, randomBytes(24), old));
  assert.deepEqual(openVault(await store.getItem('vault'), key).profile, profile);
});

function friend(name = 'Friend 🌿', addedAt = 1700000000000) {
  return { publicKey: makeVault(randomBytes(32), { name, about: '' }, false).identity.publicKey, name, addedAt };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(record = null, deviceKey = null) {
  const values = new Map(record ? [['vault', record]] : []);
  const dependencies = {
    store: { getItem: async name => values.get(name) ?? null, setItem: async (name, value) => { values.set(name, value); } },
    recordKey: 'vault', randomBytes: async length => new Uint8Array(randomBytes(length)),
    readDeviceKey: async () => deviceKey, saveDeviceKey: async key => { deviceKey = key; },
    withWrite: async task => task(), now: () => 1700000000000,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
  };
  return { values, dependencies, controller: new VaultController(dependencies), savedDeviceKey: () => deviceKey };
}
async function readyVault() {
  const result = fixture();
  await result.controller.start();
  await result.controller.beginSetup();
  const key = result.controller.getSnapshot().pendingKey;
  await result.controller.commitSetup();
  return { ...result, key };
}

test('contacts are encrypted, validated, immutable and bound to a different identity', () => {
  const data = makeVault(randomBytes(32), profile, false), key = randomBytes(32), contact = friend();
  const added = addContact(data, contact);
  assert.deepEqual(data.contacts, []);
  const sealed = sealVault(added, key, randomBytes(24));
  assert.equal(sealed.includes(contact.name), false);
  assert.equal(sealed.includes(contact.publicKey), false);
  assert.deepEqual(openVault(sealed, key).contacts, [contact]);
  assert.throws(() => addContact(added, contact), /already/);
  assert.throws(() => addContact(data, { ...contact, publicKey: data.identity.publicKey }), /belongs to you/);
  for (const malformed of [
    { ...contact, publicKey: '0'.repeat(64) }, { ...contact, publicKey: 'F'.repeat(64) },
    { ...contact, name: '' }, { ...contact, name: 'x'.repeat(51) },
    { ...contact, addedAt: Infinity }, { ...contact, addedAt: -1 }, { ...contact, addedAt: 1.5 },
  ]) assert.throws(() => validateData({ ...data, contacts: [malformed] }));
  assert.throws(() => validateData({ ...data, contacts: [contact, contact] }));
  assert.throws(() => validateData({ ...data, contacts: [{ ...contact, publicKey: data.identity.publicKey }] }));
  const full = { ...data, contacts: Array.from({ length: MAX_CONTACTS }, (_, index) => friend(`Friend ${index}`)) };
  validateData(full);
  assert.throws(() => addContact(full, contact), /full/);
  assert.throws(() => validateData({ ...full, contacts: [...full.contacts, contact] }));
});

test('original v1 records gain empty contacts without changing their identity', () => {
  const original = makeVault(randomBytes(32), profile, false), key = randomBytes(32);
  delete original.contacts;
  const opened = openVault(sealVault(original, key, randomBytes(24)), key);
  assert.deepEqual(opened.contacts, []);
  assert.deepEqual(opened.identity, original.identity);
  assert.deepEqual(opened.profile, original.profile);
});

test('controller accepts actual signed invitations, persists contacts across restart and refuses self/duplicates/tampering', async () => {
  const { controller, values, dependencies, key } = await readyVault();
  const ownToken = await controller.createInvite();
  await assert.rejects(controller.acceptInvite(ownToken), /belongs to you/);
  const remote = makeVault(randomBytes(32), { name: 'A real contact 🌿', about: '' }, false);
  const token = createInvitation(Buffer.from(remote.identity.seed, 'hex'), remote.profile.name, randomBytes(16), dependencies.now());
  await controller.acceptInvite(invitationShareUrl(token));
  assert.deepEqual(controller.getSnapshot().contacts, [{ publicKey: remote.identity.publicKey, name: remote.profile.name, addedAt: dependencies.now() }]);
  const saved = values.get('vault');
  assert.equal(saved.includes(remote.profile.name), false);
  assert.equal(saved.includes(remote.identity.publicKey), false);
  await assert.rejects(controller.acceptInvite(token), /already/);
  const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  await assert.rejects(controller.acceptInvite(tampered));
  assert.equal(values.get('vault'), saved);
  controller.stop();
  const restarted = fixture(saved);
  await restarted.controller.start();
  assert.equal(restarted.controller.getSnapshot().status, 'locked');
  await restarted.controller.unlock(key);
  assert.deepEqual(restarted.controller.getSnapshot().contacts, openVault(saved, parseKey(key)).contacts);
  assert.equal(restarted.savedDeviceKey(), null); // No unauthenticated convenience copy.
});

test('invitation expiry is checked again after waiting for the write lock', async () => {
  const { controller, dependencies, values } = await readyVault();
  const clock = dependencies.now(), token = createInvitation(randomBytes(32), 'Expiring friend', randomBytes(16), clock);
  inspectInvitation(token, clock); // The screen's earlier preview was valid.
  const entered = deferred(), release = deferred();
  dependencies.withWrite = async task => { entered.resolve(); await release.promise; return task(); };
  const oldRecord = values.get('vault'), accepting = controller.acceptInvite(token);
  const rejected = assert.rejects(accepting, /expired/);
  await entered.promise;
  dependencies.now = () => clock + INVITATION_TTL_MS;
  release.resolve();
  await rejected;
  assert.deepEqual(controller.getSnapshot().contacts, []);
  assert.equal(values.get('vault'), oldRecord);
});

test('removing a friend atomically cancels delivery, retires MLS keys and preserves read-only history across restart', { timeout: 120000 }, async () => {
  const { controller, values, dependencies, key } = await readyVault();
  const remoteSeed = randomBytes(32), remote = makeVault(remoteSeed, { name: 'Removed friend', about: '' }, false);
  const otherSeed = randomBytes(32), other = makeVault(otherSeed, { name: 'Kept friend', about: '' }, false);
  const now = dependencies.now(), expiry = now + 86400000;
  const invitation = createInvitation(remoteSeed, remote.profile.name, randomBytes(16), now);
  await controller.acceptInvite(invitation);
  await controller.acceptInvite(createInvitation(otherSeed, other.profile.name, randomBytes(16), now));
  const self = controller.getSnapshot().identity.replace(/^common:/, ''), peer = remote.identity.publicKey;
  const bundle = await createPackage(`common:${peer}`);
  const session = await startSession(`common:${self}`, `common:${peer}`, bundle.publicData, randomBytes(32));
  const messageId = randomBytes(16).toString('hex'), pendingId = randomBytes(16).toString('hex');
  const history = [
    { id: randomBytes(16).toString('hex'), content: 'Already received', mine: false, kind: 'text', createdAt: now, status: 'delivered' },
    { id: messageId, content: 'Ciphertext waiting to leave', mine: true, kind: 'text', createdAt: now, status: 'queued' },
    { id: pendingId, content: 'Waiting to encrypt', mine: true, kind: 'text', createdAt: now, status: 'queued' },
    { id: randomBytes(16).toString('hex'), content: 'Already delivered', mine: true, kind: 'text', createdAt: now, status: 'delivered' },
    { id: randomBytes(16).toString('hex'), content: 'Already at their mailbox', mine: true, kind: 'text', createdAt: now, status: 'stored' },
  ];
  const ciphertext = Buffer.from(JSON.stringify({ type: 'application', groupId: session.groupId, body: 'opaque test ciphertext' })).toString('base64');
  const inbound = { version: 1, id: randomBytes(16).toString('hex'), sender: peer, recipient: self, createdAt: now, expiresAt: expiry, ciphertext };
  inbound.signature = Buffer.from(ed25519.sign(envelopeBytes(inbound), remoteSeed)).toString('hex');
  await controller.transactMessaging(async (_, signer) => {
    const data = decodeMessaging(null);
    const outbound = { version: 1, id: randomBytes(16).toString('hex'), sender: self, recipient: peer, createdAt: now, expiresAt: expiry, ciphertext };
    outbound.signature = signer.sign(envelopeBytes(outbound));
    data.endpoint = 'https://mailbox.example'; data.enabled = true;
    data.admission = { endpoint: data.endpoint, peers: [peer, other.identity.publicKey].sort(), revision: 8 };
    data.conversations[peer] = { state: session.state, groupId: session.groupId, messages: history, setupExpiresAt: expiry,
      rotation: { updatedAt: now, messages: 0, cycle: false, received: [], receipts: [] },
      retiredGroups: Array.from({ length: 16 }, () => ({ groupId: randomBytes(32).toString('hex'), expiresAt: expiry })) };
    data.conversations[other.identity.publicKey] = { state: '', groupId: '', messages: [] };
    data.pending = [{ peer, messageId: pendingId, expiresAt: expiry }];
    data.outbox = [{ envelope: outbound, messageId }];
    data.seen = [{ sender: peer, id: inbound.id, expiresAt: expiry }];
    data.nearby = { version: 1, packages: [], claimed: [{ id: randomBytes(16).toString('hex'), expiresAt: expiry }],
      inbox: [inbound], accepted: [{ sender: peer, id: inbound.id, expiresAt: expiry }] };
    return { state: encodeMessaging(data), result: undefined };
  });
  const before = values.get('vault'), setItem = dependencies.store.setItem;
  dependencies.store.setItem = async () => { throw new Error('Storage full'); };
  await assert.rejects(controller.removeContact(peer), /Storage full/);
  assert.equal(values.get('vault'), before);
  assert.equal(controller.getSnapshot().contacts.length, 2);
  dependencies.store.setItem = setItem;
  await controller.removeContact(peer);
  const saved = values.get('vault'), removed = decodeMessaging(openVault(saved, parseKey(key)).messaging);
  assert.deepEqual(controller.getSnapshot().contacts.map(contact => contact.publicKey), [other.identity.publicKey]);
  assert.deepEqual(removed.pending, []); assert.deepEqual(removed.outbox, []); assert.deepEqual(removed.nearby.inbox, []);
  assert.equal(removed.nearby.accepted.length, 1); assert.equal(removed.nearby.claimed.length, 1); assert.equal(removed.seen.length, 1);
  assert.deepEqual(removed.admission, { endpoint: 'https://mailbox.example', peers: [other.identity.publicKey], revision: 9 });
  const conversation = removed.conversations[peer];
  assert.deepEqual(conversation.messages.map(row => row.content), history.map(row => row.content));
  assert.deepEqual(conversation.messages.map(row => row.error), [undefined, 'Friend removed; message cancelled', 'Friend removed; message cancelled', undefined, undefined]);
  assert.equal(conversation.messages.at(-1).status, 'stored');
  assert.equal(conversation.state, ''); assert.equal(conversation.groupId, '');
  assert.equal(conversation.rotation, undefined); assert.equal(conversation.setupExpiresAt, undefined);
  assert.equal(conversation.retiredGroups.length, 16); assert.equal(conversation.retiredGroups.at(-1).groupId, session.groupId);
  assert.ok(removed.conversations[other.identity.publicKey]);
  await controller.removeContact(peer);
  assert.equal(decodeMessaging(openVault(values.get('vault'), parseKey(key)).messaging).admission.revision, 9);
  controller.stop();
  const restarted = fixture(values.get('vault'));
  await restarted.controller.start(); await restarted.controller.unlock(key);
  await restarted.controller.acceptInvite(invitation);
  const readded = decodeMessaging(openVault(restarted.values.get('vault'), parseKey(key)).messaging);
  assert.deepEqual(readded.pending, []); assert.deepEqual(readded.outbox, []);
  assert.equal(readded.conversations[peer].state, ''); assert.equal(readded.conversations[peer].messages.length, 5);
  assert.deepEqual(readded.admission.peers, [other.identity.publicKey]); // Reacceptance is granted only by a fresh sync.
  await assert.rejects(restarted.controller.removeContact(self), /accepted friend/);
  await assert.rejects(restarted.controller.removeContact('invalid'), /accepted friend/);
});

test('cancel during random generation cannot resurrect setup, and another setup can start', async () => {
  const { controller, dependencies, values } = fixture();
  await controller.start();
  const draws = [deferred(), deferred()]; let index = 0;
  dependencies.randomBytes = () => draws[index++].promise;
  const settingUp = controller.beginSetup(), rejected = assert.rejects(settingUp, /cancelled/);
  await assert.rejects(controller.beginSetup(), /unavailable/);
  controller.cancelSetup();
  draws[0].resolve(randomBytes(32)); draws[1].resolve(randomBytes(32));
  await rejected;
  assert.equal(controller.getSnapshot().pendingKey, null);
  assert.equal(values.size, 0);
  dependencies.randomBytes = async length => randomBytes(length);
  await controller.beginSetup();
  assert.ok(controller.getSnapshot().pendingKey);
});

test('cancel before setup storage dispatch prevents writing, including the final stale-record read', async () => {
  const { controller, dependencies, values } = fixture();
  await controller.start(); await controller.beginSetup();
  const entered = deferred(), release = deferred(); let reads = 0;
  dependencies.store.getItem = async () => {
    reads += 1;
    if (reads === 2) { entered.resolve(); await release.promise; }
    return null;
  };
  const committing = controller.commitSetup(), rejected = assert.rejects(committing, /again/);
  await entered.promise;
  controller.cancelSetup(); release.resolve();
  await rejected;
  assert.equal(values.size, 0);
  assert.equal(controller.getSnapshot().status, 'preview');
  assert.equal(controller.getSnapshot().pendingKey, null);
});

test('cancel after storage dispatch leaves the completed vault locked instead of adopting its secrets', async () => {
  const { controller, dependencies, values } = fixture();
  await controller.start(); await controller.beginSetup();
  const key = controller.getSnapshot().pendingKey, entered = deferred(), release = deferred();
  dependencies.store.setItem = async (name, value) => { entered.resolve(); await release.promise; values.set(name, value); };
  const committing = controller.commitSetup(), rejected = assert.rejects(committing, /cancelled/);
  await entered.promise;
  controller.cancelSetup(); release.resolve();
  await rejected;
  assert.equal(controller.getSnapshot().status, 'locked');
  assert.equal(controller.getSnapshot().identity, null);
  assert.equal(controller.getSnapshot().pendingKey, null);
  assert.ok(values.get('vault'));
  await controller.unlock(key);
  assert.equal(controller.getSnapshot().status, 'unlocked');
});

test('startup never reads a saved device key, and Lock wins over delayed manual unlock', async () => {
  const original = await readyVault(), record = original.values.get('vault');
  const auto = fixture(record, Buffer.from(parseKey(original.key)).toString('hex'));
  let reads = 0;
  auto.dependencies.readDeviceKey = async () => { reads += 1; throw new Error('Unexpected key access'); };
  await auto.controller.start();
  assert.equal(reads, 0);
  assert.equal(auto.controller.getSnapshot().status, 'locked');
  assert.equal(auto.controller.getSnapshot().identity, null);
  const manual = fixture(record);
  await manual.controller.start();
  const entered = deferred(), release = deferred();
  manual.dependencies.deviceUnlock = { removeLegacyKey: async () => { entered.resolve(); await release.promise; } };
  const unlocking = manual.controller.unlock(original.key), rejected = assert.rejects(unlocking, /locked/);
  await entered.promise;
  manual.controller.lock(); release.resolve();
  await rejected;
  assert.equal(manual.controller.getSnapshot().status, 'locked');
  assert.equal(manual.controller.getSnapshot().identity, null);
});

test('Lock prevents a delayed contact write from dispatching and prevents a pending invite from escaping', async () => {
  const { controller, dependencies, values, key } = await readyVault();
  const token = createInvitation(randomBytes(32), 'Delayed friend', randomBytes(16), dependencies.now());
  const entered = deferred(), release = deferred(), oldRecord = values.get('vault');
  dependencies.store.getItem = async () => { entered.resolve(); await release.promise; return oldRecord; };
  const accepting = controller.acceptInvite(token), rejected = assert.rejects(accepting, /locked/);
  await entered.promise;
  controller.lock(); release.resolve();
  await rejected;
  assert.equal(values.get('vault'), oldRecord);
  assert.deepEqual(controller.getSnapshot().contacts, []);
  dependencies.store.getItem = async () => oldRecord;
  await controller.unlock(key);
  const randomEntered = deferred(), randomRelease = deferred();
  dependencies.randomBytes = async () => { randomEntered.resolve(); return randomRelease.promise; };
  const signing = controller.createInvite(), signingRejected = assert.rejects(signing, /locked/);
  await randomEntered.promise;
  controller.lock(); randomRelease.resolve(randomBytes(16));
  await signingRejected;
});

test('new profile writes refuse unsafe invitation names while old v1 profiles remain readable', async () => {
  const { controller, dependencies, values, key: recovery } = await readyVault();
  const originalRecord = values.get('vault');
  for (const name of ['Bad\u202ename', 'Bad\nname', 'Unpaired\ud800', ' Leading']) {
    await assert.rejects(controller.saveProfile({ name, about: '' }), /display name/);
  }
  assert.equal(values.get('vault'), originalRecord);
  const key = parseKey(recovery);
  const legacy = { ...openVault(originalRecord, key), profile: { name: 'Old\u202ename', about: 'Legacy fixture' } };
  const oldRecord = sealVault(legacy, key, randomBytes(24)), restarted = fixture(oldRecord);
  await restarted.controller.start();
  await restarted.controller.unlock(Buffer.from(key).toString('hex'));
  assert.equal(restarted.controller.getSnapshot().profile.name, legacy.profile.name);
  await assert.rejects(restarted.controller.createInvite());
  await restarted.controller.saveProfile({ name: 'Updated safe name', about: '' });
  assert.equal(inspectInvitation(await restarted.controller.createInvite(), dependencies.now()).name, 'Updated safe name');
});

test('a competing setup leaves existing data intact and switches the stale preview to Unlock', async () => {
  const first = await readyVault(), stale = fixture();
  await stale.controller.start(); await stale.controller.beginSetup();
  const saved = first.values.get('vault');
  stale.values.set('vault', saved);
  await assert.rejects(stale.controller.commitSetup(), /already exists/);
  assert.equal(stale.values.get('vault'), saved);
  assert.equal(stale.controller.getSnapshot().status, 'locked');
  assert.equal(stale.controller.getSnapshot().pendingKey, null);
  assert.equal(stale.savedDeviceKey(), null);
});

test('stop/start effect replay ignores the first delayed load and discards pending setup', async () => {
  const original = await readyVault(), delayed = fixture(original.values.get('vault'), original.key);
  const entered = deferred(), release = deferred(); let reads = 0;
  delayed.dependencies.store.getItem = async () => {
    reads += 1;
    if (reads === 1) { entered.resolve(); return release.promise; }
    return null;
  };
  const oldLoad = delayed.controller.start();
  await entered.promise;
  delayed.controller.stop();
  await delayed.controller.start();
  assert.equal(delayed.controller.getSnapshot().status, 'preview');
  release.resolve(original.values.get('vault'));
  await oldLoad;
  assert.equal(delayed.controller.getSnapshot().status, 'preview');
  assert.equal(delayed.controller.getSnapshot().identity, null);
  await delayed.controller.beginSetup();
  assert.ok(delayed.controller.getSnapshot().pendingKey);
  delayed.controller.stop();
  assert.equal(delayed.controller.getSnapshot().pendingKey, null);
  await delayed.controller.start();
  assert.equal(delayed.controller.getSnapshot().pendingKey, null);
});

test('messaging capabilities survive same-identity saves but expire on Lock and never expose private keys', async () => {
  const { controller, values, key } = await readyVault();
  const signer = await controller.transactMessaging(async (state, signer) => {
    assert.equal(state, null);
    assert.deepEqual(Object.keys(signer).sort(), ['publicKey', 'sign']);
    return { state: 'private ratchet fixture', result: signer };
  });
  const before = values.get('vault');
  assert.equal(before.includes('private ratchet fixture'), false);
  await controller.transactMessaging(async state => ({ state, result: null }));
  assert.equal(values.get('vault'), before); // Read-only operations do not rewrite the record.
  await controller.saveProfile({ name: 'New name', about: '' });
  const bytes = new TextEncoder().encode('common/mailbox-request/v1\nfixture');
  const signature = signer.sign(bytes);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signer.publicKey, 'hex')]), format: 'der', type: 'spki' });
  assert.equal(verify(null, bytes, publicKey, Buffer.from(signature, 'hex')), true);
  assert.throws(() => signer.sign(new TextEncoder().encode('unrelated credential request')), /Unsupported/);
  controller.lock();
  assert.throws(() => signer.sign(bytes), /locked|cancelled/);
  await controller.unlock(key);
  assert.throws(() => signer.sign(bytes), /locked|cancelled/);
});

test('failed messaging persistence and Lock during a pending transaction preserve the previous encrypted state', async () => {
  const { controller, values, dependencies } = await readyVault();
  await controller.transactMessaging(async () => ({ state: 'previous encrypted-state fixture', result: null }));
  const old = values.get('vault'), save = dependencies.store.setItem;
  dependencies.store.setItem = async () => { throw new Error('Storage full'); };
  await assert.rejects(controller.transactMessaging(async () => ({ state: 'new uncommitted ratchet', result: null })), /Storage full/);
  assert.equal(values.get('vault'), old);
  dependencies.store.setItem = save;
  const entered = deferred(), release = deferred();
  const pending = controller.transactMessaging(async () => { entered.resolve(); await release.promise; return { state: 'cancelled ratchet', result: null }; });
  const rejected = assert.rejects(pending, /locked|cancelled/);
  await entered.promise; controller.lock(); release.resolve(); await rejected;
  assert.equal(values.get('vault'), old);
});
