// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDeviceUnlock, BIOMETRIC_KEY, BIOMETRIC_MARKER, LEGACY_DEVICE_KEY } from '../src/security/deviceUnlockCore.ts';
import { VaultController, parseKey, openVault } from '../src/security/vaultCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function nativeStore() {
  const values = new Map(), calls = [], hooks = {};
  let available = true, deny = false;
  const store = {
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 9,
    canUseBiometricAuthentication: () => available,
    getItemAsync: async (name, options) => {
      calls.push({ operation: 'get', name, options });
      if (name === BIOMETRIC_KEY) { if (hooks.read) await hooks.read(); if (deny) throw new Error('Authentication cancelled'); }
      return values.get(name) ?? null;
    },
    setItemAsync: async (name, value, options) => {
      calls.push({ operation: 'set', name, options });
      if (hooks.write) await hooks.write(name);
      values.set(name, value);
    },
    deleteItemAsync: async (name, options) => {
      calls.push({ operation: 'delete', name, options });
      if (hooks.delete) await hooks.delete(name);
      values.delete(name);
    },
  };
  return { values, calls, hooks, store, device: createDeviceUnlock(store), available: value => { available = value; }, deny: value => { deny = value; } };
}
function fixture(native = nativeStore(), record = null) {
  const values = new Map(record ? [['vault', record]] : []);
  let foreground = true;
  const dependencies = {
    store: { getItem: async name => values.get(name) ?? null, setItem: async (name, value) => { values.set(name, value); } },
    recordKey: 'vault', randomBytes: async length => new Uint8Array(randomBytes(length)), deviceUnlock: native.device,
    withWrite: async task => task(), now: Date.now,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
    isForeground: () => foreground,
  };
  return { native, values, dependencies, controller: new VaultController(dependencies), foreground: value => { foreground = value; } };
}
async function ready() {
  const f = fixture(); await f.controller.start(); await f.controller.beginSetup();
  const recovery = f.controller.getSnapshot().pendingKey;
  await f.controller.commitSetup();
  return { ...f, recovery };
}

test('availability and opt-in checks never read a protected or legacy key', async () => {
  const f = nativeStore(); f.values.set(BIOMETRIC_MARKER, '1');
  assert.deepEqual(await f.device.status(), { available: true, enabled: true });
  assert.deepEqual(f.calls.map(c => c.name), [BIOMETRIC_MARKER]);
});

test('enrollment uses a fresh authenticated alias and read-back before activation; legacy cache is removed', async () => {
  const f = nativeStore(), key = randomBytes(32).toString('hex');
  f.values.set(LEGACY_DEVICE_KEY, 'old convenience copy');
  await f.device.enable(key, () => {});
  const protectedCalls = f.calls.filter(c => c.name === BIOMETRIC_KEY);
  assert.deepEqual(protectedCalls.map(c => c.operation), ['set', 'get']);
  for (const c of protectedCalls) {
    assert.equal(c.options.requireAuthentication, true);
    assert.equal(c.options.keychainService, 'common.vault.biometric.v1');
    assert.equal(c.options.keychainAccessible, 9);
  }
  assert.ok(f.calls.findIndex(c => c.name === BIOMETRIC_MARKER && c.operation === 'set') > f.calls.findIndex(c => c.name === BIOMETRIC_KEY && c.operation === 'get'));
  assert.equal(f.values.has(LEGACY_DEVICE_KEY), false);
  assert.equal(f.values.get(BIOMETRIC_MARKER), '1');
  assert.equal(f.calls.some(c => c.name === LEGACY_DEVICE_KEY && c.operation === 'get'), false);
});

test('cancelled read-back or failed activation removes the partially enrolled shortcut', async () => {
  for (const failure of ['authentication', 'activation']) {
    const f = nativeStore();
    if (failure === 'authentication') f.deny(true);
    else f.hooks.write = async name => { if (name === BIOMETRIC_MARKER) throw new Error('Storage failed'); };
    await assert.rejects(f.device.enable(randomBytes(32).toString('hex'), () => {}));
    assert.equal(f.values.has(BIOMETRIC_KEY), false);
    assert.equal(f.values.has(BIOMETRIC_MARKER), false);
  }
});

