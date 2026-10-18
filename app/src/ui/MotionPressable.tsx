// SPDX-License-Identifier: GPL-3.0-only
import React, { forwardRef, useEffect, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, type PressableProps, type View } from 'react-native';
import { useReducedMotion } from './useReducedMotion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export type MotionPressableProps = PressableProps & { pressScale?: number };

/** A drop-in Pressable with quiet, interruptible spring feedback. */
export const MotionPressable = forwardRef<View, MotionPressableProps>(function MotionPressable({
  style, onPressIn, onPressOut, disabled, pressScale = .975, ...props
}, ref) {
  const [scale] = useState(() => new Animated.Value(1));
  const [pressed, setPressed] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced !== false || disabled) { scale.stopAnimation(); scale.setValue(1); }
    return () => scale.stopAnimation();
  }, [disabled, reduced, scale]);
  function animate(toValue: number) {
    if (reduced !== false || disabled) return;
    Animated.spring(scale, {
      toValue, stiffness: 420, damping: 30, mass: .65,
      useNativeDriver: Platform.OS !== 'web', isInteraction: false,
    }).start();
  }
  // Animated inspects the style object before Pressable runs its callback.
  // Resolve it here so the scale is attached to the native animation graph.
  const resolved = typeof style === 'function' ? style({ pressed }) : style;
  const flat = StyleSheet.flatten(resolved);
  return <AnimatedPressable {...props} ref={ref} disabled={disabled}
    onPressIn={event => { setPressed(true); animate(pressScale); onPressIn?.(event); }}
    onPressOut={event => { setPressed(false); animate(1); onPressOut?.(event); }}
    style={[resolved,
      pressed && !disabled ? { opacity: (typeof flat?.opacity === 'number' ? flat.opacity : 1) * .82 } : undefined,
      { transform: [...(Array.isArray(flat?.transform) ? flat.transform : []), { scale }] },
    ]} />;
});
