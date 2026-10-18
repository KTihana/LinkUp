// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useState } from 'react';
import { Animated, Easing, Platform, type ViewProps } from 'react-native';
import { useReducedMotion } from './useReducedMotion';

type Props = ViewProps & { delay?: number; duration?: number; distance?: number };

/** Short opacity/position entrance; reduced motion reveals content immediately. */
export function Entrance({ style, delay = 0, duration = 320, distance = 8, ...props }: Props) {
  const [progress] = useState(() => new Animated.Value(0));
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced === null) return;
    if (reduced) { progress.stopAnimation(); progress.setValue(1); return; }
    const animation = Animated.timing(progress, {
      toValue: 1, duration, delay, easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web', isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, duration, progress, reduced]);
  return <Animated.View {...props} style={[style, {
    opacity: progress,
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
  }]} />;
}
