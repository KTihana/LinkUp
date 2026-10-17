// SPDX-License-Identifier: GPL-3.0-only
import { createHash, createPublicKey, verify } from 'node:crypto';

export const ACTIONS = new Set(['publish', 'receive', 'ack', 'keys-publish', 'keys-claim', 'keys-status', 'keys-retire', 'admission-set', 'wait', 'call-config', 'push-config', 'push-register', 'push-unregister']);
export const MAX_CIPHERTEXT_BYTES = 64 * 1024;
export const MAX_KEY_PACKAGE_BYTES = 16 * 1024;
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HEX_ID = /^[a-f0-9]{32}$/;
const HEX_KEY = /^[a-f0-9]{64}$/;
const HEX_SIGNATURE = /^[a-f0-9]{128}$/;
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export class RelayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireShape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new RelayError(400, 'invalid_shape');
}
export function isKey(value) { return typeof value === 'string' && HEX_KEY.test(value); }
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function requestBytes(path, challenge, payload) {
  return Buffer.from(`common/mailbox-request/v1\n${path}\n${challenge}\n${hash(payload)}`, 'utf8');
}
export function envelopeBytes(envelope) {
  return Buffer.from('common/mailbox-envelope/v1\n' + JSON.stringify([1, envelope.id, envelope.sender, envelope.recipient, envelope.createdAt, envelope.expiresAt, envelope.ciphertext]), 'utf8');
}
export function packageBytes(packageValue) {
  return Buffer.from('common/key-package/v1\n' + JSON.stringify([1, packageValue.id, packageValue.owner, packageValue.createdAt, packageValue.expiresAt, packageValue.data]), 'utf8');
}
export function validSignature(publicKey, signature, bytes) {
  if (!isKey(publicKey) || typeof signature !== 'string' || !HEX_SIGNATURE.test(signature)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, bytes, key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
function validDates(createdAt, expiresAt, now, allowExpired) {
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) || createdAt < 0 || expiresAt <= createdAt || expiresAt - createdAt > MAX_TTL_MS || createdAt > now + 60_000 || (!allowExpired && expiresAt <= now)) throw new RelayError(400, 'invalid_expiry');
}
export function validateEnvelope(envelope, now, allowExpired = false) {
  requireShape(envelope, ['version', 'id', 'sender', 'recipient', 'createdAt', 'expiresAt', 'ciphertext', 'signature']);
  if (envelope.version !== 1 || typeof envelope.id !== 'string' || !HEX_ID.test(envelope.id) || !isKey(envelope.sender) || !isKey(envelope.recipient) || envelope.sender === envelope.recipient) throw new RelayError(400, 'invalid_envelope');
  validDates(envelope.createdAt, envelope.expiresAt, now, allowExpired);
  const text = envelope.ciphertext;
  if (typeof text !== 'string' || !text.length || text.length > Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new RelayError(400, 'invalid_ciphertext');
  const bytes = Buffer.from(text, 'base64');
  if (!bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES || bytes.toString('base64') !== text) throw new RelayError(400, 'invalid_ciphertext');
  if (!validSignature(envelope.sender, envelope.signature, envelopeBytes(envelope))) throw new RelayError(401, 'invalid_envelope_signature');
}
export function validatePackage(packageValue, now, allowExpired = false) {
  requireShape(packageValue, ['id', 'owner', 'createdAt', 'expiresAt', 'data', 'signature']);
  if (typeof packageValue.id !== 'string' || !HEX_ID.test(packageValue.id) || !isKey(packageValue.owner) || typeof packageValue.data !== 'string' || !packageValue.data.length || Buffer.byteLength(packageValue.data, 'utf8') > MAX_KEY_PACKAGE_BYTES) throw new RelayError(400, 'invalid_key_package');
  validDates(packageValue.createdAt, packageValue.expiresAt, now, allowExpired);
  if (!validSignature(packageValue.owner, packageValue.signature, packageBytes(packageValue))) throw new RelayError(401, 'invalid_package_signature');
}
