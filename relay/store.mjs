// SPDX-License-Identifier: GPL-3.0-only
import { mkdir, open, readFile, rename, rm, lstat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RelayError, HEX_ID, isKey, hash, envelopeBytes, packageBytes, requireShape, validateEnvelope, validatePackage } from './protocol.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  maxRecords: 10_000, maxPackages: 10_000, maxStoreBytes: 32 * 1024 * 1024,
  pendingPerSender: 256, pendingPerRecipient: 256, packagesPerOwner: 100,
  admissionOwners: 1024, admissionPeers: 100,
});
const emptyState = () => ({ version: 2, envelopes: [], packages: [], admissions: [] });
const recordKey = value => `${value.sender ?? value.owner}:${value.id}`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class MailboxStore {
  constructor(dataDir, { now = Date.now, limits = {} } = {}) {
    this.dataDir = resolve(dataDir); this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.path = join(this.dataDir, 'mailbox-v1.json');
    this.lockPath = join(this.dataDir, 'writer.lock');
    this.state = emptyState(); this.queue = Promise.resolve(); this.lock = null; this.closed = false;
  }
  static async create(dataDir, options) {
    const store = new MailboxStore(dataDir, options);
    await store.initialize(); return store;
  }
  async initialize() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.dataDir)).isDirectory()) throw new Error('DATA_DIR must be a real directory.');
    await chmod(this.dataDir, 0o700);
    try { this.lock = await open(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another writer or stale writer.lock exists. Stop the other process before removing a stale lock.');
      throw error;
    }
    try {
      await this.lock.writeFile(`${process.pid}\n`); await this.lock.sync();
      try {
        const fileInfo = await lstat(this.path);
        if (!fileInfo.isFile() || fileInfo.size > this.limits.maxStoreBytes) throw new Error('Invalid or oversized mailbox snapshot.');
        const loaded = JSON.parse(await readFile(this.path, 'utf8'));
        this.validateState(loaded); this.state = loaded;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Migration deliberately grants nobody access. Existing ciphertext is
      // tombstoned, not revived when a friend is accepted later. Keep package
      // claim tombstones so old one-time material cannot be published again.
      await this.transact(state => {
        if (state.version === 1) {
          state.version = 2; state.admissions = [];
          for (const record of state.envelopes) record.envelope = null;
          for (const subscription of state.push ?? []) subscription.pending = false;
        }
      });
    } catch (error) { await this.close(); throw error; }
  }
  validateState(state) {
    if (!state || typeof state !== 'object') throw new Error('Invalid mailbox snapshot.');
    if (state.push !== undefined) {
      if (!Array.isArray(state.push) || state.push.length > 1024) throw new Error('Invalid push subscriptions.');
      const owners = new Set();
      for (const row of state.push) {
        requireShape(row, ['owner', 'subscription', 'expiresAt', 'pending', 'nextAttempt', 'attempts', 'revision']);
        if (!isKey(row.owner) || owners.has(row.owner) || !Number.isSafeInteger(row.expiresAt) || !Number.isSafeInteger(row.nextAttempt) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || typeof row.pending !== 'boolean' || typeof row.revision !== 'string' || !/^[a-f0-9]{32}$/.test(row.revision)) throw new Error('Invalid push subscription.');
        owners.add(row.owner);
      }
    }
    const fields = ['version', 'envelopes', 'packages'];
    if (state.version === 2) fields.push('admissions');
    if (state.push !== undefined) fields.push('push');
    requireShape(state, fields);
    if (![1, 2].includes(state.version) || !Array.isArray(state.envelopes) || !Array.isArray(state.packages) || state.envelopes.length > this.limits.maxRecords || state.packages.length > this.limits.maxPackages) throw new Error('Invalid mailbox snapshot.');
    if (state.version === 2) {
      if (!Array.isArray(state.admissions) || state.admissions.length > this.limits.admissionOwners) throw new Error('Invalid mailbox admission records.');
      const owners = new Set();
      for (const row of state.admissions) {
        requireShape(row, ['owner', 'revision', 'peers']);
        if (!isKey(row.owner) || owners.has(row.owner)) throw new Error('Invalid mailbox admission owner.');
        this.validateAdmission(row.owner, row.peers, row.revision); owners.add(row.owner);
      }
    }
    const now = this.now();
    for (const [records, kind] of [[state.envelopes, 'envelope'], [state.packages, 'package']]) {
      const seen = new Set();
      for (const record of records) {
        requireShape(record, kind === 'envelope' ? ['id', 'sender', 'recipient', 'expiresAt', 'fingerprint', 'envelope'] : ['id', 'owner', 'expiresAt', 'fingerprint', 'package']);
        if (typeof record.id !== 'string' || !HEX_ID.test(record.id) || !isKey(record.sender ?? record.owner) || (kind === 'envelope' && !isKey(record.recipient)) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0 || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) || seen.has(recordKey(record))) throw new Error('Invalid mailbox record.');
        seen.add(recordKey(record));
        const content = record[kind];
        if (content !== null) {
          if (kind === 'envelope') validateEnvelope(content, now, true); else validatePackage(content, now, true);
          const expected = kind === 'envelope' ? hash(envelopeBytes(content)) : hash(packageBytes(content));
          if (content.id !== record.id || (content.sender ?? content.owner) !== (record.sender ?? record.owner) || content.expiresAt !== record.expiresAt || (kind === 'envelope' && content.recipient !== record.recipient) || expected !== record.fingerprint) throw new Error('Invalid mailbox record binding.');
        }
      }
    }
  }
  prune(state) {
    const now = this.now();
    state.envelopes = state.envelopes.filter(record => record.expiresAt > now);
    state.packages = state.packages.filter(record => record.expiresAt > now);
    if (state.push) state.push = state.push.filter(row => row.expiresAt > now);
  }
  transact(operation) {
    const task = this.queue.then(async () => {
      if (this.closed) throw new RelayError(503, 'store_closed');
      const next = structuredClone(this.state);
      this.prune(next);
      const result = operation(next);
      if (!same(next, this.state)) {
        const serialized = JSON.stringify(next);
        if (Buffer.byteLength(serialized) > this.limits.maxStoreBytes) throw new RelayError(507, 'storage_quota');
        await this.atomicWrite(serialized); this.state = next;
      }
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
  async atomicWrite(serialized) {
    const temporaryPath = join(this.dataDir, `.snapshot-${randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await rename(temporaryPath, this.path);
      // A rename is atomic; syncing the directory also makes the rename durable across power loss.
      const directory = await open(this.dataDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      // A failed directory sync may follow a completed rename. Stop accepting writes rather than use stale memory.
      this.closed = true;
      throw error;
    } finally { if (handle) await handle.close(); await rm(temporaryPath, { force: true }); }
  }
  publish(sender, envelope) {
    validateEnvelope(envelope, this.now());
    if (sender !== envelope.sender) throw new RelayError(403, 'sender_mismatch');
    return this.transact(state => {
      this.requireAdmission(state, envelope.recipient, sender);
      const fingerprint = hash(envelopeBytes(envelope));
      const saved = state.envelopes.find(record => record.sender === sender && record.id === envelope.id);
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new RelayError(409, 'envelope_id_conflict');
        return { accepted: true, duplicate: true };
      }
      if (state.envelopes.length >= this.limits.maxRecords || state.envelopes.filter(record => record.envelope && record.sender === sender).length >= this.limits.pendingPerSender || state.envelopes.filter(record => record.envelope && record.recipient === envelope.recipient).length >= this.limits.pendingPerRecipient) throw new RelayError(429, 'mailbox_quota');
      state.envelopes.push({ id: envelope.id, sender, recipient: envelope.recipient, expiresAt: envelope.expiresAt, fingerprint, envelope });
      const subscription = state.push?.find(row => row.owner === envelope.recipient);
      if (subscription) { subscription.pending = true; subscription.attempts = 0; subscription.revision = randomBytes(16).toString('hex'); }
      return { accepted: true, duplicate: false };
    });
  }
  receive(recipient, limit) {
    return this.transact(state => ({ envelopes: state.envelopes.filter(record => record.envelope && record.recipient === recipient && this.admitted(state, recipient, record.sender)).slice(0, limit).map(record => record.envelope) }));
  }
  ack(recipient, messages) {
    return this.transact(state => {
      const wanted = new Set(messages.map(value => `${value.sender}:${value.id}`)); let acknowledged = 0;
      for (const record of state.envelopes) if (record.recipient === recipient && record.envelope && wanted.has(recordKey(record))) { record.envelope = null; acknowledged += 1; }
      return { acknowledged };
    });
  }
  publishPackages(owner, packages) {
    for (const packageValue of packages) {
      validatePackage(packageValue, this.now());
      if (packageValue.owner !== owner) throw new RelayError(403, 'owner_mismatch');
    }
    return this.transact(state => {
      let added = 0;
      for (const packageValue of packages) {
        const fingerprint = hash(packageBytes(packageValue));
        const saved = state.packages.find(record => record.owner === owner && record.id === packageValue.id);
        if (saved) {
          if (saved.fingerprint !== fingerprint) throw new RelayError(409, 'package_id_conflict');
          continue;
        }
        if (state.packages.length >= this.limits.maxPackages || state.packages.filter(record => record.package && record.owner === owner).length >= this.limits.packagesPerOwner) throw new RelayError(429, 'package_quota');
        state.packages.push({ id: packageValue.id, owner, expiresAt: packageValue.expiresAt, fingerprint, package: packageValue }); added += 1;
      }
      return { added };
    });
  }
  claimPackage(requester, owner) {
    if (requester === owner) throw new RelayError(403, 'cannot_claim_own_package');
    return this.transact(state => {
      this.requireAdmission(state, owner, requester);
      const record = state.packages.find(value => value.package && value.owner === owner);
      if (!record) return { package: null };
      const packageValue = record.package; record.package = null;
      return { package: packageValue };
    });
  }
  packageStatus(owner) {
    return this.transact(state => ({ available: state.packages.filter(record => record.package && record.owner === owner).slice(0, 100).map(record => record.id) }));
  }
  retirePackages(owner, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !HEX_ID.test(id)) || new Set(ids).size !== ids.length) throw new RelayError(400, 'invalid_package_ids');
    const wanted = new Set(ids);
    return this.transact(state => {
      let retired = 0;
      for (const record of state.packages) if (record.owner === owner && record.package && wanted.has(record.id)) {
        record.package = null; retired += 1;
      }
      // Preserve the original expiry/fingerprint, just as for a claimed key.
      // Retrying publication of deprecated material must never revive it.
      return { retired };
    });
  }
  admitted(state, owner, peer) {
    return state.admissions?.find(row => row.owner === owner)?.peers.includes(peer) === true;
  }
  requireAdmission(state, owner, peer) {
    if (!this.admitted(state, owner, peer)) throw new RelayError(403, 'recipient_not_accepting');
  }
  validateAdmission(owner, peers, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(peers) || peers.length > this.limits.admissionPeers
      || peers.some(peer => !isKey(peer) || peer === owner) || new Set(peers).size !== peers.length
      || !same(peers, [...peers].sort())) throw new RelayError(400, 'invalid_admission');
  }
  setAdmission(owner, peers, revision) {
    this.validateAdmission(owner, peers, revision);
    peers = [...peers];
    return this.transact(state => {
      const row = state.admissions.find(value => value.owner === owner);
      // A delayed request from a foreground/background worker may never
      // overwrite a newer revocation. Persist this revision even for [] lists.
      if (row && (revision < row.revision || (revision === row.revision && !same(peers, row.peers)))) throw new RelayError(409, 'admission_revision_conflict');
      if (row) { row.peers = peers; row.revision = revision; }
      else {
        if (state.admissions.length >= this.limits.admissionOwners) throw new RelayError(429, 'admission_quota');
        state.admissions.push({ owner, revision, peers });
      }
      for (const record of state.envelopes) if (record.recipient === owner && !peers.includes(record.sender)) record.envelope = null;
      if (!state.envelopes.some(record => record.recipient === owner && record.envelope)) {
        const subscription = state.push?.find(value => value.owner === owner);
        if (subscription) subscription.pending = false;
      }
      return { accepted: true, revision };
    });
  }
  async close() {
    await this.queue; this.closed = true;
    if (this.lock) { await this.lock.close(); this.lock = null; await rm(this.lockPath, { force: true }); }
  }
}
