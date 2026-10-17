// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { prepare, verifyEnrollment } from './prepare.mjs';
const now = Date.now();
function enrollment() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const wg = generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  const value = {schema:1,identity:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),devicePublicKey:wg,issuedAt:now};
  return {...value,signature:sign(null,Buffer.from('linkup/vpn-enrollment/v1\n'+JSON.stringify(value)),privateKey).toString('hex')};
}
function fixture() {
  const devices = [enrollment(), enrollment(), enrollment()];
  return {policy:{schema:1,label:'Our friends',endpoint:'vpn.example.org:51820',expiresAt:now+86400000,devices,friends:[[devices[0].identity,devices[1].identity],[devices[1].identity,devices[2].identity]]},hub:generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')};
}
test('signed phone enrollment binds independent device key, account and timestamp', () => {
  const e = enrollment(); verifyEnrollment(e,now);
  for (const mutation of [{devicePublicKey:enrollment().devicePublicKey},{identity:enrollment().identity},{issuedAt:now-1},{signature:'00'.repeat(64)},{extra:true}]) assert.throws(()=>verifyEnrollment({...e,...mutation},now));
  assert.throws(()=>verifyEnrollment(e,now+8*86400000));
});
test('only explicit friends get exact routes and server ACL; no internet exit or hub access', () => {
  const {policy,hub}=fixture(), output=prepare(policy,hub,now);
  assert.deepEqual(output.configurations[0].peers,['10.203.0.3/32']);
  assert.deepEqual(output.configurations[1].peers,['10.203.0.2/32','10.203.0.4/32']);
  assert.doesNotMatch(output.wg,/0\.0\.0\.0\/0|::\/0|PrivateKey\s*=/);
  assert.doesNotMatch(output.nft,/masquerade|flush ruleset|saddr 10\.203\.0\.2\/32 ip daddr 10\.203\.0\.4/);
  assert.match(output.nft,/iifname "wg-linkup" drop/); assert.match(output.nft,/oifname "wg-linkup" drop/);
  assert.match(output.nft,/tcp dport 47443 accept/); assert.match(output.nft,/tcp sport 47443 ct state established accept/);
  assert.equal(output.configurations.every(c=>c.expiresAt===policy.expiresAt && !('privateKey' in c)),true);
  assert.match(output.expire,/if \[ "\$now" -ge "\$expiry" \]/); assert.match(output.timer,/Persistent=true/);
  assert.match(output.timer,/AccuracySec=1us/); assert.match(output.timer,/RandomizedDelaySec=0/);
});
test('injected config, duplicate devices, mismatched pairs and overlong enrollment fail closed', () => {
  const {policy,hub}=fixture();
  for (const patch of [{endpoint:'vpn.example.org:51820\nPostUp=bad'},{endpoint:'127.0.0.1:51820'},{endpoint:'10.203.0.2:51820'},{endpoint:'bad.local:51820'},{label:'bad\ncommand'},{expiresAt:now},{expiresAt:now+8*86400000},{devices:[policy.devices[0],policy.devices[0]]},{friends:[[policy.devices[0].identity,'00'.repeat(32)]]},{friends:[]},{extra:true}]) assert.throws(()=>prepare({...policy,...patch},hub,now));
  assert.throws(()=>prepare(policy,'A'.repeat(43)+'=',now));
});
