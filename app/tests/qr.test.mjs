import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import jsQR from 'jsqr';
import { invitationQR } from '../src/friends/qr.ts';
import { createInvitation, inspectInvitation, invitationShareUrl } from '../src/security/invitation.ts';

test('an independent QR decoder recovers exact invitations including Unicode names', () => {
  for (const name of ['Mia 🌿', 'Željko', 'A'.repeat(50)]) {
    const now = 1791925200000;
    const token = createInvitation(randomBytes(32), name, randomBytes(16), now);
    for (const link of [invitationShareUrl(token), `common://invite?token=${token}`, `https://common.example/invite?token=${token}`]) {
      const { modules, size } = invitationQR(link), scale = 4, width = size * scale;
      const pixels = new Uint8ClampedArray(width * width * 4);
      for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4, shade = modules[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
        pixels.set([shade, shade, shade, 255], index);
      }
      assert.equal(jsQR(pixels, width, width)?.data, link);
      assert.equal(inspectInvitation(link, now).name, name);
      assert.equal(modules.slice(0, 4).flat().some(Boolean), false);
    }
  }
});
