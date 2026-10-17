// SPDX-License-Identifier: GPL-3.0-only
export type PinUnlock = {
  status: () => Promise<{ available: boolean; enabled: boolean }>;
  enable: (key: string, pin: string) => Promise<void>;
  read: (pin: string) => Promise<string>;
  disable: () => Promise<void>;
  erase?: () => Promise<void>;
  archive: (id: string) => Promise<void>;
  detach: (id: string) => Promise<void>;
};
export function validatePin(pin: string) {
  if (!/^[0-9]{6}$/.test(pin)) throw new Error('Use a six-digit LinkUp PIN.');
}

export function pinError(error: unknown, settingUp = false): Error {
  const message = error instanceof Error ? error.message : '';
  const safe = message.match(/(?:Incorrect (?:LinkUp )?PIN\. Try again(?: in [0-9]{1,4} seconds)?\.|Too many attempts\. Try again in [0-9]{1,4} seconds\.)/);
  return new Error(safe?.[0] ?? (settingUp ? 'Could not save your PIN. Please try again.' : 'PIN unlock is unavailable. Try another saved unlock method.'));
}
