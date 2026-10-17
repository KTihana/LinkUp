// SPDX-License-Identifier: GPL-3.0-only
export type ConnectionView = 'overview' | 'wifi' | 'bluetooth' | 'mailbox' | 'nearby' | 'vpn';

export const connectionTitles: Record<ConnectionView, string> = {
  overview: 'Connection', vpn: 'Private network', wifi: 'Wi-Fi & hotspot', bluetooth: 'Bluetooth', mailbox: 'Internet mailbox', nearby: 'Nearby',
};

export function connectionViewFromParam(value: string | string[] | undefined, hasNearbyInput: boolean): ConnectionView {
  if (typeof value === 'string' && Object.hasOwn(connectionTitles, value)) return value as ConnectionView;
  return hasNearbyInput ? 'nearby' : 'overview';
}
