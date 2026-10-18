// SPDX-License-Identifier: GPL-3.0-only
import { createGroupDescriptor, readGroupPacket, validateGroups, groupFingerprint, MAX_GROUPS, type GroupRecord, type GroupPacket } from './groups.ts';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MailboxClient, NoKeyPackageError, MailboxBackpressureError, MailboxAdmissionError, mailboxURL, envelopeBytes, packageBytes,
  validateMailEnvelope, validatePublicPackage as validateSignedPackage,
  type MailEnvelope, type MailSigner, type PublicPackage,
} from './mailboxClient.ts';
import type { DeliveryTransport, DeliveryPolicy } from './deliveryTransport.ts';
import { validateCallSignal, CALL_SIGNAL_TTL, type CallSignal } from '../calls/protocol.ts';
import type { CallNetwork } from '../calls/controller.ts';
import { validateNearbyStore, pruneNearbyStore, type NearbyStore } from './nearbyProtocol.ts';
import { isStickerContent } from '../stickers/content.ts';
import {
  createPackage, startSession, receiveWelcome, encryptMessage, decryptMessage,
  sessionContext, sessionInitiator, MAX_MESSAGE_BYTES, sessionEpoch, sessionSupportsEpochUpdates,
  canUpdateEpoch, createEpochUpdate, receiveEpochUpdate, messageEpoch, epochCommitId,
} from './mlsEngine.ts';

export type ChatMessage = {
  id: string; content: string; mine: boolean; kind: 'text' | 'sticker' | 'group'; createdAt: number;
  status: 'queued' | 'stored' | 'delivered'; error?: string; expiresAt?: number;
};
export type EpochRotation = {
  updatedAt: number; messages: number; cycle: boolean;
  pending?: { epoch: number; commitId: string; envelope: MailEnvelope };
  request?: MailEnvelope;
  received: { epoch: number; commitId: string; ack: MailEnvelope }[];
  receipts: string[];
  failed?: boolean;
};
export type MessagingData = {
  version: 1; endpoint: string; enabled: boolean; admission?: { peers: string[]; revision: number; endpoint: string }; groups?: Record<string, GroupRecord>; policy?: DeliveryPolicy; nearby?: NearbyStore;
  conversations: Record<string, { state: string; groupId: string; messages: ChatMessage[]; setupExpiresAt?: number;
    rotation?: EpochRotation; callInvite?: CallSignal & { type: 'invite' };
    retiredGroups?: { groupId: string; expiresAt: number }[] }>;
  pending: { peer: string; messageId: string; expiresAt: number; envelopeId?: string }[];
  outbox: { envelope: MailEnvelope; messageId: string | null }[];
  packages: { package: PublicPackage; privateData: string; published: boolean; location?: 'mailbox' | 'nearby' }[];
  seen: { sender: string; id: string; expiresAt: number }[];
};
export interface MessagingPort {
  transact<T>(task: (serialized: string | null, signer: MailSigner,
    contacts: { publicKey: string; name: string }[]) => Promise<{ state: string; result: T }>): Promise<T>;
}
export type MessagingView = {
  endpoint: string; enabled: boolean; policy: DeliveryPolicy;
  conversations: Record<string, { messages: ChatMessage[]; security?: 'legacy' | 'ready' | 'refreshing' | 'blocked' }>;
  queued: number;
  groups?: Record<string, GroupRecord & { messages: (ChatMessage & { sender: string })[] }>;
};
type Wire = { type: 'welcome'; packageId: string; body: string }
  | { type: 'application' | 'epoch' | 'epoch-ack' | 'epoch-request'; groupId: string; body: string };
type ChatPayload = { version: 1; type: 'chat'; id: string; kind: 'text' | 'sticker' | 'group'; content: string; createdAt: number };
type ReceiptPayload = { version: 1; type: 'receipt'; messageId: string };
type EpochRequestPayload = { version: 1; type: 'epoch-request'; epoch: number };
type EpochAckPayload = { version: 1; type: 'epoch-ack'; epoch: number; commitId: string };
type CallPayload = { version: 1; type: 'call'; signal: CallSignal };
export const MLS_ROTATION_MESSAGES = 64;
export const MLS_ROTATION_INTERVAL = 24 * 60 * 60 * 1000;
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_SAVED_BYTES = 900_000;
const keyPattern = /^[a-f0-9]{64}$/, idPattern = /^[a-f0-9]{32}$/;
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true });
const empty = (): MessagingData => ({ version: 1, endpoint: '', enabled: false, conversations: {}, pending: [], outbox: [], packages: [], seen: [] });
const identity = (publicKey: string) => `common:${publicKey}`;
const validKey = (value: unknown): value is string => typeof value === 'string' && keyPattern.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const date = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(field => !Object.hasOwn(value, field))
    || Object.keys(value).some(field => !required.includes(field) && !optional.includes(field))) {
    throw new Error('Invalid saved messaging data.');
  }
}
function contentValid(kind: unknown, content: unknown): content is string {
  if (kind === 'group') { try { readGroupPacket(content as string); return true; } catch { return false; } }
  return (kind === 'text' || kind === 'sticker') && typeof content === 'string' && content.length > 0
    && textEncoder.encode(content).length <= MAX_MESSAGE_BYTES
    && textDecoder.decode(textEncoder.encode(content)) === content
    && (kind !== 'sticker' || isStickerContent(content));
}
export function encodeMessaging(data: MessagingData): string {
  const result = JSON.stringify(data);
  if (textEncoder.encode(result).length > MAX_SAVED_BYTES) {
    throw new Error('Encrypted chat storage is full. Messaging currently supports a small development history.');
  }
  // Recheck the complete state before it crosses the persistence boundary.
  decodeMessaging(result);
  return result;
}

