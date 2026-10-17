// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React from 'react';
import { Platform, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '../ui/Typography';
import { Feather } from '@expo/vector-icons';
import { useAppearance } from '../appearance/AppearanceProvider';
import type { Palette } from '../appearance/palette';

export type ConnectionIconName = React.ComponentProps<typeof Feather>['name'];
export function ConnectionIcon({ name, size = 24, color }: { name: ConnectionIconName; size?: number; color: string }) {
  return <Feather name={name} size={size} color={color} style={{ width: size, height: size, lineHeight: size }} />;
}

export function ConnectionButton({ label, onPress, secondary = false, disabled = false, selected, style, hint }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean; selected?: boolean; style?: StyleProp<ViewStyle>; hint?: string;
}) {
  const { colors } = useAppearance();
  const s = connectionStyles(colors);
  return <Pressable accessibilityRole={selected === undefined ? 'button' : 'radio'} accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ disabled, ...(selected === undefined ? {} : { checked: selected }) }} aria-checked={selected} aria-disabled={disabled} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, { backgroundColor: secondary ? colors.soft : colors.button, opacity: disabled ? .45 : pressed ? .8 : 1 }, style]}>
    <Text style={[s.label, { color: secondary ? colors.ink : colors.onButton, textAlign: 'center' }]}>{label}</Text>
  </Pressable>;
}

export function connectionStyles(colors: Palette) {
  return StyleSheet.create({
    content: { padding: 22, gap: 18 },
    button: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 15.5, borderRadius: controlRadius.button, alignItems: 'center', justifyContent: 'center' },
    label: { color: colors.ink, fontSize: 14, lineHeight: 21, fontWeight: '600' },
    body: { color: colors.ink, fontSize: 15, lineHeight: 23 },
    small: { color: colors.sub, fontSize: 12, lineHeight: 18, fontWeight: '500' },
    name: { color: colors.ink, fontSize: 16, lineHeight: 23, fontWeight: '600' },
    micro: { color: colors.sub, fontSize: 10, lineHeight: 14, fontWeight: '700' },
    card: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 18, gap: 12 },
    input: { padding: 16, borderRadius: 12, backgroundColor: colors.soft, color: colors.ink, fontSize: 15, lineHeight: 23,
      ...Platform.select({ web: { outlineWidth: 0, outlineStyle: 'solid' as const } }) },
    error: { color: colors.error, fontSize: 13, lineHeight: 20 },
  });
}
