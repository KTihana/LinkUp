// SPDX-License-Identifier: GPL-3.0-only
type Options = {
  isForeground: () => boolean; suspend: () => void; graceMs: number;
  now?: () => number;
  schedule?: typeof setTimeout; cancel?: typeof clearTimeout;
};

// Recheck the deadline on return: an OS can pause JavaScript timers while the
// application is backgrounded. Clearing that timer must not bypass the lock.
export function createVisibilityPolicy(options: Options) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  let deadline: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false, stopped = false;
  const suspend = () => { if (!suspended) { suspended = true; options.suspend(); } };
  const update = () => {
    if (stopped) return;
    if (options.isForeground()) {
      if (deadline !== undefined && now() >= deadline) suspend();
      cancel(timer); timer = undefined; deadline = undefined; suspended = false;
    } else {
      deadline ??= now() + options.graceMs;
      if (now() >= deadline) suspend();
      else if (timer === undefined) timer = schedule(() => { timer = undefined; update(); }, deadline - now());
    }
  };
  const stop = () => { stopped = true; cancel(timer); timer = undefined; };
  return { update, stop };
}
