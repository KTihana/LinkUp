// SPDX-License-Identifier: GPL-3.0-only
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { validateMailEnvelope, validatePublicPackage, requestBytes, type MailEnvelope, type PublicPackage } from './mailboxClient.ts';

export const MAX_NEARBY_PACKET_BYTES = 128 * 1024;
export const nearbyKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const nearbyId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export type NearbyAction = 'publish' | 'keys-claim';
export type NearbyPacket =
  | { version: 1; id: string; type: 'challenge'; publicKey: string; action: NearbyAction }
  | { version: 1; id: string; type: 'request'; publicKey: string; action: NearbyAction; challenge: string; payload: string; signature: string }
  | { version: 1; id: string; type: 'response'; publicKey: string; body: string; signature: string };
export type NearbyResult = { requestHash: string; ok: true; result: unknown } | { requestHash: string; ok: false; error: 'no-keys' | 'busy' | 'rejected' };
export type NearbyStore = {
  version: 1; packages: PublicPackage[]; inbox: MailEnvelope[];
  claimed: { id: string; expiresAt: number }[];
  accepted: { sender: string; id: string; expiresAt: number }[];
};
export const emptyNearbyStore = (): NearbyStore => ({ version: 1, packages: [], inbox: [], claimed: [], accepted: [] });
export function nearbyShape(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field))) throw new Error('Invalid nearby packet.');
}
const signature = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{128}$/.test(value);
const date = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function verifyNearbySignature(owner: string, sig: string, bytes: Uint8Array): void {
  if (!nearbyKey(owner) || !signature(sig)) throw new Error('Invalid nearby signature.');
  try {
    const point = ed25519.Point.fromBytes(hexToBytes(owner), false);
    if (point.isSmallOrder() || !point.isTorsionFree() || bytesToHex(point.toBytes()) !== owner
      || !ed25519.verify(hexToBytes(sig), bytes, hexToBytes(owner), { zip215: false })) throw new Error();
  } catch { throw new Error('Nearby peer authentication failed.'); }
}
export function decodeNearbyPacket(serialized: string): NearbyPacket {
  if (typeof serialized !== 'string' || utf8ToBytes(serialized).length > MAX_NEARBY_PACKET_BYTES) throw new Error('Nearby packet is too large.');
  const raw: unknown = JSON.parse(serialized);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid nearby packet.');
  const packet = raw as Record<string, unknown>;
  if (JSON.stringify(packet) !== serialized) throw new Error('Nearby packet is not canonical.');
  if (!packet || typeof packet !== 'object' || !('type' in packet)) throw new Error('Invalid nearby packet.');
  if (packet.type === 'challenge') nearbyShape(packet, ['version', 'id', 'type', 'publicKey', 'action']);
  else if (packet.type === 'request') {
    nearbyShape(packet, ['version', 'id', 'type', 'publicKey', 'action', 'challenge', 'payload', 'signature']);
    if (typeof packet.challenge !== 'string' || !/^[a-f0-9]{48}$/.test(packet.challenge)
      || typeof packet.payload !== 'string' || !signature(packet.signature)) throw new Error('Invalid nearby request.');
  } else if (packet.type === 'response') {
    nearbyShape(packet, ['version', 'id', 'type', 'publicKey', 'body', 'signature']);
    if (typeof packet.body !== 'string' || utf8ToBytes(packet.body).length > 24576 || !signature(packet.signature)) throw new Error('Invalid nearby response.');
  } else throw new Error('Unsupported nearby packet.');
  const p = packet as Record<string, unknown>;
  if (p.version !== 1 || !nearbyId(p.id) || !nearbyKey(p.publicKey)
    || (p.type !== 'response' && p.action !== 'publish' && p.action !== 'keys-claim')) throw new Error('Invalid nearby packet.');
  return packet as NearbyPacket;
}
export function packetHash(serialized: string): string { return bytesToHex(sha256(utf8ToBytes(serialized))); }
export function nearbyResponseBytes(id: string, body: string): Uint8Array { return requestBytes('/nearby/response/v1', id, body); }
export function decodeNearbyResult(body: string): NearbyResult {
  const raw: unknown = JSON.parse(body);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid nearby result.');
  const result = raw as Record<string, unknown>;
  if (JSON.stringify(result) !== body || !result || typeof result !== 'object' || !('ok' in result)) throw new Error('Invalid nearby result.');
  nearbyShape(result, result.ok ? ['requestHash', 'ok', 'result'] : ['requestHash', 'ok', 'error']);
  if (!nearbyKey(result.requestHash) || typeof result.ok !== 'boolean'
    || (!result.ok && !['no-keys', 'busy', 'rejected'].includes(result.error as string))) throw new Error('Invalid nearby result.');
  return result as NearbyResult;
}
export function validateNearbyStore(value: unknown): asserts value is NearbyStore {
  nearbyShape(value, ['version', 'packages', 'inbox', 'claimed', 'accepted']);
  const store = value as unknown as NearbyStore;
  if (store.version !== 1 || !Array.isArray(store.packages) || store.packages.length > 100
    || !Array.isArray(store.inbox) || store.inbox.length > 50 || !Array.isArray(store.claimed) || store.claimed.length > 1024
    || !Array.isArray(store.accepted) || store.accepted.length > 1024) throw new Error('Nearby saved storage limit exceeded.');
  const keys = new Set<string>(), accepted = new Set<string>(), claimed = new Set<string>(), inbox = new Set<string>();
  for (const p of store.packages) { validatePublicPackage(p, p?.owner, p?.createdAt); if (keys.has(p.id)) throw new Error('Duplicate nearby package.'); keys.add(p.id); }
  for (const item of store.claimed) {
    nearbyShape(item, ['id', 'expiresAt']);
    if (!nearbyId(item.id) || !date(item.expiresAt) || keys.has(item.id) || claimed.has(item.id)) throw new Error('Invalid nearby key claim.');
    claimed.add(item.id);
  }
  for (const item of store.accepted) {
    nearbyShape(item, ['sender', 'id', 'expiresAt']); const id = `${item.sender}:${item.id}`;
    if (!nearbyKey(item.sender) || !nearbyId(item.id) || !date(item.expiresAt) || accepted.has(id)) throw new Error('Invalid nearby deduplication record.');
    accepted.add(id);
  }
  for (const e of store.inbox) {
    validateMailEnvelope(e, e?.recipient, e?.createdAt); const id = `${e.sender}:${e.id}`;
    if (inbox.has(id) || !store.accepted.some(item => item.sender === e.sender && item.id === e.id && item.expiresAt === e.expiresAt)) throw new Error('Invalid nearby saved inbox.');
    inbox.add(id);
  }
}
export function pruneNearbyStore(store: NearbyStore, now: number): void {
  store.packages = store.packages.filter(item => item.expiresAt > now);
  store.inbox = store.inbox.filter(item => item.expiresAt > now);
  store.claimed = store.claimed.filter(item => item.expiresAt > now);
  store.accepted = store.accepted.filter(item => item.expiresAt > now);
}
