import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import type {
  ClientConfig,
  ClientState,
  Credential,
  Decoder,
  KeyPackage,
  PrivateKeyPackage,
  CiphersuiteImpl,
} from 'ts-mls';
import { createApplicationMessage } from 'ts-mls/createMessage.js';
import { createCommit } from 'ts-mls/createCommit.js';
import { createGroup, joinGroup, encodeGroupState, decodeGroupState } from 'ts-mls/clientState.js';
import { decodeMlsMessage, encodeMlsMessage } from 'ts-mls/message.js';
import { emptyPskIndex } from 'ts-mls/pskIndex.js';
import { processPrivateMessage } from 'ts-mls/processMessages.js';
import { getCiphersuiteFromName } from 'ts-mls/crypto/ciphersuite.js';
import { makeGenericHpke } from 'ts-mls/crypto/implementation/hpke.js';
import { makeKdfImpl } from 'ts-mls/crypto/implementation/default/makeKdfImpl.js';
import { makeHashImpl } from 'ts-mls/crypto/implementation/default/makeHashImpl.js';
import { defaultRng } from 'ts-mls/crypto/implementation/default/rng.js';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { generateKeyPackage, verifyKeyPackage } from 'ts-mls/keyPackage.js';
import { verifyLeafNodeSignatureKeyPackage } from 'ts-mls/leafNode.js';
import { decryptSenderData } from 'ts-mls/privateMessage.js';

// RFC 9420 suite 1. The crypto provider must be initialized before calling this
// module on native platforms. No plaintext or MLS private state may be logged.
const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const MAX_PACKAGE = 16_384;
const MAX_WELCOME = 65_536;
const MAX_STATE = 262_144;
const MAX_CIPHERTEXT = 32_768;
// A bounded delivery window, never old HPKE private paths or old init secrets.
export const RETAINED_MLS_EPOCHS = 2;
const MAX_EPOCH = BigInt(Number.MAX_SAFE_INTEGER);
export const MAX_MESSAGE_BYTES = 8_192;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// Select only standard suite 1 rather than importing the library's optional
// post-quantum/other-suite factories into every mobile bundle. These are the
// library's HPKE/KDF/hash adapters, @hpke/core's AES/X25519 and noble's Ed25519;
// all MLS and HPKE protocol operations remain in the upstream libraries.
async function getSuite(): Promise<CiphersuiteImpl> {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('This device does not have the required cryptography runtime.');
  }
  const suite = getCiphersuiteFromName(SUITE);
  const aead = new Aes128Gcm();
  const hpke = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead,
  });
  return {
    name: SUITE,
    rng: defaultRng,
    hash: makeHashImpl(globalThis.crypto.subtle, 'SHA-256'),
    kdf: makeKdfImpl(new HkdfSha256()),
    signature: {
      async sign(key, message) { return ed25519.sign(message, key); },
      async verify(key, message, signature) { return ed25519.verify(signature, message, key, { zip215: false }); },
      async keygen() {
        const signKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
        return { signKey, publicKey: ed25519.getPublicKey(signKey) };
      },
    },
    hpke: await makeGenericHpke(suite.hpke, {
      async encrypt(key, nonce, aad, plaintext) {
        return new Uint8Array(await aead.createEncryptionContext(key).seal(nonce, plaintext, aad));
      },
      async decrypt(key, nonce, aad, ciphertext) {
        return new Uint8Array(await aead.createEncryptionContext(key).open(nonce, ciphertext, aad));
      },
    }, hpke),
  };
}

type PublicData = { version: 1 | 2; message: string };
type PrivateData = {
  version: 1 | 2;
  identity: string;
  publicData: string;
  initPrivateKey: string;
  hpkePrivateKey: string;
  signaturePrivateKey: string;
};
type WelcomeData = { version: 1 | 2; groupId: string; peerSignatureKey: string; message: string };
type StateData = {
  version: 1 | 2;
  self: string;
  peer: string;
  groupId: string;
  selfSignatureKey: string;
  peerSignatureKey: string;
  bytes: string;
};

