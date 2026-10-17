import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { VaultController, makeVault, sealVault, openVault, parseKey } from '../src/security/vaultCore.ts';
import { defaults, migratePreferences, patchPreferences } from '../src/appearance/palette.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
import { isForeground, watchSessionVisibility } from '../src/security/sessionVisibility.web.ts';
import { createVisibilityPolicy } from '../src/security/visibilityPolicy.ts';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(record = null) {
  const values = new Map(record ? [['vault', record]] : []);
  let foreground = true;
  const dependencies = {
    store: {
      getItem: async name => values.get(name) ?? null,
      setItem: async (name, value) => { values.set(name, value); },
      removeItem: async name => { values.delete(name); },
    },
    recordKey: 'vault', randomBytes: async length => new Uint8Array(randomBytes(length)),
    readDeviceKey: async () => { throw new Error('Startup must not read a private key'); },
    saveDeviceKey: async () => {}, withWrite: async task => task(), now: Date.now,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName,
    isForeground: () => foreground,
  };
  return { controller: new VaultController(dependencies), dependencies, values, foreground: value => { foreground = value; } };
}
async function setup() {
  const f = fixture();
  await f.controller.start(); await f.controller.beginSetup();
  const key = f.controller.getSnapshot().pendingKey;
  await f.controller.commitSetup();
  return { ...f, key };
}

test('preview appearance is ephemeral; setup encrypts it and restart hides it until explicit unlock', async () => {
  const f = fixture(); await f.controller.start();
  await f.controller.saveAppearance({ theme: 'Automatic', palettes: { Dark: { accentColor: '#12AB34', textColor: '#FEDCBA', backgroundColor: '#123456', buttonColor: '#63356D' }, Light: { backgroundColor: '#F1E5FB' } }, schedule: { lightStart: 480, darkStart: 1200 } });
  assert.equal(f.values.size, 0);
  await f.controller.beginSetup(); const key = f.controller.getSnapshot().pendingKey;
  await f.controller.commitSetup();
  const record = f.values.get('vault');
  assert.equal(record.includes('#12AB34'), false);
  assert.equal(record.includes('#123456'), false);
  assert.equal(record.includes('#63356D'), false);
  assert.equal(record.includes('Dark'), false);
  assert.equal(openVault(record, parseKey(key)).appearance.theme, 'Automatic');
  const restarted = fixture(record); await restarted.controller.start();
  assert.equal(restarted.controller.getSnapshot().status, 'locked');
  assert.deepEqual(restarted.controller.getSnapshot().appearance, defaults);
  await restarted.controller.unlock(key);
  assert.equal(restarted.controller.getSnapshot().appearance.palettes.Dark.accentColor, '#12AB34');
  assert.equal(restarted.controller.getSnapshot().appearance.palettes.Dark.backgroundColor, '#123456');
  assert.equal(restarted.controller.getSnapshot().appearance.palettes.Dark.buttonColor, '#63356D');
  assert.equal(restarted.controller.getSnapshot().appearance.palettes.Light.backgroundColor, '#F1E5FB');
  assert.deepEqual(restarted.controller.getSnapshot().appearance.schedule, { lightStart: 480, darkStart: 1200 });
});

test('old encrypted colors migrate in memory and save both independent palettes without replacing the identity', async () => {
  const key = randomBytes(32), data = makeVault(randomBytes(32), { name: 'Legacy', about: '' }, false);
  const old = { theme: 'Dark', accentColor: '#123456', textColor: '#ABCDEF', backgroundColor: '#152535' };
  data.appearance = old;
  const record = sealVault(data, key, randomBytes(24)), f = fixture(record);
  await f.controller.start(); await f.controller.unlock(key.toString('hex'));
  const appearance = f.controller.getSnapshot().appearance;
  assert.deepEqual(appearance, migratePreferences(old));
  assert.equal(f.values.get('vault'), record, 'unlock must not rewrite the encrypted record');
  const savedDark = { ...appearance.palettes.Dark };
  await f.controller.saveAppearance({ palettes: { Light: { backgroundColor: '#FAEEDD' } } });
  const saved = openVault(f.values.get('vault'), key);
  assert.deepEqual(saved.identity, data.identity);
  assert.deepEqual(saved.appearance.palettes.Dark, savedDark);
  assert.equal(saved.appearance.palettes.Light.backgroundColor, '#FAEEDD');
});