test('a cancellation during enrollment rolls back even after the protected write', async () => {
  const f = nativeStore(); let allowed = true;
  f.hooks.read = async () => { allowed = false; };
  await assert.rejects(f.device.enable(randomBytes(32).toString('hex'), () => { if (!allowed) throw new Error('Cancelled'); }), /Cancelled/);
  assert.equal(f.values.has(BIOMETRIC_KEY), false);
  assert.equal(f.values.has(BIOMETRIC_MARKER), false);
});

test('public opt-in metadata cannot bypass a denied native key read or fall back to the old cache', async () => {
  const f = nativeStore();
  f.values.set(BIOMETRIC_MARKER, '1'); f.values.set(BIOMETRIC_KEY, 'protected value'); f.values.set(LEGACY_DEVICE_KEY, 'old value'); f.deny(true);
  await assert.rejects(f.device.read(), /cancelled/);
  assert.equal(f.calls.some(c => c.name === LEGACY_DEVICE_KEY), false);
  assert.equal(f.calls.filter(c => c.name === BIOMETRIC_KEY)[0].options.requireAuthentication, true);
});

test('disable revokes the shortcut before native deletion; a deletion failure cannot permit reads', async () => {
  const f = nativeStore(); f.values.set(BIOMETRIC_MARKER, '1'); f.values.set(BIOMETRIC_KEY, 'protected value');
  f.hooks.delete = async name => { if (name === BIOMETRIC_KEY) throw new Error('Native deletion failed'); };
  await assert.rejects(f.device.disable(), /deletion/);
  assert.equal(f.values.has(BIOMETRIC_MARKER), false);
  await assert.rejects(f.device.read(), /Enable biometric/);
  assert.equal(f.calls.some(c => c.name === BIOMETRIC_KEY && c.operation === 'get'), false);
});

test('unsupported biometrics refuse enrollment without saving a key', async () => {
  const f = nativeStore(); f.available(false);
  await assert.rejects(f.device.enable(randomBytes(32).toString('hex'), () => {}), /supported fingerprint/);
  assert.equal(f.values.size, 0);
});

test('new vaults default to opt-out and never save an unauthenticated device key', async () => {
  const f = await ready();
  assert.equal(f.controller.getSnapshot().deviceUnlock.enabled, false);
  assert.equal(f.native.values.size, 0);
  assert.equal(f.native.calls.some(c => c.operation === 'set'), false);
  assert.equal(f.values.get('vault').includes(f.recovery.replaceAll('-', '')), false);
});

test('explicit biometric unlock restores the same encrypted identity and profile; restart never prompts', async () => {
  const f = await ready(); await f.controller.saveProfile({ name: 'Biometric fixture', about: 'Encrypted profile' });
  const identity = f.controller.getSnapshot().identity, record = f.values.get('vault');
  await f.controller.enableDeviceUnlock(); f.controller.stop(); f.native.calls.length = 0;
  const restarted = fixture(f.native, record); await restarted.controller.start();
  assert.equal(restarted.controller.getSnapshot().status, 'locked');
  assert.equal(restarted.controller.getSnapshot().deviceUnlock.enabled, true);
  assert.equal(f.native.calls.some(c => c.name === BIOMETRIC_KEY), false);
  await restarted.controller.unlockWithDevice();
  assert.equal(restarted.controller.getSnapshot().identity, identity);
  assert.equal(restarted.controller.getSnapshot().profile.name, 'Biometric fixture');
  assert.equal(restarted.values.get('vault'), record);
  assert.equal(openVault(record, parseKey(f.recovery)).profile.name, 'Biometric fixture');
});

test('denied biometrics stay locked and recovery-key unlock remains available', async () => {
  const f = await ready(); await f.controller.enableDeviceUnlock(); f.controller.lock(); f.native.deny(true);
  await assert.rejects(f.controller.unlockWithDevice(), /cancelled/);
  assert.equal(f.controller.getSnapshot().status, 'locked');
  assert.equal(f.controller.getSnapshot().identity, null);
  await f.controller.unlock(f.recovery);
  assert.equal(f.controller.getSnapshot().status, 'unlocked');
});

