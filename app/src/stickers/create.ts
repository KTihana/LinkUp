// SPDX-License-Identifier: GPL-3.0-only
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { cleanupGeneratedPhoto } from '../security/photoCleanup';
import { isCustomSticker, stickerDataUri } from './content';

/** Crop and resize locally; send only bounded raster data through encrypted chats. */
export async function createCustomSticker(image: { uri: string; width: number; height: number }): Promise<string> {
  for (const [side, format, quality] of [[96, SaveFormat.PNG, 1], [96, SaveFormat.JPEG, .55], [64, SaveFormat.JPEG, .35]] as const) {
    const context = ImageManipulator.manipulate(image.uri);
    const square = Math.min(image.width, image.height);
    context.crop({ originX: (image.width - square) / 2, originY: (image.height - square) / 2, width: square, height: square }).resize({ width: side, height: side });
    const rendered = await context.renderAsync();
    const result = await rendered.saveAsync({ format, compress: quality, base64: true });
    try {
      const uri = stickerDataUri(format === SaveFormat.PNG ? 'png' : 'jpeg', result.base64 ?? '');
      if (isCustomSticker(uri)) return uri;
    } finally {
      if (result.uri !== image.uri) cleanupGeneratedPhoto(result.uri);
    }
  }
  throw new Error('This photo could not be made into a sticker. Try a simpler image.');
}
