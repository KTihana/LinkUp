// SPDX-License-Identifier: GPL-3.0-only
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import trust from './releaseTrust.json';
import { useMessaging } from '../messaging/MessagingProvider';
import { assetUrl, latestRelease, migrateReleaseRepository, validRepository, type Release } from './release';

type Installed = { version: string; versionCode: number; packageName: string; updateReady?: boolean };
type NativeUpdates = { installed(): Promise<Installed>; download(url: string, hash: string, bytes: number, code: number): Promise<boolean>; install(): Promise<'permission' | 'installer'>; cancel(): Promise<void> };
const native = () => requireNativeModule<NativeUpdates>('TihoUpdates');
type Settings = { repository: string; automatic: boolean };
type Status = 'idle' | 'checking' | 'available' | 'current' | 'empty' | 'downloading' | 'ready' | 'permission' | 'installer' | 'error';
type Updates = { settings: Settings; installed: Installed | null; release: Release | null; status: Status; error: string; ready: boolean; automaticPaused: boolean; save(s: Settings): Promise<void>; check(): Promise<void>; download(): Promise<void>; install(): Promise<void>; cancel(): void };
const Context = createContext<Updates | null>(null);
const storage = 'tiho.updates.preferences.v1';
const publisher = trust as { publicKey: string; repository?: string };
const initial: Settings = { repository: publisher.repository ?? '', automatic: true };
export function UpdatesProvider({ children }: { children: React.ReactNode }) {
  const messaging = useMessaging();
  const automaticPaused = messaging.view.policy === 'nearby-only';
  const [settings, setSettings] = useState(initial), [installed, setInstalled] = useState<Installed | null>(null);
  const [release, setRelease] = useState<Release | null>(null), [status, setStatus] = useState<Status>('idle'), [error, setError] = useState(''), [ready, setReady] = useState(Platform.OS !== 'android');
  const request = useRef<AbortController | null>(null), lastCheck = useRef(0), busy = useRef(false);
  const generation = useRef(0);
  const pendingInstall = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let alive = true;
    void Promise.all([native().installed(), SecureStore.getItemAsync(storage)]).then(([info, raw]) => {
      if (!alive) return;
      setInstalled(info);
      pendingInstall.current = info.updateReady === true;
      if (pendingInstall.current) setStatus('ready');
      console.info('LinkUp: native update service ready.');
      if (raw) { const s = JSON.parse(raw); if (typeof s.repository === 'string' && (s.repository === '' || validRepository(s.repository)) && typeof s.automatic === 'boolean') setSettings({ ...s, repository: migrateReleaseRepository(s.repository) }); }
      setReady(true);
    }).catch(() => { if (alive) { setReady(true); setError('Couldn’t load Android update settings.'); setStatus('error'); } });
    return () => { alive = false; request.current?.abort(); };
  }, []);
  const check = useCallback(async () => {
    if (Platform.OS !== 'android' || !installed || !settings.repository || busy.current || pendingInstall.current) return;
    busy.current = true;
    const controller = new AbortController(); request.current = controller;
    const token = generation.current;
    const timeout = setTimeout(() => controller.abort(), 30000);
    setStatus('checking'); setError(''); setRelease(null); lastCheck.current = Date.now();
    try {
      const next = await latestRelease(settings.repository, trust.publicKey, installed.packageName, controller.signal);
      if (token !== generation.current) return;
      if (!next) setStatus('empty');
      else if (next.versionCode <= installed.versionCode) setStatus('current');
      else { setRelease(next); setStatus('available'); }
    } catch (e) { if (token === generation.current) { if (controller.signal.aborted) { setStatus('idle'); setError(''); } else { setStatus('error'); setError(e instanceof Error ? e.message : 'Couldn’t check for updates.'); } } }
    finally { clearTimeout(timeout); busy.current = false; if (request.current === controller) request.current = null; }
  }, [installed, settings.repository]);
  useEffect(() => {
    if (!ready || !settings.automatic || !settings.repository || automaticPaused || !messaging.preferencesReady) return;
    const maybeCheck = () => { if (AppState.currentState === 'active' && Date.now() - lastCheck.current > 12 * 60 * 60 * 1000) void check(); };
    maybeCheck();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') maybeCheck(); else request.current?.abort(); });
    return () => { subscription.remove(); request.current?.abort(); };
  }, [ready, settings.automatic, settings.repository, check, automaticPaused, messaging.preferencesReady]);
  async function save(input: Settings) {
    const next = { ...input, repository: migrateReleaseRepository(input.repository) };
    if (busy.current) throw new Error('Finish or cancel the current update first.');
    if (next.repository && !validRepository(next.repository)) throw new Error('Use a GitHub repository in the form owner/name.');
    if (Platform.OS === 'android') await SecureStore.setItemAsync(storage, JSON.stringify(next), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    generation.current++; lastCheck.current = 0; setRelease(null); setError(''); setStatus(pendingInstall.current ? 'ready' : 'idle'); setSettings(next);
  }
  async function download() {
    if (!release || busy.current) return;
    busy.current = true; setStatus('downloading'); setError('');
    try { await native().download(assetUrl(settings.repository, release.version, release.file), release.sha256, release.bytes, release.versionCode); pendingInstall.current = true; setStatus('ready'); }
    catch (e) { setStatus('error'); setError(e instanceof Error ? e.message : 'Download failed. Try again.'); }
    finally { busy.current = false; }
  }
  async function install() {
    if (busy.current) return;
    busy.current = true; setError('');
    try { setStatus(await native().install()); }
    catch (e) { pendingInstall.current = false; setStatus('error'); setError(e instanceof Error ? e.message : 'Couldn’t open the installer. Download the update again.'); }
    finally { busy.current = false; }
  }
  function cancel() { request.current?.abort(); if (Platform.OS === 'android') void native().cancel().catch(() => {}); }
  return <Context.Provider value={{ settings, installed, release, status, error, ready, automaticPaused, save, check, download, install, cancel }}>{children}</Context.Provider>;
}
export function useUpdates() { const context = useContext(Context); if (!context) throw new Error('Updates provider is missing.'); return context; }
