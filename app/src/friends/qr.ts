// SPDX-License-Identifier: GPL-3.0-only
// The package exports one CommonJS factory; its default import is intentional.
// eslint-disable-next-line import/no-named-as-default
import qrcode from 'qrcode-generator';

export function invitationQR(value: string) {
  if (!value || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) throw new Error('Invalid QR invitation.');
  const qr = qrcode(0, 'M'); qr.addData(value, 'Byte'); qr.make();
  const count = qr.getModuleCount();
  const modules = Array.from({ length: count + 8 }, (_, row) => Array.from({ length: count + 8 }, (_, col) => row >= 4 && col >= 4 && row < count + 4 && col < count + 4 && qr.isDark(row - 4, col - 4)));
  let path = '';
  for (let row = 0; row < modules.length; row++) for (let col = 0; col < modules.length; col++) if (modules[row][col]) path += `M${col},${row}h1v1h-1z`;
  return { path, size: count + 8, modules };
}