test('Lock, suspension, stop and foreground loss win over a delayed biometric result', async () => {
  for (const reason of ['lock', 'suspend', 'stop', 'background']) {
    const f = await ready(); await f.controller.enableDeviceUnlock(); f.controller.lock();
    const entered = deferred(), release = deferred();
    f.native.hooks.read = async () => { entered.resolve(); await release.promise; };
    const unlocking = f.controller.unlockWithDevice(), rejected = assert.rejects(unlocking, /locked|Open LinkUp/);
    await entered.promise;
    if (reason === 'background') f.foreground(false);
    else if (reason === 'lock') f.controller.lock();
    else if (reason === 'suspend') f.controller.suspend();
    else f.controller.stop();
    release.resolve(); await rejected;
    assert.notEqual(f.controller.getSnapshot().status, 'unlocked');
    assert.equal(f.controller.getSnapshot().identity, null);
  }
});

test('locking during enrollment cannot activate a shortcut or replace encrypted data', async () => {
  const f = await ready(), record = f.values.get('vault'), entered = deferred(), release = deferred();
  f.native.hooks.read = async () => { entered.resolve(); await release.promise; };
  const enabling = f.controller.enableDeviceUnlock(), rejected = assert.rejects(enabling, /locked/);
  await entered.promise; f.controller.lock(); release.resolve(); await rejected;
  assert.equal(f.native.values.has(BIOMETRIC_KEY), false);
  assert.equal(f.native.values.has(BIOMETRIC_MARKER), false);
  assert.equal(f.values.get('vault'), record);
  assert.equal(f.controller.getSnapshot().status, 'locked');
});

test('biometric invalidation falls back to recovery without changing or losing the vault', async () => {
  const f = await ready(); await f.controller.enableDeviceUnlock(); f.controller.lock();
  const record = f.values.get('vault'); f.native.values.delete(BIOMETRIC_KEY);
  await assert.rejects(f.controller.unlockWithDevice(), /recovery key/);
  assert.equal(f.controller.getSnapshot().deviceUnlock.enabled, false);
  assert.equal(f.values.get('vault'), record);
  await f.controller.unlock(f.recovery); await f.controller.enableDeviceUnlock();
  assert.equal(f.controller.getSnapshot().deviceUnlock.enabled, true);
});

test('a stale biometric key cannot unlock a different vault and does not overwrite it', async () => {
  const f = await ready(); await f.controller.enableDeviceUnlock(); f.controller.lock();
  const record = f.values.get('vault'); f.native.values.set(BIOMETRIC_KEY, randomBytes(32).toString('hex'));
  await assert.rejects(f.controller.unlockWithDevice(), /did not open this vault/);
  assert.equal(f.controller.getSnapshot().identity, null);
  assert.equal(f.values.get('vault'), record);
  await f.controller.unlock(f.recovery); await f.controller.disableDeviceUnlock();
  assert.equal(f.native.values.has(BIOMETRIC_KEY), false);
});

test('an orphaned Keychain shortcut is cleared only when committing a new vault', async () => {
  const native = nativeStore(); native.values.set(BIOMETRIC_MARKER, '1'); native.values.set(BIOMETRIC_KEY, randomBytes(32).toString('hex'));
  const f = fixture(native); await f.controller.start();
  assert.equal(native.values.has(BIOMETRIC_KEY), true);
  await f.controller.beginSetup(); await f.controller.commitSetup();
  assert.equal(native.values.has(BIOMETRIC_KEY), false);
  assert.equal(f.controller.getSnapshot().deviceUnlock.enabled, false);
});

test('quick-unlock settings cannot be changed from a locked session', async () => {
  const f = await ready(); f.controller.lock();
  await assert.rejects(f.controller.enableDeviceUnlock(), /Unlock your saved data/);
  await assert.rejects(f.controller.disableDeviceUnlock(), /Unlock your saved data/);
  assert.equal(f.native.values.size, 0);
});

test('returning from phone settings refreshes availability without prompting or exposing a key', async () => {
  const f = await ready(); f.native.available(false);
  await f.controller.refreshDeviceUnlock();
  assert.equal(f.controller.getSnapshot().deviceUnlock.available, false);
  f.controller.lock(); f.native.available(true); f.native.calls.length = 0;
  await f.controller.refreshDeviceUnlock();
  assert.equal(f.controller.getSnapshot().deviceUnlock.available, true);
  assert.equal(f.controller.getSnapshot().status, 'locked');
  assert.equal(f.native.calls.some(c => c.name === BIOMETRIC_KEY), false);
});
