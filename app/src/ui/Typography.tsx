// SPDX-License-Identifier: GPL-3.0-only
import React, { forwardRef } from 'react';
import { Platform, Text as NativeText, TextInput as NativeTextInput, type TextProps, type TextInputProps } from 'react-native';

// System fonts preserve platform typography, font weights and Dynamic Type.
// Explicit faces (for example identity fingerprints) can still override this.
const systemFont = Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' });
export const fontFamilies = { regular: systemFont, medium: systemFont, semibold: systemFont, bold: systemFont, extraBold: systemFont };
export const Text = forwardRef<NativeText, TextProps>(function LinkUpText({ style, ...props }, ref) {
  return <NativeText {...props} ref={ref} style={[{ fontFamily: systemFont }, style]} />;
});
export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function LinkUpTextInput({ style, ...props }, ref) {
  return <NativeTextInput {...props} ref={ref} style={[{ fontFamily: systemFont }, style]} />;
});
