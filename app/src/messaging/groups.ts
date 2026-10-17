// SPDX-License-Identifier: GPL-3.0-only
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { MailSigner } from './mailboxClient.ts';

export type GroupMember = { publicKey: string; name: string };
export type GroupDescriptor = { version: 1; id: string; name: string; owner: string; members: GroupMember[]; createdAt: number; signature: string };
export type GroupRecord = { descriptor: GroupDescriptor; status: 'invited' | 'joined' | 'left'; departed: string[] };
export type GroupPacket = { group: GroupDescriptor; event: 'invite' | 'accept' | 'leave' | 'message'; kind: 'text' | 'sticker'; text: string };
export const MAX_GROUPS = 5, MAX_GROUP_MEMBERS = 8;
const key = /^[a-f0-9]{64}$/, id = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();
// A positive cache of complete signed descriptors avoids re-verifying the same
// roster for every saved fanout copy. A single changed byte misses the cache.
const verifiedDescriptors = new Map<string, true>();
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('Invalid group data.');
}
function name(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
export function groupBytes(d: Omit<GroupDescriptor, 'signature'>): Uint8Array {
  return encoder.encode('common/group/v1\n' + JSON.stringify([1, d.id, d.name, d.owner, d.members.map(m => [m.publicKey, m.name]), d.createdAt]));
}
export function validateGroup(value: unknown): asserts value is GroupDescriptor {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || serialized.length > 4000) throw new Error('Group data is too large.');
  if (verifiedDescriptors.has(serialized)) return;
  exact(value, ['version', 'id', 'name', 'owner', 'members', 'createdAt', 'signature']);
  const d = value as unknown as GroupDescriptor;
  if (d.version !== 1 || !id.test(d.id) || !name(d.name, 60) || !key.test(d.owner) || !Number.isSafeInteger(d.createdAt) || d.createdAt < 0 || !/^[a-f0-9]{128}$/.test(d.signature) || !Array.isArray(d.members) || d.members.length < 3 || d.members.length > MAX_GROUP_MEMBERS) throw new Error('Invalid group invitation.');
  const keys = new Set<string>();
  for (const member of d.members) {
    exact(member, ['publicKey', 'name']);
    if (!key.test(member.publicKey) || !name(member.name, 50) || keys.has(member.publicKey)) throw new Error('Invalid group members.');
    keys.add(member.publicKey);
  }
  if (!keys.has(d.owner) || !ed25519.verify(hexToBytes(d.signature), groupBytes(d), hexToBytes(d.owner))) throw new Error('The group invitation signature is invalid.');
  if (verifiedDescriptors.size >= 64) verifiedDescriptors.delete(verifiedDescriptors.keys().next().value!);
  verifiedDescriptors.set(serialized, true);
}
export function groupFingerprint(d: GroupDescriptor): string { return bytesToHex(sha256(groupBytes(d))); }
export function createGroupDescriptor(idValue: string, title: string, members: GroupMember[], createdAt: number, signer: MailSigner): GroupDescriptor {
  const unsigned = { version: 1 as const, id: idValue, name: title.trim(), owner: signer.publicKey, members: members.map(m => ({ publicKey: m.publicKey, name: m.name.trim() })).sort((a, b) => a.publicKey.localeCompare(b.publicKey)), createdAt };
  const d = { ...unsigned, signature: signer.sign(groupBytes(unsigned)) };
  validateGroup(d); return d;
}
export function readGroupPacket(text: string): GroupPacket {
  if (typeof text !== 'string' || text.length > 7500) throw new Error('Group message is too large.');
  const value: unknown = JSON.parse(text);
  exact(value, ['group', 'event', 'kind', 'text']);
  validateGroup(value.group);
  if (JSON.stringify(value) !== text || !['invite', 'accept', 'leave', 'message'].includes(value.event as string) || !['text', 'sticker'].includes(value.kind as string) || typeof value.text !== 'string' || (value.event !== 'message' && (value.text !== '' || value.kind !== 'text')) || (value.event === 'message' && (!value.text.length || encoder.encode(value.text).length > 4000))) throw new Error('Invalid group message.');
  if (value.kind === 'sticker' && !/^cat-(lavender|mint|peach|rose|sky|violet)$/.test(value.text)) throw new Error('Unknown sticker.');
  return value as unknown as GroupPacket;
}
export function validateGroups(groups: unknown): asserts groups is Record<string, GroupRecord> {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups) || Object.keys(groups).length > MAX_GROUPS) throw new Error('Group storage is full.');
  for (const [groupId, record] of Object.entries(groups)) {
    exact(record, ['descriptor', 'status', 'departed']); validateGroup(record.descriptor);
    const row = record as unknown as GroupRecord;
    if (groupId !== row.descriptor.id || !['invited', 'joined', 'left'].includes(row.status) || !Array.isArray(row.departed) || new Set(row.departed).size !== row.departed.length || row.departed.some(p => !row.descriptor.members.some(m => m.publicKey === p))) throw new Error('Invalid saved group.');
  }
}
