// SPDX-License-Identifier: GPL-3.0-only
import type { PinUnlock } from './pinUnlockCore';
// A short PIN cannot safely protect a browser-only vault against offline guesses.
export const pinUnlock: PinUnlock | undefined = undefined;
