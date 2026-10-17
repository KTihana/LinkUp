// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { VaultController, openVault, parseKey } from '../src/security/vaultCore.ts';
import { passwordRecordKey, wrapPasswordKey, unwrapPasswordKey, readPasswordRecord } from '../src/security/passwordUnlock.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
const random = async n => new Uint8Array(randomBytes(n));
const password = 'copper otter meadow lantern';
function fixture(values = new Map(), phone = { key: null, deny: false }) {
  const hooks = {};
  const store = {
    getItem: async name => values.get(name) ?? null,
    getAllKeys: async () => [...values.keys()],
    setItem: async (name,value) => { await hooks.write?.(name,value); values.set(name,value); },
    removeItem: async name => { await hooks.remove?.(name); values.delete(name); },
  };
  const device = {
    status: async () => ({ available: true, enabled: !!phone.key, kind: 'phone' }),
    enable: async (key, allowed) => { allowed(); if (phone.deny) throw Error('Authentication cancelled'); phone.key = key; allowed(); },
    read: async () => { if (phone.deny) throw Error('Authentication cancelled'); return phone.key; },
    disable: async () => { phone.key = null; }, removeLegacyKey: async () => {},
    erase: async () => { phone.key = null; phone.archives?.clear(); },
    archive: async id => { phone.archives ??= new Map(); phone.archives.set(id, phone.key); },
    detach: async () => { phone.key = null; },
  };
  const controller = new VaultController({ store, recordKey: 'vault', randomBytes: random, deviceUnlock: device, withWrite: async task => task(), now: Date.now, signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName, isForeground: () => hooks.foreground !== false, eraseExternalAccountData: async () => { await hooks.externalErase?.(); } });
  return { values, phone, hooks, controller };
}
async function create(protection) { const f=fixture(); await f.controller.start(); await f.controller.beginSetup(); const key=f.controller.getSnapshot().pendingKey; await f.controller.commitSetup(protection); return {...f,key}; }
test('phone-protected signup persists usable phone access before saving the identity', async () => {
  const f=await create({method:'device'}), identity=f.controller.getSnapshot().identity;
  assert.ok(f.phone.key); assert.equal(f.controller.getSnapshot().deviceUnlock.kind,'phone');
  f.controller.stop(); const next=fixture(f.values,f.phone); await next.controller.start();
  assert.equal(next.controller.getSnapshot().status,'locked');
  await next.controller.unlockWithDevice(); assert.equal(next.controller.getSnapshot().identity,identity);
});
test('cancelled phone authentication never creates an inaccessible account', async () => {
  const f=fixture(); f.phone.deny=true; await f.controller.start(); await f.controller.beginSetup();
  await assert.rejects(f.controller.commitSetup({method:'device'}),/cancelled/);
  assert.equal(f.values.has('vault'),false); assert.equal(f.controller.getSnapshot().status,'preview');
});
test('password signup survives restart, rejects a wrong password and never stores password or raw key', async () => {
  const f=await create({method:'password',password}), identity=f.controller.getSnapshot().identity, saved=f.values.get('vault');
  const wrapper=f.values.get(passwordRecordKey('vault'));
  assert.ok(!wrapper.includes(password) && !wrapper.includes(f.key.replaceAll('-','')));
  f.controller.stop(); const next=fixture(f.values,f.phone); await next.controller.start();
  assert.equal(next.controller.getSnapshot().passwordEnabled,true);
  await assert.rejects(next.controller.unlockWithPassword('wrong password phrase'),/did not unlock/);
  assert.equal(next.values.get('vault'),saved); assert.equal(next.controller.getSnapshot().identity,null);
  await next.controller.unlockWithPassword(password); assert.equal(next.controller.getSnapshot().identity,identity);
});
test('adding a password migrates an open older account without changing identity or ciphertext', async () => {
  const f=await create(), saved=f.values.get('vault'), identity=f.controller.getSnapshot().identity;
  await f.controller.setPassword(password); f.controller.lock();
  assert.equal(f.controller.getSnapshot().passwordEnabled,true);
  await f.controller.unlockWithPassword(password);
  assert.equal(f.values.get('vault'),saved); assert.equal(f.controller.getSnapshot().identity,identity);
});
test('authenticated password wrapping rejects tampering, weak passwords and resource profiles', async () => {
  const key=randomBytes(32), wrapped=await wrapPasswordKey(key,password,random), record=JSON.parse(wrapped);
  assert.deepEqual(Buffer.from(await unwrapPasswordKey(wrapped,password)),key);
  record.ciphertext=record.ciphertext.slice(0,-2)+(record.ciphertext.endsWith('00')?'01':'00');
  await assert.rejects(unwrapPasswordKey(JSON.stringify(record),password),/did not unlock/);
  assert.throws(()=>readPasswordRecord(JSON.stringify({...JSON.parse(wrapped),kdf:'scrypt-unbounded'})),/Invalid/);
  await assert.rejects(wrapPasswordKey(key,'123456',random),/12/);
});
test('Lock during password derivation wins over a late successful password result', async () => {
  const f=await create({method:'password',password}); f.controller.lock();
  const work=f.controller.unlockWithPassword(password), rejected=assert.rejects(work,/locked|cancelled/);
  f.controller.lock(); await rejected; assert.equal(f.controller.getSnapshot().status,'locked');
});
test('a late initial vault write remains unlockable after Lock without a recovery key', async () => {
  for (const method of ['device','password']) {
    const f=fixture(); await f.controller.start(); await f.controller.beginSetup();
    let entered, release; const writing=new Promise(r=>{entered=r;}), released=new Promise(r=>{release=r;});
    f.hooks.write=async name=>{if(name==='vault'){entered(); await released;}};
    const work=f.controller.commitSetup(method==='device'?{method}:{method,password});
    const rejected=assert.rejects(work,/locked|cancelled/);
    await writing; f.controller.lock(); release(); await rejected;
    assert.ok(f.values.has('vault'));
    if(method==='device') await f.controller.unlockWithDevice();
    else { assert.equal(f.controller.getSnapshot().passwordEnabled,true); await f.controller.unlockWithPassword(password); }
    assert.equal(f.controller.getSnapshot().status,'unlocked');
  }
});
test('new signup can complete without publishing any raw recovery key to the UI', async () => {
  const f=fixture(); await f.controller.start(); await f.controller.beginSetup(false);
  assert.equal(f.controller.getSnapshot().pendingKey,null);
  await f.controller.commitSetup({method:'device'}); f.controller.lock();
  await f.controller.unlockWithDevice(); assert.equal(f.controller.getSnapshot().status,'unlocked');
});

