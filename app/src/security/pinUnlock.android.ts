// SPDX-License-Identifier: GPL-3.0-only
import { NativeModule, requireOptionalNativeModule } from 'expo';
import { pinError, type PinUnlock } from './pinUnlockCore';
declare class NativePin extends NativeModule {
  status(): ReturnType<PinUnlock['status']>;
  enable(key: string, pin: string): Promise<void>;
  read(pin: string): Promise<string>;
  disable(): Promise<void>;
  erase(): Promise<void>;
  archive(id: string): Promise<void>;
  detach(id: string): Promise<void>;
}
const native = requireOptionalNativeModule<NativePin>('LinkUpPinUnlock');
export const pinUnlock: PinUnlock | undefined = native ? {
  status: () => native.status(), enable: async (key, pin) => { try { await native.enable(key, pin); } catch (e) { throw pinError(e, true); } },
  read: async pin => { try { return await native.read(pin); } catch (e) { throw pinError(e); } }, disable: () => native.disable(),
  erase: () => native.erase(),
  archive: id => native.archive(id), detach: id => native.detach(id),
} : undefined;
