// SPDX-License-Identifier: GPL-3.0-only
import React from 'react';
import { Platform, Switch, type SwitchProps } from 'react-native';
import { useAppearance } from '../appearance/AppearanceProvider';

type Props = Omit<SwitchProps, 'thumbColor' | 'trackColor' | 'ios_backgroundColor'>;

export function ThemedSwitch({ value = false, ...props }: Props) {
  const { colors } = useAppearance();
  const webColors = Platform.OS === 'web' ? { activeThumbColor: colors.brand } : {};
  return <Switch {...props} {...webColors} value={value}
    thumbColor={value ? colors.brand : colors.sub}
    trackColor={{ false: colors.line, true: `${colors.brand}55` }}
    ios_backgroundColor={colors.line} />;
}
