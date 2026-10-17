// UI and Headless JS share one React runtime/process and this serializer. The
// background port always opens the newest encrypted record inside this lock.
let queue: Promise<unknown> = Promise.resolve();
export function withVaultWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task); queue = next.catch(() => {}); return next;
}
