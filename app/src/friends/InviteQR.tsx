// SPDX-License-Identifier: GPL-3.0-only
import React, { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { invitationQR } from './qr';

export function InviteQR({ value, label = 'Friend invitation QR code' }: { value: string; label?: string }) {
  const { path, size } = useMemo(() => invitationQR(value), [value]);
  return <Svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} accessibilityRole="image" accessibilityLabel={label}><Rect width={size} height={size} fill="#FFFFFF" /><Path d={path} fill="#111111" /></Svg>;
}
