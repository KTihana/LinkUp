import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createNearbyOffer, inspectNearbyOffer, nearbyOfferBytes, isLocalIPv4, BLE_SERVICE, NEARBY_OFFER_TTL } from '../src/messaging/nearbyOffer.ts';
import { invitationQR } from '../src/friends/qr.ts';
import jsQR from 'jsqr';
const now = 1791914400000;
function identity() { const seed = randomBytes(32), key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }); const pub = createPublicKey(key); return { publicKey: pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), pub, sign: bytes => sign(null, bytes, key).toString('hex') }; }
const alice = identity(), bob = identity();
const common = { version: 1, publicKey: alice.publicKey, peer: bob.publicKey, issuedAt: now, expiresAt: now + NEARBY_OFFER_TTL, nonce: randomBytes(16).toString('hex') };
const wifi = { ...common, kind: 'wifi', host: '192.168.43.1', port: 42424, pin: randomBytes(32).toString('hex'), ssid: 'Common nearby', password: 'test-only-network' };
const ble = { ...common, kind: 'bluetooth', service: BLE_SERVICE };
test('Wi-Fi pin, recipient and Bluetooth service are bound by independently verified identity signatures', () => {
  for (const offer of [wifi, ble]) { const link = createNearbyOffer(offer, alice), token = link.split('token=')[1], [body,sig] = token.split('.'); assert.equal(verify(null, nearbyOfferBytes(offer), alice.pub, Buffer.from(sig,'hex')), true); assert.deepEqual(inspectNearbyOffer(link,now),offer); assert.deepEqual(inspectNearbyOffer(token,now),offer); assert.equal(Buffer.from(body,'base64url').toString().includes('private'),false); }
  const link = createNearbyOffer(wifi,alice), [body,sig] = link.split('token=')[1].split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body,'base64url')), pin: randomBytes(32).toString('hex') })).toString('base64url'); assert.throws(() => inspectNearbyOffer(`${changed}.${sig}`,now));
  assert.throws(() => createNearbyOffer(wifi,bob));
});
test('nearby codes refuse public endpoints, ambiguous routes, schema/canonical changes and expired/future times', () => {
  for (const host of ['example.org','8.8.8.8','0.0.0.0','192.168.01.2','192.168.1.999','127.0.0.2','[::1]']) { assert.equal(isLocalIPv4(host),false); assert.throws(()=>createNearbyOffer({...wifi,host},alice)); }
  for (const host of ['10.1.2.3','172.16.0.2','172.31.255.254','192.168.0.1','169.254.1.2','127.0.0.1']) assert.equal(isLocalIPv4(host),true);
  for (const offer of [{...wifi, extra:true},{...wifi, port:443},{...wifi, password:undefined},{...ble,service:'bad'},{...wifi,peer:alice.publicKey}]) assert.throws(()=>createNearbyOffer(offer,alice));
  const link=createNearbyOffer(wifi,alice);
  for (const v of [`${link}&other=1`,`${link}#extra`,link.replace('nearby','invite'),`https://example.org/nearby?${link.split('?')[1]}`,link.replace('.', '%2E')]) assert.throws(()=>inspectNearbyOffer(v,now));
  assert.throws(()=>inspectNearbyOffer(link,wifi.expiresAt),/expired/); assert.throws(()=>inspectNearbyOffer(link,now-30001),/future/);
});
test('independent QR decoder recovers both signed nearby connection kinds', () => {
  for (const offer of [wifi,ble]) { const link=createNearbyOffer(offer,alice), {modules}=invitationQR(link), scale=6, width=modules.length*scale, pixels=new Uint8ClampedArray(width*width*4); pixels.fill(255); for(let y=0;y<width;y++) for(let x=0;x<width;x++) if(modules[Math.floor(y/scale)][Math.floor(x/scale)]) { const p=(y*width+x)*4; pixels[p]=pixels[p+1]=pixels[p+2]=0; } const decoded=jsQR(pixels,width,width); assert.equal(decoded?.data,link); }
});
