type Clock = {
  now: () => Date;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onResume: (callback: () => void) => () => void;
};
// Recompute from local wall time after each minute or foreground transition.
// Re-arming also handles clock/time-zone changes and timers delayed by sleep.
export function watchThemeClock(onTime: (now: Date) => void, clock: Clock) {
  let timer: unknown, stopped = false;
  function refresh() {
    if (stopped) return;
    clock.clearTimer(timer);
    const now = clock.now();
    onTime(now);
    timer = clock.setTimer(refresh, 60000 - now.getTime() % 60000);
  }
  const unsubscribe = clock.onResume(refresh);
  refresh();
  return () => { stopped = true; clock.clearTimer(timer); unsubscribe(); };
}
