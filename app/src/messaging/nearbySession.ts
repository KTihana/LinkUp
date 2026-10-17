// SPDX-License-Identifier: GPL-3.0-only
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NearbyNativeModule } from '../../modules/common-nearby/index.ts';
import { NearbyTransport } from './nearbyTransport.ts';
import { decodeMessaging, encodeMessaging, type Messenger, type MessagingPort } from './messenger.ts';
import { BLE_SERVICE, createNearbyOffer, inspectNearbyOffer, NEARBY_OFFER_TTL, type NearbyOffer } from './nearbyOffer.ts';

export type NearbyState = {
  phase: 'idle' | 'starting' | 'waiting' | 'connected'; kind: 'wifi' | 'hotspot' | 'bluetooth' | 'vpn' | null;
  peer: string; offer: string; ssid: string; password: string;
  devices: { deviceId: string; label: string }[]; links: string[]; problem: string;
};
const empty = (): NearbyState => ({ phase: 'idle', kind: null, peer: '', offer: '', ssid: '', password: '', devices: [], links: [], problem: '' });
type Options = {
  native: NearbyNativeModule | null; port: MessagingPort; messenger: Pick<Messenger, 'setPolicy' | 'attachNearby'>;
  randomBytes: (length: number) => Promise<Uint8Array>; ensureCrypto: () => Promise<void>;
  sync: () => void; now?: () => number; isForeground: () => boolean;
};
/** Native resource lifecycle. Stop invalidates pending permission/connect/QR operations. */
export class NearbySession {
  private options: Options;
  private state = empty();
  private listeners = new Set<() => void>();
  private generation = 0;
  private service: NearbyTransport | null = null;
  private subscriptions: { remove(): void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private joining: NearbyOffer | null = null;
  constructor(options: Options) { this.options = options; }
  setSyncListener = (listener: () => void) => { this.options.sync = listener; };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<NearbyState>) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener(); }
  private current(token: number) {
    if (token !== this.generation || !this.options.isForeground()) throw new Error('Nearby was stopped. Return to LinkUp and start a new session.');
  }
  private native() { if (!this.options.native) throw new Error('Nearby connections need the Android development build. They are unavailable in this browser or Expo Go.'); return this.options.native; }
  private async fail(token: number, error: unknown) {
    if (token !== this.generation) return;
    const closing = this.generation + 1;
    await this.stop();
    if (closing === this.generation) this.update({ problem: error instanceof Error ? error.message : 'Nearby connection stopped.' });
  }
  private async authorize(peer: string, offer?: NearbyOffer) {
    return this.options.port.transact(async (serialized, signer, contacts) => {
      if (!contacts.some(c => c.publicKey === peer) || peer === signer.publicKey) throw new Error('Add each other as friends before connecting nearby.');
      if (offer && (offer.peer !== signer.publicKey || offer.publicKey !== peer)) throw new Error('This nearby code was made for a different identity.');
      return { state: serialized ?? encodeMessaging(decodeMessaging(null)), result: signer.publicKey };
    });
  }
  private async begin(peer: string, kind: NonNullable<NearbyState['kind']>) {
    const native = this.native();
    const token = this.generation + 1;
    await this.stop();
    this.current(token);
    this.update({ ...empty(), phase: 'starting', kind, peer });
    try {
    const self = await this.authorize(peer); this.current(token);
    await this.options.ensureCrypto(); this.current(token);
    await this.options.messenger.setPolicy('nearby-only'); this.current(token);
    const service = new NearbyTransport({ port: this.options.port, randomBytes: this.options.randomBytes, onIncoming: this.options.sync,
      now: this.options.now, channel: { send: (linkId, payload) => native.send(linkId, payload), subscribe: listener => {
        const subscription = native.addListener('packet', event => { if (token === this.generation && this.options.isForeground()) listener(event); }); return () => subscription.remove();
      } } });
    this.service = service;
    await service.start(); this.current(token);
    this.options.messenger.attachNearby(service);
    this.update({ ...empty(), phase: 'starting', kind, peer });
    this.subscriptions.push(native.addListener('link', event => {
      if (token !== this.generation || this.service !== service) return;
      if (event.state === 'connected') {
        if (!this.options.isForeground()) { void native.close(event.linkId).catch(() => {}); return; }
        if (this.joining && this.joining.expiresAt <= (this.options.now ?? Date.now)()) { void native.close(event.linkId).catch(() => {}); return; }
        service.attachLink(event.linkId, peer);
        this.update({ phase: 'connected', links: [...new Set([...this.state.links, event.linkId])] });
        this.options.sync();
      } else {
        service.detachLink(event.linkId);
        const links = this.state.links.filter(id => id !== event.linkId);
        this.update({ links, phase: links.length ? 'connected' : 'waiting' });
      }
    }));
    this.subscriptions.push(native.addListener('bluetoothPeer', event => {
      if (token !== this.generation || !this.options.isForeground() || kind !== 'bluetooth' || !event.deviceId || event.deviceId.length > 128) return;
      if (!this.state.devices.some(d => d.deviceId === event.deviceId) && this.state.devices.length < 20) {
        // Native identifiers are temporary; never display an arbitrary advertisement name.
        this.update({ devices: [...this.state.devices, { deviceId: event.deviceId, label: `Nearby phone ${this.state.devices.length + 1}` }] });
      }
    }));
    this.subscriptions.push(native.addListener('error', event => {
      if (token !== this.generation) return;
      const message = typeof event.message === 'string' ? event.message.slice(0, 300) : 'Nearby connection stopped.';
      void this.fail(token, new Error(message)).catch(() => {});
    }));
    this.timer = setTimeout(() => { void this.fail(token, new Error('Nearby session ended. Start a new session to keep chatting.')).catch(() => {}); }, NEARBY_OFFER_TTL);
    return { token, native, service, self };
    } catch (e) {
      await this.fail(token, e);
      throw e;
    }
  }
  private async makeOffer(token: number, value: Omit<NearbyOffer, 'version' | 'publicKey' | 'peer' | 'issuedAt' | 'expiresAt' | 'nonce'>, self: string) {
    const nonce = bytesToHex(await this.options.randomBytes(16)), issuedAt = (this.options.now ?? Date.now)(); this.current(token);
    const offer = await this.options.port.transact(async (serialized, signer, contacts) => {
      this.current(token);
      if (signer.publicKey !== self || !contacts.some(c => c.publicKey === this.state.peer)) throw new Error('This identity changed. Start nearby again.');
      const details = { ...value, version: 1, publicKey: self, peer: this.state.peer, issuedAt, expiresAt: issuedAt + NEARBY_OFFER_TTL, nonce } as NearbyOffer;
      return { state: serialized ?? encodeMessaging(decodeMessaging(null)), result: createNearbyOffer(details, signer) };
    });
    this.current(token); return offer;
  }
  host = async (peer: string, kind: NonNullable<NearbyState['kind']>) => {
    let token = this.generation;
    try {
      const session = await this.begin(peer, kind); token = session.token;
      if (kind === 'bluetooth') {
        const details = await session.native.startBluetooth(); this.current(token);
        if (details.service !== BLE_SERVICE) throw new Error('This Bluetooth build uses an unsupported service.');
        const offer = await this.makeOffer(token, { kind: 'bluetooth', service: details.service } as NearbyOffer, session.self);
        this.update({ offer, phase: this.state.links.length ? 'connected' : 'waiting' });
      } else {
        const details = kind === 'vpn' ? await session.native.startPrivateNetwork() : await session.native.startWifi(kind === 'hotspot'); this.current(token);
        const offer = await this.makeOffer(token, { kind: kind === 'vpn' ? 'vpn' : 'wifi', ...details } as NearbyOffer, session.self);
        this.update({ offer, ssid: details.ssid ?? '', password: details.password ?? '', phase: this.state.links.length ? 'connected' : 'waiting' });
      }
      this.options.sync();
    } catch (e) { await this.fail(token, e); throw e; }
  };
  join = async (input: string) => {
    const original = this.generation;
    const offer = inspectNearbyOffer(input, (this.options.now ?? Date.now)());
    await this.authorize(offer.publicKey, offer);
    this.current(original);
    const session = await this.begin(offer.publicKey, offer.kind);
    const { token, native, service } = session;
    try {
      this.joining = offer;
      if (offer.kind === 'bluetooth') {
        const details = await native.startBluetooth(); this.current(token);
        inspectNearbyOffer(input, (this.options.now ?? Date.now)());
        if (details.service !== offer.service) throw new Error('Unsupported Bluetooth service.');
        this.update({ phase: 'waiting' });
      } else {
        const result = await (offer.kind === 'vpn' ? native.connectPrivateNetwork(offer.host, offer.port, offer.pin) : native.connectWifi(offer.host, offer.port, offer.pin)); this.current(token);
        inspectNearbyOffer(input, (this.options.now ?? Date.now)());
        service.attachLink(result.linkId, offer.publicKey);
        this.update({ links: [...new Set([...this.state.links, result.linkId])], phase: 'connected' });
        this.options.sync();
      }
    } catch (e) { await this.fail(token, e); throw e; }
  };
  connectBluetooth = async (deviceId: string) => {
    const token = this.generation, offer = this.joining, native = this.native(), service = this.service;
    this.current(token);
    if (!offer || offer.kind !== 'bluetooth' || !service || !this.state.devices.some(d => d.deviceId === deviceId)) throw new Error('Scan your friend’s Bluetooth code first, then choose their phone.');
    if (offer.expiresAt <= (this.options.now ?? Date.now)()) throw new Error('This nearby code expired. Ask for a new one.');
    for (const previous of this.state.links) { service.detachLink(previous); await native.close(previous); this.current(token); }
    this.update({ links: [], phase: 'waiting' });
    const result = await native.connectBluetooth(deviceId); this.current(token);
    if (offer.expiresAt <= (this.options.now ?? Date.now)()) { await this.fail(token, new Error('This nearby code expired. Ask for a new one.')); throw new Error('This nearby code expired.'); }
    service.attachLink(result.linkId, offer.publicKey);
    this.update({ links: [...new Set([...this.state.links, result.linkId])], phase: 'connected' });
    this.options.sync();
  };
  stop = async () => {
    this.generation += 1;
    clearTimeout(this.timer); this.timer = undefined;
    this.joining = null;
    this.options.messenger.attachNearby(null);
    this.service?.stop(); this.service = null;
    for (const listener of this.subscriptions.splice(0)) listener.remove();
    this.update(empty());
    // Keep native teardown serialized so a delayed stop cannot close a new session.
    this.cleanup = this.cleanup.catch(() => {}).then(() => this.options.native?.stop());
    await this.cleanup;
  };
  background = () => { if (this.state.phase !== 'starting') void this.stop().catch(() => {}); };
}
