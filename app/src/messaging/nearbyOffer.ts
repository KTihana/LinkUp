// SPDX-License-Identifier: GPL-3.0-only
import { base64urlnopad } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { MailSigner } from './mailboxClient.ts';

export const NEARBY_OFFER_TTL = 10 * 60 * 1000;
export const BLE_SERVICE = 'b8e7f1a0-6e3b-4c28-9bd8-9756d6f74a20';
type Common = { version: 1; publicKey: string; peer: string; issuedAt: number; expiresAt: number; nonce: string };
export type NearbyOffer = Common & ({ kind: 'wifi'; host: string; port: number; pin: string; ssid?: string; password?: string } | { kind: 'vpn'; host: string; port: number; pin: string } | { kind: 'bluetooth'; service: string });
const invalid = () => new Error('This nearby code is invalid or has been changed.');
function validIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return false;
  try { const p = ed25519.Point.fromBytes(hexToBytes(value), false); return !p.isSmallOrder() && p.isTorsionFree() && bytesToHex(p.toBytes()) === value; } catch { return false; }
}
export function isLocalIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const p = value.split('.').map(Number);
  return p.every(n => n <= 255) && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || value === '127.0.0.1');
}
export function isPrivateNetworkIPv4(value: unknown): value is string {
  return isLocalIPv4(value) && value.startsWith('10.203.') && Number(value.split('.')[3]) >= 1 && Number(value.split('.')[3]) <= 254;
}
function validate(value: unknown): asserts value is NearbyOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as NearbyOffer;
  const required = ['version', 'publicKey', 'peer', 'issuedAt', 'expiresAt', 'nonce', 'kind'];
  const allowed = v.kind === 'wifi' ? [...required, 'host', 'port', 'pin', 'ssid', 'password'] : v.kind === 'vpn' ? [...required, 'host', 'port', 'pin'] : [...required, 'service'];
  if (required.some(f => !Object.hasOwn(v, f)) || Object.keys(v).some(f => !allowed.includes(f))
    || v.version !== 1 || !validIdentity(v.publicKey) || !validIdentity(v.peer) || v.peer === v.publicKey
    || !Number.isSafeInteger(v.issuedAt) || v.issuedAt < 0 || !Number.isSafeInteger(v.expiresAt)
    || v.expiresAt - v.issuedAt !== NEARBY_OFFER_TTL || typeof v.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(v.nonce)) throw invalid();
  if (v.kind === 'wifi' || v.kind === 'vpn') {
    if (!isLocalIPv4(v.host) || !Number.isSafeInteger(v.port) || v.port < 1024 || v.port > 65535 || typeof v.pin !== 'string' || !/^[a-f0-9]{64}$/.test(v.pin)) throw invalid();
    if (v.kind === 'vpn') { if (!isPrivateNetworkIPv4(v.host) || v.port !== 47443) throw invalid(); return; }
    if ((v.ssid === undefined) !== (v.password === undefined)) throw invalid();
    if (v.ssid !== undefined && (typeof v.ssid !== 'string' || !v.ssid.length || utf8ToBytes(v.ssid).length > 32 || /[\u0000-\u001f\u007f]/.test(v.ssid)
      || typeof v.password !== 'string' || !/^[\x20-\x7e]{8,63}$/.test(v.password))) throw invalid();
  } else if (v.kind !== 'bluetooth' || v.service !== BLE_SERVICE) throw invalid();
}
function canonical(v: NearbyOffer) {
  const common = { version: v.version, publicKey: v.publicKey, peer: v.peer, issuedAt: v.issuedAt, expiresAt: v.expiresAt, nonce: v.nonce, kind: v.kind };
  return JSON.stringify(v.kind === 'vpn' ? { ...common, host: v.host, port: v.port, pin: v.pin } : v.kind === 'wifi' ? { ...common, host: v.host, port: v.port, pin: v.pin, ...(v.ssid === undefined ? {} : { ssid: v.ssid, password: v.password }) } : { ...common, service: v.service });
}
export function nearbyOfferBytes(v: NearbyOffer) { validate(v); return utf8ToBytes('common/nearby-offer/v1\n' + canonical(v)); }
/** Connection details for the selected friend, including temporary hotspot credentials when present. Identity and TLS private keys are never exported. */
export function createNearbyOffer(value: NearbyOffer, signer: MailSigner): string {
  validate(value);
  if (signer.publicKey !== value.publicKey) throw invalid();
  const token = `${base64urlnopad.encode(utf8ToBytes(canonical(value)))}.${signer.sign(nearbyOfferBytes(value))}`;
  const link = `common://nearby?token=${token}`;
  if (link.length > 2048) throw new Error('Nearby connection details are too large for a QR code.');
  inspectNearbyOffer(link, value.issuedAt);
  return link;
}
export function inspectNearbyOffer(input: string, now: number): NearbyOffer {
  if (typeof input !== 'string' || input.length > 2048 || !Number.isSafeInteger(now) || now < 0) throw invalid();
  const match = /^(?:common:\/\/nearby\?token=)?([A-Za-z0-9_-]+)\.([a-f0-9]{128})$/.exec(input.trim());
  if (!match) throw invalid();
  let text: string, value: unknown;
  try { const bytes = base64urlnopad.decode(match[1]); if (base64urlnopad.encode(bytes) !== match[1]) throw invalid(); text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); } catch { throw invalid(); }
  validate(value);
  if (canonical(value) !== text!) throw invalid();
  if (value.issuedAt > now + 30000) throw new Error('This nearby code was created in the future.');
  if (value.expiresAt <= now) throw new Error('This nearby code expired. Ask your friend for a new one.');
  if (!ed25519.verify(hexToBytes(match[2]), nearbyOfferBytes(value), hexToBytes(value.publicKey), { zip215: false })) throw invalid();
  return value;
}
