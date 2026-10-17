import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  createApplicationMessage, createCommit, createGroup, createProposal, decodeGroupState, decodeMlsMessage, encodeMlsMessage,
  defaultCapabilities, defaultLifetime, emptyPskIndex, generateKeyPackageWithKey,
  getCiphersuiteFromName, getCiphersuiteImpl, joinGroup, processPrivateMessage,
} from 'ts-mls';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import {
  createPackage, validatePublicPackage, startSession, receiveWelcome,
  encryptMessage, decryptMessage, sessionContext, MAX_MESSAGE_BYTES,
  sessionEpoch, sessionSupportsEpochUpdates, canUpdateEpoch, createEpochUpdate, receiveEpochUpdate, RETAINED_MLS_EPOCHS,
} from '../src/messaging/mlsEngine.ts';

const self = `common:${bytesToHex(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))))}`;
const peer = `common:${bytesToHex(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))))}`;
const other = `common:${bytesToHex(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))))}`;
const utf8 = new TextEncoder();
const text = new TextDecoder();

async function pair() {
  const bobPackage = await createPackage(peer);
  const alice = await startSession(self, peer, bobPackage.publicData, crypto.getRandomValues(new Uint8Array(32)));
  const bob = await receiveWelcome(peer, self, alice.welcome, bobPackage.privateData);
  return { alice, bob, bobPackage };
}

test('real two-member MLS welcome, first message and reply work after serialized restart', async () => {
  const { alice, bob, bobPackage } = await pair();
  await validatePublicPackage(peer, bobPackage.publicData);
  assert.equal(alice.groupId, bob.groupId);
  assert.deepEqual(sessionContext(alice.state), { self, peer, groupId: alice.groupId });
  assert.deepEqual(sessionContext(bob.state), { self: peer, peer: self, groupId: alice.groupId });
  const outgoing = await encryptMessage(alice.state, utf8.encode('Hello, Bob! 🌍'));
  assert.equal(outgoing.ciphertext.includes(bytesToHex(utf8.encode('Hello, Bob!'))), false);
  const incoming = await decryptMessage(bob.state, outgoing.ciphertext);
  assert.equal(text.decode(incoming.plaintext), 'Hello, Bob! 🌍');
  // JSON storage round-trips preserve the MLS codec's bigint/maps/byte arrays.
  const restoredBob = JSON.parse(JSON.stringify(incoming.state));
  const reply = await encryptMessage(restoredBob, utf8.encode('Hello, Alice!'));
  const restoredAlice = JSON.parse(JSON.stringify(outgoing.state));
  const received = await decryptMessage(restoredAlice, reply.ciphertext);
  assert.equal(text.decode(received.plaintext), 'Hello, Alice!');
});

test('MLS supports reordered queued delivery and rejects a replay after persisting the new state', async () => {
  const { alice, bob } = await pair();
  const one = await encryptMessage(alice.state, utf8.encode('one'));
  const two = await encryptMessage(one.state, utf8.encode('two'));
  const three = await encryptMessage(two.state, utf8.encode('three'));
  const receivedThree = await decryptMessage(bob.state, three.ciphertext);
  const receivedOne = await decryptMessage(receivedThree.state, one.ciphertext);
  const receivedTwo = await decryptMessage(receivedOne.state, two.ciphertext);
  assert.deepEqual([receivedOne, receivedTwo, receivedThree].map((value) => text.decode(value.plaintext)), ['one', 'two', 'three']);
  await assert.rejects(decryptMessage(receivedTwo.state, one.ciphertext));
  await assert.rejects(decryptMessage(receivedTwo.state, three.ciphertext));
});

test('tampered ciphertext fails authentication without changing the supplied serialized state', async () => {
  const { alice, bob } = await pair();
  const message = await encryptMessage(alice.state, utf8.encode('saved atomically'));
  const bytes = hexToBytes(message.ciphertext);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(decryptMessage(bob.state, bytesToHex(bytes)));
  const valid = await decryptMessage(bob.state, message.ciphertext);
  assert.equal(text.decode(valid.plaintext), 'saved atomically');
  // A failed storage write can retain the original state; no input string or
  // its key material was mutated by either operation.
  const retried = await decryptMessage(bob.state, message.ciphertext);
  assert.equal(text.decode(retried.plaintext), 'saved atomically');
});

