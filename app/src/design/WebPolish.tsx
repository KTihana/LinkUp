// SPDX-License-Identifier: GPL-3.0-only
import React from 'react';
import { Platform } from 'react-native';
import Head from 'expo-router/head';
import { useAppearance } from '../appearance/AppearanceProvider';

/** Browser affordances complement the shared native components. */
export function WebPolish() {
  const { colors } = useAppearance();
  if (Platform.OS !== 'web') return null;
  return <Head><meta name="theme-color" content={colors.outer} /><style>{`
    :root { color-scheme: ${colors.dark ? 'dark' : 'light'}; }
    [role="button"], button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    [role="button"]:focus-visible, button:focus-visible, a:focus-visible,
    input:focus-visible, textarea:focus-visible {
      outline: 2px solid ${colors.brand} !important; outline-offset: 3px; border-radius: 12px;
    }
    input, textarea { caret-color: ${colors.brand}; }
    [role="heading"] { text-wrap: balance; }
    @media (hover: hover) {
      [role="button"]:not([aria-disabled="true"]):hover, button:enabled:hover { filter: brightness(${colors.dark ? '1.12' : '.96'}); }
    }
    ::selection { background: ${colors.outgoing}; color: ${colors.ink}; }
  `}</style></Head>;
}
