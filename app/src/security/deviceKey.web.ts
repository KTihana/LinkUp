// Web deliberately does not persist the decryption key alongside ciphertext.
// A browser permission dialog is not equivalent to a protected native key read.
import type { DeviceUnlock } from './deviceUnlockCore';
export const deviceUnlock: DeviceUnlock = {
  status: async () => ({ available: false, enabled: false }),
  enable: async () => { throw new Error('Biometric unlock is available in the Android and iPhone apps.'); },
  read: async () => { throw new Error('Use your recovery key in this browser.'); },
  disable: async () => {}, removeLegacyKey: async () => {},
};