function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^common:[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid LinkUp identity.');
  }
}

function conversation(self: string, peer: string) {
  identity(self);
  identity(peer);
  if (self === peer) throw new Error('A conversation needs two different identities.');
}

function hex(value: unknown, maxBytes: number, exactBytes?: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2 ||
      value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value) ||
      (exactBytes !== undefined && value.length !== exactBytes * 2)) {
    throw new Error('Invalid MLS encoded data.');
  }
  return hexToBytes(value);
}

// Our JSON envelope is canonical too: this rejects duplicate keys, extra keys,
// alternate encodings and oversized input before any MLS decoder is invoked.
function object(text: string, max: number, keys: string[], versions: readonly number[] = [1]): Record<string, unknown> {
  if (typeof text !== 'string' || text.length > max) throw new Error('MLS data is too large.');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(value) !== text ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('Invalid MLS data.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'number' || !versions.includes(record.version)) throw new Error('Unsupported MLS data version.');
  return record;
}

function complete<T>(decode: Decoder<T>, bytes: Uint8Array): T {
  const result = decode(bytes, 0);
  if (!result || result[1] !== bytes.length) throw new Error('Invalid or trailing MLS bytes.');
  return result[0];
}

function credentialIdentity(credential: Credential): string {
  if (credential.credentialType !== 'basic') throw new Error('Only LinkUp basic credentials are supported.');
  const name = decoder.decode(credential.identity);
  identity(name);
  return name;
}

function config(self: string, peer: string, selfKey: string, peerKey: string): ClientConfig {
  conversation(self, peer);
  hex(selfKey, 32, 32);
  hex(peerKey, 32, 32);
  return {
    ...defaultClientConfig,
    // Bound the memory/work needed to process out-of-order offline messages.
    keyRetentionConfig: { retainKeysForGenerations: 128, retainKeysForEpochs: RETAINED_MLS_EPOCHS, maximumForwardRatchetSteps: 200 },
    authService: {
      async validateCredential(credential, signaturePublicKey) {
        try {
          const name = credentialIdentity(credential);
          const expected = name === self ? selfKey : name === peer ? peerKey : undefined;
          return expected !== undefined && bytesToHex(signaturePublicKey) === expected;
        } catch {
          return false;
        }
      },
    },
  };
}

async function packageFrom(identityName: string, publicData: string): Promise<KeyPackage> {
  identity(identityName);
  const value = object(publicData, MAX_PACKAGE, ['version', 'message'], [1, 2]);
  const decoded = complete(decodeMlsMessage, hex(value.message, MAX_PACKAGE / 2));
  if (decoded.version !== 'mls10' || decoded.wireformat !== 'mls_key_package') {
    throw new Error('Expected an MLS key package.');
  }
  const kp = decoded.keyPackage;
  if (kp.version !== 'mls10' || kp.cipherSuite !== SUITE ||
      credentialIdentity(kp.leafNode.credential) !== identityName ||
      kp.leafNode.signaturePublicKey.length !== 32 || kp.initKey.length !== 32 ||
      kp.leafNode.hpkePublicKey.length !== 32 || kp.extensions.length !== 0 ||
      kp.leafNode.extensions.length !== 0) {
    throw new Error('The MLS package does not match this friend.');
  }
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (kp.leafNode.lifetime.notBefore > now || kp.leafNode.lifetime.notAfter <= now) {
    throw new Error('The MLS key package has expired or is not yet valid.');
  }
  const suite = await getSuite();
  if (!await verifyKeyPackage(kp, suite.signature) ||
      !await verifyLeafNodeSignatureKeyPackage(kp.leafNode, suite.signature)) {
    throw new Error('The MLS key package signature is invalid.');
  }
  return kp;
}

/** Validate before the controller accepts/publishes an outer identity-signed package. */
export async function validatePublicPackage(identityName: string, publicData: string): Promise<void> {
  await packageFrom(identityName, publicData);
}

function assertMembers(tree: ClientState['ratchetTree'], data: Omit<StateData, 'version' | 'bytes'>) {
  if (tree.length !== 3) throw new Error('Only two-member conversations are supported.');
  const leaves = tree.filter((node) => node?.nodeType === 'leaf');
  if (leaves.length !== 2) throw new Error('Only two-member conversations are supported.');
  const members = new Set<string>();
  for (const node of leaves) {
    if (!node || node.nodeType !== 'leaf') throw new Error('Invalid MLS member.');
    const name = credentialIdentity(node.leaf.credential);
    const expected = name === data.self ? data.selfSignatureKey : name === data.peer ? data.peerSignatureKey : undefined;
    if (!expected || bytesToHex(node.leaf.signaturePublicKey) !== expected || members.has(name) ||
        node.leaf.hpkePublicKey.length !== 32 || node.leaf.extensions.length !== 0) {
      throw new Error('Unexpected MLS member or signing key.');
    }
    members.add(name);
  }
}

function assertGroup(state: ClientState, data: Omit<StateData, 'version' | 'bytes'>) {
  const context = state.groupContext;
  if (context.version !== 'mls10' || context.cipherSuite !== SUITE || context.epoch < 1n || context.epoch > MAX_EPOCH ||
      bytesToHex(context.groupId) !== data.groupId || context.extensions.length !== 0 ||
      state.groupActiveState.kind !== 'active' || state.historicalReceiverData.size > RETAINED_MLS_EPOCHS ||
      Object.keys(state.unappliedProposals).length !== 0) {
    throw new Error('The MLS state does not match this conversation.');
  }
  assertMembers(state.ratchetTree, data);
  for (const [epoch, receiver] of state.historicalReceiverData) {
    const previous = receiver.groupContext;
    if (epoch < 1n || epoch >= context.epoch || epoch < context.epoch - BigInt(RETAINED_MLS_EPOCHS) ||
        previous.epoch !== epoch || previous.version !== 'mls10' || previous.cipherSuite !== SUITE ||
        bytesToHex(previous.groupId) !== data.groupId || previous.extensions.length !== 0) {
      throw new Error('Invalid retained MLS epoch.');
    }
    assertMembers(receiver.ratchetTree, data);
  }
  const own = state.ratchetTree[state.privatePath.leafIndex * 2];
  if (!own || own.nodeType !== 'leaf' || credentialIdentity(own.leaf.credential) !== data.self) {
    throw new Error('The MLS state belongs to a different identity.');
  }
  if (state.signaturePrivateKey.length !== 32 ||
      bytesToHex(ed25519.getPublicKey(state.signaturePrivateKey)) !== data.selfSignatureKey) {
    throw new Error('The MLS private signing key does not match this identity.');
  }
}

function encodeState(state: ClientState, data: Omit<StateData, 'version' | 'bytes'>, version: 1 | 2): string {
  assertGroup(state, data);
  const result = JSON.stringify({ version, ...data, bytes: bytesToHex(encodeGroupState(state)) } satisfies StateData);
  if (result.length > MAX_STATE) throw new Error('The MLS state is too large.');
  return result;
}

function readState(serialized: string): { state: ClientState; data: Omit<StateData, 'version' | 'bytes'>; version: 1 | 2 } {
  const value = object(serialized, MAX_STATE,
    ['version', 'self', 'peer', 'groupId', 'selfSignatureKey', 'peerSignatureKey', 'bytes'], [1, 2]);
  identity(value.self);
  identity(value.peer);
  conversation(value.self, value.peer);
  hex(value.groupId, 32, 32);
  hex(value.selfSignatureKey, 32, 32);
  hex(value.peerSignatureKey, 32, 32);
  const data = {
    self: value.self,
    peer: value.peer,
    groupId: value.groupId as string,
    selfSignatureKey: value.selfSignatureKey as string,
    peerSignatureKey: value.peerSignatureKey as string,
  };
  const group = complete(decodeGroupState, hex(value.bytes, MAX_STATE / 2));
  const state: ClientState = { ...group, clientConfig: config(data.self, data.peer, data.selfSignatureKey, data.peerSignatureKey) };
  assertGroup(state, data);
  if (value.version === 1 && (state.groupContext.epoch !== 1n || state.historicalReceiverData.size !== 0)) {
    throw new Error('A legacy MLS session cannot change epochs.');
  }
  return { state, data, version: value.version as 1 | 2 };
}

/** Used by the caller to compare authenticated envelope sender/group to its vault record. */
export function sessionContext(serialized: string): { self: string; peer: string; groupId: string } {
  const { data } = readState(serialized);
  return { self: data.self, peer: data.peer, groupId: data.groupId };
}

/** The authenticated first MLS leaf created this two-member session. */
export function sessionInitiator(serialized: string): string {
  const { state } = readState(serialized);
  const first = state.ratchetTree[0];
  if (!first || first.nodeType !== 'leaf') throw new Error('Invalid conversation creator.');
  return credentialIdentity(first.leaf.credential);
}

export async function createPackage(identityName: string): Promise<{ publicData: string; privateData: string }> {
  identity(identityName);
  const suite = await getSuite();
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const pair = await generateKeyPackage(
    { credentialType: 'basic', identity: encoder.encode(identityName) },
    { versions: ['mls10'], ciphersuites: [SUITE], extensions: [], proposals: [], credentials: ['basic'] },
    { notBefore: now - 300n, notAfter: now + 604_800n }, [], suite,
  );
  const publicData = JSON.stringify({ version: 2, message: bytesToHex(encodeMlsMessage({
    version: 'mls10', wireformat: 'mls_key_package', keyPackage: pair.publicPackage,
  })) } satisfies PublicData);
  const privateData = JSON.stringify({
    version: 2, identity: identityName, publicData,
    initPrivateKey: bytesToHex(pair.privatePackage.initPrivateKey),
    hpkePrivateKey: bytesToHex(pair.privatePackage.hpkePrivateKey),
    signaturePrivateKey: bytesToHex(pair.privatePackage.signaturePrivateKey),
  } satisfies PrivateData);
  return { publicData, privateData };
}

export async function startSession(self: string, peer: string, remotePublicData: string, groupId: Uint8Array): Promise<{
  state: string; welcome: string; groupId: string;
}> {
  conversation(self, peer);
  if (!(groupId instanceof Uint8Array) || groupId.length !== 32) throw new Error('Expected a 32-byte conversation ID.');
  const remote = await packageFrom(peer, remotePublicData);
  const version = object(remotePublicData, MAX_PACKAGE, ['version', 'message'], [1, 2]).version as 1 | 2;
  const local = await createPackage(self);
  const pair = await readPrivate(self, local.privateData);
  const selfSignatureKey = bytesToHex(pair.publicPackage.leafNode.signaturePublicKey);
  const peerSignatureKey = bytesToHex(remote.leafNode.signaturePublicKey);
  const suite = await getSuite();
  const initial = await createGroup(groupId, pair.publicPackage, pair.privatePackage, [], suite,
    config(self, peer, selfSignatureKey, peerSignatureKey));
  const result = await createCommit({ state: initial, cipherSuite: suite }, {
    extraProposals: [{ proposalType: 'add', add: { keyPackage: remote } }], ratchetTreeExtension: true,
  });
  if (!result.welcome) throw new Error('MLS did not create a welcome message.');
  const id = bytesToHex(groupId);
  // Epoch zero contained only the creator; it has no friend messages to retain.
  const state = encodeState({ ...result.newState, historicalReceiverData: new Map() },
    { self, peer, groupId: id, selfSignatureKey, peerSignatureKey }, version);
  const welcome = JSON.stringify({ version, groupId: id, peerSignatureKey: selfSignatureKey,
    message: bytesToHex(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome })),
  } satisfies WelcomeData);
  if (welcome.length > MAX_WELCOME) throw new Error('The MLS welcome is too large.');
  return { state, welcome, groupId: id };
}

