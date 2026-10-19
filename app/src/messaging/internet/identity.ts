// SPDX-License-Identifier: GPL-3.0-only
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
/** Standard Ed25519→X25519 conversion keeps existing signed friend invitations usable. */
export function internetPublicKey(publicKey: string): string {
  const bytes = hexToBytes(publicKey), point = ed25519.Point.fromBytes(bytes, false);
  if (bytes.length !== 32 || point.isSmallOrder() || !point.isTorsionFree() || bytesToHex(point.toBytes()) !== publicKey) throw new Error('Invalid friend identity.');
  return bytesToHex(ed25519.utils.toMontgomery(bytes));
}
export function internetSecretKey(seed: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomerySecret(seed);
}