test('wrong Common identity, signing-key pin, private package or group ID is rejected', async () => {
  const { alice, bob, bobPackage } = await pair();
  await assert.rejects(validatePublicPackage(other, bobPackage.publicData));
  await assert.rejects(startSession(self, other, bobPackage.publicData, crypto.getRandomValues(new Uint8Array(32))));
  await assert.rejects(receiveWelcome(peer, other, alice.welcome, bobPackage.privateData));
  await assert.rejects(receiveWelcome(other, self, alice.welcome, bobPackage.privateData));
  const wrongPackage = await createPackage(peer);
  await assert.rejects(receiveWelcome(peer, self, alice.welcome, wrongPackage.privateData));
  const wrongWelcomeKey = JSON.parse(alice.welcome);
  wrongWelcomeKey.peerSignatureKey = '00'.repeat(32);
  await assert.rejects(receiveWelcome(peer, self, JSON.stringify(wrongWelcomeKey), bobPackage.privateData));
  const wrongWelcomeGroup = JSON.parse(alice.welcome);
  wrongWelcomeGroup.groupId = '00'.repeat(32);
  await assert.rejects(receiveWelcome(peer, self, JSON.stringify(wrongWelcomeGroup), bobPackage.privateData));
  const message = await encryptMessage(alice.state, utf8.encode('right group'));
  const unrelated = await pair();
  await assert.rejects(decryptMessage(unrelated.bob.state, message.ciphertext));
  const wrongState = JSON.parse(bob.state);
  wrongState.peer = other;
  assert.throws(() => sessionContext(JSON.stringify(wrongState)));
});

test('strict whole-decoding rejects trailing MLS bytes, extra JSON fields, malformed identities and oversized payloads', async () => {
  const bob = await createPackage(peer);
  const trailing = JSON.parse(bob.publicData);
  trailing.message += '00';
  await assert.rejects(validatePublicPackage(peer, JSON.stringify(trailing)));
  await assert.rejects(validatePublicPackage(peer, JSON.stringify({ ...JSON.parse(bob.publicData), extra: true })));
  await assert.rejects(validatePublicPackage(peer, ` ${bob.publicData}`));
  await assert.rejects(createPackage('common:bad'));
  await assert.rejects(createPackage(self.toUpperCase()));
  await assert.rejects(startSession(self, self, bob.publicData, crypto.getRandomValues(new Uint8Array(32))));
  await assert.rejects(startSession(self, peer, bob.publicData, new Uint8Array(31)));
  const { alice, bob: recipient } = await pair();
  const state = JSON.parse(alice.state);
  state.bytes += '00';
  assert.throws(() => sessionContext(JSON.stringify(state)));
  await assert.rejects(encryptMessage(alice.state, new Uint8Array(MAX_MESSAGE_BYTES + 1)));
  await assert.rejects(encryptMessage(alice.state, new Uint8Array()));
  const message = await encryptMessage(alice.state, utf8.encode('whole message'));
  await assert.rejects(decryptMessage(recipient.state, message.ciphertext + '00'));
  await assert.rejects(decryptMessage(recipient.state, '00'.repeat(32_769)));
});

test('private proposal/commit and self-sent messages cannot be accepted as friend messages', async () => {
  const { alice, bob } = await pair();
  const parsed = JSON.parse(alice.state);
  const decoded = decodeGroupState(hexToBytes(parsed.bytes), 0);
  assert.ok(decoded);
  const state = { ...decoded[0], clientConfig: defaultClientConfig };
  const suite = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
  const proposal = await createProposal(state, false, { proposalType: 'remove', remove: { removed: 1 } }, suite);
  const encodedProposal = bytesToHex(encodeMlsMessage(proposal.message));
  await assert.rejects(decryptMessage(bob.state, encodedProposal), /application message/);
  const app = await encryptMessage(alice.state, utf8.encode('own message'));
  await assert.rejects(decryptMessage(alice.state, app.ciphertext), /not from this friend/);
  const decodedMessage = decodeMlsMessage(hexToBytes(app.ciphertext), 0)[0];
  decodedMessage.privateMessage.epoch = 2n;
  await assert.rejects(decryptMessage(bob.state, bytesToHex(encodeMlsMessage(decodedMessage))), /application message/);
});

