// SPDX-License-Identifier: GPL-3.0-only
import { NativeModule, requireOptionalNativeModule } from 'expo';
import type { PrivateNetworkNative, PrivateNetworkStatus } from './types';

declare class NativeVpn extends NativeModule<{ change: (status: PrivateNetworkStatus) => void }> {
  status(): Promise<PrivateNetworkStatus>;
  initialize(identity: string): Promise<PrivateNetworkStatus>;
  configure(configJson: string): Promise<PrivateNetworkStatus>;
  connect(): Promise<PrivateNetworkStatus>;
  stop(): Promise<void>;
  erase(): Promise<void>;
}

const native = requireOptionalNativeModule<NativeVpn>('LinkUpVpn');
export const privateNetwork: PrivateNetworkNative | undefined = native ? {
  status: () => native.status(),
  initialize: identity => native.initialize(identity),
  configure: json => native.configure(json),
  connect: () => native.connect(),
  stop: () => native.stop(),
  erase: () => native.erase(),
  subscribe: listener => { const subscription = native.addListener('change', listener); return () => subscription.remove(); },
} : undefined;
export type { PrivateNetworkConfig, PrivateNetworkStatus, PrivateNetworkNative } from './types';