/** Only call within the encrypted-vault transaction, never expose the result to UI. */
export function decodeMessaging(serialized: string | null): MessagingData {
  if (serialized === null) return empty();
  if (typeof serialized !== 'string' || textEncoder.encode(serialized).length > MAX_SAVED_BYTES) throw new Error('Saved messaging data is too large.');
  const value: unknown = JSON.parse(serialized);
  shape(value, ['version', 'endpoint', 'enabled', 'conversations', 'pending', 'outbox', 'packages', 'seen'], ['policy', 'nearby', 'groups', 'admission']);
  if (JSON.stringify(value) !== serialized || value.version !== 1 || typeof value.endpoint !== 'string'
    || typeof value.enabled !== 'boolean' || (value.policy !== undefined && !['automatic', 'nearby-only'].includes(value.policy as string))
    || (value.endpoint !== '' && mailboxURL(value.endpoint) !== value.endpoint)) throw new Error('Invalid saved mailbox settings.');
  const data = value as unknown as MessagingData;
  if (data.admission !== undefined) {
    shape(data.admission, ['peers', 'revision', 'endpoint']);
    if (!Array.isArray(data.admission.peers) || data.admission.peers.length > 100 ||
        data.admission.peers.some((peer, index) => !validKey(peer) || (index > 0 && data.admission!.peers[index - 1] >= peer)) ||
        !Number.isSafeInteger(data.admission.revision) || data.admission.revision < 1 ||
        typeof data.admission.endpoint !== 'string' || mailboxURL(data.admission.endpoint) !== data.admission.endpoint) {
      throw new Error('Invalid saved mailbox admission.');
    }
  }
  if (data.nearby !== undefined) validateNearbyStore(data.nearby);
  if (data.groups !== undefined) validateGroups(data.groups);
  if (!data.conversations || typeof data.conversations !== 'object' || Array.isArray(data.conversations)
    || Object.keys(data.conversations).length > 10
    || !Array.isArray(data.pending) || data.pending.length > 500
    || !Array.isArray(data.outbox) || data.outbox.length > 1000
    || !Array.isArray(data.packages) || data.packages.length > 110
    || !Array.isArray(data.seen) || data.seen.length > 8192) throw new Error('Saved messaging limits were exceeded.');
  let messages = 0;
  for (const [peer, conversation] of Object.entries(data.conversations)) {
    shape(conversation, ['state', 'groupId', 'messages'], ['setupExpiresAt', 'retiredGroups', 'callInvite', 'rotation']);
    if (conversation.callInvite !== undefined) {
      validateCallSignal(conversation.callInvite, 0, false);
      if (conversation.callInvite.type !== 'invite' || !conversation.state || conversation.setupExpiresAt === undefined) throw new Error('Invalid pending call invitation.');
    }
    if (!validKey(peer) || typeof conversation.state !== 'string' || conversation.state.length > 262144
      || typeof conversation.groupId !== 'string' || !Array.isArray(conversation.messages)
      || (conversation.setupExpiresAt !== undefined && (!date(conversation.setupExpiresAt) || conversation.state === ''))) throw new Error('Invalid saved conversation.');
    if (conversation.retiredGroups !== undefined) {
      if (!Array.isArray(conversation.retiredGroups) || conversation.retiredGroups.length > 16) throw new Error('Invalid retired conversation records.');
      const retired = new Set<string>();
      for (const record of conversation.retiredGroups) {
        shape(record, ['groupId', 'expiresAt']);
        if (!validKey(record.groupId) || !date(record.expiresAt) || retired.has(record.groupId)) throw new Error('Invalid retired conversation records.');
        retired.add(record.groupId);
      }
    }
    if (conversation.state === '') {
      if (conversation.groupId !== '') throw new Error('Invalid pending conversation.');
    } else {
      const context = sessionContext(conversation.state);
      if (!validKey(conversation.groupId) || context.peer !== identity(peer) || context.groupId !== conversation.groupId) throw new Error('Saved session does not match its friend.');
    }
    if (conversation.rotation !== undefined) validateRotation(conversation, peer);
    const seenMessages = new Set<string>();
    for (const message of conversation.messages) {
      shape(message, ['id', 'content', 'mine', 'kind', 'createdAt', 'status'], ['error', 'expiresAt']);
      if (!validId(message.id) || !contentValid(message.kind, message.content) || typeof message.mine !== 'boolean'
        || !date(message.createdAt) || !['queued', 'stored', 'delivered'].includes(message.status)
        || (!message.mine && message.status !== 'delivered')
        || (message.expiresAt !== undefined && (!date(message.expiresAt) || message.expiresAt <= message.createdAt || message.expiresAt - message.createdAt > TTL))
        || (message.error !== undefined && !['Expired before delivery', 'Chat reconnected; send this message again', 'Friend removed; message cancelled'].includes(message.error))
        || seenMessages.has(`${message.mine}:${message.id}`)) throw new Error('Invalid saved chat message.');
      seenMessages.add(`${message.mine}:${message.id}`);
    }
    messages += conversation.messages.length;
  }
  if (messages > 500) throw new Error('The development chat history limit is 500 messages.');
  const pendingIDs = new Set<string>();
  for (const pending of data.pending) {
    shape(pending, ['peer', 'messageId', 'expiresAt'], ['envelopeId']);
    const message = data.conversations[pending.peer]?.messages.find(item => item.mine && item.id === pending.messageId);
    const composite = `${pending.peer}:${pending.messageId}`;
    if (!validKey(pending.peer) || !validId(pending.messageId) || !date(pending.expiresAt)
      || (pending.envelopeId !== undefined && !validId(pending.envelopeId))
      || !message || message.error || message.status !== 'queued' || pendingIDs.has(composite)) throw new Error('Invalid queued message.');
    pendingIDs.add(composite);
  }
  const outboxIDs = new Set<string>();
  for (const item of data.outbox) {
    shape(item, ['envelope', 'messageId']);
    validateMailEnvelope(item.envelope, item.envelope?.recipient, item.envelope?.createdAt);
    const wire = decodeWire(item.envelope.ciphertext);
    const composite = `${item.envelope.sender}:${item.envelope.id}`;
    if (outboxIDs.has(composite) || (item.messageId !== null && !validId(item.messageId))) throw new Error('Invalid saved outbox.');
    outboxIDs.add(composite);
    if (item.messageId !== null) {
      const message = data.conversations[item.envelope.recipient]?.messages.find(row => row.mine && row.id === item.messageId);
      if (wire.type !== 'application' || !message || message.error
        || message.status !== 'queued' || pendingIDs.has(`${item.envelope.recipient}:${item.messageId}`)) throw new Error('Invalid encrypted queued message.');
    }
  }
  const packageIDs = new Set<string>();
  for (const stored of data.packages) {
    shape(stored, ['package', 'privateData', 'published'], ['location']);
    validateSignedPackage(stored.package, stored.package?.owner, stored.package?.createdAt);
    if (typeof stored.privateData !== 'string' || !stored.privateData.length || stored.privateData.length > 32768
      || typeof stored.published !== 'boolean' || (stored.location !== undefined && !['mailbox', 'nearby'].includes(stored.location)) || packageIDs.has(stored.package.id)) throw new Error('Invalid private messaging package.');
    packageIDs.add(stored.package.id);
  }
  const seenIDs = new Set<string>();
  for (const record of data.seen) {
    shape(record, ['sender', 'id', 'expiresAt']);
    const composite = `${record.sender}:${record.id}`;
    if (!validKey(record.sender) || !validId(record.id) || !date(record.expiresAt) || seenIDs.has(composite)) throw new Error('Invalid received-message record.');
    seenIDs.add(composite);
  }
  return data;
}
function decodeWire(ciphertext: string): Wire {
  const decoded = base64.decode(ciphertext);
  if (!decoded.length || decoded.length > 65536 || base64.encode(decoded) !== ciphertext) throw new Error('Invalid message encoding.');
  const serialized = textDecoder.decode(decoded), value: unknown = JSON.parse(serialized);
  if (JSON.stringify(value) !== serialized) throw new Error('Invalid message encoding.');
  shape(value, ['type', 'body'], ['packageId', 'groupId']);
  if (typeof value.body !== 'string' || !value.body.length) throw new Error('Empty protocol message.');
  if (value.type === 'welcome') {
    shape(value, ['type', 'packageId', 'body']);
    if (!validId(value.packageId) || value.body.length > 65536) throw new Error('Invalid welcome message.');
  } else if (value.type === 'application' || value.type === 'epoch' || value.type === 'epoch-ack' || value.type === 'epoch-request') {
    shape(value, ['type', 'groupId', 'body']);
    if (!validKey(value.groupId) || value.body.length > 32768) throw new Error('Invalid encrypted chat message.');
  } else throw new Error('Unsupported protocol message.');
  return value as Wire;
}
function decodePayload(bytes: Uint8Array, envelope: MailEnvelope): ChatPayload | ReceiptPayload | CallPayload | EpochAckPayload | EpochRequestPayload {
  const serialized = textDecoder.decode(bytes), value: unknown = JSON.parse(serialized);
  if (JSON.stringify(value) !== serialized) throw new Error('Invalid message contents.');
  shape(value, ['version', 'type'], ['id', 'kind', 'content', 'createdAt', 'messageId', 'signal', 'epoch', 'commitId']);
  if (value.version !== 1) throw new Error('Unsupported message contents.');
  if (value.type === 'chat') {
    shape(value, ['version', 'type', 'id', 'kind', 'content', 'createdAt']);
    if (!validId(value.id) || !contentValid(value.kind, value.content)
      || !date(value.createdAt) || value.createdAt > envelope.createdAt + 60000) throw new Error('Invalid chat contents.');
  } else if (value.type === 'receipt') {
    shape(value, ['version', 'type', 'messageId']);
    if (!validId(value.messageId)) throw new Error('Invalid delivery receipt.');
  } else if (value.type === 'epoch-request') {
    shape(value, ['version', 'type', 'epoch']);
    if (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 || (value.epoch as number) % 2 !== 1) throw new Error('Invalid key-update request.');
  } else if (value.type === 'epoch-ack') {
    shape(value, ['version', 'type', 'epoch', 'commitId']);
    if (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 2 || !validKey(value.commitId)) throw new Error('Invalid key-update acknowledgement.');
  } else if (value.type === 'call') {
    shape(value, ['version', 'type', 'signal']);
    validateCallSignal(value.signal, envelope.createdAt);
    if (envelope.expiresAt - envelope.createdAt > CALL_SIGNAL_TTL) throw new Error('Invalid call expiry.');
  } else throw new Error('Unsupported message contents.');
  return value as ChatPayload | ReceiptPayload | CallPayload | EpochAckPayload | EpochRequestPayload;
}
function validateRotation(conversation: MessagingData['conversations'][string], peer: string) {
  const rotation = conversation.rotation!;
  shape(rotation, ['updatedAt', 'messages', 'cycle', 'received', 'receipts'], ['pending', 'failed', 'request']);
  if (!conversation.state || !sessionSupportsEpochUpdates(conversation.state) || !date(rotation.updatedAt) ||
      !Number.isSafeInteger(rotation.messages) || rotation.messages < 0 || rotation.messages > 1000000 ||
      typeof rotation.cycle !== 'boolean' || (rotation.failed !== undefined && rotation.failed !== true) ||
      !Array.isArray(rotation.received) || rotation.received.length > 4 ||
      !Array.isArray(rotation.receipts) || rotation.receipts.length > 500 ||
      new Set(rotation.receipts).size !== rotation.receipts.length || rotation.receipts.some(id => !validId(id))) {
    throw new Error('Invalid saved key-update controls.');
  }
  const own = sessionContext(conversation.state).self.slice(7), currentEpoch = sessionEpoch(conversation.state);
  const validateControl = (envelope: MailEnvelope, type: Wire['type']) => {
    validateMailEnvelope(envelope, peer, envelope.createdAt);
    const wire = decodeWire(envelope.ciphertext);
    if (envelope.sender !== own || wire.type !== type || wire.type === 'welcome' || wire.groupId !== conversation.groupId) {
      throw new Error('Invalid saved key-update envelope.');
    }
    return wire;
  };
  if (rotation.pending) {
    shape(rotation.pending, ['epoch', 'commitId', 'envelope']);
    const wire = validateControl(rotation.pending.envelope, 'epoch');
    if (!rotation.cycle || rotation.pending.epoch !== currentEpoch || !validKey(rotation.pending.commitId) ||
        rotation.pending.commitId !== epochCommitId(wire.body) || messageEpoch(wire.body) + 1 !== currentEpoch) {
      throw new Error('Invalid pending MLS key update.');
    }
  }
  if (rotation.request) {
    const wire = validateControl(rotation.request, 'epoch-request');
    if (!rotation.cycle || rotation.pending || currentEpoch % 2 !== 1 || canUpdateEpoch(conversation.state) || messageEpoch(wire.body) !== currentEpoch) {
      throw new Error('Invalid saved key-update request.');
    }
  }
  const ids = new Set<string>();
  for (const received of rotation.received) {
    shape(received, ['epoch', 'commitId', 'ack']);
    const wire = validateControl(received.ack, 'epoch-ack');
    if (!Number.isSafeInteger(received.epoch) || received.epoch < 2 || received.epoch > currentEpoch ||
        !validKey(received.commitId) || ids.has(received.commitId) || messageEpoch(wire.body) !== received.epoch) {
      throw new Error('Invalid saved key-update acknowledgement.');
    }
    ids.add(received.commitId);
  }
}
function rotationFor(conversation: MessagingData['conversations'][string], now: number): EpochRotation | undefined {
  if (!conversation.state || !sessionSupportsEpochUpdates(conversation.state)) return undefined;
  return conversation.rotation ??= { updatedAt: now, messages: 0, cycle: false, received: [], receipts: [] };
}
function rotationBlocked(conversation: MessagingData['conversations'][string]): boolean {
  return !!(conversation.rotation?.cycle || conversation.rotation?.pending || conversation.rotation?.failed);
}
function prune(data: MessagingData, now: number) {
  if (data.nearby) pruneNearbyStore(data.nearby, now);
  data.seen = data.seen.filter(item => item.expiresAt > now);
  data.packages = data.packages.filter(item => item.package.expiresAt > now);
  for (const conversation of Object.values(data.conversations)) {
    if (conversation.rotation) {
      conversation.rotation.received = conversation.rotation.received.filter(item => item.ack.expiresAt > now);
      if ((conversation.rotation.pending && conversation.rotation.pending.envelope.expiresAt <= now) ||
          (conversation.rotation.request && conversation.rotation.request.expiresAt <= now)) conversation.rotation.failed = true;
    }
    if (conversation.callInvite && (conversation.callInvite.createdAt + CALL_SIGNAL_TTL <= now
      || (conversation.setupExpiresAt ?? 0) <= now)) delete conversation.callInvite;
  }
  for (const conversation of Object.values(data.conversations)) if (conversation.retiredGroups) {
    conversation.retiredGroups = conversation.retiredGroups.filter(item => item.expiresAt > now);
    if (!conversation.retiredGroups.length) delete conversation.retiredGroups;
  }
  for (const conversation of Object.values(data.conversations)) for (const message of conversation.messages) {
    if (message.mine && message.status !== 'delivered' && message.error !== 'Chat reconnected; send this message again' && message.error !== 'Friend removed; message cancelled'
      && (message.expiresAt ?? message.createdAt + TTL) <= now) message.error = 'Expired before delivery';
  }
  const expiredSetups = new Set(Object.entries(data.conversations)
    .filter(([, conversation]) => conversation.setupExpiresAt !== undefined && conversation.setupExpiresAt <= now)
    .map(([peer]) => peer));
  for (const peer of expiredSetups) for (const message of data.conversations[peer].messages) {
    if (message.mine && message.status !== 'delivered') message.error = 'Expired before delivery';
  }
  for (const pending of data.pending) if (pending.expiresAt <= now) {
    const row = data.conversations[pending.peer]?.messages.find(item => item.mine && item.id === pending.messageId);
    if (row) row.error = 'Expired before delivery';
  }
  data.pending = data.pending.filter(item => item.expiresAt > now && !expiredSetups.has(item.peer));
  for (const item of data.outbox) if (item.envelope.expiresAt <= now && item.messageId !== null) {
    const row = data.conversations[item.envelope.recipient]?.messages.find(message => message.mine && message.id === item.messageId);
    if (row) row.error = 'Expired before delivery';
  }
  data.outbox = data.outbox.filter(item => item.envelope.expiresAt > now && !expiredSetups.has(item.envelope.recipient));
}
function messageCount(data: MessagingData): number {
  return Object.values(data.conversations).reduce((count, item) => count + item.messages.length, 0);
}
function requireContact(peer: string, contacts: { publicKey: string }[]) {
  if (!validKey(peer) || !contacts.some(contact => contact.publicKey === peer)) throw new Error('Add this friend using their invitation before messaging.');
}
function validateOwner(data: MessagingData, signer: MailSigner) {
  if (!validKey(signer.publicKey) || data.packages.some(item => item.package.owner !== signer.publicKey)
    || data.admission?.peers.includes(signer.publicKey)
    || data.outbox.some(item => item.envelope.sender !== signer.publicKey)
    || data.nearby?.packages.some(item => item.owner !== signer.publicKey)
    || data.nearby?.inbox.some(item => item.recipient !== signer.publicKey)
    || Object.entries(data.conversations).some(([peer, item]) => peer === signer.publicKey
      || (item.state !== '' && sessionContext(item.state).self !== identity(signer.publicKey)))) throw new Error('Messaging data belongs to a different identity.');
}
const runtimeCheck = async () => {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('Initialize the platform encryption runtime before messaging.');
  }
};

