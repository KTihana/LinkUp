// Web Locks prevents two browser tabs from creating or overwriting the same vault concurrently.
export function withVaultWrite<T>(task: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate local vault writes. Try a current browser.');
  return navigator.locks.request('common.local-vault.v1', task);
}
