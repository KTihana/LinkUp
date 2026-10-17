// SPDX-License-Identifier: GPL-3.0-only
import type { PrivateNetworkStatus } from './types.ts';
export function requireVpnAccount(status: PrivateNetworkStatus, account: string | null | undefined) {
  const identity = account?.replace(/^common:/, '');
  if (!identity || !/^[a-f0-9]{64}$/.test(identity) || !status.initialized || status.identity !== identity ||
      (status.config && (status.config.identity !== identity || status.config.devicePublicKey !== status.publicKey))) {
    throw new Error('This private network belongs to another account or phone. Remove the saved network and enroll this account.');
  }
}
