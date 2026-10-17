// SPDX-License-Identifier: GPL-3.0-only
import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { getRandomBytesAsync } from 'expo-crypto';
import { useVpn } from '../vpn/VpnProvider';
import { privateNetwork } from '../vpn/native';
import { inspectNearbyOffer } from './nearbyOffer';
import { useVault } from '../security/VaultProvider';
import { ensureMessagingCrypto } from './cryptoRuntime';
import { Messenger, type MessagingView } from './messenger';
import { NearbySession, type NearbyState } from './nearbySession';
import nativeNearby, { type NearbyCapabilities } from '../../modules/common-nearby';
import { notificationsNative } from '../notifications/native';
import type { DeliveryPolicy } from './deliveryTransport';
import { watchSessionVisibility } from '../security/sessionVisibility';
import { addNetworkStateListener } from 'expo-network';
import type { CallSignal } from '../calls/protocol';
import type { CallNetwork } from '../calls/controller';

const emptyView: MessagingView = { endpoint: '', enabled: false, policy: 'automatic', conversations: {}, queued: 0 };
type Value = { removeFriend: (peer: string) => Promise<string>; view: MessagingView; preferencesReady: boolean; busy: boolean; problem: string; connect: (url: string) => Promise<void>; disconnect: () => Promise<void>; sync: () => Promise<void>; reconnect: (peer: string) => Promise<void>; send: (peer: string, text: string, kind?: 'text' | 'sticker') => Promise<void>;
  notificationRequest: (action: 'push-config' | 'push-register' | 'push-unregister', payload: unknown) => Promise<Record<string, unknown>>;
  createGroup: (name: string, peers: string[]) => Promise<string>; answerGroup: (id: string, join: boolean) => Promise<void>; sendGroup: (id: string, text: string, kind?: 'text' | 'sticker') => Promise<void>;
  sendCall: (peer: string, signal: CallSignal) => Promise<void>; subscribeCalls: (listener: (peer: string, signal: CallSignal) => void) => () => void; callNetwork: (refresh?: boolean) => Promise<CallNetwork>;
  nearby: NearbyState; capabilities: NearbyCapabilities; setPolicy: (policy: DeliveryPolicy) => Promise<void>;
  hostNearby: (peer: string, kind: 'wifi' | 'hotspot' | 'bluetooth' | 'vpn') => Promise<void>;
  joinNearby: (input: string) => Promise<void>; connectBluetooth: (deviceId: string) => Promise<void>; stopNearby: () => Promise<void>;
};
const Context = createContext<Value | null>(null);
export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const vault = useVault(), vpn = useVpn();
  useEffect(() => {
    if (vault.status === 'unlocked') void notificationsNative?.wake().catch(() => {});
  }, [vault.status, vault.generation]);
  const [messenger] = useState(() => new Messenger({ transact: vault.transactMessaging }, getRandomBytesAsync, Date.now, fetch, ensureMessagingCrypto));
  const [view, setView] = useState<MessagingView>(emptyView), [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const [policyGeneration, setPolicyGeneration] = useState(-1);
  const syncing = useRef(false), requestedSync = useRef(false), generation = useRef(0);
  const lastSyncFailed = useRef(false), removingFriend = useRef(false);
  function requireAvailable() { if (removingFriend.current) throw new Error('Wait until removing this friend finishes.'); }
  const sync = useCallback(async () => {
    if (removingFriend.current) return;
    if (syncing.current) { requestedSync.current = true; return; }
    const current = generation.current;
    syncing.current = true; setBusy(true);
    try {
      let rounds = 0;
      do {
        requestedSync.current = false;
        try { await messenger.sync(); lastSyncFailed.current = false; if (generation.current === current) setProblem(''); }
        catch (e) { lastSyncFailed.current = true; if (generation.current === current) setProblem(e instanceof Error ? e.message : 'Could not reach your friend.'); }
        rounds += 1;
      } while (!removingFriend.current && requestedSync.current && rounds < 3 && generation.current === current && AppState.currentState === 'active');
    } finally { syncing.current = false; requestedSync.current = false; if (generation.current === current) setBusy(false); }
  }, [messenger]);
  const [nearbySession] = useState(() => new NearbySession({ native: nativeNearby, port: { transact: vault.transactMessaging }, messenger,
    randomBytes: getRandomBytesAsync, ensureCrypto: ensureMessagingCrypto, sync: () => {}, isForeground: () => AppState.currentState === 'active' }));
  useEffect(() => { nearbySession.setSyncListener(() => { void sync(); }); return () => nearbySession.setSyncListener(() => {}); }, [nearbySession, sync]);
  const nearby = useSyncExternalStore(nearbySession.subscribe, nearbySession.getSnapshot, nearbySession.getSnapshot);
  useEffect(() => {
    if (nearby.kind === 'vpn' && !vpn.status.connected) { messenger.suspend(); void nearbySession.stop().catch(() => {}); }
  }, [nearby.kind, vpn.status.connected, messenger, nearbySession]);
  const [capabilities, setCapabilities] = useState<NearbyCapabilities>({ wifi: false, hotspot: false, bluetooth: false, platform: nativeNearby ? 'android' : 'unavailable' });
  useEffect(() => {
    let alive = true;
    if (nativeNearby) void nativeNearby.capabilities().then(value => { if (alive) setCapabilities(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') nearbySession.background(); });
    return () => { listener.remove(); void nearbySession.stop().catch(() => {}); };
  }, [nearbySession]);
  useEffect(() => watchSessionVisibility(() => {
    messenger.suspend();
    nearbySession.background();
  }), [messenger, nearbySession]);
  useEffect(() => {
    let alive = true;
    if (vault.status === 'unlocked') {
      void messenger.view().then(next => { if (alive) { setView(next); setPolicyGeneration(vault.generation); } }).catch(e => { if (alive) setProblem(e instanceof Error ? e.message : 'Saved messages could not be opened.'); });
    }
    return () => { alive = false; };
  }, [messenger, vault.status, vault.generation, vault.messagingRevision]);
  useEffect(() => {
    if (vault.status === 'unlocked') return;
    let alive = true;
    generation.current += 1;
    messenger.suspend();
    void nearbySession.stop().catch(() => {});
    // Promise callbacks keep effect state updates asynchronous and discard stale session work.
    void Promise.resolve().then(() => { if (alive) { setView(emptyView); setProblem(''); setBusy(false); } });
    return () => { alive = false; };
  }, [vault.status, messenger, nearbySession]);
  useEffect(() => {
    if (vault.status !== 'unlocked' || !view.enabled || policyGeneration !== vault.generation) return;
    let stopped = false, running = false, wakeRequested = false, delay = 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const foreground = () => AppState.currentState === 'active' || AppState.currentState === null;
    const run = async () => {
      if (stopped || running || !foreground()) return;
      if (removingFriend.current) { timer = setTimeout(() => { void run(); }, 1_000); return; }
      running = true; wakeRequested = false;
      try {
        await sync();
        if (stopped || removingFriend.current || !foreground()) return;
        if (lastSyncFailed.current) throw new Error('Delivery will retry.');
        if (view.policy !== 'nearby-only' && nearby.phase === 'idle' && view.endpoint) {
          await messenger.waitForMail(); delay = 250;
        } else delay = 5_000;
      } catch { delay = Math.min(Math.max(delay * 2, 2_000), 30_000); }
      finally {
        running = false;
        if (!stopped && foreground()) timer = setTimeout(() => { void run(); }, wakeRequested ? 0 : delay);
      }
    };
    const wake = () => { wakeRequested = true; clearTimeout(timer); messenger.cancelWait(); if (!running) void run(); };
    void run();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') wake(); else { clearTimeout(timer); messenger.cancelWait(); } });
    const network = addNetworkStateListener(state => { if (state.isConnected) wake(); });
    return () => { stopped = true; clearTimeout(timer); messenger.cancelWait(); listener.remove(); network.remove(); };
  }, [vault.status, vault.generation, policyGeneration, view.enabled, view.endpoint, view.policy, nearby.phase, sync, messenger]);
  useEffect(() => {
    if (vault.status === 'unlocked' && policyGeneration === vault.generation) notificationsNative?.deliveryAllowed(!removingFriend.current && view.enabled && view.policy === 'automatic' && !!view.endpoint);
  }, [vault.status, vault.generation, policyGeneration, view.enabled, view.policy, view.endpoint]);
  async function restoreBackgroundRoute() { try { const latest = await messenger.view(); notificationsNative?.deliveryAllowed(!removingFriend.current && latest.enabled && latest.policy === 'automatic' && !!latest.endpoint); } catch { /* Locked state keeps the last explicit revocation. */ } }
  async function connect(url: string) { await requireRoute('internet'); notificationsNative?.deliveryAllowed(false); const current = generation.current; try { await messenger.setPolicy('automatic'); await messenger.connect(url); if (current === generation.current) setProblem(''); } catch (e) { if (current === generation.current) setProblem(e instanceof Error ? e.message : 'Could not connect your mailbox.'); throw e; } finally { await restoreBackgroundRoute(); } }
  async function disconnect() { requireAvailable(); notificationsNative?.deliveryAllowed(false); await nearbySession.stop(); await messenger.disconnect(); setProblem(''); }
  async function send(peer: string, text: string, kind: 'text' | 'sticker' = 'text') { requireAvailable(); await messenger.send(peer, text, kind); if (view.enabled) void sync(); }
  async function reconnect(peer: string) { requireAvailable(); await messenger.reconnect(peer); void sync(); }
  async function setPolicy(policy: DeliveryPolicy) { requireAvailable(); if (policy === 'automatic') await requireRoute('internet'); notificationsNative?.deliveryAllowed(false); try { await messenger.setPolicy(policy); setProblem(''); if (policy === 'automatic' && view.enabled) void sync(); } finally { await restoreBackgroundRoute(); } }
  async function removeFriend(peer: string): Promise<string> {
    requireAvailable(); removingFriend.current = true; generation.current += 1; setBusy(true);
    notificationsNative?.deliveryAllowed(false); messenger.suspend();
    try {
    await nearbySession.stop(); await vpn.stop();
    await vault.removeContact(peer);
    let result = 'Friend removed from this phone. Mailbox revocation will apply when internet delivery reconnects.';
    const latest = await messenger.view();
    if (latest.enabled && latest.policy === 'automatic' && latest.endpoint) {
      try { await messenger.sync(); result = 'Friend removed. Mailbox access revoked.'; }
      catch { /* Local removal is durable even if the server cannot be reached. */ }
    } else if (!latest.endpoint) result = 'Friend removed from this phone.';
    if (vpn.status.configured) result += ' Ask your private-network administrator to remove this friend from the hub policy too.';
    return result;
    } finally { removingFriend.current = false; setBusy(false); await restoreBackgroundRoute(); }
  }
  async function requireRoute(kind: string) {
    requireAvailable();
    const status = await privateNetwork?.status();
    requireAvailable();
    if (kind === 'vpn') {
      if (!status?.connected || status.identity !== vault.identity?.replace(/^common:/, '') || !status.config || status.config.expiresAt <= Date.now()) throw new Error('Connect your enrolled private network first.');
    } else if (status?.connected || status?.connecting) throw new Error('Stop your private network before choosing a different route.');
  }
  return <Context.Provider value={{ view: vault.status === 'unlocked' ? view : emptyView, preferencesReady: vault.status === 'unlocked' && policyGeneration === vault.generation, busy, problem, connect, disconnect, sync, reconnect, send, removeFriend,
    notificationRequest: async (action, payload) => { requireAvailable(); return messenger.notificationRequest(action, payload); },
    createGroup: async (name, peers) => { requireAvailable(); const id = await messenger.createGroup(name, peers, vault.profile.name); if (view.enabled) void sync(); return id; },
    answerGroup: async (id, join) => { requireAvailable(); await messenger.answerGroup(id, join); if (!join) void notificationsNative?.clear(`group:${id}`).catch(() => {}); if (view.enabled) void sync(); },
    sendGroup: async (id, text, kind) => { requireAvailable(); await messenger.sendGroup(id, text, kind); if (view.enabled) void sync(); },
    sendCall: async (peer, signal) => { requireAvailable(); return messenger.sendCall(peer, signal); }, subscribeCalls: messenger.subscribeCalls,
    callNetwork: async refresh => {
      requireAvailable();
      if (vpn.status.connected || vpn.status.connecting || nearby.kind === 'vpn') throw new Error('Calls over the private network are not enabled yet. Stop it and choose another connection to call.');
      if (nearby.kind === 'bluetooth') throw new Error('Bluetooth supports messages. Connect over Wi-Fi or the internet for calls.');
      return messenger.callNetwork(refresh);
    },
    nearby, capabilities, setPolicy, hostNearby: async (peer, kind) => { notificationsNative?.deliveryAllowed(false); await requireRoute(kind); await nearbySession.host(peer, kind); }, joinNearby: async input => { notificationsNative?.deliveryAllowed(false); await requireRoute(inspectNearbyOffer(input, Date.now()).kind); await nearbySession.join(input); },
    connectBluetooth: async id => { requireAvailable(); await nearbySession.connectBluetooth(id); }, stopNearby: nearbySession.stop,
  }}>{children}</Context.Provider>;
}
export function useMessaging() { const value = useContext(Context); if (!value) throw new Error('Missing messaging provider.'); return value; }
