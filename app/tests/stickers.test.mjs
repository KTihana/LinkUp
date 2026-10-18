import test from 'node:test';
import assert from 'node:assert/strict';
import { isCustomSticker, isStickerContent, stickerDataUri } from '../src/stickers/content.ts';
import { customSticker, jpegWithMetadata } from './fixtures/customSticker.mjs';
const jpegSticker = stickerDataUri('jpeg', jpegWithMetadata);

test('custom stickers accept bounded PNG and JPEG data while retaining old message IDs', () => {
  assert.equal(isCustomSticker(customSticker), true);
  assert.equal(isCustomSticker(jpegSticker), true);
  assert.equal(isCustomSticker('cat-mint'), false);
  assert.equal(isStickerContent('cat-mint'), true, 'upgrading must not invalidate saved messages');
});

test('custom stickers reject remote URLs, SVG, malformed encodings and oversized rasters', () => {
  for (const value of [null, '', 'file:///sticker.jpg', 'https://example.com/sticker.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,AA==', customSticker + 'A', 'data:image/jpeg;base64,' + 'A'.repeat(3500)]) assert.equal(isCustomSticker(value), false);
  const png = Buffer.from(customSticker.split(',')[1], 'base64');
  for (const [width, height] of [[0, 1], [1, 0], [129, 1], [1, 1000000]]) {
    const changed = Buffer.from(png); changed.writeUInt32BE(width, 16); changed.writeUInt32BE(height, 20);
    assert.equal(isCustomSticker('data:image/png;base64,' + changed.toString('base64')), false);
  }
  const truncated = Buffer.from(jpegSticker.split(',')[1], 'base64').subarray(0, 100);
  assert.equal(isCustomSticker('data:image/jpeg;base64,' + truncated.toString('base64')), false);
});

test('creation strips JPEG metadata before encrypted delivery', () => {
  assert.ok(jpegSticker.length < jpegWithMetadata.length);
  const bytes = Buffer.from(jpegSticker.split(',')[1], 'base64');
  assert.equal(bytes.includes(Buffer.from('Exif')), false);
  assert.equal(bytes.includes(Buffer.from('ICC_PROFILE')), false);
  assert.equal(isCustomSticker(jpegSticker), true);
});