test('explicit suite provider exchanges standard MLS messages with the upstream default provider', async () => {
  const suite = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const rawBob = await generateKeyPackageWithKey(
    { credentialType: 'basic', identity: utf8.encode(peer) }, defaultCapabilities(), defaultLifetime, [],
    { signKey: seed, publicKey: ed25519.getPublicKey(seed) }, suite,
  );
  const publicData = JSON.stringify({ version: 1, message: bytesToHex(encodeMlsMessage({
    version: 'mls10', wireformat: 'mls_key_package', keyPackage: rawBob.publicPackage,
  })) });
  const alice = await startSession(self, peer, publicData, crypto.getRandomValues(new Uint8Array(32)));
  const welcome = decodeMlsMessage(hexToBytes(JSON.parse(alice.welcome).message), 0)[0];
  const signingPins = { [self]: JSON.parse(alice.welcome).peerSignatureKey, [peer]: bytesToHex(rawBob.publicPackage.leafNode.signaturePublicKey) };
  const clientConfig = { ...defaultClientConfig, authService: {
    async validateCredential(credential, key) {
      return credential.credentialType === 'basic' && signingPins[text.decode(credential.identity)] === bytesToHex(key);
    },
  } };
  let bob = await joinGroup(welcome.welcome, rawBob.publicPackage, rawBob.privatePackage, emptyPskIndex, suite,
    undefined, undefined, clientConfig);
  const sentByAlice = await encryptMessage(alice.state, utf8.encode('standard wire format'));
  const decodedMessage = decodeMlsMessage(hexToBytes(sentByAlice.ciphertext), 0)[0];
  const receivedByBob = await processPrivateMessage(bob, decodedMessage.privateMessage, emptyPskIndex, suite);
  assert.equal(receivedByBob.kind, 'applicationMessage');
  assert.equal(text.decode(receivedByBob.message), 'standard wire format');
  bob = receivedByBob.newState;
  const rawReply = await createApplicationMessage(bob, utf8.encode('upstream reply'), suite);
  const replyBytes = bytesToHex(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_private_message', privateMessage: rawReply.privateMessage }));
  const receivedByAlice = await decryptMessage(sentByAlice.state, replyBytes);
  assert.equal(text.decode(receivedByAlice.plaintext), 'upstream reply');
});

test('welcome with an unauthorized third member is rejected even when it has only one recipient secret', async () => {
  const suite = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
  const make = async (name) => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    return generateKeyPackageWithKey(
      { credentialType: 'basic', identity: utf8.encode(name) }, defaultCapabilities(), defaultLifetime, [],
      { signKey: seed, publicKey: ed25519.getPublicKey(seed) }, suite,
    );
  };
  const creator = await make(self);
  const third = await make(other);
  const recipient = await createPackage(peer);
  const recipientPublic = decodeMlsMessage(hexToBytes(JSON.parse(recipient.publicData).message), 0)[0].keyPackage;
  const groupId = crypto.getRandomValues(new Uint8Array(32));
  const allowed = { [self]: bytesToHex(creator.publicPackage.leafNode.signaturePublicKey),
    [other]: bytesToHex(third.publicPackage.leafNode.signaturePublicKey),
    [peer]: bytesToHex(recipientPublic.leafNode.signaturePublicKey) };
  const clientConfig = { ...defaultClientConfig, authService: {
    async validateCredential(credential, key) {
      return credential.credentialType === 'basic' && allowed[text.decode(credential.identity)] === bytesToHex(key);
    },
  } };
  const group = await createGroup(groupId, creator.publicPackage, creator.privatePackage, [], suite, clientConfig);
  const result = await createCommit({ state: group, cipherSuite: suite }, {
    extraProposals: [{ proposalType: 'add', add: { keyPackage: recipientPublic } },
      { proposalType: 'add', add: { keyPackage: third.publicPackage } }], ratchetTreeExtension: true,
  });
  const welcomes = result.welcome;
  assert.equal(welcomes.secrets.length, 2);
  // Both recipient secrets contain the same authenticated group info/tree.
  for (const secret of welcomes.secrets) {
    const welcome = JSON.stringify({ version: 1, groupId: bytesToHex(groupId),
      peerSignatureKey: bytesToHex(creator.publicPackage.leafNode.signaturePublicKey),
      message: bytesToHex(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: { ...welcomes, secrets: [secret] } })),
    });
    await assert.rejects(receiveWelcome(peer, self, welcome, recipient.privateData));
  }
});


function upstreamState(serialized) {
  const stored = JSON.parse(serialized);
  const decoded = decodeGroupState(hexToBytes(stored.bytes), 0)[0];
  return { ...decoded, clientConfig: { ...defaultClientConfig,
    keyRetentionConfig: { retainKeysForGenerations: 128, retainKeysForEpochs: RETAINED_MLS_EPOCHS, maximumForwardRatchetSteps: 200 },
    authService: { async validateCredential(credential, key) {
      const name = text.decode(credential.identity);
      const expected = name === stored.self ? stored.selfSignatureKey : name === stored.peer ? stored.peerSignatureKey : undefined;
      return credential.credentialType === 'basic' && expected === bytesToHex(key);
    } },
  } };
}

