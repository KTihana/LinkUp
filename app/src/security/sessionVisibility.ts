// SPDX-License-Identifier: GPL-3.0-only
import { AppState } from 'react-native';
import { createVisibilityPolicy } from './visibilityPolicy';

export function isForeground() {
  return AppState.currentState === 'active' || AppState.currentState === null;
}
export function watchSessionVisibility(suspend: () => void, graceMs = 0) {
  const policy = createVisibilityPolicy({ isForeground, suspend, graceMs });
  const listener = AppState.addEventListener('change', policy.update);
  policy.update();
  return () => { policy.stop(); listener.remove(); };
}
