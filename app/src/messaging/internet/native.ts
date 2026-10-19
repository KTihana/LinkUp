// SPDX-License-Identifier: GPL-3.0-only
import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
export type InternetEvents = {
  packet: (event: { linkId: string; payload: string }) => void;
  link: (event: { linkId: string; state: 'connected' | 'closed'; direct: boolean }) => void;
  network: (event: { connected: boolean }) => void;
  error: (event: { message: string }) => void;
};
export declare class InternetNative extends NativeModule<InternetEvents> {
  start(secret: string, contacts: { publicKey: string; toxKey: string }[]): Promise<void>;
  send(peer: string, payload: string): Promise<void>;
  stop(): Promise<void>;
}
export const internetNative = Platform.OS === 'android' ? requireOptionalNativeModule<InternetNative>('LinkUpTox') : null;