async function readPrivate(self: string, privateData: string): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage; version: 1 | 2 }> {
  const value = object(privateData, MAX_PACKAGE * 2,
    ['version', 'identity', 'publicData', 'initPrivateKey', 'hpkePrivateKey', 'signaturePrivateKey'], [1, 2]);
  if (value.identity !== self || typeof value.publicData !== 'string') throw new Error('The MLS private package belongs to another identity.');
  const publicPackage = await packageFrom(self, value.publicData);
  const signaturePrivateKey = hex(value.signaturePrivateKey, 32, 32);
  const initPrivateKey = hex(value.initPrivateKey, 32, 32);
  const hpkePrivateKey = hex(value.hpkePrivateKey, 32, 32);
  if (bytesToHex(ed25519.getPublicKey(signaturePrivateKey)) !== bytesToHex(publicPackage.leafNode.signaturePublicKey) ||
      bytesToHex(x25519.getPublicKey(initPrivateKey)) !== bytesToHex(publicPackage.initKey) ||
      bytesToHex(x25519.getPublicKey(hpkePrivateKey)) !== bytesToHex(publicPackage.leafNode.hpkePublicKey)) {
    throw new Error('The MLS private package does not match its public keys.');
  }
  if (object(value.publicData, MAX_PACKAGE, ['version', 'message'], [1, 2]).version !== value.version) {
    throw new Error('Inconsistent MLS key-package capability.');
  }
  return { publicPackage, privatePackage: { initPrivateKey, hpkePrivateKey, signaturePrivateKey }, version: value.version as 1 | 2 };
}

