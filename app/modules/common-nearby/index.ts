// SPDX-License-Identifier: GPL-3.0-only
import { requireOptionalNativeModule, NativeModule } from 'expo';
import { Platform } from 'react-native';

export type NearbyCapabilities = {
  wifi: boolean;
  hotspot: boolean;
  bluetooth: boolean;
  platform: string;
};
export type WifiSession = {
  host: string;
  port: number;
  /** SHA-256 of the session's exact DER-encoded TLS certificate. */
  pin: string;
  ssid?: string;
  password?: string;
};
export type NearbyEvents = {
  packet: (event: { linkId: string; payload: string }) => void;
  link: (event: {
    linkId: string;
    state: 'connected' | 'closed';
    kind: 'wifi' | 'bluetooth' | 'vpn';
  }) => void;
  bluetoothPeer: (event: { deviceId: string; label: string }) => void;
  error: (event: { kind: 'wifi' | 'bluetooth' | 'vpn'; message: string }) => void;
};
export declare class NearbyNativeModule extends NativeModule<NearbyEvents> {
  capabilities(): Promise<NearbyCapabilities>;
  startWifi(hotspot: boolean): Promise<WifiSession>;
  connectWifi(host: string, port: number, pin: string): Promise<{ linkId: string }>;
  startPrivateNetwork(): Promise<WifiSession>;
  connectPrivateNetwork(host: string, port: number, pin: string): Promise<{ linkId: string }>;
  startBluetooth(): Promise<{ service: string }>;
  connectBluetooth(deviceId: string): Promise<{ linkId: string }>;
  send(linkId: string, payload: string): Promise<void>;
  close(linkId: string): Promise<void>;
  stop(): Promise<void>;
}

// Optional loading preserves web/iOS and Expo Go. These platforms must show an
// explicit unsupported state; they must not silently use an internet transport.
const nearby = Platform.OS === 'android'
  ? requireOptionalNativeModule<NearbyNativeModule>('CommonNearby')
  : null;

export default nearby;
