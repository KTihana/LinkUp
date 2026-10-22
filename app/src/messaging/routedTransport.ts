// SPDX-License-Identifier: GPL-3.0-only
import type { DeliveryTransport } from './deliveryTransport.ts';
import { MailboxBackpressureError, NoKeyPackageError, type MailEnvelope, type MailSigner, type PublicPackage } from './mailboxClient.ts';
import { NearbyKeysUnavailableError, NearbyUnavailableError } from './nearbyTransport.ts';

/** Mailbox accounts also reach internet-P2P friends: a friend connected over P2P is
 * contacted directly, everyone else through the mailbox. Mailbox inbox and key pool
 * calls go to the mailbox; Messenger processes the P2P inbox and key pool separately.
 * Without a reachable mailbox only P2P-connected friends are contacted. */
export class RoutedTransport implements DeliveryTransport {
  private direct: DeliveryTransport;
  private mailbox: DeliveryTransport | null;
  constructor(direct: DeliveryTransport, mailbox: DeliveryTransport | null) { this.direct = direct; this.mailbox = mailbox; }
  cancel(): void { this.direct.cancel?.(); this.mailbox?.cancel?.(); }
  private linked(peer: string): boolean { return this.direct.isLinked?.(peer) ?? false; }
  async publish(envelope: MailEnvelope, signer: MailSigner): Promise<void> {
    if (this.linked(envelope.recipient)) {
      try { return await this.direct.publish(envelope, signer); }
      catch (error) { if (!(error instanceof MailboxBackpressureError) || !this.mailbox) throw error; }
    }
    if (!this.mailbox) throw new NearbyUnavailableError();
    return this.mailbox.publish(envelope, signer);
  }
  async claim(owner: string, signer: MailSigner): Promise<PublicPackage> {
    if (this.linked(owner)) {
      try { return await this.direct.claim(owner, signer); }
      catch (error) { if (!(error instanceof NoKeyPackageError) || !this.mailbox) throw error; }
    }
    if (!this.mailbox) throw new NearbyKeysUnavailableError();
    return this.mailbox.claim(owner, signer);
  }
  async receive(signer: MailSigner): Promise<MailEnvelope[]> { return this.mailbox ? this.mailbox.receive(signer) : []; }
  async acknowledge(messages: { sender: string; id: string }[], signer: MailSigner): Promise<void> {
    if (this.mailbox && messages.length) await this.mailbox.acknowledge(messages, signer);
  }
  async keyStatus(signer: MailSigner): Promise<string[]> { if (!this.mailbox) throw new Error('Mailbox is unavailable.'); return this.mailbox.keyStatus(signer); }
  async publishKeys(packages: PublicPackage[], signer: MailSigner): Promise<void> { if (!this.mailbox) throw new Error('Mailbox is unavailable.'); return this.mailbox.publishKeys(packages, signer); }
  async retireKeys(ids: string[], signer: MailSigner): Promise<void> {
    if (!this.mailbox?.retireKeys) throw new Error('This connection needs an update before it can replace older messaging keys.');
    return this.mailbox.retireKeys(ids, signer);
  }
}