// The caller MUST verify the whole welcome string with the accepted friend's
// long-term identity signature before invoking this method. That signature binds
// the ephemeral MLS signing key and group ID to the invitation identity.
export async function receiveWelcome(self: string, peer: string, welcome: string, privateData: string): Promise<{
  state: string; groupId: string;
}> {
  conversation(self, peer);
  const value = object(welcome, MAX_WELCOME, ['version', 'groupId', 'peerSignatureKey', 'message'], [1, 2]);
  hex(value.groupId, 32, 32);
  hex(value.peerSignatureKey, 32, 32);
  const message = complete(decodeMlsMessage, hex(value.message, MAX_WELCOME / 2));
  if (message.version !== 'mls10' || message.wireformat !== 'mls_welcome' || message.welcome.secrets.length !== 1) {
    throw new Error('Expected a welcome for one new member.');
  }
  const pair = await readPrivate(self, privateData);
  if (pair.version !== value.version) throw new Error('The MLS welcome changed the advertised key-update capability.');
  const selfSignatureKey = bytesToHex(pair.publicPackage.leafNode.signaturePublicKey);
  const peerSignatureKey = value.peerSignatureKey as string;
  const data = { self, peer, groupId: value.groupId as string, selfSignatureKey, peerSignatureKey };
  const suite = await getSuite();
  const group = await joinGroup(message.welcome, pair.publicPackage, pair.privatePackage, emptyPskIndex, suite,
    undefined, undefined, config(self, peer, selfSignatureKey, peerSignatureKey));
  // Existing first-contact envelopes only authorize the initial two-member epoch.
  if (group.groupContext.epoch !== 1n) throw new Error('Expected an initial MLS welcome.');
  return { state: encodeState(group, data, pair.version), groupId: data.groupId };
}

