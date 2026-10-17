// SPDX-License-Identifier: GPL-3.0-only
import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { addNetworkStateListener } from 'expo-network';
import { getRandomBytesAsync } from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { useVpn } from '../vpn/VpnProvider';
import { useMessaging } from '../messaging/MessagingProvider';
import { useVault } from '../security/VaultProvider';
import { CallController, type CallState } from './controller';
import { createCallMedia } from './media';

type Value = { state: CallState; controller: CallController };
const Context = createContext<Value | null>(null);
export function CallsProvider({ children }: { children: React.ReactNode }) {
  const messaging = useMessaging(), vault = useVault(), vpn = useVpn();
  const { subscribeCalls } = messaging;
  const [controller] = useState(() => new CallController({
    now: Date.now, id: async () => bytesToHex(await getRandomBytesAsync(16)),
    allowed: () => false,
    send: async () => { throw new Error('Calls are starting.'); },
    network: async () => { throw new Error('Calls are starting.'); }, media: createCallMedia,
  }));
  useEffect(() => {
    controller.setCallbacks({
      allowed: peer => vault.status === 'unlocked' && messaging.view.enabled && vault.contacts.some(contact => contact.publicKey === peer),
      send: messaging.sendCall, network: messaging.callNetwork,
    });
  }, [controller, messaging, vault]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { if (state.peer && !vault.contacts.some(contact => contact.publicKey === state.peer)) controller.stop(); }, [state.peer, vault.contacts, controller]);
  useEffect(() => subscribeCalls(controller.receive), [subscribeCalls, controller]);
  useEffect(() => { if (vault.status !== 'unlocked' || !messaging.view.enabled) controller.stop(); }, [vault.status, messaging.view.enabled, controller]);
  useEffect(() => {
    let previous: string | undefined;
    const subscription = addNetworkStateListener(network => {
      const next = `${network.type}:${network.isConnected}:${network.isInternetReachable}`;
      if (previous !== undefined && previous !== next && network.isConnected) controller.recoverConnection();
      previous = next;
    });
    return () => subscription.remove();
  }, [controller]);
  useEffect(() => { if (vpn.status.connected || vpn.status.connecting) controller.stop(); }, [vpn.status.connected, vpn.status.connecting, controller]);
  // A privacy/relay policy change ends the old route immediately.
  useEffect(() => () => controller.stop(), [controller, messaging.view.policy, messaging.view.endpoint]);
  return <Context.Provider value={{ state, controller }}>{children}</Context.Provider>;
}
export function useCalls() { const value = useContext(Context); if (!value) throw new Error('Missing calls provider.'); return value; }
