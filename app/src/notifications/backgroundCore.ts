// SPDX-License-Identifier: GPL-3.0-only
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { openVault, parseKey, persistVaultRecord, type RecordStore } from '../security/vaultCore.ts';
import { decodeMessaging, type MessagingPort } from '../messaging/messenger.ts';

export type Reply = { id: string; thread: string; text: string };
export class BackgroundPort implements MessagingPort {
  private stopped = false;
  private key: Uint8Array;
  private seeds = new Set<Uint8Array>();
  private store: RecordStore;
  private withWrite: <T>(task: () => Promise<T>) => Promise<T>;
  private random: (length: number) => Promise<Uint8Array>;
  private allowed: () => boolean;
  constructor(key: string, store: RecordStore, withWrite: <T>(task: () => Promise<T>) => Promise<T>, random: (length: number) => Promise<Uint8Array>, allowed: () => boolean) {
    this.key = parseKey(key); this.store = store; this.withWrite = withWrite; this.random = random; this.allowed = allowed;
  }
  close() { this.stopped = true; this.key.fill(0); for (const seed of this.seeds) seed.fill(0); this.seeds.clear(); }
  private check = () => { if (this.stopped || !this.allowed()) throw new Error('Background messaging is locked or disabled.'); };
  transact<T>(task: Parameters<MessagingPort['transact']>[0]): Promise<T> {
    return this.withWrite(async () => {
      this.check();
      const resetting = await this.store.getItem('common.encrypted-vault.v1.reset.v1'); this.check();
      if (resetting === '1') { this.close(); throw new Error('Account data is being deleted. Background messaging is disabled.'); }
      const record = await this.store.getItem('common.encrypted-vault.v1'); this.check();
      if (!record) throw new Error('No saved vault.');
      const data = openVault(record, this.key), messaging = decodeMessaging(data.messaging ?? null);
      // Recheck encrypted policy on EVERY transaction: a notification may never
      // turn Nearby only, Pause or Disconnect into an internet connection.
      if (!messaging.enabled || messaging.policy === 'nearby-only' || !messaging.endpoint) throw new Error('Background internet delivery is paused.');
      const seed = hexToBytes(data.identity.seed); this.seeds.add(seed);
      const result = await task(data.messaging ?? null, { publicKey: data.identity.publicKey, sign: bytes => {
        this.check();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (bytes.length > 131072 || !['common/mailbox-request/v1\n', 'common/mailbox-envelope/v1\n', 'common/key-package/v1\n'].some(prefix => text.startsWith(prefix))) throw new Error('Unsupported background signature.');
        return bytesToHex(ed25519.sign(bytes, seed));
      } }, data.contacts ?? []);
      this.check();
      if (result.state !== data.messaging) {
        const nonce = await this.random(24); this.check();
        await persistVaultRecord(this.store, 'common.encrypted-vault.v1', { ...data, messaging: result.state }, this.key, nonce, record, this.check);
      }
      return result.result as T;
    });
  }
}
