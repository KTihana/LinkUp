// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { requireVpnAccount } from '../src/vpn/account.ts';
import { createEnrollment } from '../src/vpn/enrollment.ts';
import { verifyEnrollment } from '../../deploy/vpn/prepare.mjs';
import { createNearbyOffer, inspectNearbyOffer, NEARBY_OFFER_TTL } from '../src/messaging/nearbyOffer.ts';
const require = createRequire(import.meta.url), { protectActivity } = require('../plugins/withScreenPrivacy.cjs');
function signer() { const key=randomBytes(32); return {publicKey:bytesToHex(ed25519.getPublicKey(key)),sign:bytes=>bytesToHex(ed25519.sign(bytes,key))}; }
test('app signed public enrollment verifies on independently implemented server', () => {
  const publicKey=generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'), now=Date.now();
  const result=JSON.parse(createEnrollment(publicKey,signer(),now)); verifyEnrollment(result,now);
  assert.deepEqual(Object.keys(result),['schema','identity','devicePublicKey','issuedAt','signature']);
});
test('signed VPN offer pins friend, exact overlay address, TLS certificate and fixed service', () => {
  const self=signer(), peer=signer(), issuedAt=Date.now(), data={version:1,publicKey:self.publicKey,peer:peer.publicKey,issuedAt,expiresAt:issuedAt+NEARBY_OFFER_TTL,nonce:'11'.repeat(16),kind:'vpn',host:'10.203.0.2',port:47443,pin:'12'.repeat(32)};
  const offer=createNearbyOffer(data,self); assert.deepEqual(inspectNearbyOffer(offer,issuedAt),data);
  for (const change of [{host:'192.168.1.2'},{host:'10.203.0.0'},{host:'10.203.0.255'},{host:'10.204.0.2'},{port:4444},{ssid:'bad'},{password:'bad'}]) assert.throws(()=>createNearbyOffer({...data,...change},self));
  assert.throws(()=>createNearbyOffer(data,peer));
});
test('Android screen protection is installed before content, idempotent and fails closed on changed templates', () => {
  const activity='class MainActivity {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(null)\n  }\n}';
  const result=protectActivity(activity);
  assert.equal(protectActivity(result),result); assert.ok(result.indexOf('FLAG_SECURE')<result.indexOf('super.onCreate'));
  assert.throws(()=>protectActivity('unsupported template'));
});


test('saved VPN enrollment is rejected across account changes or device-key substitution', () => {
  const identity=signer().publicKey, other=signer().publicKey;
  const status={initialized:true,identity,publicKey:'public-key',config:{identity,devicePublicKey:'public-key'}};
  requireVpnAccount(status,'common:'+identity);
  for (const account of [undefined,null,'',other,'common:'+other]) assert.throws(()=>requireVpnAccount(status,account));
  assert.throws(()=>requireVpnAccount({...status,config:{...status.config,identity:other}},identity));
  assert.throws(()=>requireVpnAccount({...status,config:{...status.config,devicePublicKey:'other-key'}},identity));
});