test('phone-managed accounts cannot remove their only unlock method', async () => {
  const f=await create({method:'device'}), key=f.phone.key;
  await assert.rejects(f.controller.disableDeviceUnlock(),/Add .*password/);
  assert.equal(f.phone.key,key); await f.controller.setPassword(password);
  await f.controller.disableDeviceUnlock(); f.controller.lock();
  await f.controller.unlockWithPassword(password); assert.equal(f.controller.getSnapshot().status,'unlocked');
});
test('an existing delegated device key can recover the same account with protected phone unlock', async () => {
  const f=await create(), saved=f.values.get('vault'), identity=f.controller.getSnapshot().identity; f.controller.lock();
  await f.controller.recoverWithSavedKey(f.key,{method:'device'});
  assert.equal(f.controller.getSnapshot().identity,identity); assert.equal(f.values.get('vault'),saved);
  f.controller.lock(); await f.controller.unlockWithDevice(); assert.equal(f.controller.getSnapshot().identity,identity);
});
test('saved-device recovery verifies the old vault before changing protection and supports a new password', async () => {
  const f=await create(), saved=f.values.get('vault'); f.controller.lock();
  await assert.rejects(f.controller.recoverWithSavedKey(randomBytes(32).toString('hex'),{method:'device'}));
  assert.equal(f.phone.key,null); assert.equal(f.values.get('vault'),saved);
  await f.controller.recoverWithSavedKey(f.key,{method:'password',password}); f.controller.lock();
  await f.controller.unlockWithPassword(password); assert.equal(f.values.get('vault'),saved);
});
test('saved background access cannot reset the foreground password without phone authentication', async () => {
  const f=await create(); f.controller.lock(); f.phone.deny=true;
  await assert.rejects(f.controller.recoverWithSavedKey(f.key,{method:'password',password}),/cancelled/);
  assert.equal(f.values.has(passwordRecordKey('vault')),false); assert.equal(f.controller.getSnapshot().status,'locked');
});

