// SPDX-License-Identifier: GPL-3.0-only
import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
export type NotificationStatus = { supported: boolean; enabled: boolean; permission: boolean; previews: boolean; registered: boolean; error: string; distributors: string[]; distributorLabels?: Record<string, string> };
declare class NotificationsNative extends NativeModule {
  canAccess(): boolean;
  deliveryAllowed(enabled: boolean): void;
  status(): Promise<NotificationStatus>;
  enable(key: string, baseline: string): Promise<void>;
  disable(): Promise<void>;
  register(distributor: string, vapid: string): Promise<void>;
  previews(value: boolean): Promise<void>;
  key(): Promise<string>;
  subscription(): Promise<string | null>;
  registered(): Promise<void>;
  replies(): Promise<string>;
  acknowledge(id: string): Promise<void>;
  show(thread: string, id: string, name: string, sender: string, text: string, createdAt: number, canReply: boolean): Promise<void>;
  activeThread(thread: string): Promise<void>;
  clear(thread: string): Promise<void>;
  wake(): Promise<void>;
  healthy(): Promise<void>;
  problem(): Promise<void>;
  finish(jobId: string, success: boolean): Promise<void>;
}
export const notificationsNative = Platform.OS === 'android' ? requireOptionalNativeModule<NotificationsNative>('LinkUpNotifications') : null;