test('rapid appearance patches preserve each choice; invalid settings never replace encrypted data', async () => {
  const f = await setup();
  await Promise.all([
    f.controller.saveAppearance({ theme: 'Dark' }),
    f.controller.saveAppearance({ palettes: { Light: { accentColor: '#123456' } } }),
    f.controller.saveAppearance({ palettes: { Light: { textColor: '#ABCDEF' } } }),
    f.controller.saveAppearance({ palettes: { Dark: { backgroundColor: '#556677' } } }),
  ]);
  const appearance = patchPreferences(defaults, { theme: 'Dark', palettes: { Light: { accentColor: '#123456', textColor: '#ABCDEF' }, Dark: { backgroundColor: '#556677' } } });
  assert.deepEqual(openVault(f.values.get('vault'), parseKey(f.key)).appearance, appearance);
  const saved = f.values.get('vault');
  for (const patch of [{ theme: 'Rose' }, { accentColor: 'url(secret)' }, { textColor: 'bad' }, { backgroundColor: 'bad' }, { backgroundColor: null }, { palettes: { Dark: { backgroundColor: 'bad' } } }, { schedule: { lightStart: 1140 } }, { extra: 'data' }]) {
    await assert.rejects(f.controller.saveAppearance(patch));
  }
  assert.equal(f.values.get('vault'), saved);
});

test('legacy plaintext colors migrate only after successful encrypted persistence', async () => {
  const key = randomBytes(32), appearance = { theme: 'Dark', accentColor: '#123456', textColor: '#ABCDEF' };
  const data = makeVault(randomBytes(32), { name: 'Legacy', about: '' }, false);
  const record = sealVault(data, key, randomBytes(24)), f = fixture(record);
  f.values.set('common.appearance.v1', JSON.stringify(appearance));
  await f.controller.start(); await f.controller.unlock(key.toString('hex'));
  const write = f.dependencies.store.setItem;
  f.dependencies.store.setItem = async () => { throw new Error('Disk full'); };
  await assert.rejects(f.controller.importLegacyAppearance(), /Disk full/);
  assert.equal(f.values.get('vault'), record);
  assert.ok(f.values.has('common.appearance.v1'));
  f.dependencies.store.setItem = write;
  await f.controller.importLegacyAppearance();
  assert.deepEqual(openVault(f.values.get('vault'), key).appearance, migratePreferences(appearance));
  assert.equal(f.values.has('common.appearance.v1'), false);
});

test('legacy cleanup does not overwrite a newer encrypted appearance choice', async () => {
  const f = await setup();
  f.values.set('common.appearance.v1', JSON.stringify({ theme: 'Dark', accent: 'Ocean', text: 'Navy' }));
  await f.controller.saveAppearance({ palettes: { Light: { accentColor: '#654321' } } });
  await f.controller.importLegacyAppearance();
  assert.equal(f.controller.getSnapshot().appearance.palettes.Light.accentColor, '#654321');
  assert.equal(f.values.has('common.appearance.v1'), false);
});

test('suspension hides private state and revokes retained signing capabilities', async () => {
  const f = await setup();
  await f.controller.saveProfile({ name: 'Private profile', about: 'Private about' });
  const signer = await f.controller.transactMessaging(async (_, signer) => ({ state: 'Private state', result: signer }));
  const request = new TextEncoder().encode('common/mailbox-request/v1\nfixture');
  assert.equal(typeof signer.sign(request), 'string');
  f.foreground(false);
  assert.throws(() => signer.sign(request), /Open LinkUp/);
  f.controller.suspend();
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.status, 'locked');
  assert.equal(snapshot.identity, null);
  assert.equal(snapshot.profile.name.includes('Private'), false);
  assert.equal(snapshot.contacts.length, 0);
  assert.throws(() => signer.sign(request), /locked/);
  await assert.rejects(f.controller.unlock(f.key), /Open LinkUp/);
  f.foreground(true);
  assert.equal(f.controller.getSnapshot().status, 'locked');
  await f.controller.unlock(f.key);
  assert.equal(f.controller.getSnapshot().profile.name, 'Private profile');
});