test('starting fresh deletes active data, password, preferences and every earlier archive', async () => {
  const f=await create({method:'password',password}), old=f.controller.getSnapshot().identity;
  f.values.set('vault.archives.v1','malformed old index');f.values.set('vault.archives.v1.orphan','encrypted old archive');
  f.values.set('vault.archives.v1.orphan.password.v1','old wrapper');f.values.set('common.appearance.v1','old colors');
  f.values.set('unrelated.app','keep');f.phone.archives=new Map([['old','old key']]);
  let external=0;f.hooks.externalErase=async()=>{external++;};f.controller.lock();await f.controller.startNewIdentity();
  assert.deepEqual([...f.values],[['unrelated.app','keep']]);assert.equal(f.phone.archives.size,0);assert.equal(external,1);
  assert.equal(f.controller.getSnapshot().profile.name,'Anon');assert.equal(f.controller.getSnapshot().contacts.length,0);
  await f.controller.beginSetup(false);await f.controller.commitSetup({method:'device'});assert.notEqual(f.controller.getSnapshot().identity,old);
});
test('failed deletion intent cannot erase keys or saved conversations', async () => {
  const f=await create({method:'device'}),saved=f.values.get('vault'),key=f.phone.key;f.controller.lock();
  f.hooks.write=async name=>{if(name==='vault.reset.v1')throw Error('Disk full');};
  await assert.rejects(f.controller.startNewIdentity(),/Disk full/);assert.equal(f.values.get('vault'),saved);assert.equal(f.phone.key,key);
});
test('interrupted deletion fails closed and resumes on restart before permitting setup', async () => {
  const f=await create({method:'device'});f.controller.lock();f.values.set('vault.archives.v1.old','old ciphertext');
  f.hooks.remove=async name=>{if(name==='vault')throw Error('Disk unavailable');};
  await assert.rejects(f.controller.startNewIdentity(),/Disk unavailable/);
  assert.equal(f.values.get('vault.reset.v1'),'1');assert.equal(f.phone.key,null);assert.equal(f.controller.getSnapshot().resetRequired,true);
  await assert.rejects(f.controller.unlock(f.key),/deleting/);f.controller.stop();
  const next=fixture(f.values,f.phone);await next.controller.start();assert.equal(next.controller.getSnapshot().status,'preview');assert.equal(next.values.size,0);
});
test('new-account deletion never asks for the old phone credential', async () => {
  const f=await create({method:'device'});f.phone.deny=true;f.controller.lock();await f.controller.startNewIdentity();
  assert.equal(f.controller.getSnapshot().status,'preview');assert.equal(f.values.size,0);assert.equal(f.phone.key,null);
});
test('Lock during confirmed deletion cannot abandon cleanup halfway through', async () => {
  const f=await create({method:'device'});f.controller.lock();let release,entered;
  const waiting=new Promise(r=>{entered=r;});f.hooks.externalErase=()=>new Promise(r=>{release=r;entered();});
  const task=f.controller.startNewIdentity();await waiting;f.controller.lock();release();await task;
  assert.equal(f.values.size,0);assert.equal(f.controller.getSnapshot().status,'preview');assert.equal(f.controller.getSnapshot().identity,null);
});
test('deletion cannot start in the background or from an unlocked session', async () => {
  const f=await create({method:'device'}),saved=f.values.get('vault');
  await assert.rejects(f.controller.startNewIdentity(),/Lock/);f.controller.lock();f.hooks.foreground=false;
  await assert.rejects(f.controller.startNewIdentity(),/Open LinkUp/);assert.equal(f.values.get('vault'),saved);assert.equal(f.values.has('vault.reset.v1'),false);
});

test('signup clears archives left behind when an earlier version failed after archiving', async () => {
  const values=new Map([['vault.archives.v1','old index'],['vault.archives.v1.old','old encrypted messages'],['common.appearance.v1','old preferences']]);
  const phone={key:null,deny:false,archives:new Map([['old','old protected key']])};const f=fixture(values,phone);await f.controller.start();
  let cleaned=0;f.hooks.externalErase=async()=>{cleaned++;};await f.controller.beginSetup(false);await f.controller.commitSetup({method:'password',password});
  assert.equal(values.has('vault.archives.v1'),false);assert.equal(values.has('vault.archives.v1.old'),false);assert.equal(values.has('common.appearance.v1'),false);
  assert.equal(phone.archives.size,0);assert.equal(cleaned,1);assert.equal(f.controller.getSnapshot().status,'unlocked');
});
