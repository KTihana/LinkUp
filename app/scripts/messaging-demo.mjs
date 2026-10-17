// SPDX-License-Identifier: GPL-3.0-only
// Disposable developer demonstration: two actual encrypted vaults, one HTTP
// mailbox relay, offline first-message delivery, restart and encrypted receipts.
// This never opens the app's normal storage or makes external network requests.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, webcrypto } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
import { Messenger } from '../src/messaging/messenger.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
import { createRelay } from '../../relay/server.mjs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const secureRandom = async length => new Uint8Array(randomBytes(length));
const decoder = new TextDecoder('utf-8', { fatal: true });
const firstText = 'Hello Bob! This was sent while you were offline. 🌿';
const replyText = 'Hi Alice! My encrypted messages survived a restart. 🎉';
const directory = await mkdtemp(join(tmpdir(), 'common-offline-demo-'));
const controllers = new Set();
let relay;
let aliceKey = '', bobKey = '';

function diskStore(path) {
  return {
    async getItem(name) {
      if (name !== 'vault') throw new Error('Unexpected demo record name.');
      try { return await readFile(path, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async setItem(name, value) {
      if (name !== 'vault') throw new Error('Unexpected demo record name.');
      const record = JSON.parse(value);
      assert.deepEqual(Object.keys(record), ['version', 'algorithm', 'nonce', 'ciphertext'], 'Only encrypted vault envelope fields can be written.');
      assert.equal(record.algorithm, 'XChaCha20-Poly1305', 'Only encrypted vault records can be written by this demo.');
      assert.ok(typeof record.ciphertext === 'string' && /^[0-9a-f]+$/.test(record.ciphertext), 'Missing encrypted vault contents.');
      const temporary = `${path}.tmp`;
      try {
        await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    },
  };
}

function controller(store) {
  const vault = new VaultController({
    store, recordKey: 'vault', randomBytes: secureRandom,
    // Model web storage: keys stay in memory and a restart must unlock the vault.
    readDeviceKey: async () => null, saveDeviceKey: async () => {},
    withWrite: async task => task(), now: Date.now,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
  });
  controllers.add(vault);
  return vault;
}

async function createIdentity(name, store) {
  const vault = controller(store);
  await vault.start();
  assert.equal(vault.getSnapshot().status, 'preview');
  await vault.saveProfile({ name, about: 'Disposable developer demo identity.' });
  await vault.beginSetup();
  const key = vault.getSnapshot().pendingKey;
  assert.ok(key, 'Vault setup must provide a private unlock key.');
  await vault.commitSetup();
  assert.equal(vault.getSnapshot().status, 'unlocked');
  const identity = vault.getSnapshot().identity;
  assert.ok(identity?.startsWith('common:'), 'The vault must create a stable Common identity.');
  return { vault, key, publicKey: identity.slice('common:'.length) };
}

const history = async (messenger, peer) => (await messenger.view()).conversations[peer]?.messages ?? [];
const decodeWire = envelope => JSON.parse(decoder.decode(base64.decode(envelope.ciphertext)));

try {
  await chmod(directory, 0o700);
  await ensureMessagingCrypto();
  relay = await createRelay({ dataDir: join(directory, 'relay') });
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${relay.server.address().port}`;
  const envelopes = [];
  const demoFetch = async (url, options) => {
    const address = new URL(url);
    assert.equal(address.origin, endpoint, 'The demo may only use its own loopback relay.');
    if (address.pathname === '/v1/publish') {
      const request = JSON.parse(options.body);
      envelopes.push(JSON.parse(request.payload).envelope);
    }
    return fetch(url, options);
  };
  const messenger = vault => new Messenger(
    { transact: vault.transactMessaging }, secureRandom, Date.now, demoFetch, ensureMessagingCrypto,
  );
  const aliceStore = diskStore(join(directory, 'alice.encrypted.json'));
  const bobStore = diskStore(join(directory, 'bob.encrypted.json'));
  const alice = await createIdentity('Alice', aliceStore);
  const bob = await createIdentity('Bob', bobStore);
  aliceKey = alice.key; bobKey = bob.key;
  assert.notEqual(alice.publicKey, bob.publicKey, 'The clients must have independent identities.');
  await alice.vault.acceptInvite(await bob.vault.createInvite());
  await bob.vault.acceptInvite(await alice.vault.createInvite());
  const aliceClient = messenger(alice.vault), bobClient = messenger(bob.vault);
  await bobClient.connect(endpoint);
  await aliceClient.connect(endpoint);
  console.log('✓ Alice and Bob created independent encrypted vaults and exchanged signed invitations.');

  // Bob's complete vault controller stops: no secret-bearing operation can run
  // until a new controller loads the encrypted disk record and unlocks it.
  bob.vault.stop();
  await aliceClient.send(bob.publicKey, firstText);
  assert.equal((await history(aliceClient, bob.publicKey))[0].status, 'queued', 'Send must first save the message in the encrypted local queue.');
  // Sending only commits the local queue; the app's polling loop separately
  // syncs it. This standalone demo drives that loop explicitly.
  await aliceClient.sync();
  const aliceFirst = (await history(aliceClient, bob.publicKey))[0];
  assert.equal(aliceFirst.status, 'stored', 'The relay should store the offline message.');
  const relayDisk = await readFile(join(directory, 'relay', 'mailbox-v1.json'), 'utf8');
  const stored = JSON.parse(relayDisk).envelopes.filter(item => item.envelope !== null);
  assert.equal(stored.length, 2, 'A first message should publish one welcome and one encrypted application.');
  assert.ok(!relayDisk.includes(firstText), 'The relay snapshot must not contain chat plaintext.');
  const firstApplication = envelopes.find(envelope => decodeWire(envelope).type === 'application');
  assert.ok(firstApplication, 'The HTTP wire should contain an encrypted application message.');
  const application = decodeWire(firstApplication);
  assert.ok(/^[0-9a-f]+$/.test(application.body), 'The application body must be standard encoded MLS ciphertext.');
  assert.ok(!Buffer.from(application.body, 'hex').toString('utf8').includes(firstText), 'MLS ciphertext must not contain chat plaintext.');
  console.log('✓ Alice sent while Bob was offline: Stored. Relay disk and HTTP wire contain encrypted chat data.');

  const restartedVault = controller(bobStore);
  await restartedVault.start();
  assert.equal(restartedVault.getSnapshot().status, 'locked', 'Restarted storage must require the private vault key.');
  await restartedVault.unlock(bobKey);
  assert.equal(restartedVault.getSnapshot().identity, `common:${bob.publicKey}`, 'Restart must preserve Bob’s identity.');
  const restartedBob = messenger(restartedVault);
  await restartedBob.sync();
  const bobFirst = (await history(restartedBob, alice.publicKey))[0];
  assert.equal(bobFirst.content, firstText, 'Bob should decrypt the message after restarting.');
  await aliceClient.sync();
  assert.equal((await history(aliceClient, bob.publicKey))[0].status, 'delivered', 'Only Bob’s authenticated encrypted receipt should mark delivery.');
  console.log('✓ Bob restarted, unlocked his encrypted vault, received the message, and confirmed: Delivered.');

  await restartedBob.send(alice.publicKey, replyText);
  assert.equal((await history(restartedBob, alice.publicKey))[1].status, 'queued', 'Bob’s reply must be saved locally before publication.');
  await restartedBob.sync();
  await aliceClient.sync();
  assert.equal((await history(aliceClient, bob.publicKey))[1].content, replyText, 'Alice should decrypt Bob’s reply.');
  await restartedBob.sync();
  assert.equal((await history(restartedBob, alice.publicKey))[1].status, 'delivered', 'Alice’s encrypted receipt should confirm Bob’s reply.');
  assert.equal((await aliceClient.view()).queued, 0);
  assert.equal((await restartedBob.view()).queued, 0);
  for (const store of [aliceStore, bobStore]) {
    const encrypted = await store.getItem('vault');
    assert.ok(!encrypted.includes(firstText) && !encrypted.includes(replyText), 'Chat history on disk must remain encrypted.');
    assert.ok(!encrypted.includes(aliceKey.replaceAll('-', '')) && !encrypted.includes(bobKey.replaceAll('-', '')),
      'Private vault unlock keys must never be written to disk.');
  }
  const finalRelayDisk = await readFile(join(directory, 'relay', 'mailbox-v1.json'), 'utf8');
  assert.ok(!finalRelayDisk.includes(firstText) && !finalRelayDisk.includes(replyText), 'The final relay snapshot must not contain chat plaintext.');
  console.log('✓ Bob replied; Alice decrypted it and returned an encrypted delivery receipt. Both queues are empty.');
  console.log('PASS: Two encrypted vaults → offline HTTP delivery → restart/unlock → authenticated receipts → reply.');
} catch (error) {
  console.error(`Demo failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const vault of controllers) vault.stop();
  aliceKey = ''; bobKey = '';
  try { await relay?.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
