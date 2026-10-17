import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { getRandomBytesAsync } from 'expo-crypto';
import { MessagingTask, Profile, VaultController, VaultSnapshot } from './vaultCore';
import { createInvitation, inspectInvitation, isValidDisplayName } from './invitation';
import { notificationsNative } from '../notifications/native';
import { deviceUnlock } from './deviceKey';
import { privateNetwork } from '../vpn/native';
import { pinUnlock } from './pinUnlock';
import { withVaultWrite } from './withVaultWrite';
import { eraseAccountCaches } from './eraseAccountCaches';
import * as SecureStore from 'expo-secure-store';
import { isForeground, watchSessionVisibility } from './sessionVisibility';
import type { AppearancePatch } from '../appearance/palette';

type VaultContextValue = VaultSnapshot & {
  beginSetup: () => Promise<void>; commitSetup: () => Promise<void>; cancelSetup: () => void;
  createIdentity: (method: 'device' | 'password' | 'pin', password?: string) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<void>; setPin: (pin: string) => Promise<void>;
  unlockWithPassword: (password: string) => Promise<void>; setPassword: (password: string) => Promise<void>; startNewIdentity: () => Promise<void>;
  recoverOnThisPhone: (password?: string) => Promise<void>;
  enableBackgroundMessaging: (baseline?: string[]) => Promise<void>;
  unlock: (key: string) => Promise<void>; lock: () => void;
  enableDeviceUnlock: () => Promise<void>; disableDeviceUnlock: () => Promise<void>; unlockWithDevice: () => Promise<void>;
  saveProfile: (profile: Profile) => Promise<void>; setOnline: (value: boolean) => Promise<void>;
  createInvite: () => Promise<string>; acceptInvite: (input: string) => Promise<void>;
  removeContact: (publicKey: string) => Promise<void>;
  transactMessaging: <T>(task: MessagingTask<T>) => Promise<T>;
  saveAppearance: (patch: AppearancePatch) => Promise<void>;
  importLegacyAppearance: () => Promise<void>;
};
const Context = createContext<VaultContextValue | null>(null);
export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [controller] = useState(() => new VaultController({
    store: AsyncStorage, recordKey: 'common.encrypted-vault.v1', randomBytes: getRandomBytesAsync,
    eraseExternalAccountData: async () => {
      notificationsNative?.deliveryAllowed(false);
      await notificationsNative?.disable();
      await privateNetwork?.erase();
      if (Platform.OS !== 'web') await SecureStore.deleteItemAsync('tiho.updates.preferences.v1');
      await eraseAccountCaches();
    },
    reloadExternalWrites: Platform.OS === 'android',
    deviceUnlock, pinUnlock, withWrite: withVaultWrite, now: Date.now,
    signInvitation: createInvitation, verifyInvitation: inspectInvitation, isValidDisplayName, isForeground,
  }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.start(); return controller.stop; }, [controller]);
  // Native system pickers/permissions temporarily leave the active app. Allow
  // a bounded 30-second return; web hides/pagehide lock immediately.
  useEffect(() => watchSessionVisibility(controller.suspend, 30_000), [controller]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void controller.refreshDeviceUnlock(); });
    return () => listener.remove();
  }, [controller]);
  return <Context.Provider value={{
    ...snapshot, beginSetup: controller.beginSetup, commitSetup: controller.commitSetup, cancelSetup: controller.cancelSetup,
    createIdentity: async (method, password = '') => { await controller.beginSetup(false); try { await controller.commitSetup(method === 'device' ? { method } : method === 'pin' ? { method, pin: password } : { method, password }); } catch (e) { controller.cancelSetup(); throw e; } },
    unlockWithPin: controller.unlockWithPin, setPin: controller.setPin,
    unlockWithPassword: controller.unlockWithPassword, setPassword: controller.setPassword,
    recoverOnThisPhone: async password => {
      if (!notificationsNative || !(await notificationsNative.status()).enabled) throw new Error('No saved background access was found on this phone.');
      await controller.recoverWithSavedKey(await notificationsNative.key(), password === undefined ? { method: 'device' } : { method: 'password', password });
    },
    startNewIdentity: async () => {
      // Revoke background signers before taking the shared vault write lock.
      notificationsNative?.deliveryAllowed(false);
      await controller.startNewIdentity();
    },
    unlock: controller.unlock, lock: () => { void privateNetwork?.stop().catch(() => {}); controller.lock(); }, saveProfile: controller.saveProfile, setOnline: controller.setOnline,
    enableBackgroundMessaging: async (baseline = []) => { if (!notificationsNative) throw new Error('Background replies require the Android app.'); try { await controller.enableBackgroundAccess(key => notificationsNative!.enable(key, JSON.stringify(baseline.slice(-1000)))); } catch (e) { await notificationsNative.disable().catch(() => {}); throw e; } },
    enableDeviceUnlock: controller.enableDeviceUnlock, disableDeviceUnlock: controller.disableDeviceUnlock, unlockWithDevice: controller.unlockWithDevice,
    createInvite: controller.createInvite, acceptInvite: controller.acceptInvite, removeContact: controller.removeContact,
    transactMessaging: controller.transactMessaging,
    saveAppearance: controller.saveAppearance, importLegacyAppearance: controller.importLegacyAppearance,
  }}>{children}</Context.Provider>;
}
export function useVault() { const value = useContext(Context); if (!value) throw new Error('Missing vault provider.'); return value; }
