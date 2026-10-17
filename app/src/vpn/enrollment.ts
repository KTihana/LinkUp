// SPDX-License-Identifier: GPL-3.0-only
import { base64 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { MailSigner } from '../messaging/mailboxClient.ts';

export type Enrollment = { schema: 1; identity: string; devicePublicKey: string; issuedAt: number; signature: string };
export function enrollmentBytes(value: Omit<Enrollment, 'signature'>): Uint8Array {
  if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.identity) || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0) throw new Error('Invalid private network enrollment.');
  const key = base64.decode(value.devicePublicKey);
  if (key.length !== 32 || !key.some(Boolean) || base64.encode(key) !== value.devicePublicKey) throw new Error('Invalid device public key.');
  const point = ed25519.Point.fromBytes(hexToBytes(value.identity), false);
  if (point.isSmallOrder() || !point.isTorsionFree() || bytesToHex(point.toBytes()) !== value.identity) throw new Error('Invalid account identity.');
  return utf8ToBytes('linkup/vpn-enrollment/v1\n' + JSON.stringify({ schema: 1, identity: value.identity, devicePublicKey: value.devicePublicKey, issuedAt: value.issuedAt }));
}
export function createEnrollment(devicePublicKey: string, signer: MailSigner, now: number): string {
  const value = { schema: 1 as const, identity: signer.publicKey, devicePublicKey, issuedAt: now };
  return JSON.stringify({ ...value, signature: signer.sign(enrollmentBytes(value)) });
}