export class Messenger {
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private port: MessagingPort;
  private randomBytes: (length: number) => Promise<Uint8Array>;
  private now: () => number;
  private fetcher: typeof fetch;
  private ensureCrypto: () => Promise<void>;
  private nearby: DeliveryTransport | null = null;
  private activeTransport: DeliveryTransport | null = null;
  private wakeTransport: MailboxClient | null = null;
  private callConfigTransport: MailboxClient | null = null;
  private callNetworkCache: { endpoint: string; expiresAt: number; value: CallNetwork } | null = null;
  private callListeners = new Set<(peer: string, signal: CallSignal) => void>();
  private receivedBatchSize = 0;
  get lastReceivedBatchSize(): number { return this.receivedBatchSize; }
  subscribeCalls = (listener: (peer: string, signal: CallSignal) => void) => {
    this.callListeners.add(listener); return () => { this.callListeners.delete(listener); };
  };
  private invalidate(): void { this.revision += 1; this.activeTransport?.cancel?.(); this.wakeTransport?.cancel(); this.callConfigTransport?.cancel(); this.activeTransport = null; this.wakeTransport = null; this.callConfigTransport = null; this.callNetworkCache = null; }
  /** Lock/background revokes network jobs without changing encrypted delivery preferences. */
  suspend(): void { this.invalidate(); }
  constructor(port: MessagingPort, randomBytes: (length: number) => Promise<Uint8Array>,
    now: () => number = Date.now, fetcher: typeof fetch = fetch,
    ensureCrypto: () => Promise<void> = runtimeCheck) {
    this.port = port; this.randomBytes = randomBytes; this.now = now;
    this.fetcher = fetcher; this.ensureCrypto = ensureCrypto;
  }
  private operation<T>(task: (token: number) => Promise<T>): Promise<T> {
    const token = this.revision, result = this.queue.then(() => { this.current(token); return task(token); });
    this.queue = result.catch(() => {}); return result;
  }
  private current(token: number) {
    if (token !== this.revision) throw new Error('Messaging was disconnected. Pending messages remain saved.');
  }
  private async id(bytes = 16): Promise<string> {
    const generated = await this.randomBytes(bytes);
    if (!(generated instanceof Uint8Array) || generated.length !== bytes) throw new Error('Secure random generation failed.');
    return bytesToHex(generated);
  }
  private transaction<T>(token: number, task: (data: MessagingData, signer: MailSigner,
    contacts: { publicKey: string; name: string }[]) => Promise<T>): Promise<T> {
    this.current(token);
    return this.port.transact(async (serialized, signer, contacts) => {
      this.current(token);
      const data = decodeMessaging(serialized);
      validateOwner(data, signer);
      // The mailbox challenge is an asynchronous boundary. A retained signer
      // must recheck Pause/Disconnect immediately before signing its response.
      const boundSigner: MailSigner = { publicKey: signer.publicKey, sign: message => {
        this.current(token); return signer.sign(message);
      } };
      const result = await task(data, boundSigner, contacts);
      this.current(token);
      return { state: encodeMessaging(data), result };
    });
  }
  async notificationRequest(action: 'push-config' | 'push-register' | 'push-unregister', payload: unknown): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot(this.revision);
    if (!snapshot.data.enabled || snapshot.data.policy === 'nearby-only' || !snapshot.data.endpoint) throw new Error('Connect an internet mailbox to configure push delivery.');
    return new MailboxClient(snapshot.data.endpoint, this.fetcher, this.now).request(action, payload, snapshot.signer);
  }
  async view(): Promise<MessagingView> {
    return this.port.transact(async (serialized, signer) => {
      const data = decodeMessaging(serialized); validateOwner(data, signer);
      const conversations = Object.fromEntries(Object.entries(data.conversations)
        .map(([peer, conversation]) => [peer, { messages: conversation.messages.filter(message => message.kind !== 'group').map(message => ({ ...message })),
          security: !conversation.state ? 'ready' as const : !sessionSupportsEpochUpdates(conversation.state) ? 'legacy' as const
            : conversation.rotation?.failed ? 'blocked' as const : rotationBlocked(conversation) ? 'refreshing' as const : 'ready' as const }]));
      const queued = data.pending.length + data.outbox.filter(item => item.messageId !== null).length;
      return { state: serialized ?? encodeMessaging(data), result: { endpoint: data.endpoint, enabled: data.enabled, policy: data.policy ?? 'automatic', conversations, queued, groups: this.groupViews(data, signer.publicKey) } };
    });
  }
  private groupViews(data: MessagingData, self: string): NonNullable<MessagingView['groups']> {
    return Object.fromEntries(Object.entries(data.groups ?? {}).map(([id, record]) => {
      const rows = new Map<string, ChatMessage & { sender: string }>();
      if (record.status === 'joined') for (const [peer, conversation] of Object.entries(data.conversations)) for (const message of conversation.messages) {
        if (message.kind !== 'group') continue;
        const packet = readGroupPacket(message.content);
        if (packet.group.id !== id || packet.event !== 'message') continue;
        const sender = message.mine ? self : peer, key = sender + ':' + message.id;
        const row = rows.get(key);
        if (!row) rows.set(key, { ...message, content: packet.text, kind: packet.kind, sender });
        else if (message.mine) {
          const rank = { queued: 0, stored: 1, delivered: 2 };
          if (rank[message.status] < rank[row.status]) row.status = message.status;
          if (message.error) row.error = message.error;
        }
      }
      return [id, { ...record, descriptor: { ...record.descriptor, members: record.descriptor.members.map(member => ({ ...member })) }, departed: [...record.departed], messages: [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }];
    }));
  }
  private queueGroup(data: MessagingData, self: string, contacts: { publicKey: string }[], packet: GroupPacket, id: string, createdAt: number) {
    const content = JSON.stringify(packet);
    if (!contentValid('group', content) || textEncoder.encode(JSON.stringify({ version: 1, type: 'chat', id, kind: 'group', content, createdAt })).length > MAX_MESSAGE_BYTES) throw new Error('Group message is too long.');
    const peers = packet.group.members.filter(m => m.publicKey !== self && (packet.event !== 'leave' || contacts.some(c => c.publicKey === m.publicKey)) && (packet.event !== 'message' || !data.groups?.[packet.group.id]?.departed.includes(m.publicKey)));
    if (messageCount(data) + peers.length > 500) throw new Error('Chat storage is full.');
    for (const member of peers) {
      requireContact(member.publicKey, contacts);
      if (!data.conversations[member.publicKey]) {
        if (Object.keys(data.conversations).length >= 10) throw new Error('Conversation storage is full.');
        data.conversations[member.publicKey] = { state: '', groupId: '', messages: [] };
      }
      const conversation = data.conversations[member.publicKey];
      if (conversation.messages.some(m => m.mine && m.id === id)) continue;
      conversation.messages.push({ id, content, kind: 'group', mine: true, createdAt, expiresAt: createdAt + TTL, status: 'queued' });
      data.pending.push({ peer: member.publicKey, messageId: id, envelopeId: bytesToHex(sha256(textEncoder.encode('common/group-envelope/v1:' + id + ':' + member.publicKey))).slice(0, 32), expiresAt: createdAt + TTL });
    }
  }
  createGroup(name: string, peers: string[], selfName: string): Promise<string> {
    const token = this.revision;
    return this.transaction(token, async (data, signer, contacts) => {
      if ((Object.keys(data.groups ?? {}).length) >= MAX_GROUPS) throw new Error('The current group limit is five.');
      if (new Set(peers).size !== peers.length || peers.includes(signer.publicKey)) throw new Error('Choose different friends.');
      const members = [{ publicKey: signer.publicKey, name: selfName }, ...peers.map(peer => { requireContact(peer, contacts); return { publicKey: peer, name: contacts.find(c => c.publicKey === peer)!.name }; })];
      const descriptor = createGroupDescriptor(await this.id(), name, members, this.now(), signer);
      data.groups ??= {}; data.groups[descriptor.id] = { descriptor, status: 'joined', departed: [] };
      this.queueGroup(data, signer.publicKey, contacts, { group: descriptor, event: 'invite', kind: 'text', text: '' }, await this.id(), this.now());
      return descriptor.id;
    });
  }
  answerGroup(id: string, join: boolean): Promise<void> {
    const token = this.revision;
    return this.transaction(token, async (data, signer, contacts) => {
      const group = data.groups?.[id];
      if (!group || group.status === 'left') throw new Error('This invitation is no longer available.');
      if (join && group.status !== 'invited') return;
      this.queueGroup(data, signer.publicKey, contacts, { group: group.descriptor, event: join ? 'accept' : 'leave', kind: 'text', text: '' }, await this.id(), this.now());
      group.status = join ? 'joined' : 'left';
      if (!join && !group.departed.includes(signer.publicKey)) group.departed.push(signer.publicKey);
    });
  }
  sendGroup(id: string, content: string, kind: 'text' | 'sticker' = 'text', requestId?: string): Promise<void> {
    const token = this.revision;
    return this.transaction(token, async (data, signer, contacts) => {
      const group = data.groups?.[id];
      if (!group || group.status !== 'joined' || group.departed.includes(signer.publicKey)) throw new Error('Join this group before sending.');
      if (!contentValid(kind, content)) throw new Error('Invalid group message.');
      if (requestId !== undefined && !validId(requestId)) throw new Error('Invalid reply ID.');
      this.queueGroup(data, signer.publicKey, contacts, { group: group.descriptor, event: 'message', kind, text: content }, requestId ?? await this.id(), this.now());
    });
  }
  /** Changing routes revokes retained signing capabilities before any next request. */
  attachNearby(transport: DeliveryTransport | null): void {
    if (this.nearby === transport) return;
    this.invalidate(); this.nearby = transport;
  }
  setPolicy(policy: DeliveryPolicy): Promise<void> {
    if (policy !== 'automatic' && policy !== 'nearby-only') return Promise.reject(new Error('Invalid connection preference.'));
    this.invalidate();
    return this.operation(async token => {
      await this.transaction(token, async data => { data.policy = policy; if (policy === 'nearby-only') data.enabled = true; });
    });
  }
  connect(endpoint: string): Promise<void> {
    const address = mailboxURL(endpoint);
    return this.operation(async token => {
      await this.ensureCrypto(); this.current(token);
      await this.transaction(token, async data => {
        if (data.endpoint && data.endpoint !== address && (Object.keys(data.conversations).length || data.outbox.length || data.packages.length)) {
          throw new Error('Changing a mailbox with saved sessions is not supported yet. Reconnect to the existing mailbox.');
        }
        data.endpoint = address; data.enabled = true; prune(data, this.now());
      });
      await this.synchronize(token);
    });
  }
  disconnect(): Promise<void> {
    this.invalidate();
    return this.operation(async token => {
      await this.transaction(token, async data => { data.enabled = false; });
    });
  }
  reconnect(peer: string): Promise<void> {
    // Explicit user recovery invalidates in-flight operations using the old
    // session. No network Welcome is allowed to replace a saved session.
    this.invalidate();
    return this.operation(async token => {
      await this.transaction(token, async (data, _signer, contacts) => {
        prune(data, this.now()); requireContact(peer, contacts);
        const conversation = data.conversations[peer];
        if (!conversation) return;
        if (conversation.groupId && !conversation.retiredGroups?.some(item => item.groupId === conversation.groupId)) {
          conversation.retiredGroups ??= [];
          if (conversation.retiredGroups.length >= 16) throw new Error('Recent reconnection records are full. Wait for them to expire before reconnecting again.');
          conversation.retiredGroups.push({ groupId: conversation.groupId, expiresAt: this.now() + TTL + 60000 });
        }
        for (const message of conversation.messages) if (message.mine && message.status !== 'delivered') {
          message.error = 'Chat reconnected; send this message again';
        }
        conversation.state = ''; conversation.groupId = ''; delete conversation.setupExpiresAt; delete conversation.callInvite; delete conversation.rotation;
        data.pending = data.pending.filter(item => item.peer !== peer);
        data.outbox = data.outbox.filter(item => item.envelope.recipient !== peer);
      });
    });
  }
  send(peer: string, content: string, kind: 'text' | 'sticker' = 'text', requestId?: string): Promise<void> {
    // Local queue writes use the vault's transaction serializer rather than
    // waiting behind the network operation queue. Typing/sending can continue
    // while a poll is awaiting its HTTP response.
    const token = this.revision;
    return (async () => {
      this.current(token);
      if (requestId !== undefined && !validId(requestId)) throw new Error('Invalid reply ID.');
      const id = requestId ?? await this.id(), createdAt = this.now(); this.current(token);
      const payload: ChatPayload = { version: 1, type: 'chat', id, kind, content, createdAt };
      if (!contentValid(kind, content) || textEncoder.encode(JSON.stringify(payload)).length > MAX_MESSAGE_BYTES) {
        throw new Error('Messages are limited to 8 KiB including metadata. Choose a valid custom sticker for sticker messages.');
      }
      await this.transaction(token, async (data, signer, contacts) => {
        prune(data, this.now()); requireContact(peer, contacts);
        if (peer === signer.publicKey) throw new Error('Choose another friend.');
        if (!data.conversations[peer]) {
          if (Object.keys(data.conversations).length >= 10) throw new Error('The development conversation limit is 10 friends.');
          data.conversations[peer] = { state: '', groupId: '', messages: [] };
        }
        if (data.conversations[peer].messages.some(m => m.mine && m.id === id)) return;
        if (messageCount(data) >= 500) throw new Error('The development chat history limit is 500 messages.');
        data.conversations[peer].messages.push({ id, content, mine: true, kind, createdAt, expiresAt: createdAt + TTL, status: 'queued' });
        data.pending.push({ peer, messageId: id, expiresAt: createdAt + TTL });
      });
      // Send returns after durable queueing. The UI controls background Sync;
      // explicit Sync reports transport failures without discarding the queue.
    })();
  }
  sync(): Promise<void> { return this.operation(token => this.synchronize(token)); }
  /** Wait is separate from sync so an open long poll never blocks Send. */
  async waitForMail(): Promise<boolean> {
    const token = this.revision, snapshot = await this.snapshot(token);
    if (!snapshot.data.enabled || this.nearby || snapshot.data.policy === 'nearby-only' || !snapshot.data.endpoint) return false;
    const client = new MailboxClient(snapshot.data.endpoint, this.fetcher, this.now);
    this.wakeTransport?.cancel(); this.wakeTransport = client;
    try { const ready = await client.wait(snapshot.signer); this.current(token); return ready; }
    finally { if (this.wakeTransport === client) this.wakeTransport = null; }
  }
  cancelWait(): void { this.wakeTransport?.cancel(); this.wakeTransport = null; }
  async callNetwork(refresh = false): Promise<CallNetwork> {
    const token = this.revision, snapshot = await this.snapshot(token);
    if (!snapshot.data.enabled) throw new Error('Resume delivery before calling.');
    if (snapshot.data.policy === 'nearby-only') {
      if (!this.nearby) throw new Error('Connect your friend over local Wi-Fi before calling.');
      return { iceServers: [], localOnly: true };
    }
    if (!snapshot.data.endpoint) {
      if (this.nearby) return { iceServers: [], localOnly: true };
      throw new Error('Connect a mailbox before calling.');
    }
    if (!refresh && this.callNetworkCache?.endpoint === snapshot.data.endpoint && this.callNetworkCache.expiresAt > this.now() + 5_000) return this.callNetworkCache.value;
    const client = new MailboxClient(snapshot.data.endpoint, this.fetcher, this.now);
    this.callConfigTransport?.cancel(); this.callConfigTransport = client;
    try {
      const configuration = await client.callConfiguration(snapshot.signer); this.current(token);
      const value = { iceServers: configuration.iceServers, localOnly: false, expiresAt: configuration.expiresAt };
      this.callNetworkCache = { endpoint: snapshot.data.endpoint, expiresAt: configuration.expiresAt, value };
      return value;
    } finally { if (this.callConfigTransport === client) this.callConfigTransport = null; }
  }
  /** Call signaling uses the accepted friend's MLS session, never plaintext SDP. */
  sendCall(peer: string, signal: CallSignal): Promise<void> {
    validateCallSignal(signal, this.now());
    return this.operation(async token => {
      await this.ensureCrypto(); this.current(token);
      const snapshot = await this.snapshot(token);
      requireContact(peer, snapshot.contacts);
      if (!snapshot.data.enabled) throw new Error('Resume message delivery before calling.');
      if (!this.nearby && snapshot.data.policy === 'nearby-only') throw new Error('Connect over local Wi-Fi before calling in Nearby only mode.');
      if (!this.nearby && !snapshot.data.endpoint) throw new Error('Connect a mailbox before calling.');
      const client = this.nearby ?? new MailboxClient(snapshot.data.endpoint, this.fetcher, this.now);
      this.activeTransport = client;
      try {
        await this.admit(token, client);
        // Do not create a second session if a Welcome is already waiting.
        await this.incoming(token, client);
        // Calling directly (including a background action) must not bypass the
        // time-based key-renewal barrier between periodic chat syncs.
        await this.queueEpochRetries(token);
        await this.rotateKeys(token);
        await this.flush(token, client, new Set());
        const current = await this.snapshot(token);
        let remote: PublicPackage | undefined;
        if (!current.data.conversations[peer]?.state) remote = await client.claim(peer, current.signer);
        await this.transaction(token, async (data, signer, contacts) => {
          validateCallSignal(signal, this.now()); requireContact(peer, contacts); prune(data, this.now());
          let conversation = data.conversations[peer];
          if (!conversation) {
            if (Object.keys(data.conversations).length >= 10) throw new Error('Conversation storage is full.');
            conversation = data.conversations[peer] = { state: '', groupId: '', messages: [] };
          }
          if (!conversation.state) {
            if (!remote) throw new Error('Your friend needs to connect before the first call.');
            const started = await startSession(identity(signer.publicKey), identity(peer), remote.data, await this.randomBytes(32));
            conversation.state = started.state; conversation.groupId = started.groupId; rotationFor(conversation, this.now()); conversation.setupExpiresAt = remote.expiresAt;
            data.outbox.push({ envelope: await this.envelope(signer, peer,
              { type: 'welcome', packageId: remote.id, body: started.welcome }, await this.id(), remote.expiresAt), messageId: null });
          }
          if (!sessionSupportsEpochUpdates(conversation.state)) throw new Error('Reconnect this chat to upgrade its encryption before calling.');
          if (rotationBlocked(conversation)) throw new Error('Messaging keys are updating. Wait for your friend before calling.');
          const expiresAt = Math.min(signal.createdAt + CALL_SIGNAL_TTL, conversation.setupExpiresAt ?? Infinity);
          if (expiresAt <= this.now()) throw new Error('This call has expired. Start a new call.');
          if (signal.type === 'invite' && conversation.setupExpiresAt !== undefined && sessionInitiator(conversation.state) === identity(signer.publicKey)) {
            conversation.callInvite = { ...signal };
          } else if (signal.type === 'end' && conversation.callInvite?.callId === signal.callId) delete conversation.callInvite;
          const encrypted = await encryptMessage(conversation.state, textEncoder.encode(JSON.stringify({ version: 1, type: 'call', signal } satisfies CallPayload)));
          conversation.state = encrypted.state;
          data.outbox.push({ envelope: await this.envelope(signer, peer,
            { type: 'application', groupId: conversation.groupId, body: encrypted.ciphertext }, await this.id(), expiresAt), messageId: null });
        });
        const warning = await this.flush(token, client, new Set());
        if (warning) throw new Error(warning);
      } finally { if (this.activeTransport === client) this.activeTransport = null; }
    });
  }
  private async snapshot(token: number) {
    return this.transaction(token, async (data, signer, contacts) => {
      prune(data, this.now()); return { data, signer, contacts };
    });
  }
  private async envelope(signer: MailSigner, recipient: string, wire: Wire,
    id: string, expiresAt = this.now() + TTL): Promise<MailEnvelope> {
    const value = { version: 1 as const, id, sender: signer.publicKey, recipient,
      createdAt: this.now(), expiresAt, ciphertext: base64.encode(textEncoder.encode(JSON.stringify(wire))) };
    const envelope = { ...value, signature: signer.sign(envelopeBytes(value)) };
    validateMailEnvelope(envelope, recipient, this.now()); return envelope;
  }
  private async admit(token: number, client: DeliveryTransport): Promise<void> {
    if (!(client instanceof MailboxClient)) return;
    const request = await this.transaction(token, async (data, signer, contacts) => {
      if (data.endpoint !== client.endpoint || data.policy === 'nearby-only' || !data.enabled) throw new Error('Mailbox permission changed.');
      const peers = [...new Set(contacts.map(contact => contact.publicKey))].sort();
      const previous = data.admission;
      if (!previous || previous.endpoint !== client.endpoint || JSON.stringify(previous.peers) !== JSON.stringify(peers)) {
        const revision = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('Mailbox permission revision is exhausted.');
        data.admission = { peers, revision, endpoint: client.endpoint };
      }
      return { ...data.admission!, signer };
    });
    // Persist before sending, retry the exact revision. A concurrent worker's
    // newer contact revocation must never be overwritten by an older snapshot.
    this.current(token);
    await client.setAdmission(request.peers, request.revision, request.signer);
    this.current(token);
  }
  private async queueEpochRetries(token: number): Promise<void> {
    await this.transaction(token, async (data, _signer, contacts) => {
      prune(data, this.now());
      for (const [peer, conversation] of Object.entries(data.conversations)) {
        if (!contacts.some(contact => contact.publicKey === peer)) continue;
        const envelope = conversation.rotation?.pending?.envelope ?? conversation.rotation?.request;
        if (envelope && !conversation.rotation?.failed && !data.outbox.some(item => item.envelope.id === envelope.id)) {
          data.outbox.push({ envelope, messageId: null });
        }
      }
    });
  }
  private async rotateKeys(token: number): Promise<string | undefined> {
    return this.transaction(token, async (data, signer, contacts) => {
      prune(data, this.now());
      let warning: string | undefined;
      for (const [peer, conversation] of Object.entries(data.conversations)) {
        if (!contacts.some(contact => contact.publicKey === peer)) continue;
        const rotation = rotationFor(conversation, this.now());
        if (!rotation) continue;
        if (rotation.failed) { warning ??= 'The key update expired. Both friends need to reconnect this chat.'; continue; }
        if (conversation.setupExpiresAt !== undefined || rotation.pending) continue;
        if (rotation.messages >= MLS_ROTATION_MESSAGES || this.now() - rotation.updatedAt >= MLS_ROTATION_INTERVAL) rotation.cycle = true;
        if (rotation.cycle && canUpdateEpoch(conversation.state)) {
          // Previously encrypted messages/receipts must be published first.
          // They retain their exact bytes; only unsent plaintext waits here.
          // An already-durable epoch ACK may precede the response Commit in
          // this batch, so background delivery does not need another wakeup.
          if (data.outbox.some(item => item.envelope.recipient === peer && decodeWire(item.envelope.ciphertext).type !== 'epoch-ack')) continue;
          const update = await createEpochUpdate(conversation.state);
          const envelope = await this.envelope(signer, peer,
            { type: 'epoch', groupId: conversation.groupId, body: update.ciphertext }, await this.id());
          conversation.state = update.state;
          rotation.pending = { epoch: update.epoch, commitId: update.commitId, envelope };
          data.outbox.push({ envelope, messageId: null });
        }
        if (rotation.cycle && !rotation.pending && !rotation.request && !canUpdateEpoch(conversation.state) &&
            sessionEpoch(conversation.state) % 2 === 1 && !data.outbox.some(item => item.envelope.recipient === peer)) {
          const payload: EpochRequestPayload = { version: 1, type: 'epoch-request', epoch: sessionEpoch(conversation.state) };
          const encrypted = await encryptMessage(conversation.state, textEncoder.encode(JSON.stringify(payload)));
          conversation.state = encrypted.state;
          rotation.request = await this.envelope(signer, peer,
            { type: 'epoch-request', groupId: conversation.groupId, body: encrypted.ciphertext }, await this.id());
          data.outbox.push({ envelope: rotation.request, messageId: null });
        }
        if (!rotationBlocked(conversation) && rotation.receipts.length) {
          for (const messageId of rotation.receipts) {
            const encrypted = await encryptMessage(conversation.state,
              textEncoder.encode(JSON.stringify({ version: 1, type: 'receipt', messageId } satisfies ReceiptPayload)));
            conversation.state = encrypted.state;
            data.outbox.push({ envelope: await this.envelope(signer, peer,
              { type: 'application', groupId: conversation.groupId, body: encrypted.ciphertext }, await this.id()), messageId: null });
          }
          rotation.receipts = [];
        }
      }
      return warning;
    });
  }
  private async keyPool(token: number, client: DeliveryTransport, location: 'mailbox' | 'nearby'): Promise<string | undefined> {
    const snapshot = await this.snapshot(token);
    this.current(token);
    const available = new Set(await client.keyStatus(snapshot.signer));
    this.current(token);
    // Upgrade advertised public packages without deleting private material
    // needed by an already-claimed, in-flight legacy Welcome.
    const legacy = snapshot.data.packages.filter(item => (item.location ?? 'mailbox') === location &&
      JSON.parse(item.package.data).version !== 2).map(item => item.package.id);
    if (legacy.length && !client.retireKeys) throw new Error('This connection needs an update before it can replace older messaging keys.');
    for (let offset = 0; offset < legacy.length; offset += 100) {
      await client.retireKeys!(legacy.slice(offset, offset + 100), snapshot.signer); this.current(token);
    }
    for (const id of legacy) available.delete(id);

    const upload = await this.transaction(token, async (data, signer) => {
      prune(data, this.now());
      const routed = () => data.packages.filter(item => (item.location ?? 'mailbox') === location);
      if (available.size > 10 || [...available].some(id => !routed().some(item => item.package.id === id))) {
        throw new Error('The mailbox has messaging keys missing from this vault. Restore the matching vault before publishing more keys.');
      }
      for (const item of routed()) if (available.has(item.package.id) || legacy.includes(item.package.id)) item.published = true;
      let active = available.size + routed().filter(item => !item.published).length;
      let warning: string | undefined;
      while (active < 10) {
        const retained = routed().filter(item => item.published && !available.has(item.package.id)).length;
        if (retained > 100 || data.packages.length >= 110) {
          warning = 'The first-use key pool is full. Claimed private keys are retained until their Welcomes arrive or expire.';
          break;
        }
        const material = await createPackage(identity(signer.publicKey)), createdAt = this.now();
        const value = { id: await this.id(), owner: signer.publicKey, createdAt, expiresAt: createdAt + TTL, data: material.publicData };
        const signed = { ...value, signature: signer.sign(packageBytes(value)) };
        data.packages.push({ package: signed, privateData: material.privateData, published: false, location });
        active += 1;
      }
      return { signer, packages: routed().filter(item => !item.published).map(item => item.package), warning };
    });
    if (upload.packages.length) {
      this.current(token); await client.publishKeys(upload.packages, upload.signer); this.current(token);
      await this.transaction(token, async data => {
        for (const item of data.packages) if (upload.packages.some(candidate => candidate.id === item.package.id)) item.published = true;
      });
    }
    return upload.warning;
  }
  private async flush(token: number, client: DeliveryTransport, busyRecipients: Set<string>): Promise<string | undefined> {
    const snapshot = await this.snapshot(token);
    let warning: string | undefined;
    for (const item of snapshot.data.outbox) {
      this.current(token);
      if (item.envelope.expiresAt <= this.now() || busyRecipients.has(item.envelope.recipient)) continue;
      const current = await this.snapshot(token);
      if (!current.contacts.some(contact => contact.publicKey === item.envelope.recipient) ||
          !current.data.outbox.some(saved => saved.envelope.id === item.envelope.id && saved.envelope.sender === item.envelope.sender)) continue;
      try { await client.publish(item.envelope, current.signer); }
      catch (error) {
        if (!(error instanceof MailboxBackpressureError) && !(error instanceof MailboxAdmissionError)) throw error;
        warning ??= error.message; busyRecipients.add(item.envelope.recipient); continue;
      }
      this.current(token);
      await this.transaction(token, async data => {
        const found = data.outbox.find(entry => entry.envelope.id === item.envelope.id && entry.envelope.sender === item.envelope.sender);
        if (!found) return;
        if (found.messageId !== null) {
          const row = data.conversations[found.envelope.recipient]?.messages.find(message => message.mine && message.id === found.messageId);
          if (row && row.status !== 'delivered') row.status = 'stored';
        }
        data.outbox = data.outbox.filter(entry => entry !== found);
      });
    }
    return warning;
  }
  private async prepare(token: number, client: DeliveryTransport): Promise<string | undefined> {
    const snapshot = await this.snapshot(token);
    const blockedPeers = new Set<string>();
    let warning: string | undefined;
    // Established sessions progress without needing an unavailable friend's
    // first-use key package. Do those first, then claim for new conversations.
    const pendingMessages = [...snapshot.data.pending].sort((left, right) =>
      Number(Boolean(snapshot.data.conversations[right.peer]?.state)) - Number(Boolean(snapshot.data.conversations[left.peer]?.state)));
    for (const pending of pendingMessages) {
      this.current(token);
      if (blockedPeers.has(pending.peer)) continue;
      const current = await this.snapshot(token);
      if (!current.contacts.some(contact => contact.publicKey === pending.peer) ||
          !current.data.pending.some(item => item.peer === pending.peer && item.messageId === pending.messageId)) continue;
      let remote: PublicPackage | undefined;
      if (!snapshot.data.conversations[pending.peer]?.state) {
        try { remote = await client.claim(pending.peer, current.signer); }
        catch (error) {
          if (!(error instanceof NoKeyPackageError) && !(error instanceof MailboxAdmissionError)) throw error;
          warning ??= error.message; blockedPeers.add(pending.peer); continue;
        }
      }
      this.current(token);
      await this.transaction(token, async (data, signer, contacts) => {
        prune(data, this.now());
        if (!contacts.some(contact => contact.publicKey === pending.peer)) return;
        const saved = data.pending.find(item => item.peer === pending.peer && item.messageId === pending.messageId);
        if (!saved) return;
        const conversation = data.conversations[pending.peer];
        const message = conversation.messages.find(row => row.mine && row.id === pending.messageId);
        if (!message) throw new Error('The queued message is missing.');
        if (!conversation.state) {
          if (!remote) throw new Error('Messaging keys are unavailable. Your message stays queued.');
          const started = await startSession(identity(signer.publicKey), identity(pending.peer), remote.data, await this.randomBytes(32));
          conversation.state = started.state; conversation.groupId = started.groupId; rotationFor(conversation, this.now());
          // A Welcome cannot be processed after the recipient's one-use private
          // package expires, even when the transport envelope has a longer TTL.
          conversation.setupExpiresAt = remote.expiresAt;
          saved.expiresAt = Math.min(saved.expiresAt, conversation.setupExpiresAt);
          const welcome = await this.envelope(signer, pending.peer,
            { type: 'welcome', packageId: remote.id, body: started.welcome }, await this.id(), saved.expiresAt);
          data.outbox.push({ envelope: welcome, messageId: null });
        }
        if (conversation.setupExpiresAt !== undefined) {
          if (conversation.setupExpiresAt <= this.now()) {
            message.error = 'Expired before delivery';
            data.pending = data.pending.filter(item => item !== saved);
            warning ??= 'The conversation setup expired before your friend confirmed it. Both devices need to reconnect this chat.';
            return;
          }
          saved.expiresAt = Math.min(saved.expiresAt, conversation.setupExpiresAt);
        }
        if (!sessionSupportsEpochUpdates(conversation.state)) {
          warning ??= 'Reconnect this chat on both phones to upgrade its messaging encryption. Your history stays saved.'; return;
        }
        const dueRotation = rotationFor(conversation, this.now());
        if (dueRotation && conversation.setupExpiresAt === undefined && (dueRotation.messages >= MLS_ROTATION_MESSAGES || this.now() - dueRotation.updatedAt >= MLS_ROTATION_INTERVAL)) dueRotation.cycle = true;
        if (rotationBlocked(conversation)) {
          if (conversation.rotation?.failed) warning ??= 'The key update expired. Both friends need to reconnect this chat.';
          return;
        }
        const rotation = rotationFor(conversation, this.now());
        if (rotation) rotation.messages += 1;
        const encrypted = await encryptMessage(conversation.state, textEncoder.encode(JSON.stringify({
          version: 1, type: 'chat', id: message.id, kind: message.kind, content: message.content, createdAt: message.createdAt,
        } satisfies ChatPayload)));
        const envelope = await this.envelope(signer, pending.peer,
          { type: 'application', groupId: conversation.groupId, body: encrypted.ciphertext }, saved.envelopeId ?? message.id, saved.expiresAt);
        message.expiresAt = saved.expiresAt;
        conversation.state = encrypted.state; data.outbox.push({ envelope, messageId: message.id });
        data.pending = data.pending.filter(item => item !== saved);
      });
      // Re-read after every durable transition: several pending messages can
      // share a peer, and only the first one should claim/start a new session.
      snapshot.data = (await this.snapshot(token)).data;
    }
    return warning;
  }
  private async incoming(token: number, client: DeliveryTransport): Promise<string | undefined> {
    const initial = await this.snapshot(token);
    this.current(token); const received = await client.receive(initial.signer); this.current(token);
    this.receivedBatchSize = received.length;
    const acknowledgement: { sender: string; id: string }[] = [];
    let warning: string | undefined;
    const deferred: MailEnvelope[] = [];
    const accept = async (envelope: MailEnvelope): Promise<boolean> => {
      let call: CallSignal | undefined;
      const accepted = await this.transaction(token, async (data, signer, contacts) => {
      prune(data, this.now());
      // Validate again at the transaction boundary, including recipient binding.
      validateMailEnvelope(envelope, signer.publicKey, this.now());
      if (!contacts.some(contact => contact.publicKey === envelope.sender)) return true;
      const alreadySeen = data.seen.some(item => item.sender === envelope.sender && item.id === envelope.id);
      const remember = () => {
        if (alreadySeen) return;
        if (data.seen.length >= 8192) throw new Error('Received-message storage is full.');
        data.seen.push({ sender: envelope.sender, id: envelope.id, expiresAt: envelope.expiresAt });
      };
      let wire: Wire;
      try { wire = decodeWire(envelope.ciphertext); } catch { remember(); warning ??= 'An invalid message from a friend was rejected.'; return true; }
      let conversation = data.conversations[envelope.sender];
      if (wire.type === 'epoch' && conversation?.groupId === wire.groupId) {
        let id: string | undefined;
        try { id = epochCommitId(wire.body); } catch { /* Invalid commits use the rejection path below. */ }
        const received = conversation.rotation?.received.find(item => item.commitId === id);
        if (received) {
          if (!data.outbox.some(item => item.envelope.id === received.ack.id)) data.outbox.push({ envelope: received.ack, messageId: null });
          remember(); return true;
        }
      }
      if (alreadySeen) return true;
      if (wire.type === 'welcome') {
        let offeredGroup: unknown;
        try { offeredGroup = JSON.parse(wire.body).groupId; } catch { /* The engine validates any non-retired Welcome below. */ }
        if (conversation?.retiredGroups?.some(item => item.groupId === offeredGroup)) { remember(); return true; }
        const privatePackage = data.packages.find(item => item.package.id === wire.packageId && item.package.owner === signer.publicKey);
        if (!privatePackage) { remember(); warning ??= 'A welcome used missing or expired messaging keys.'; return true; }
        const competing = !!conversation?.state;
        // Arbitration is allowed only for an unconfirmed session we created.
        // Once authenticated peer traffic arrives, no Welcome may replace it.
        if (conversation?.state && (conversation.setupExpiresAt === undefined
          || sessionInitiator(conversation.state) !== identity(signer.publicKey))) {
          remember(); warning ??= 'An unexpected conversation setup was rejected.'; return true;
        }
        if (!conversation && Object.keys(data.conversations).length >= 10) throw new Error('The development conversation limit is 10 friends.');
        let joined: Awaited<ReturnType<typeof receiveWelcome>>;
        try { joined = await receiveWelcome(identity(signer.publicKey), identity(envelope.sender), wire.body, privatePackage.privateData); }
        catch { remember(); warning ??= 'An unauthenticated welcome was rejected.'; return true; }
          conversation ??= { state: '', groupId: '', messages: [] };
          if (competing) {
            // Both sides independently choose the lower public identity's
            // authenticated session. No new cryptography is introduced here.
            const keepLocal = signer.publicKey < envelope.sender;
            const retiredId = keepLocal ? joined.groupId : conversation.groupId;
            conversation.retiredGroups ??= [];
            if (conversation.retiredGroups.length >= 16) throw new Error('Too many competing sessions.');
            conversation.retiredGroups.push({ groupId: retiredId, expiresAt: this.now() + TTL + 60000 });
            data.packages = data.packages.filter(item => item !== privatePackage);
            if (keepLocal) { remember(); return true; }
            // Re-encrypt undelivered messages in the chosen session. Message
            // IDs remain stable for UI deduplication; new envelope IDs avoid
            // conflicting with ciphertext already stored by a relay.
            data.outbox = data.outbox.filter(item => item.envelope.recipient !== envelope.sender);
            data.pending = data.pending.filter(item => item.peer !== envelope.sender);
            for (const message of conversation.messages) {
              if (!message.mine || message.status === 'delivered' || message.error) continue;
              message.status = 'queued';
              data.pending.push({ peer: envelope.sender, messageId: message.id, envelopeId: await this.id(),
                expiresAt: message.expiresAt ?? message.createdAt + TTL });
            }
          }
          conversation.state = joined.state; conversation.groupId = joined.groupId; delete conversation.rotation; rotationFor(conversation, this.now());
          conversation.setupExpiresAt = Math.min(privatePackage.package.expiresAt, envelope.expiresAt);
          // An outgoing first call can race the peer's first message or call.
          // Re-encrypt its still-live invitation in the selected group, just
          // like queued chats, rather than silently dropping the call.
          const invite = conversation.callInvite;
          delete conversation.callInvite;
          if (invite && invite.createdAt + CALL_SIGNAL_TTL > this.now()) {
            const encrypted = await encryptMessage(conversation.state, textEncoder.encode(JSON.stringify({ version: 1, type: 'call', signal: invite } satisfies CallPayload)));
            conversation.state = encrypted.state;
            data.outbox.push({ envelope: await this.envelope(signer, envelope.sender,
              { type: 'application', groupId: conversation.groupId, body: encrypted.ciphertext }, await this.id(),
              Math.min(invite.createdAt + CALL_SIGNAL_TTL, conversation.setupExpiresAt)), messageId: null });
          }
          data.conversations[envelope.sender] = conversation;
          data.packages = data.packages.filter(item => item !== privatePackage);
        remember(); return true;
      }
      if (conversation?.retiredGroups?.some(item => item.groupId === wire.groupId)) { remember(); return true; }
      if (!conversation?.state) return false;
      if (conversation.groupId !== wire.groupId) {
        // An authenticated competing Welcome can arrive later in this batch
        // or the next one. Keep its application packet until arbitration.
        if (conversation.setupExpiresAt !== undefined && sessionInitiator(conversation.state) === identity(signer.publicKey)) return false;
        remember(); warning ??= 'A message for a different conversation was rejected.'; return true;
      }
      // The public epoch is only a routing hint. It never authenticates a
      // message or changes state; defer one future epoch for reordered commits.
      let wireEpoch: number;
      try { wireEpoch = messageEpoch(wire.body); }
      catch { remember(); warning ??= 'An invalid encrypted protocol packet was rejected.'; return true; }
      const currentEpoch = sessionEpoch(conversation.state);
      if (sessionSupportsEpochUpdates(conversation.state) && wireEpoch === currentEpoch + 1) return false;
      if (wire.type === 'epoch') {
        const rotation = rotationFor(conversation, this.now());
        if (!rotation || rotation.failed) { remember(); warning ??= 'Reconnect this chat to restore key updates.'; return true; }
        if (rotation.pending && wireEpoch === currentEpoch) return false;
        let update: Awaited<ReturnType<typeof receiveEpochUpdate>>;
        try { update = await receiveEpochUpdate(conversation.state, wire.body); }
        catch { remember(); warning ??= 'An unauthorized or conflicting key update was rejected.'; return true; }
        conversation.state = update.state;
        if (rotation.request) data.outbox = data.outbox.filter(item => item.envelope.id !== rotation.request!.id);
        delete rotation.request;
        delete conversation.setupExpiresAt;
        const ackPayload: EpochAckPayload = { version: 1, type: 'epoch-ack', epoch: update.epoch, commitId: update.commitId };
        const encrypted = await encryptMessage(conversation.state, textEncoder.encode(JSON.stringify(ackPayload)));
        conversation.state = encrypted.state;
        const ack = await this.envelope(signer, envelope.sender,
          { type: 'epoch-ack', groupId: conversation.groupId, body: encrypted.ciphertext }, await this.id());
        rotation.received = [...rotation.received, { epoch: update.epoch, commitId: update.commitId, ack }].slice(-4);
        rotation.cycle = update.epoch % 2 === 0;
        if (!rotation.cycle) { rotation.messages = 0; rotation.updatedAt = this.now(); }
        data.outbox.push({ envelope: ack, messageId: null });
        remember(); return true;
      }
      let opened: Awaited<ReturnType<typeof decryptMessage>>;
      try { opened = await decryptMessage(conversation.state, wire.body); }
      catch { remember(); warning ??= 'A message that failed encryption authentication was rejected.'; return true; }
      // Even authenticated malformed application data consumes its receiver
      // ratchet state. Persist that transition before acknowledging/discarding.
      conversation.state = opened.state;
      let payload: ChatPayload | ReceiptPayload | CallPayload | EpochAckPayload | EpochRequestPayload;
      try { payload = decodePayload(opened.plaintext, envelope); }
      catch { remember(); warning ??= 'Invalid encrypted message contents were rejected.'; return true; }
      if (wire.type === 'epoch-request' || payload.type === 'epoch-request') {
        if (wire.type !== 'epoch-request' || payload.type !== 'epoch-request' || payload.epoch !== wireEpoch ||
            payload.epoch !== sessionEpoch(conversation.state) || !canUpdateEpoch(conversation.state)) {
          remember(); warning ??= 'An unrelated key-update request was rejected.'; return true;
        }
        const rotation = rotationFor(conversation, this.now())!;
        rotation.cycle = true;
        delete conversation.setupExpiresAt;
        remember(); return true;
      }
      if (wire.type === 'epoch-ack' || payload.type === 'epoch-ack') {
        if (wire.type !== 'epoch-ack' || payload.type !== 'epoch-ack') { remember(); warning ??= 'Invalid key-update acknowledgement.'; return true; }
        const rotation = conversation.rotation, pending = rotation?.pending;
        if (!rotation || !pending || rotation.failed || payload.epoch !== pending.epoch ||
            payload.epoch !== wireEpoch || payload.commitId !== pending.commitId) {
          remember(); warning ??= 'An unrelated key-update acknowledgement was rejected.'; return true;
        }
        data.outbox = data.outbox.filter(item => item.envelope.id !== pending.envelope.id);
        delete rotation.pending;
        if (payload.epoch % 2 === 1) { rotation.cycle = false; rotation.messages = 0; rotation.updatedAt = this.now(); }
        remember(); return true;
      }
      // A valid peer application proves that this peer has the matching MLS
      // group state. Subsequent messages can use their normal delivery TTL.
      delete conversation.setupExpiresAt;
      delete conversation.callInvite;
      if (payload.type === 'call') {
        // Emit only after the receive ratchet and replay record commit. The
        // listener never receives a signer or the encrypted session state.
        if (payload.signal.createdAt + CALL_SIGNAL_TTL > this.now()) call = payload.signal;
      } else if (payload.type === 'receipt') {
        const message = conversation.messages.find(item => item.mine && item.id === payload.messageId);
        if (message) {
          message.status = 'delivered'; delete message.error;
          // A verified peer receipt is stronger evidence than an uncertain
          // publish response. Stop retrying that ciphertext if it is still in
          // the outbox; the state transition and cleanup are one durable write.
          data.outbox = data.outbox.filter(item => !(item.envelope.recipient === envelope.sender && item.messageId === payload.messageId));
          data.pending = data.pending.filter(item => !(item.peer === envelope.sender && item.messageId === payload.messageId));
        }
      } else {
        if (payload.kind === 'group') {
          const packet = readGroupPacket(payload.content), descriptor = packet.group;
          if (!descriptor.members.some(m => m.publicKey === signer.publicKey) || !descriptor.members.some(m => m.publicKey === envelope.sender) || descriptor.createdAt > envelope.createdAt + 60_000 || (packet.event === 'invite' && envelope.sender !== descriptor.owner)) { remember(); warning ??= 'An unauthorized group message was rejected.'; return true; }
          data.groups ??= {};
          let group = data.groups[descriptor.id];
          if (group && groupFingerprint(group.descriptor) !== groupFingerprint(descriptor)) { remember(); warning ??= 'A conflicting group invitation was rejected.'; return true; }
          if (!group) {
            if (Object.keys(data.groups).length >= MAX_GROUPS) { remember(); warning ??= 'Group storage is full. A group invitation could not be saved.'; return true; }
            group = data.groups[descriptor.id] = { descriptor, status: 'invited', departed: [] };
          }
          if (group.status === 'left' || group.departed.includes(envelope.sender)) { remember(); return true; }
          if (packet.event === 'leave' && !group.departed.includes(envelope.sender)) group.departed.push(envelope.sender);
        }
        if (!conversation.messages.some(item => !item.mine && item.id === payload.id)) {
          if (messageCount(data) >= 500) throw new Error('The development chat history limit is 500 messages.');
          conversation.messages.push({ id: payload.id, content: payload.content, kind: payload.kind, createdAt: payload.createdAt, mine: false, status: 'delivered' });
        }
        const rotation = rotationFor(conversation, this.now());
        if (rotation) rotation.messages += 1;
        if (rotationBlocked(conversation)) {
          if (!rotation!.receipts.includes(payload.id)) rotation!.receipts.push(payload.id);
          remember(); return true;
        }
        const receipt = await encryptMessage(conversation.state,
          textEncoder.encode(JSON.stringify({ version: 1, type: 'receipt', messageId: payload.id } satisfies ReceiptPayload)));
        conversation.state = receipt.state;
        data.outbox.push({ envelope: await this.envelope(signer, envelope.sender,
          { type: 'application', groupId: conversation.groupId, body: receipt.ciphertext }, await this.id()), messageId: null });
      }
      remember(); return true;
      });
      if (call) for (const listener of this.callListeners) {
        try { listener(envelope.sender, call); } catch { /* UI observers cannot undo durable receipt. */ }
      }
      return accepted;
    };
    for (const envelope of received) {
      if (await accept(envelope)) acknowledgement.push({ sender: envelope.sender, id: envelope.id });
      else deferred.push(envelope);
    }
    // A Welcome later in this same batch can unblock an earlier application.
    // If it is still unavailable, leave the message unacknowledged for next poll.
    for (const envelope of deferred) if (await accept(envelope)) acknowledgement.push({ sender: envelope.sender, id: envelope.id });
    if (acknowledgement.length) {
      this.current(token); await client.acknowledge(acknowledgement, initial.signer); this.current(token);
    }
    return warning;
  }
  private async synchronize(token: number): Promise<void> {
    this.receivedBatchSize = 0;
    await this.ensureCrypto(); this.current(token);
    const snapshot = await this.snapshot(token);
    if (!snapshot.data.enabled) throw new Error('Messaging is paused. Connect nearby or resume your mailbox before syncing.');
    const location = this.nearby ? 'nearby' : 'mailbox';
    if (!this.nearby && snapshot.data.policy === 'nearby-only') throw new Error('Nearby only is enabled. Connect your friend over local Wi-Fi or Bluetooth; your messages stay queued.');
    if (!this.nearby && !snapshot.data.endpoint) throw new Error('Connect a mailbox or a nearby friend before syncing.');
    // The nearby-only branch above exits before constructing any HTTP client.
    const client: DeliveryTransport = this.nearby ?? new MailboxClient(snapshot.data.endpoint, this.fetcher, this.now);
    this.activeTransport = client;
    try {
    await this.admit(token, client);
    const busyRecipients = new Set<string>();
    await this.queueEpochRetries(token);
    const firstFlushWarning = await this.flush(token, client, busyRecipients);
    const incomingWarning = await this.incoming(token, client);
    const poolWarning = await this.keyPool(token, client, location);
    const rotationWarning = await this.rotateKeys(token);
    const prepareWarning = await this.prepare(token, client);
    const flushWarning = await this.flush(token, client, busyRecipients);
    const remaining = await this.snapshot(token);
    const busyWarning = remaining.data.outbox.some(item => busyRecipients.has(item.envelope.recipient))
      ? firstFlushWarning ?? flushWarning : undefined;
    const setupWarning = Object.values(remaining.data.conversations).some(conversation =>
      conversation.setupExpiresAt !== undefined && conversation.setupExpiresAt <= this.now())
      ? 'The initial chat setup expired. Both devices need to reconnect this chat, then one friend sends first.' : undefined;
    const warning = incomingWarning ?? rotationWarning ?? prepareWarning ?? busyWarning ?? poolWarning ?? setupWarning;
    if (warning) throw new Error(warning);
    } finally { if (this.activeTransport === client) this.activeTransport = null; }
  }
}
