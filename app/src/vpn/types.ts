// SPDX-License-Identifier: GPL-3.0-only
/** Public enrollment only. Private WireGuard keys never cross the native boundary. */
export type PrivateNetworkConfig = {
  schema: 1;
  identity: string;
  devicePublicKey: string;
  label: string;
  address: string;
  hubPublicKey: string;
  endpoint: string;
  peers: string[];
  expiresAt: number;
};

export type PrivateNetworkStatus = {
  supported: boolean;
  initialized: boolean;
  configured: boolean;
  /** Means an interface exists; delivery still requires an authenticated peer. */
  connected: boolean;
  connecting: boolean;
  consentRequired: boolean;
  publicKey?: string;
  identity?: string;
  config?: PrivateNetworkConfig;
  lastHandshakeAt?: number;
};

export interface PrivateNetworkNative {
  status(): Promise<PrivateNetworkStatus>;
  initialize(identity: string): Promise<PrivateNetworkStatus>;
  configure(configJson: string): Promise<PrivateNetworkStatus>;
  connect(): Promise<PrivateNetworkStatus>;
  stop(): Promise<void>;
  erase(): Promise<void>;
  subscribe(listener: (status: PrivateNetworkStatus) => void): () => void;
}
