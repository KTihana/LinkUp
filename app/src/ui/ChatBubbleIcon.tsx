// SPDX-License-Identifier: GPL-3.0-only
import React from 'react';
import Svg, { Path } from 'react-native-svg';

/** A squarer conversation bubble with the logo's short, lower-left tail. */
export function ChatBubbleIcon({ color, size = 24 }: { color: string; size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false} aria-hidden>
    <Path d="M7 3.5h10a4.5 4.5 0 0 1 4.5 4.5v6a4.5 4.5 0 0 1-4.5 4.5H9l-5.5 3v-4.3A4.5 4.5 0 0 1 2.5 14V8A4.5 4.5 0 0 1 7 3.5Z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>;
}
