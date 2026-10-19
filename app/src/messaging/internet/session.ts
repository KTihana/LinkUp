// SPDX-License-Identifier: GPL-3.0-only
import { bytesToHex } from '@noble/hashes/utils.js';
import { NearbyTransport } from '../nearbyTransport.ts';
import type { Messenger, MessagingPort } from '../messenger.ts';
import type { InternetNative } from './native.ts';
import { internetPublicKey } from './identity.ts';
export type InternetState = { phase: 'off' | 'connecting' | 'online'; peers: string[]; problem: string };
export class InternetSession {
  private state: InternetState = { phase: 'off', peers: [], problem: '' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private service: NearbyTransport | null = null;
  private subscriptions: { remove(): void }[] = [];
  private cleanup: Promise<void> = Promise.resolve();
  private sync: () => void = () => {};
  private options: { native: InternetNative | null; messenger: Pick<Messenger, 'attachInternet'>; port: MessagingPort; randomBytes: (size: number) => Promise<Uint8Array>; isForeground: () => boolean };
  constructor(options: InternetSession['options']) { this.options = options; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setSyncListener(listener: () => void) { this.sync = listener; }
  private update(change: Partial<InternetState>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(); }
  start = async (withIdentity: (start: (secret: Uint8Array) => Promise<void>) => Promise<void>, contacts: { publicKey: string }[]) => {
    const token = this.generation + 1;
    await this.stop();
    const native = this.options.native;
    const current = () => token === this.generation && this.options.isForeground();
    if (!native || !current()) return;
    const allowed = new Set(contacts.map(contact => contact.publicKey));
    this.update({ phase: 'connecting', problem: '' });
    try {
      const service = new NearbyTransport({ port: this.options.port, randomBytes: this.options.randomBytes, maxLinks: 100,
        onIncoming: () => { if (current()) this.sync(); }, channel: {
          send: (peer, payload) => { if (!current()) return Promise.reject(new Error('Internet connection stopped.')); return native.send(peer, payload); },
          subscribe: listener => { const subscription = native.addListener('packet', event => { if (current() && allowed.has(event.linkId)) listener(event); }); return () => subscription.remove(); },
        } });
      this.service = service; await service.start();
      if (!current()) { service.stop(); return; }
      this.options.messenger.attachInternet(service);
      this.subscriptions.push(native.addListener('link', event => {
        if (!current() || !allowed.has(event.linkId)) return;
        if (event.state === 'connected') {
          service.attachLink(event.linkId, event.linkId);
          this.update({ peers: [...new Set([...this.state.peers, event.linkId])] });
        } else { service.detachLink(event.linkId); this.update({ peers: this.state.peers.filter(peer => peer !== event.linkId) }); }
        this.sync();
      }));
      this.subscriptions.push(native.addListener('network', event => { if (current()) this.update({ phase: event.connected ? 'online' : 'connecting' }); }));
      this.subscriptions.push(native.addListener('error', () => {
        if (current()) void this.stop().then(() => { if (this.generation === token + 1) this.update({ problem: 'Internet connection interrupted. Reopen LinkUp to retry.' }); });
      }));
      await withIdentity(async secret => {
        if (!current()) throw new Error('Internet connection stopped.');
        await native.start(bytesToHex(secret), contacts.map(contact => ({ publicKey: contact.publicKey, toxKey: internetPublicKey(contact.publicKey) })));
      });
      if (current()) this.sync();
    } catch (error) {
      if (token !== this.generation) return;
      await this.stop();
      if (this.generation === token + 1) this.update({ problem: error instanceof Error ? error.message : 'Could not connect to the P2P network.' });
    }
  };
  stop = async () => {
    this.generation++;
    this.options.messenger.attachInternet(null);
    this.service?.stop(); this.service = null;
    for (const subscription of this.subscriptions.splice(0)) subscription.remove();
    this.update({ phase: 'off', peers: [], problem: '' });
    this.cleanup = this.cleanup.catch(() => {}).then(() => this.options.native?.stop());
    await this.cleanup;
  };
}
