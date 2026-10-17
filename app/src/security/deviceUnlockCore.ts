// SPDX-License-Identifier: GPL-3.0-only
export type DeviceUnlockStatus = { available: boolean; enabled: boolean; kind?: 'phone' | 'biometric' };
export type DeviceUnlock = {
  status: () => Promise<DeviceUnlockStatus>;
  enable: (key: string, assertAllowed: () => void) => Promise<void>;
  read: () => Promise<string | null>;
  disable: () => Promise<void>;
  removeLegacyKey: () => Promise<void>;
  erase?: () => Promise<void>;
  archive?: (id: string) => Promise<void>;
  detach?: (id: string) => Promise<void>;
};
type Options = { keychainService?: string; requireAuthentication?: boolean; authenticationPrompt?: string; keychainAccessible?: number };
type ProtectedStore = {
  getItemAsync: (name: string, options?: Options) => Promise<string | null>;
  setItemAsync: (name: string, value: string, options?: Options) => Promise<void>;
  deleteItemAsync: (name: string, options?: Options) => Promise<void>;
  canUseBiometricAuthentication: () => boolean;
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: number;
};

// A fresh authenticated alias is essential: never reuse the old, unauthenticated
// convenience key. The marker is public metadata and cannot decrypt the vault.
export const BIOMETRIC_KEY = 'common.local-vault-biometric-key.v1';
export const BIOMETRIC_MARKER = 'common.local-vault-biometric-enabled.v1';
export const LEGACY_DEVICE_KEY = 'common.local-vault-key.v1';
export function createDeviceUnlock(store: ProtectedStore): DeviceUnlock {
  const auth: Options = { keychainService: 'common.vault.biometric.v1', requireAuthentication: true,
    authenticationPrompt: 'Unlock LinkUp', keychainAccessible: store.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY };
  const metadata: Options = { keychainService: 'common.vault.biometric-settings.v1', keychainAccessible: store.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY };
  const removeLegacyKey = () => store.deleteItemAsync(LEGACY_DEVICE_KEY);
  const enabled = async () => await store.getItemAsync(BIOMETRIC_MARKER, metadata) === '1';
  const disable = async () => {
    // Revoke access first, even if subsequent native deletion fails.
    await store.deleteItemAsync(BIOMETRIC_MARKER, metadata);
    await store.deleteItemAsync(BIOMETRIC_KEY, auth);
  };
  return {
    status: async () => ({ available: store.canUseBiometricAuthentication(), enabled: await enabled() }),
    removeLegacyKey, disable,
    erase: async () => { await disable(); await removeLegacyKey(); },
    read: async () => {
      if (!await enabled()) throw new Error('Enable biometric unlock after opening LinkUp with your recovery key.');
      // SecureStore binds this read to a native Keystore/Keychain authentication
      // operation. A separate success boolean is never used to release a key.
      return store.getItemAsync(BIOMETRIC_KEY, auth);
    },
    enable: async (key, assertAllowed) => {
      assertAllowed();
      if (!store.canUseBiometricAuthentication()) throw new Error('Set up a supported fingerprint or face unlock in your phone settings first.');
      if (await enabled()) throw new Error('Biometric unlock is already enabled.');
      assertAllowed();
      try {
        await store.setItemAsync(BIOMETRIC_KEY, key, auth);
        assertAllowed();
        // iOS does not authenticate on initial creation, so always require an
        // authenticated read-back before activating the shortcut on either OS.
        const verified = await store.getItemAsync(BIOMETRIC_KEY, auth);
        assertAllowed();
        if (verified !== key) throw new Error('Biometric key verification failed.');
        await removeLegacyKey();
        assertAllowed();
        await store.setItemAsync(BIOMETRIC_MARKER, '1', metadata);
        assertAllowed();
      } catch (error) {
        try { await disable(); }
        catch { throw new Error('Biometric setup could not be cleaned up. Use your recovery key and turn biometric unlock off before trying again.'); }
        throw error;
      }
    },
  };
}