const standardSuite = () => getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
const privateMessage = (ciphertext) => decodeMlsMessage(hexToBytes(ciphertext), 0)[0].privateMessage;

test('new sessions agree rotation capability and alternate authenticated fresh UpdatePath commits after restart', async () => {
  const { alice, bob } = await pair();
  assert.equal(sessionSupportsEpochUpdates(alice.state), true);
  assert.equal(sessionSupportsEpochUpdates(bob.state), true);
  assert.equal(sessionEpoch(alice.state), 1);
  assert.equal(canUpdateEpoch(alice.state), true);
  assert.equal(canUpdateEpoch(bob.state), false);
  await assert.rejects(createEpochUpdate(bob.state), /turn/);
  const oldAliceHpke = upstreamState(alice.state).privatePath.privateKeys;
  const first = await createEpochUpdate(alice.state);
  const received = await receiveEpochUpdate(JSON.parse(JSON.stringify(bob.state)), first.ciphertext);
  assert.equal(first.epoch, 2);
  assert.equal(first.commitId, received.commitId);
  assert.equal(first.commitId.length, 64);
  assert.notDeepEqual(upstreamState(first.state).privatePath.privateKeys, oldAliceHpke);
  assert.equal(canUpdateEpoch(first.state), false);
  assert.equal(canUpdateEpoch(received.state), true);
  const second = await createEpochUpdate(JSON.parse(JSON.stringify(received.state)));
  const accepted = await receiveEpochUpdate(first.state, second.ciphertext);
  assert.equal(second.epoch, 3);
  assert.equal(sessionEpoch(accepted.state), 3);
  assert.equal(canUpdateEpoch(accepted.state), true);
  const chat = await encryptMessage(accepted.state, utf8.encode('both members refreshed'));
  const opened = await decryptMessage(second.state, chat.ciphertext);
  assert.equal(text.decode(opened.plaintext), 'both members refreshed');
});

test('legacy serialized sessions remain readable but cannot silently enable rotation', async () => {
  const bobPackage = await createPackage(peer);
  const publicData = JSON.stringify({ ...JSON.parse(bobPackage.publicData), version: 1 });
  const privateData = JSON.stringify({ ...JSON.parse(bobPackage.privateData), version: 1, publicData });
  const alice = await startSession(self, peer, publicData, crypto.getRandomValues(new Uint8Array(32)));
  const bob = await receiveWelcome(peer, self, alice.welcome, privateData);
  assert.equal(JSON.parse(alice.welcome).version, 1);
  assert.equal(sessionSupportsEpochUpdates(alice.state), false);
  assert.equal(canUpdateEpoch(alice.state), false);
  const app = await encryptMessage(alice.state, utf8.encode('legacy delivery drains'));
  assert.equal(JSON.parse(app.state).version, 1);
  assert.equal(text.decode((await decryptMessage(bob.state, app.ciphertext)).plaintext), 'legacy delivery drains');
  await assert.rejects(createEpochUpdate(alice.state));
  await assert.rejects(receiveWelcome(peer, self, alice.welcome, bobPackage.privateData), /capability/);
  const upgradedWelcome = JSON.stringify({ ...JSON.parse(alice.welcome), version: 2 });
  await assert.rejects(receiveWelcome(peer, self, upgradedWelcome, privateData), /capability/);
});

test('epoch update replay, tampering, foreign group, out-of-turn sender and competing branches are rejected', async () => {
  const { alice, bob } = await pair();
  const update = await createEpochUpdate(alice.state);
  const damaged = hexToBytes(update.ciphertext);
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(receiveEpochUpdate(bob.state, bytesToHex(damaged)));
  const accepted = await receiveEpochUpdate(bob.state, update.ciphertext);
  await assert.rejects(receiveEpochUpdate(accepted.state, update.ciphertext), /current-epoch/);
  await assert.rejects(receiveEpochUpdate(alice.state, update.ciphertext), /authorized friend/);
  const unrelated = await pair();
  await assert.rejects(receiveEpochUpdate(unrelated.bob.state, update.ciphertext), /conversation/);
  const competing = await createEpochUpdate(alice.state);
  assert.notEqual(competing.commitId, update.commitId);
  await assert.rejects(receiveEpochUpdate(accepted.state, competing.ciphertext), /current-epoch/);
  const splitMessage = await encryptMessage(competing.state, utf8.encode('competing branch'));
  await assert.rejects(decryptMessage(accepted.state, splitMessage.ciphertext));
  const suite = await standardSuite();
  const forbidden = await createCommit({ state: upstreamState(bob.state), cipherSuite: suite });
  await assert.rejects(receiveEpochUpdate(alice.state, bytesToHex(encodeMlsMessage(forbidden.commit))), /authorized friend/);
});

