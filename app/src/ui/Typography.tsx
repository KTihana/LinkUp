// SPDX-License-Identifier: GPL-3.0-only
import React, { forwardRef } from 'react';
import { StyleSheet, Text as NativeText, TextInput as NativeTextInput, type TextProps, type TextInputProps, type StyleProp, type TextStyle } from 'react-native';

export const fontFamilies = { regular: 'LinkUpManrope', medium: 'LinkUpManropeMedium', semibold: 'LinkUpManropeSemiBold', bold: 'LinkUpManropeBold', extraBold: 'LinkUpManropeExtraBold' };
function face(style: StyleProp<TextStyle>): TextStyle {
  const flat = StyleSheet.flatten(style);
  if (flat?.fontFamily) return {};
  const weight = flat?.fontWeight === 'bold' ? 700 : Number(flat?.fontWeight) || 400;
  const fontFamily = weight >= 800 ? fontFamilies.extraBold : weight >= 700 ? fontFamilies.bold : weight >= 600 ? fontFamilies.semibold : weight >= 500 ? fontFamilies.medium : fontFamilies.regular;
  return { fontFamily, fontWeight: 'normal' };
}
export const Text = forwardRef<NativeText, TextProps>(function LinkUpText({ style, ...props }, ref) {
  return <NativeText {...props} ref={ref} style={[style, face(style)]} />;
});
export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function LinkUpTextInput({ style, ...props }, ref) {
  return <NativeTextInput {...props} ref={ref} style={[style, face(style)]} />;
});
