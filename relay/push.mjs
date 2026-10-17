// SPDX-License-Identifier: GPL-3.0-only
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { RelayError, requireShape } from './protocol.mjs';

// Only operator-approved origins can receive requests. DNS is resolved and
// checked at connection time too, preventing redirects and DNS rebinding into
// localhost/LAN/metadata endpoints. Endpoint URLs are never written to logs.
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0:|2:|10:)/i.test(address) && !/^2002:/i.test(address);
  return false;
}
function publicLookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, records) => {
    if (error) return callback(error);
    if (!records.length || records.some(row => !publicAddress(row.address))) return callback(new Error('Non-public push destination'));
    if (options?.all) callback(null, records); else callback(null, records[0].address, records[0].family);
  });
}
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || (url.port && url.port !== '443') || isIP(url.hostname) || !url.hostname.includes('.')) throw new Error('PUSH_ORIGINS requires exact public HTTPS origins on port 443.');
  return value;
}
export function readPushConfiguration(env) {
  const origins = (env.PUSH_ORIGINS ?? '').split(',').filter(Boolean).map(origin);
  const vapid = env.PUSH_VAPID_PUBLIC_KEY || env.PUSH_VAPID_PRIVATE_KEY ? { subject: env.PUSH_VAPID_SUBJECT, publicKey: env.PUSH_VAPID_PUBLIC_KEY, privateKey: env.PUSH_VAPID_PRIVATE_KEY } : undefined;
  if (vapid) webpush.generateRequestDetails({ endpoint: 'https://push.example.org/test', keys: { p256dh: 'BKOYUrSE3hLkKV7ZT66gGxlyvShmZgNtGfP18tJ3V53psVW6iJ4ChfF9aS5GfK7McM-VH3AaKjNpqAT3f6YTvzc', auth: 'dGVzdC1hdXRoLXNlY3JldA' } }, null, { vapidDetails: vapid });
  return { origins, vapid };
}
export class PushDelivery {
  constructor(store, { origins = [], vapid, send } = {}, now = Date.now) {
    this.store = store; this.origins = new Set(origins.map(origin)); this.vapid = vapid; this.now = now; this.running = null; this.closed = false;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 4, lookup: publicLookup });
    this.send = send ?? (subscription => webpush.sendNotification(subscription, JSON.stringify({ version: 1, type: 'mailbox-wake' }), { TTL: 86400, urgency: 'high', topic: 'linkup-mail', timeout: 10000, agent: this.agent, ...(this.vapid ? { vapidDetails: this.vapid } : {}) }));
  }
  configuration() { return { enabled: this.origins.size > 0, origins: [...this.origins], publicKey: this.vapid?.publicKey ?? '' }; }
  validate(subscription) {
    requireShape(subscription, ['endpoint', 'keys']); requireShape(subscription.keys, ['p256dh', 'auth']);
    let url; try { url = new URL(subscription.endpoint); } catch { throw new RelayError(400, 'invalid_push_endpoint'); }
    if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 1000 || url.protocol !== 'https:' || url.username || url.password || url.hash || !this.origins.has(url.origin) || !url.pathname || url.pathname === '/') throw new RelayError(400, 'push_origin_not_allowed');
    for (const [name, length] of [['p256dh', 65], ['auth', 16]]) {
      const text = subscription.keys[name];
      if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) || Buffer.from(text, 'base64url').length !== length || Buffer.from(text, 'base64url').toString('base64url') !== text) throw new RelayError(400, 'invalid_push_keys');
    }
    try { webpush.generateRequestDetails(subscription, 'test'); } catch { throw new RelayError(400, 'invalid_push_keys'); }
  }
  async register(owner, subscription) {
    if (!this.origins.size) throw new RelayError(503, 'push_not_configured');
    this.validate(subscription);
    return this.store.transact(state => {
      state.push ??= [];
      const existing = state.push.find(row => row.owner === owner);
      if (!existing && state.push.length >= 1024) throw new RelayError(429, 'push_quota');
      const row = { owner, subscription, expiresAt: this.now() + 30 * 86400000, pending: state.envelopes.some(e => e.recipient === owner && e.envelope), nextAttempt: this.now(), attempts: 0, revision: randomBytes(16).toString('hex') };
      state.push = state.push.filter(p => p.owner !== owner); state.push.push(row);
      return { registered: true, expiresAt: row.expiresAt };
    });
  }
  unregister(owner) { return this.store.transact(state => { if (state.push) state.push = state.push.filter(row => row.owner !== owner); return { removed: true }; }); }
  async start() {
    // Recover a crash between storing ciphertext and dispatching its wakeup.
    await this.store.transact(state => { for (const row of state.push ?? []) if (state.envelopes.some(e => e.recipient === row.owner && e.envelope)) row.pending = true; });
    this.timer = setInterval(() => { if (!this.running && !this.closed) this.running = this.flush().catch(() => {}).finally(() => { this.running = null; }); }, 1000); this.timer.unref();
  }
  async flush() {
    const pending = await this.store.transact(state => (state.push ?? []).filter(row => row.pending && row.nextAttempt <= this.now()).slice(0, 4).map(row => structuredClone(row)));
    await Promise.all(pending.map(async row => {
      let status = 0;
      try { this.validate(row.subscription); await this.send(row.subscription); status = 201; }
      catch (error) { status = error.statusCode ?? 0; }
      if (this.closed) return;
      await this.store.transact(state => {
        const current = state.push?.find(p => p.owner === row.owner && JSON.stringify(p.subscription) === JSON.stringify(row.subscription));
        if (!current) return;
        if (status === 404 || status === 410) { state.push = state.push.filter(p => p !== current); return; }
        if (status >= 200 && status < 300) { current.pending = current.revision !== row.revision; current.attempts = 0; current.nextAttempt = this.now() + 10000; }
        else { current.attempts += 1; current.nextAttempt = this.now() + Math.min(300000, 1000 * 2 ** Math.min(current.attempts, 9)); }
      });
    }));
  }
  async close() { this.closed = true; clearInterval(this.timer); if (this.running) await this.running; this.agent.destroy(); }
}
