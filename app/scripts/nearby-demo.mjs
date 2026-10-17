// SPDX-License-Identifier: GPL-3.0-only
// Developer demo of encrypted Nearby delivery over a bounded in-memory packet
// channel. It exercises the actual vault and MLS protocol, not physical radios.
import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultController } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
import { Messenger } from '../src/messaging/messenger.ts';
import { NearbyTransport } from '../src/messaging/nearbyTransport.ts';
import { decodeNearbyPacket } from '../src/messaging/nearbyProtocol.ts';
import { ensureMessagingCrypto } from '../src/messaging/cryptoRuntime.web.ts';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const secureRandom = async length => new Uint8Array(randomBytes(length));
const directory = await mkdtemp(join(tmpdir(), 'common-nearby-demo-'));
const controllers = new Set(), services = new Set();
const firstText = 'Hello over our private nearby connection 🌿';
let aliceKey = '', bobKey = '', httpCalls = 0;
const listeners = [new Set(), new Set()], packets = [];
const channels = [0, 1].map(side => ({
  subscribe(listener) { listeners[side].add(listener); return () => listeners[side].delete(listener); },
  async send(linkId, payload) { decodeNearbyPacket(payload); packets.push(payload); for (const listener of listeners[1 - side]) listener({ linkId, payload }); },
}));
const noHTTP = async () => { httpCalls += 1; throw new Error('HTTP is forbidden in this demo.'); };
const history = async (messenger, peer) => (await messenger.view()).conversations[peer]?.messages ?? [];
async function client(vault, side, friend) {
  const port = { transact: vault.transactMessaging };
  const service = new NearbyTransport({ port, channel: channels[side], randomBytes: secureRandom, timeoutMs: 500 });
  services.add(service); await service.start(); service.attachLink('friend-link', friend);
  const messenger = new Messenger(port, secureRandom, Date.now, noHTTP, ensureMessagingCrypto);
  messenger.attachNearby(service); await messenger.setPolicy('nearby-only');
  return { messenger, service };
}
async function resume(store, unlockKey) {
  const vault = controller(store); await vault.start(); assert.equal(vault.getSnapshot().status, 'locked');
  await vault.unlock(unlockKey); return vault;
}
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


try {
  await chmod(directory, 0o700); await ensureMessagingCrypto();
  const aliceStore = diskStore(join(directory, 'alice.encrypted.json'));
  const bobStore = diskStore(join(directory, 'bob.encrypted.json'));
  const alice = await createIdentity('Alice', aliceStore), bob = await createIdentity('Bob', bobStore);
  aliceKey = alice.key; bobKey = bob.key;
  await alice.vault.acceptInvite(await bob.vault.createInvite()); await bob.vault.acceptInvite(await alice.vault.createInvite());
  const a = await client(alice.vault, 0, bob.publicKey), b = await client(bob.vault, 1, alice.publicKey);
  await b.messenger.sync(); await a.messenger.sync();
  console.log('✓ Two independent encrypted vaults and signed invitations; Nearby only selected.');
  b.service.stop(); bob.vault.stop();
  await a.messenger.send(bob.publicKey, firstText);
  await assert.rejects(a.messenger.sync(), /did not respond/);
  assert.equal((await history(a.messenger, bob.publicKey))[0].status, 'queued');
  assert.equal(httpCalls, 0);
  console.log('✓ Out-of-range friend: message remains in the encrypted queue with no internet fallback.');
  const returnedVault = await resume(bobStore, bobKey);
  const returned = await client(returnedVault, 1, alice.publicKey); await returned.messenger.sync();
  await a.messenger.sync(); assert.equal((await history(a.messenger, bob.publicKey))[0].status, 'stored');
  returned.service.stop(); returnedVault.stop();
  assert.ok(!await bobStore.getItem('vault').then(record => record.includes(firstText)));
  console.log('✓ Friend reconnects: encrypted Welcome and message commit to the receiver vault before confirmation.');
  const restartedVault = await resume(bobStore, bobKey);
  const restarted = await client(restartedVault, 1, alice.publicKey); await restarted.messenger.sync(); await a.messenger.sync();
  assert.equal((await history(restarted.messenger, alice.publicKey))[0].content, firstText);
  assert.equal((await history(a.messenger, bob.publicKey))[0].status, 'delivered');
  await restarted.messenger.send(alice.publicKey, 'cat-mint', 'sticker'); await restarted.messenger.sync(); await a.messenger.sync(); await restarted.messenger.sync();
  assert.equal((await history(a.messenger, bob.publicKey))[1].content, 'cat-mint');
  assert.equal((await history(restarted.messenger, alice.publicKey))[1].status, 'delivered');
  assert.ok(packets.every(packet => !packet.includes(firstText)));
  assert.equal(httpCalls, 0);
  for (const store of [aliceStore, bobStore]) {
    const encrypted = await store.getItem('vault');
    assert.ok(!encrypted.includes(firstText) && !encrypted.includes(aliceKey.replaceAll('-', '')) && !encrypted.includes(bobKey.replaceAll('-', '')));
  }
  console.log('PASS: Two encrypted vaults → Nearby packet delivery → restart/unlock → authenticated receipts → sticker reply. HTTP calls: 0.');
  console.log('Physical Wi-Fi/Bluetooth operation still requires the Android development build and two-device testing.');
} catch (error) {
  console.error(`Nearby demo failed: ${error.message}`); process.exitCode = 1;
} finally {
  for (const service of services) service.stop(); for (const vault of controllers) vault.stop();
  aliceKey = ''; bobKey = ''; await rm(directory, { recursive: true, force: true });
}
