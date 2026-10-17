// SPDX-License-Identifier: GPL-3.0-only
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useVault } from '../security/VaultProvider';
import { privateNetwork, type PrivateNetworkStatus } from './native';
import { requireVpnAccount } from './account';
import { createEnrollment } from './enrollment';
import { decodeMessaging, encodeMessaging } from '../messaging/messenger';

const empty: PrivateNetworkStatus = { supported: !!privateNetwork, initialized: false, configured: false, connected: false, connecting: false, consentRequired: true };
type Value = { status: PrivateNetworkStatus; enrollment: () => Promise<string>; configure: (json: string) => Promise<void>; connect: () => Promise<void>; stop: () => Promise<void>; erase: () => Promise<void> };
const Context = createContext<Value | null>(null);
export function VpnProvider({ children }: { children: React.ReactNode }) {
  const vault = useVault(), active = useRef(false), account = useRef(vault.identity), revision = useRef(0);
  const [status, setStatus] = useState(empty);
  useEffect(() => {
    let alive = true;
    const update = (value: PrivateNetworkStatus) => { if (alive) setStatus(value); };
    const unsubscribe = privateNetwork?.subscribe(update);
    const refresh = () => { void privateNetwork?.status().then(update).catch(() => {}); };
    refresh();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { alive = false; unsubscribe?.(); listener.remove(); void privateNetwork?.stop().catch(() => {}); };
  }, []);
  useLayoutEffect(() => {
    active.current = vault.status === 'unlocked'; account.current = vault.identity;
    revision.current += 1;
    if (vault.status !== 'unlocked') void privateNetwork?.stop().catch(() => {});
  }, [vault.status, vault.identity, vault.generation]);
  function native() {
    if (!active.current) throw new Error('Unlock LinkUp before configuring a private network.');
    if (!privateNetwork) throw new Error('Private networks require the new Android build.');
    return privateNetwork;
  }
  async function checked(task: () => Promise<PrivateNetworkStatus>) {
    if (!active.current) throw new Error('Unlock LinkUp before configuring a private network.');
    const token = revision.current, next = await task();
    if (!active.current || revision.current !== token) { await privateNetwork?.stop(); throw new Error('LinkUp locked. The private network was stopped.'); }
    try { requireVpnAccount(next, account.current); } catch (error) { await privateNetwork?.stop(); throw error; }
    setStatus(next); return next;
  }
  async function boundNative() { const api = native(); requireVpnAccount(await api.status(), account.current); return api; }
  const sameAccount = status.identity === vault.identity?.replace(/^common:/, '');
  return <Context.Provider value={{ status: vault.status === 'unlocked' ? (!status.initialized || sameAccount ? status : { ...empty, initialized: status.initialized, connected: status.connected }) : { ...empty, connected: status.connected },
    enrollment: async () => {
      const api = native(), identity = vault.identity?.replace(/^common:/, '');
      if (!identity) throw new Error('Create your LinkUp account first.');
      const device = await checked(() => api.initialize(identity));
      if (!device.publicKey || device.identity !== identity) throw new Error('Device enrollment does not match this account.');
      return vault.transactMessaging(async (serialized, signer) => ({ state: serialized ?? encodeMessaging(decodeMessaging(null)), result: createEnrollment(device.publicKey!, signer, Date.now()) }));
    },
    configure: async json => { const api = await boundNative(); if (json.length > 8192) throw new Error('Network configuration is too large.'); await checked(() => api.configure(json)); },
    connect: async () => { const api = await boundNative(); await checked(() => api.connect()); },
    stop: async () => { revision.current += 1; await privateNetwork?.stop(); if (privateNetwork) setStatus(await privateNetwork.status()); },
    erase: async () => { revision.current += 1; await privateNetwork?.erase(); if (privateNetwork) setStatus(await privateNetwork.status()); },
  }}>{children}</Context.Provider>;
}
export function useVpn() { const value = useContext(Context); if (!value) throw new Error('Missing private network provider.'); return value; }
