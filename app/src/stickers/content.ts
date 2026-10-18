// SPDX-License-Identifier: GPL-3.0-only
import { base64 } from '@scure/base';

// Fits the existing private/group message limits without external image URLs.
export const MAX_CUSTOM_STICKER_LENGTH = 3500;
export const MAX_STICKER_SIDE = 128;
const legacyIds = new Set(['cat-lavender', 'cat-mint', 'cat-peach', 'cat-rose', 'cat-sky', 'cat-violet']);

/** Strip image metadata locally, retaining only pixels and decoding information. */
export function stickerDataUri(format: 'png' | 'jpeg', encoded: string): string {
  const bytes = base64.decode(encoded);
  if (bytes.length > 128000) throw new Error('Sticker image is too large.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let offset = format === 'png' ? 8 : 2;
  parts.push(bytes.subarray(0, offset));
  while (offset < bytes.length) {
    const start = offset;
    if (format === 'png') {
      if (offset + 12 > bytes.length) throw new Error('Invalid sticker image.');
      const length = view.getUint32(offset), type = view.getUint32(offset + 4);
      offset += length + 12;
      if (offset > bytes.length) throw new Error('Invalid sticker image.');
      if ([0x49484452, 0x504c5445, 0x49444154, 0x49454e44, 0x74524e53].includes(type)) parts.push(bytes.subarray(start, offset));
    } else {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid sticker image.');
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) { parts.push(bytes.subarray(start)); break; }
      if (offset + 2 > bytes.length) throw new Error('Invalid sticker image.');
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Invalid sticker image.');
      offset += length;
      if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(bytes.subarray(start, offset));
    }
  }
  const clean = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) { clean.set(part, cursor); cursor += part.length; }
  return `data:image/${format};base64,${base64.encode(clean)}`;
}

export function isCustomSticker(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_CUSTOM_STICKER_LENGTH) return false;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  let bytes: Uint8Array;
  try { bytes = base64.decode(match[2]); if (base64.encode(bytes) !== match[2]) return false; } catch { return false; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (w: number, h: number) => w > 0 && h > 0 && w <= MAX_STICKER_SIDE && h <= MAX_STICKER_SIDE;
  if (match[1] === 'png') {
    if (bytes.length < 57 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
    return size(view.getUint32(16), view.getUint32(20)) && view.getUint32(bytes.length - 12) === 0 && view.getUint32(bytes.length - 8) === 0x49454e44;
  }
  if (bytes.length < 12 || view.getUint16(0) !== 0xffd8 || view.getUint16(bytes.length - 2) !== 0xffd9) return false;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return length >= 8 && bytes[offset + 2] === 8 && size(view.getUint16(offset + 5), view.getUint16(offset + 3));
    offset += length;
  }
  return false;
}

/** Retain old message IDs so upgrading never invalidates saved conversations. */
export function isStickerContent(value: unknown): value is string {
  return typeof value === 'string' && (legacyIds.has(value) || isCustomSticker(value));
}
