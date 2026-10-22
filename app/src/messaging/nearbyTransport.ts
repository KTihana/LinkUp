// SPDX-License-Identifier: GPL-3.0-only
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DeliveryTransport, NearbyPacketChannel, NearbyPacketEvent } from './deliveryTransport.ts';
import { MailboxBackpressureError, NoKeyPackageError, requestBytes, validateMailEnvelope, validatePublicPackage,
  type MailEnvelope, type MailSigner, type PublicPackage } from './mailboxClient.ts';
import { decodeMessaging, encodeMessaging, type MessagingPort } from './messenger.ts';
import { decodeNearbyPacket, decodeNearbyResult, emptyNearbyStore, MAX_NEARBY_PACKET_BYTES, nearbyId, nearbyKey,
  nearbyResponseBytes, nearbyShape, packetHash, pruneNearbyStore, verifyNearbySignature,
  type NearbyAction, type NearbyPacket, type NearbyResult, type NearbyStore } from './nearbyProtocol.ts';

const CLOCK_SKEW_MS = 5 * 60 * 1000;
export class NearbyUnavailableError extends MailboxBackpressureError {
  constructor() { super(); this.message = 'Your friend is offline or out of range. Your message stays queued.'; }
}
export class NearbyKeysUnavailableError extends NoKeyPackageError {
  constructor() { super(); this.message = 'Waiting for your friend to connect. Your message stays queued.'; }
}
export type NearbyTransportOptions = {
  port: MessagingPort; channel: NearbyPacketChannel; randomBytes: (length: number) => Promise<Uint8Array>;
  now?: () => number; timeoutMs?: number; maxLinks?: number;
  /** Schedule processing after a new encrypted envelope has durably committed. */
  onIncoming?: () => void;
};
type Pending = { linkId: string; peer: string; hash: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Challenge = { linkId: string; peer: string; action: NearbyAction; expiresAt: number };
type PacketWriter = { tail: Promise<void>; pending: number };
/** One-to-one delivery service. Only signed public MLS material crosses the packet channel. */
export class NearbyTransport implements DeliveryTransport {
  private port: MessagingPort;
  private channel: NearbyPacketChannel;
  private randomBytes: (length: number) => Promise<Uint8Array>;
  private now: () => number;
  private timeoutMs: number;
  private maxLinks: number;
  private onIncoming?: () => void;
  private revision = 0;
  private rpcRevision = 0;
  private running = false;
  private unsubscribe: (() => void) | null = null;
  private links = new Map<string, string>();
  private writers = new Map<string, PacketWriter>();
  private pending = new Map<string, Pending>();
  private challenges = new Map<string, Challenge>();
  private rates = new Map<string, { start: number; count: number }>();
  private activeRequests = 0;
  constructor(options: NearbyTransportOptions) {
    this.port = options.port; this.channel = options.channel; this.randomBytes = options.randomBytes;
    this.maxLinks = options.maxLinks ?? 8;
    if (!Number.isSafeInteger(this.maxLinks) || this.maxLinks < 1 || this.maxLinks > 100) throw new Error('Invalid friend link limit.');
    this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 60000; this.onIncoming = options.onIncoming;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120000) throw new Error('Invalid nearby request timeout.');
  }
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true; const token = ++this.revision;
    try { await this.store(token, async () => {}); }
    catch (error) { if (token === this.revision) this.running = false; throw error; }
    this.current(token);
    this.unsubscribe = this.channel.subscribe(event => { void this.onPacket(event).catch(() => {}); });
  }
  stop(): void {
    this.running = false; this.revision += 1; this.unsubscribe?.(); this.unsubscribe = null;
    this.cancel(); this.links.clear(); this.writers.clear(); this.challenges.clear(); this.rates.clear();
  }
  /** Abort RPCs while retaining the inbound service until explicitly stopped. */
  cancel(): void {
    this.rpcRevision += 1;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Nearby connection stopped. Messages remain queued.')); }
    this.pending.clear();
  }
  attachLink(linkId: string, expectedPeer: string): void {
    if (!this.running || typeof linkId !== 'string' || !linkId.length || linkId.length > 128 || /[\x00-\x1f\x7f]/.test(linkId) || !nearbyKey(expectedPeer)) throw new Error('Invalid nearby friend link.');
    if (!this.links.has(linkId) && this.links.size >= this.maxLinks) throw new Error('Too many nearby links.');
    const previous = this.links.get(linkId);
    if (previous && previous !== expectedPeer) this.detachLink(linkId);
    this.links.set(linkId, expectedPeer);
  }
  isLinked(peer: string): boolean { return this.running && [...this.links.values()].includes(peer); }
  detachLink(linkId: string): void {
    this.links.delete(linkId); this.writers.delete(linkId); this.rates.delete(linkId);
    for (const [id, pending] of this.pending) if (pending.linkId === linkId) {
      clearTimeout(pending.timer); pending.reject(new Error('Nearby friend disconnected. Messages remain queued.')); this.pending.delete(id);
    }
    for (const [id, challenge] of this.challenges) if (challenge.linkId === linkId) this.challenges.delete(id);
  }
  private current(token: number): void { if (!this.running || token !== this.revision) throw new Error('Nearby connection stopped. Messages remain queued.'); }
  private async random(length: number): Promise<string> {
    const bytes = await this.randomBytes(length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Secure nearby random generation failed.');
    return bytesToHex(bytes);
  }
  private store<T>(token: number, task: (store: NearbyStore, signer: MailSigner, contacts: { publicKey: string; name: string }[]) => Promise<T>): Promise<T> {
    this.current(token);
    return this.port.transact(async (serialized, signer, contacts) => {
      this.current(token); const data = decodeMessaging(serialized); data.nearby ??= emptyNearbyStore();
      if (data.nearby.packages.some(item => item.owner !== signer.publicKey) || data.nearby.inbox.some(item => item.recipient !== signer.publicKey)) throw new Error('Nearby storage belongs to a different identity.');
      pruneNearbyStore(data.nearby, this.now());
      const result = await task(data.nearby, signer, contacts); this.current(token);
      return { state: encodeMessaging(data), result };
    });
  }
  async keyStatus(signer: MailSigner): Promise<string[]> {
    return this.store(this.revision, async (store, local) => { if (signer.publicKey !== local.publicKey) throw new Error('Nearby identity changed.'); return store.packages.map(item => item.id); });
  }
  async retireKeys(ids: string[], signer: MailSigner): Promise<void> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !nearbyId(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid nearby key retirement.');
    const wanted = new Set(ids);
    await this.store(this.revision, async (store, local) => {
      if (signer.publicKey !== local.publicKey) throw new Error('Nearby identity changed.');
      const retired = store.packages.filter(item => wanted.has(item.id));
      if (store.claimed.length + retired.length > 1024) throw new MailboxBackpressureError();
      store.claimed.push(...retired.map(({ id, expiresAt }) => ({ id, expiresAt })));
      store.packages = store.packages.filter(item => !wanted.has(item.id));
    });
  }
  async publishKeys(packages: PublicPackage[], signer: MailSigner): Promise<void> {
    await this.store(this.revision, async (store, local) => {
      if (signer.publicKey !== local.publicKey || !Array.isArray(packages) || !packages.length || packages.length > 10) throw new Error('Invalid nearby public packages.');
      for (const candidate of packages) {
        validatePublicPackage(candidate, local.publicKey, this.now());
        if (store.claimed.some(item => item.id === candidate.id)) continue;
        const previous = store.packages.find(item => item.id === candidate.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) throw new Error('Nearby package ID was reused.');
        if (!previous) { if (store.packages.length >= 100) throw new MailboxBackpressureError(); store.packages.push(candidate); }
      }
    });
  }
  async receive(signer: MailSigner): Promise<MailEnvelope[]> {
    return this.store(this.revision, async (store, local, contacts) => {
      if (signer.publicKey !== local.publicKey) throw new Error('Nearby identity changed.');
      store.inbox = store.inbox.filter(item => contacts.some(contact => contact.publicKey === item.sender));
      return store.inbox.slice(0, 50).map(item => ({ ...item }));
    });
  }
  async acknowledge(messages: { sender: string; id: string }[], signer: MailSigner): Promise<void> {
    await this.store(this.revision, async (store, local) => {
      if (signer.publicKey !== local.publicKey || !Array.isArray(messages) || messages.length > 50
        || messages.some(item => !nearbyKey(item.sender) || !nearbyId(item.id) || Object.keys(item).length !== 2)) throw new Error('Invalid nearby acknowledgment.');
      store.inbox = store.inbox.filter(item => !messages.some(message => message.sender === item.sender && message.id === item.id));
      // Retain dedup tombstones so a lost publish reply cannot reinsert acknowledged ciphertext.
    });
  }
  private async request(peer: string, action: NearbyAction, payloadValue: unknown, signer: MailSigner): Promise<unknown> {
    const token = this.revision, rpcToken = this.rpcRevision; this.current(token);
    const active = () => { this.current(token); if (rpcToken !== this.rpcRevision) throw new Error('Nearby connection stopped. Messages remain queued.'); };
    await this.store(token, async (_store, local, contacts) => {
      if (signer.publicKey !== local.publicKey) throw new Error('Nearby identity changed.');
      if (peer === local.publicKey || !contacts.some(item => item.publicKey === peer)) throw new Error('Add this nearby friend using their invitation first.');
    });
    active();
    const link = [...this.links.entries()].reverse().find(([, expected]) => expected === peer)?.[0];
    if (!link) throw action === 'publish' ? new NearbyUnavailableError() : new NearbyKeysUnavailableError();
    try {
      const challengePacket: NearbyPacket = { version: 1, id: await this.random(16), type: 'challenge', publicKey: signer.publicKey, action };
      active(); const challenge = await this.exchange(link, peer, challengePacket);
      active(); nearbyShape(challenge, ['challenge', 'expiresAt']);
      // The responder sets and enforces expiry with its own clock; allow ordinary phone clock skew here.
      if (typeof challenge.challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge.challenge) || !Number.isSafeInteger(challenge.expiresAt)
        || (challenge.expiresAt as number) <= this.now() - CLOCK_SKEW_MS || (challenge.expiresAt as number) > this.now() + 60000 + CLOCK_SKEW_MS) throw new Error('Invalid nearby challenge.');
      const requestId = await this.random(16); active();
      const payload = JSON.stringify(payloadValue), request: NearbyPacket = { version: 1, id: requestId, type: 'request',
        publicKey: signer.publicKey, action, challenge: challenge.challenge, payload,
        signature: signer.sign(requestBytes(`/v1/${action}`, challenge.challenge, payload)) };
      active(); return await this.exchange(link, peer, request);
    } catch (error) {
      // Stop/Lock still aborts the caller. Any other link failure affects only this friend,
      // so Messenger skips them for this round instead of stalling delivery to everyone.
      if (!this.running || token !== this.revision || rpcToken !== this.rpcRevision) throw error;
      if (action === 'publish' ? error instanceof MailboxBackpressureError : error instanceof NoKeyPackageError) throw error;
      const unavailable = action === 'publish' ? new NearbyUnavailableError() : new NearbyKeysUnavailableError();
      if (error instanceof Error) unavailable.message = error.message;
      throw unavailable;
    }
  }
  async claim(owner: string, signer: MailSigner): Promise<PublicPackage> {
    const result = await this.request(owner, 'keys-claim', { owner }, signer); nearbyShape(result, ['package']);
    if (!result.package) throw new NearbyKeysUnavailableError(); validatePublicPackage(result.package, owner, this.now()); return result.package;
  }
  async publish(envelope: MailEnvelope, signer: MailSigner): Promise<void> {
    if (envelope.sender !== signer.publicKey) throw new Error('Nearby sender mismatch.'); validateMailEnvelope(envelope, envelope.recipient, this.now());
    const result = await this.request(envelope.recipient, 'publish', { envelope }, signer); nearbyShape(result, ['accepted', 'duplicate']);
    if (result.accepted !== true || typeof result.duplicate !== 'boolean') throw new Error('Nearby friend did not confirm encrypted storage.');
  }
  /** GATT accepts one outgoing packet per link. Queue fragments' parent packets,
   * including responses, without holding a vault transaction or waiting for RPC replies. */
  private async sendPacket(linkId: string, peer: string, payload: string, eligible: () => boolean = () => true): Promise<void> {
    const token = this.revision; this.current(token);
    if (this.links.get(linkId) !== peer) throw new Error('Nearby friend disconnected. Messages remain queued.');
    let writer = this.writers.get(linkId);
    if (!writer) { writer = { tail: Promise.resolve(), pending: 0 }; this.writers.set(linkId, writer); }
    if (writer.pending >= 16) throw new MailboxBackpressureError();
    const queue = writer;
    queue.pending += 1;
    const sending = queue.tail.then(async () => {
      this.current(token);
      if (this.writers.get(linkId) !== queue || this.links.get(linkId) !== peer || !eligible()) {
        throw new Error('Nearby send was canceled. Messages remain queued.');
      }
      await this.channel.send(linkId, payload);
    });
    // A failed native write must not poison subsequent packets or other links.
    queue.tail = sending.catch(() => {});
    try { await sending; } finally { queue.pending -= 1; }
  }
  private async exchange(linkId: string, peer: string, packet: NearbyPacket): Promise<unknown> {
    const token = this.revision; this.current(token);
    if (this.links.get(linkId) !== peer || this.pending.size >= 8) throw new Error('Nearby link is unavailable or busy.');
    const serialized = JSON.stringify(packet); decodeNearbyPacket(serialized);
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(packet.id); reject(new Error('Nearby friend did not respond. Messages remain queued.')); }, this.timeoutMs);
      this.pending.set(packet.id, { linkId, peer, hash: packetHash(serialized), resolve, reject, timer });
    });
    // Install the pending response before sending; test channels may respond synchronously.
    const request = this.pending.get(packet.id);
    void this.sendPacket(linkId, peer, serialized, () => this.pending.get(packet.id) === request).catch(error => {
      const pending = this.pending.get(packet.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(packet.id); pending.reject(error instanceof Error ? error : new Error('Nearby send failed.'));
    });
    const response = await result; this.current(token); return response;
  }
  private rate(linkId: string): boolean {
    const now = this.now(), previous = this.rates.get(linkId);
    const rate = !previous || now - previous.start >= 60000 ? { start: now, count: 0 } : previous;
    rate.count += 1; this.rates.set(linkId, rate); return rate.count <= 180;
  }
  private async onPacket(event: NearbyPacketEvent): Promise<void> {
    if (!this.running || typeof event.payload !== 'string' || event.payload.length > MAX_NEARBY_PACKET_BYTES || !this.links.has(event.linkId)) return;
    let packet: NearbyPacket; try { packet = decodeNearbyPacket(event.payload); } catch { return; }
    const expected = this.links.get(event.linkId); if (packet.publicKey !== expected || !this.rate(event.linkId)) return;
    if (packet.type === 'response') {
      const pending = this.pending.get(packet.id); if (!pending || pending.linkId !== event.linkId || pending.peer !== packet.publicKey) return;
      try {
        verifyNearbySignature(packet.publicKey, packet.signature, nearbyResponseBytes(packet.id, packet.body));
        const result = decodeNearbyResult(packet.body); if (result.requestHash !== pending.hash) return;
        clearTimeout(pending.timer); this.pending.delete(packet.id);
        if (result.ok) pending.resolve(result.result);
        else pending.reject(result.error === 'no-keys' ? new NoKeyPackageError() : result.error === 'busy' ? new MailboxBackpressureError() : new Error('Nearby request was rejected.'));
      } catch { /* Invalid replies cannot consume a legitimate pending request. */ }
      return;
    }
    if (this.activeRequests >= 8) return;
    const token = this.revision; this.activeRequests += 1;
    let newEnvelope = false;
    try {
      const signed = await this.store(token, async (store, signer, contacts) => {
        if (this.links.get(event.linkId) !== packet.publicKey || packet.publicKey === signer.publicKey
          || !contacts.some(item => item.publicKey === packet.publicKey)) throw new Error('Unknown nearby friend.');
        let result: unknown;
        for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= this.now()) this.challenges.delete(id);
        if (packet.type === 'challenge') {
          if (this.challenges.size >= 32) throw new MailboxBackpressureError();
          const challenge = await this.random(24), expiresAt = this.now() + 60000; this.current(token);
          this.challenges.set(challenge, { linkId: event.linkId, peer: packet.publicKey, action: packet.action, expiresAt });
          result = { challenge, expiresAt };
        } else {
          const challenge = this.challenges.get(packet.challenge); this.challenges.delete(packet.challenge);
          if (!challenge || challenge.expiresAt <= this.now() || challenge.linkId !== event.linkId || challenge.peer !== packet.publicKey || challenge.action !== packet.action) throw new Error('Expired or replayed nearby challenge.');
          verifyNearbySignature(packet.publicKey, packet.signature, requestBytes(`/v1/${packet.action}`, packet.challenge, packet.payload));
          const payload: unknown = JSON.parse(packet.payload); if (JSON.stringify(payload) !== packet.payload) throw new Error('Invalid nearby payload.');
          if (packet.action === 'keys-claim') {
            nearbyShape(payload, ['owner']); if (payload.owner !== signer.publicKey) throw new Error('Nearby key owner mismatch.');
            const candidate = store.packages.shift();
            if (candidate) { if (store.claimed.length >= 1024) throw new MailboxBackpressureError(); store.claimed.push({ id: candidate.id, expiresAt: candidate.expiresAt }); }
            result = { package: candidate ?? null };
          } else {
            nearbyShape(payload, ['envelope']); validateMailEnvelope(payload.envelope, signer.publicKey, this.now());
            const envelope = payload.envelope;
            if (envelope.sender !== packet.publicKey) throw new Error('Nearby envelope sender mismatch.');
            const duplicate = store.accepted.some(item => item.sender === envelope.sender && item.id === envelope.id);
            if (!duplicate) {
              if (store.inbox.length >= 50 || store.accepted.length >= 1024) throw new MailboxBackpressureError();
              store.inbox.push(envelope); store.accepted.push({ sender: envelope.sender, id: envelope.id, expiresAt: envelope.expiresAt });
              newEnvelope = true;
            }
            result = { accepted: true, duplicate };
          }
        }
        return this.response(packet.id, event.payload, { ok: true, result }, signer);
      });
      // Commit encrypted storage before confirming publication or one-use key claim.
      this.current(token);
      if (newEnvelope) { try { this.onIncoming?.(); } catch { /* UI scheduling cannot undo committed delivery. */ } }
      if (this.links.get(event.linkId) === packet.publicKey) await this.sendPacket(event.linkId, packet.publicKey, signed);
    } catch (error) {
      if (!this.running || token !== this.revision) return;
      try {
        const reply = await this.store(token, async (_store, signer, contacts) => {
          if (!contacts.some(item => item.publicKey === packet.publicKey) || this.links.get(event.linkId) !== packet.publicKey) throw new Error('Unknown nearby friend.');
          return this.response(packet.id, event.payload, { ok: false, error: error instanceof MailboxBackpressureError || (error instanceof Error && /storage is full|too large|storage limit/i.test(error.message)) ? 'busy' : 'rejected' }, signer);
        });
        this.current(token); await this.sendPacket(event.linkId, packet.publicKey, reply);
      } catch { /* Lock or Stop refuses signing; the caller keeps its queued data. */ }
    } finally { this.activeRequests -= 1; }
  }
  private response(id: string, request: string, value: { ok: true; result: unknown } | { ok: false; error: 'busy' | 'rejected' }, signer: MailSigner): string {
    const body = JSON.stringify({ requestHash: packetHash(request), ...value } satisfies NearbyResult);
    return JSON.stringify({ version: 1, id, type: 'response', publicKey: signer.publicKey, body, signature: signer.sign(nearbyResponseBytes(id, body)) });
  }
}