test('epoch update receiver refuses membership proposals even when the current peer signed the commit', async () => {
  const { alice, bob } = await pair();
  const suite = await standardSuite();
  const extra = await createPackage(other);
  const keyPackage = decodeMlsMessage(hexToBytes(JSON.parse(extra.publicData).message), 0)[0].keyPackage;
  // The malicious member chooses a permissive local authentication policy.
  const attacker = { ...upstreamState(alice.state), clientConfig: defaultClientConfig };
  const added = await createCommit({ state: attacker, cipherSuite: suite }, {
    extraProposals: [{ proposalType: 'add', add: { keyPackage } }],
  });
  await assert.rejects(receiveEpochUpdate(bob.state, bytesToHex(encodeMlsMessage(added.commit))), /credential|membership change/);
  const removed = await createCommit({ state: attacker, cipherSuite: suite }, {
    extraProposals: [{ proposalType: 'remove', remove: { removed: 1 } }],
  });
  await assert.rejects(receiveEpochUpdate(bob.state, bytesToHex(encodeMlsMessage(removed.commit))), /membership change/);
});

test('only two old receive epochs survive; delayed applications work once and cannot roll back the active epoch', async () => {
  const original = await pair();
  const oldOne = await encryptMessage(original.alice.state, utf8.encode('delayed one'));
  const oldTwo = await encryptMessage(oldOne.state, utf8.encode('delayed two'));
  let alice = oldTwo.state, bob = original.bob.state;
  for (let epoch = 2; epoch <= 4; epoch++) {
    const local = epoch % 2 === 0 ? alice : bob;
    const remote = epoch % 2 === 0 ? bob : alice;
    const update = await createEpochUpdate(local);
    const accepted = await receiveEpochUpdate(remote, update.ciphertext);
    if (epoch % 2 === 0) { alice = update.state; bob = accepted.state; }
    else { bob = update.state; alice = accepted.state; }
    if (epoch === 3) {
      const delayed = await decryptMessage(bob, oldOne.ciphertext);
      assert.equal(text.decode(delayed.plaintext), 'delayed one');
      assert.equal(sessionEpoch(delayed.state), 3);
      bob = delayed.state;
      await assert.rejects(decryptMessage(bob, oldOne.ciphertext));
    }
  }
  assert.deepEqual([...upstreamState(bob).historicalReceiverData.keys()], [2n, 3n]);
  await assert.rejects(decryptMessage(bob, oldTwo.ciphertext), /retained MLS epochs/);
  const now = await encryptMessage(alice, utf8.encode('newest epoch'));
  assert.equal(text.decode((await decryptMessage(bob, now.ciphertext)).plaintext), 'newest epoch');
});

test('engine updates interoperate with the upstream default provider and reject a stale compromised leaf snapshot', async () => {
  const { alice, bob } = await pair();
  const suite = await standardSuite();
  const first = await createEpochUpdate(alice.state);
  let rawBob = upstreamState(bob.state);
  const processed = await processPrivateMessage(rawBob, privateMessage(first.ciphertext), emptyPskIndex, suite);
  assert.equal(processed.kind, 'newState');
  rawBob = processed.newState;
  const second = await createCommit({ state: rawBob, cipherSuite: suite });
  const secondWire = bytesToHex(encodeMlsMessage(second.commit));
  const received = await receiveEpochUpdate(first.state, secondWire);
  assert.equal(received.epoch, 3);
  const sent = await encryptMessage(received.state, utf8.encode('after both honest updates'));
  const decrypted = await processPrivateMessage(second.newState, privateMessage(sent.ciphertext), emptyPskIndex, suite);
  assert.equal(decrypted.kind, 'applicationMessage');
  assert.equal(text.decode(decrypted.message), 'after both honest updates');
  // This attacker has Bob's entire pre-update state, including his old leaf
  // private key. It can follow Alice's update, but not Bob's fresh self-update.
  // Exercise raw upstream crypto, not our API's self-sender policy rejection.
  const stolen = await processPrivateMessage(upstreamState(bob.state), privateMessage(first.ciphertext), emptyPskIndex, suite);
  await assert.rejects(processPrivateMessage(stolen.newState, privateMessage(secondWire), emptyPskIndex, suite));
  await assert.rejects(processPrivateMessage(stolen.newState, privateMessage(sent.ciphertext), emptyPskIndex, suite));
});
