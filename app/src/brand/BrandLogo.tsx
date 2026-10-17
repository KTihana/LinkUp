// SPDX-License-Identifier: GPL-3.0-only
import React from 'react';
import { Platform, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { logoSvg, markSvg } from './artwork';

/** Uses the same vector geometry as the downloadable logo and launcher icons. */
export function BrandLogo({ color, height = 38, markOnly = false }: { color: string; height?: number; markOnly?: boolean }) {
  const width = height * (markOnly ? 640 / 600 : 650 / 180);
  return <View accessible accessibilityRole="image" accessibilityLabel="LinkUp" style={{ width, height }}>
    <SvgXml xml={markOnly ? markSvg : logoSvg} color={color} width={width} height={height} accessible={Platform.OS === 'web' ? undefined : false} aria-hidden />
  </View>;
}