// Serialization creates a fresh state snapshot; neither function mutates the
// supplied string. The caller must atomically persist this snapshot and its
// outbox/inbox entry before sending or acknowledging a message. A failed write
// keeps the old snapshot valid. JS strings/garbage collection cannot be wiped.
export async function encryptMessage(serialized: string, plaintext: Uint8Array): Promise<{ state: string; ciphertext: string }> {
  if (!(plaintext instanceof Uint8Array) || plaintext.length === 0 || plaintext.length > MAX_MESSAGE_BYTES) {
    throw new Error('Message size is unsupported.');
  }
  const { state, data, version } = readState(serialized);
  const suite = await getSuite();
  const result = await createApplicationMessage(state, plaintext, suite);
  const ciphertext = bytesToHex(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_private_message', privateMessage: result.privateMessage }));
  if (ciphertext.length > MAX_CIPHERTEXT) throw new Error('Encrypted message is too large.');
  return { state: encodeState(result.newState, data, version), ciphertext };
}

export async function decryptMessage(serialized: string, ciphertext: string): Promise<{ state: string; plaintext: Uint8Array }> {
  const { state, data, version } = readState(serialized);
  const message = complete(decodeMlsMessage, hex(ciphertext, MAX_CIPHERTEXT / 2));
  if (message.version !== 'mls10' || message.wireformat !== 'mls_private_message' ||
      message.privateMessage.contentType !== 'application' || message.privateMessage.epoch > state.groupContext.epoch ||
      bytesToHex(message.privateMessage.groupId) !== data.groupId || message.privateMessage.authenticatedData.length !== 0) {
    throw new Error('Expected an application message for this conversation.');
  }
  const suite = await getSuite();
  const epoch = message.privateMessage.epoch;
  const receiver = epoch === state.groupContext.epoch ? undefined : state.historicalReceiverData.get(epoch);
  if (epoch !== state.groupContext.epoch && !receiver) throw new Error('This message is outside the retained MLS epochs.');
  const sender = await decryptSenderData(message.privateMessage, receiver?.senderDataSecret ?? state.keySchedule.senderDataSecret, suite);
  const leaf = sender === undefined ? undefined : (receiver?.ratchetTree ?? state.ratchetTree)[sender.leafIndex * 2];
  if (!leaf || leaf.nodeType !== 'leaf' || credentialIdentity(leaf.leaf.credential) !== data.peer) {
    throw new Error('The message is not from this friend.');
  }
  const result = await processPrivateMessage(state, message.privateMessage, emptyPskIndex, suite, () => 'reject');
  if (result.kind !== 'applicationMessage' || result.message.length === 0 || result.message.length > MAX_MESSAGE_BYTES) {
    throw new Error('Unsupported MLS application message.');
  }
  return { state: encodeState(result.newState, data, version), plaintext: result.message };
}

/** Current authenticated epoch, safe to use in the durable application control record. */
export function sessionEpoch(serialized: string): number {
  return Number(readState(serialized).state.groupContext.epoch);
}

// MLS leaves are fixed at initial membership. Alternating the authorized
// committer prevents two honest endpoints from producing competing commits.
// Both endpoints must update: one member's update does not heal compromise of
// the other member. Availability/retry/deadline policy belongs to the controller.
function updateLeaf(state: ClientState): number {
  return Number((state.groupContext.epoch - 1n) % 2n);
}

export function sessionSupportsEpochUpdates(serialized: string): boolean {
  return readState(serialized).version === 2;
}

export function canUpdateEpoch(serialized: string): boolean {
  const { state, version } = readState(serialized);
  return version === 2 && state.groupContext.epoch < MAX_EPOCH && updateLeaf(state) === state.privatePath.leafIndex;
}

export type EpochUpdate = { state: string; ciphertext: string; epoch: number; commitId: string };

function updateResult(state: ClientState, data: Omit<StateData, 'version' | 'bytes'>, ciphertext: string): EpochUpdate {
  return { state: encodeState(state, data, 2), ciphertext, epoch: Number(state.groupContext.epoch),
    commitId: bytesToHex(sha256(hex(ciphertext, MAX_CIPHERTEXT / 2))) };
}

/**
 * An RFC 9420 empty Commit includes a fresh leaf/path, produced by the MLS
 * library. Atomically persist the returned state and EXACT commit ciphertext
 * before publication. Do not send application data until the peer durably
 * acknowledges this epoch + commitId inside its new-epoch encrypted message.
 * A published pending commit must never be cancelled/rolled back/regenerated.
 */
export async function createEpochUpdate(serialized: string): Promise<EpochUpdate> {
  const { state, data, version } = readState(serialized);
  if (version !== 2 || state.groupContext.epoch >= MAX_EPOCH || updateLeaf(state) !== state.privatePath.leafIndex) {
    throw new Error('It is this friend’s turn to update the MLS keys.');
  }
  const previous = state.groupContext.epoch;
  const suite = await getSuite();
  const result = await createCommit({ state, cipherSuite: suite }, { extraProposals: [] });
  if (result.welcome || result.commit.wireformat !== 'mls_private_message' ||
      result.commit.privateMessage.contentType !== 'commit' || result.newState.groupContext.epoch !== previous + 1n) {
    throw new Error('MLS did not create the expected key update.');
  }
  const ciphertext = bytesToHex(encodeMlsMessage(result.commit));
  if (ciphertext.length > MAX_CIPHERTEXT) throw new Error('The MLS key update is too large.');
  return updateResult(result.newState, data, ciphertext);
}

/**
 * Applies one current-epoch, empty, authenticated peer Commit. Duplicate commits
 * are rejected here; the controller must resend its already-persisted encrypted
 * acknowledgement using its bounded commitId ledger, without processing twice.
 */
export async function receiveEpochUpdate(serialized: string, ciphertext: string): Promise<EpochUpdate> {
  const { state, data, version } = readState(serialized);
  const message = complete(decodeMlsMessage, hex(ciphertext, MAX_CIPHERTEXT / 2));
  if (version !== 2 || state.groupContext.epoch >= MAX_EPOCH || message.version !== 'mls10' ||
      message.wireformat !== 'mls_private_message' || message.privateMessage.contentType !== 'commit' ||
      message.privateMessage.epoch !== state.groupContext.epoch ||
      bytesToHex(message.privateMessage.groupId) !== data.groupId || message.privateMessage.authenticatedData.length !== 0) {
    throw new Error('Expected a current-epoch MLS key update for this conversation.');
  }
  const suite = await getSuite();
  const sender = await decryptSenderData(message.privateMessage, state.keySchedule.senderDataSecret, suite);
  const leaf = sender === undefined ? undefined : state.ratchetTree[sender.leafIndex * 2];
  if (!sender || !leaf || leaf.nodeType !== 'leaf' || credentialIdentity(leaf.leaf.credential) !== data.peer ||
      sender.leafIndex !== updateLeaf(state)) {
    throw new Error('The MLS key update is not from the authorized friend.');
  }
  const result = await processPrivateMessage(state, message.privateMessage, emptyPskIndex, suite, (incoming) =>
    incoming.kind === 'commit' && incoming.senderLeafIndex === sender.leafIndex && incoming.proposals.length === 0 ? 'accept' : 'reject');
  if (result.kind !== 'newState' || result.actionTaken !== 'accept' ||
      result.newState.groupContext.epoch !== state.groupContext.epoch + 1n) {
    throw new Error('Unsupported MLS membership change or key update.');
  }
  // With no proposals RFC 9420 requires an UpdatePath. The library verifies
  // that path, its leaf signature, transcript and next-epoch confirmation tag.
  return updateResult(result.newState, data, ciphertext);
}

/** Unauthenticated routing hint only; trust it only after successful MLS processing. */
export function messageEpoch(ciphertext: string): number {
  const message = complete(decodeMlsMessage, hex(ciphertext, MAX_CIPHERTEXT / 2));
  if (message.version !== 'mls10' || message.wireformat !== 'mls_private_message' ||
      message.privateMessage.epoch < 1n || message.privateMessage.epoch > MAX_EPOCH) {
    throw new Error('Expected an MLS private message.');
  }
  return Number(message.privateMessage.epoch);
}

/** Stable identifier for an exact serialized Commit; does not authenticate it. */
export function epochCommitId(ciphertext: string): string {
  return bytesToHex(sha256(hex(ciphertext, MAX_CIPHERTEXT / 2)));
}
