// SPDX-License-Identifier: GPL-3.0-only
import React from 'react';
import { RTCView, type MediaStream } from 'react-native-webrtc';
export function CallVideo({ stream, local = false, video = true }: { stream: unknown; local?: boolean; video?: boolean }) {
  if (!stream || !video) return null;
  return <RTCView streamURL={(stream as MediaStream).toURL()} mirror={local} objectFit="cover" style={{ width: '100%', height: '100%' }} />;
}
