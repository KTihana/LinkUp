// SPDX-License-Identifier: GPL-3.0-only
export function isForeground() {
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}
export function watchSessionVisibility(suspend: () => void, _nativeGraceMs = 0) {
  const onVisibility = () => { if (!isForeground()) suspend(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', suspend);
  onVisibility();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', suspend);
  };
}
