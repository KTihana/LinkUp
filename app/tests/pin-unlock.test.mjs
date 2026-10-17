// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { VaultController, openVault, parseKey } from '../src/security/vaultCore.ts';
import { pinError, validatePin } from '../src/security/pinUnlockCore.ts';
import { createInvitation, inspectInvitation, isValidDisplayName } from '../src/security/invitation.ts';
const pin='847291';
function fixture(values=new Map(), saved={entry:null,archives:new Map()}) {
  const hooks={};
  const adapter={
    status:async()=>({available:true,enabled:!!saved.entry}),
    enable:async(key,pin)=>{await hooks.enable?.();saved.entry={key,pin};},
    read:async(pin)=>{await hooks.read?.();if(saved.entry?.pin!==pin)throw Error('Incorrect LinkUp PIN');return saved.entry.key;},
    erase:async()=>{saved.entry=null;saved.archives.clear();},
    disable:async()=>{saved.entry=null;}, archive:async id=>{saved.archives.set(id,saved.entry);},detach:async()=>{saved.entry=null;},
  };
  const store={getAllKeys:async()=>[...values.keys()],getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{await hooks.write?.(k,v);values.set(k,v);},removeItem:async k=>{values.delete(k);}};
  const controller=new VaultController({store,recordKey:'vault',randomBytes:async n=>new Uint8Array(randomBytes(n)),pinUnlock:adapter,withWrite:async task=>task(),now:Date.now,signInvitation:createInvitation,verifyInvitation:inspectInvitation,isValidDisplayName});
  return {values,saved,hooks,controller};
}
async function create() {const f=fixture();await f.controller.start();await f.controller.beginSetup(false);await f.controller.commitSetup({method:'pin',pin});return f;}
test('PIN signup stores protection before ciphertext and resumes the same identity after restart',async()=>{
  const f=fixture();await f.controller.start();await f.controller.beginSetup(false);
  f.hooks.write=async name=>{if(name==='vault')assert.ok(f.saved.entry);};
  await f.controller.commitSetup({method:'pin',pin});const identity=f.controller.getSnapshot().identity,saved=f.values.get('vault');
  assert.equal(f.controller.getSnapshot().pendingKey,null);assert.equal(f.controller.getSnapshot().pinUnlock.enabled,true);
  f.controller.stop();const next=fixture(f.values,f.saved);await next.controller.start();assert.equal(next.controller.getSnapshot().status,'locked');
  await assert.rejects(next.controller.unlockWithPin('847292'),/Incorrect/);assert.equal(next.values.get('vault'),saved);
  await next.controller.unlockWithPin(pin);assert.equal(next.controller.getSnapshot().identity,identity);
});
test('unavailable or failed PIN protection cannot commit an inaccessible account',async()=>{
  const f=fixture();await f.controller.start();await f.controller.beginSetup(false);f.hooks.enable=async()=>{throw Error('Keystore unavailable');};
  await assert.rejects(f.controller.commitSetup({method:'pin',pin}),/Keystore/);assert.equal(f.values.has('vault'),false);
});
test('changing the app PIN preserves the identity and encrypted conversations',async()=>{
  const f=await create(),identity=f.controller.getSnapshot().identity,saved=f.values.get('vault');
  await f.controller.setPin('614983');f.controller.lock();await assert.rejects(f.controller.unlockWithPin(pin),/Incorrect/);
  await f.controller.unlockWithPin('614983');assert.equal(f.controller.getSnapshot().identity,identity);assert.equal(f.values.get('vault'),saved);
});
test('Lock revokes a pending successful native PIN response',async()=>{
  const f=await create();f.controller.lock();let finish;f.hooks.read=()=>new Promise(r=>{finish=r;});
  const task=f.controller.unlockWithPin(pin),rejected=assert.rejects(task,/locked|cancelled/);f.controller.lock();finish();await rejected;
  assert.equal(f.controller.getSnapshot().status,'locked');assert.equal(f.controller.getSnapshot().identity,null);
});
test('starting fresh deletes old PIN entries and archived key references',async()=>{
  const f=await create(),entry=f.saved.entry;f.saved.archives.set('old',entry);f.controller.lock();await f.controller.startNewIdentity();
  assert.equal(f.saved.entry,null);assert.equal(f.saved.archives.size,0);assert.equal(f.values.size,0);
  await f.controller.beginSetup(false);await f.controller.commitSetup({method:'pin',pin:'614983'});assert.notEqual(f.saved.entry.key,entry.key);
});
test('PIN validation preserves leading zeros and refuses non-digit, short or long values',()=>{
  validatePin('014729');for(const value of ['', '12345','1234567','１２３４５６','abc123','12 345'])assert.throws(()=>validatePin(value),/six-digit/);
});

test('native PIN errors expose a readable retry message without bridge internals',()=>{
  assert.equal(pinError(new Error("Call to LinkUpPinUnlock.read rejected: Incorrect PIN. Try again in 30 seconds.")).message,'Incorrect PIN. Try again in 30 seconds.');
  assert.equal(pinError(new Error('native key alias private debug detail')).message,'PIN unlock is unavailable. Try another saved unlock method.');
});
