// SPDX-License-Identifier: GPL-3.0-only
import { NativeModule, requireOptionalNativeModule } from 'expo';
import * as SecureStore from 'expo-secure-store';
import { createDeviceUnlock, type DeviceUnlock } from './deviceUnlockCore';
declare class PhoneUnlock extends NativeModule {
  status(): Promise<{ available: boolean; enabled: boolean; ignoreLegacy: boolean }>;
  enable(key: string): Promise<void>;
  read(): Promise<string | null>;
  disable(): Promise<void>;
  erase(): Promise<void>;
  archive(id: string, legacy: boolean): Promise<void>;
  detach(id: string): Promise<void>;
}
const phone = requireOptionalNativeModule<PhoneUnlock>('LinkUpPhoneUnlock');
const legacy = createDeviceUnlock(SecureStore);
export const deviceUnlock: DeviceUnlock = {
  status: async () => {
    const current = await phone?.status();
    if (current?.enabled) return { ...current, kind: 'phone' };
    const old = current?.ignoreLegacy ? { available: false, enabled: false } : await legacy.status();
    if (old.enabled) return { ...old, kind: 'biometric' };
    return { available: current?.available || old.available, enabled: false, kind: current?.available ? 'phone' : 'biometric' };
  },
  enable: async (key, assertAllowed) => {
    const current = await phone?.status();
    if (!current?.available) {
      if (current?.ignoreLegacy) throw new Error('Use a password on this Android version to preserve the previous account’s saved unlock.');
      if ((await legacy.status()).enabled) { const saved = await legacy.read(); assertAllowed(); if (saved !== key) throw new Error('The saved biometric method does not match this account.'); return; }
      return legacy.enable(key, assertAllowed);
    }
    assertAllowed();
    try { await phone!.enable(key); assertAllowed(); }
    catch (e) { if (!current.enabled) await phone!.disable(); throw e; }
  },
  read: async () => {
    const current = await phone?.status();
    if (current?.enabled) return phone!.read();
    if (current?.ignoreLegacy) throw new Error('Phone unlock is not set up for this account.');
    return legacy.read();
  },
  disable: async () => { const current = await phone?.status(); await phone?.disable(); if (!current?.ignoreLegacy) await legacy.disable(); },
  erase: async () => { await phone?.erase(); await legacy.erase!(); },
  archive: async id => { if (!phone) throw new Error('Update LinkUp before archiving protected phone access.'); const current = await phone.status(); await phone.archive(id, !current.ignoreLegacy && (await legacy.status()).enabled); },
  detach: async id => { if (!phone) throw new Error('Update LinkUp before starting a new account.'); await phone.detach(id); },
  removeLegacyKey: legacy.removeLegacyKey,
};
