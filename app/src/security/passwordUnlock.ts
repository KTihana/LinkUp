// SPDX-License-Identifier: GPL-3.0-only
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
const aad = utf8ToBytes('linkup/password-unlock/v1');
const profile = { N: 32768, r: 8, p: 3, dkLen: 32, maxmem: 64 * 1024 * 1024 };
export const passwordRecordKey = (vault: string) => vault + '.password.v1';
export function validatePassword(password: string) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || !password.trim()) throw new Error('Use a password of 12–256 characters. A few random words are easier to remember.');
}
export function readPasswordRecord(serialized: string) {
  if (serialized.length > 1024) throw new Error('Invalid password protection.');
  const value = JSON.parse(serialized);
  if (!value || Object.keys(value).sort().join(',') !== 'ciphertext,kdf,nonce,salt,version' || value.version !== 1 || value.kdf !== 'scrypt-32768-8-3' || typeof value.salt !== 'string' || typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string' || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{48}$/.test(value.nonce) || !/^[a-f0-9]{96}$/.test(value.ciphertext)) throw new Error('Invalid password protection.');
  return value as { version: 1; kdf: string; salt: string; nonce: string; ciphertext: string };
}
export async function wrapPasswordKey(key: Uint8Array, password: string, random: (length: number) => Promise<Uint8Array>) {
  validatePassword(password); if (key.length !== 32) throw new Error('Invalid encryption key.');
  const salt = await random(16), nonce = await random(24);
  const derived = await scryptAsync(password, salt, profile);
  try { return JSON.stringify({ version: 1, kdf: 'scrypt-32768-8-3', salt: bytesToHex(salt), nonce: bytesToHex(nonce), ciphertext: bytesToHex(xchacha20poly1305(derived, nonce, aad).encrypt(key)) }); }
  finally { derived.fill(0); }
}
export async function unwrapPasswordKey(record: string, password: string) {
  validatePassword(password); const saved = readPasswordRecord(record);
  const derived = await scryptAsync(password, hexToBytes(saved.salt), profile);
  try { return xchacha20poly1305(derived, hexToBytes(saved.nonce), aad).decrypt(hexToBytes(saved.ciphertext)); }
  catch { throw new Error('That password did not unlock LinkUp. Your saved data is unchanged.'); }
  finally { derived.fill(0); }
}