test('a background transition during an explicit unlock cannot restore a session', async () => {
  const f = await setup(); f.controller.lock();
  const entered = deferred(), release = deferred();
  f.dependencies.deviceUnlock = { removeLegacyKey: async () => { entered.resolve(); await release.promise; } };
  const unlocking = f.controller.unlock(f.key), rejected = assert.rejects(unlocking, /locked/);
  await entered.promise;
  f.foreground(false); f.controller.suspend(); release.resolve();
  await rejected;
  assert.equal(f.controller.getSnapshot().status, 'locked');
  assert.equal(f.controller.getSnapshot().identity, null);
});

test('suspension cancels pending setup and preserves an existing encrypted record during delayed writes', async () => {
  const f = fixture(); await f.controller.start();
  const draws = [deferred(), deferred()]; let draw = 0;
  f.dependencies.randomBytes = () => draws[draw++].promise;
  const pending = f.controller.beginSetup(), rejected = assert.rejects(pending, /locked|cancelled/);
  f.controller.suspend(); draws.forEach(item => item.resolve(randomBytes(32))); await rejected;
  assert.equal(f.controller.getSnapshot().pendingKey, null);
  assert.equal(f.values.size, 0);
  const ready = await setup(), oldRecord = ready.values.get('vault'), entered = deferred(), release = deferred();
  ready.dependencies.store.getItem = async () => { entered.resolve(); await release.promise; return oldRecord; };
  const changing = ready.controller.saveAppearance({ theme: 'Dark' }), cancelled = assert.rejects(changing, /locked/);
  await entered.promise; ready.controller.suspend(); release.resolve(); await cancelled;
  assert.equal(ready.values.get('vault'), oldRecord);
});

test('browser visibility and pagehide lock immediately, never auto-unlock, and remove listeners on cleanup', () => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  const doc = new EventTarget(), win = new EventTarget(); doc.visibilityState = 'visible';
  globalThis.document = doc; globalThis.window = win;
  try {
    let locks = 0;
    const cleanup = watchSessionVisibility(() => { locks += 1; }, 30_000);
    assert.equal(isForeground(), true);
    doc.dispatchEvent(new Event('visibilitychange')); assert.equal(locks, 0);
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(isForeground(), false); assert.equal(locks, 1);
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(locks, 1);
    win.dispatchEvent(new Event('pagehide')); assert.equal(locks, 2);
    cleanup(); doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pagehide')); assert.equal(locks, 2);
    const hiddenCleanup = watchSessionVisibility(() => { locks += 1; });
    assert.equal(locks, 3); hiddenCleanup();
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});

test('native return after the deadline locks even when the OS never ran its background timer', () => {
  let foreground = true, now = 0, locks = 0, scheduled, cancellations = 0;
  const policy = createVisibilityPolicy({
    isForeground: () => foreground, now: () => now, graceMs: 30_000,
    suspend: () => { locks += 1; },
    schedule: callback => { scheduled = callback; return 1; }, cancel: () => { cancellations += 1; },
  });
  policy.update(); foreground = false; policy.update();
  now = 31_000; foreground = true; policy.update();
  assert.equal(locks, 1);
  scheduled(); assert.equal(locks, 1);
  assert.ok(cancellations); policy.stop();
});

test('short native picker return cancels the lock; background transitions do not extend its deadline', () => {
  let foreground = true, now = 0, locks = 0, scheduled, schedules = 0;
  const policy = createVisibilityPolicy({
    isForeground: () => foreground, now: () => now, graceMs: 30_000,
    suspend: () => { locks += 1; },
    schedule: callback => { schedules += 1; scheduled = callback; return schedules; }, cancel: () => {},
  });
  policy.update(); foreground = false; policy.update();
  now = 5_000; foreground = true; policy.update(); assert.equal(locks, 0);
  foreground = false; policy.update(); now = 20_000; policy.update();
  assert.equal(schedules, 2);
  now = 35_001; scheduled(); assert.equal(locks, 1);
  policy.update(); assert.equal(locks, 1);
  policy.stop(); foreground = true; scheduled(); assert.equal(locks, 1);
});
