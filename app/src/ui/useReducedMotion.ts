// SPDX-License-Identifier: GPL-3.0-only
import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Share one device query/listener across all controls on a screen.
let reduced: boolean | null = null;
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | undefined;
let generation = 0;
const listeners = new Set<() => void>();
function publish(value: boolean) {
  if (reduced === value) return;
  reduced = value;
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!subscription) {
    const currentGeneration = ++generation;
    let receivedChange = false;
    subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      receivedChange = true;
      publish(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (generation === currentGeneration && !receivedChange) publish(value);
    }).catch(() => { if (generation === currentGeneration) publish(true); });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      subscription?.remove();
      subscription = undefined;
      generation++;
      reduced = null;
    }
  };
}
const snapshot = () => reduced;
const serverSnapshot = () => true;
/** null means the initial device preference is still being read. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
