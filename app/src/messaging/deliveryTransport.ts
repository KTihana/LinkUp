// SPDX-License-Identifier: GPL-3.0-only
import type { MailEnvelope, MailSigner, PublicPackage } from './mailboxClient.ts';

export type DeliveryPolicy = 'automatic' | 'nearby-only';
/** Delivery carries authenticated opaque MLS packets, never private MLS keys. */
export interface DeliveryTransport {
  /** Revoke outstanding requests; already dispatched packets cannot be recalled. */
  cancel?(): void;
  /** Whether a direct link to this friend is currently connected (direct transports only). */
  isLinked?(peer: string): boolean;
  publishKeys(packages: PublicPackage[], signer: MailSigner): Promise<void>;
  /** Retire deprecated public setup material without reviving consumed IDs. */
  retireKeys?(ids: string[], signer: MailSigner): Promise<void>;
  keyStatus(signer: MailSigner): Promise<string[]>;
  claim(owner: string, signer: MailSigner): Promise<PublicPackage>;
  publish(envelope: MailEnvelope, signer: MailSigner): Promise<void>;
  receive(signer: MailSigner): Promise<MailEnvelope[]>;
  acknowledge(messages: { sender: string; id: string }[], signer: MailSigner): Promise<void>;
}
export type NearbyPacketEvent = { linkId: string; payload: string };
export interface NearbyPacketChannel {
  send(linkId: string, payload: string): Promise<void>;
  subscribe(listener: (event: NearbyPacketEvent) => void): () => void;
}
