// SPDX-License-Identifier: GPL-3.0-only
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createPackage, startSession, receiveWelcome, encryptMessage, decryptMessage } from './mlsEngine';

/** Exercise the actual MLS adapters on Hermes, with disposable in-memory peers.
 * No vault is opened, no networking occurs and no test material is persisted.
 */
export async function verifyMessagingEngine(): Promise<void> {
  const seeds = [crypto.getRandomValues(new Uint8Array(32)), crypto.getRandomValues(new Uint8Array(32))];
  try {
    const [alice, bob] = seeds.map(seed => `common:${bytesToHex(ed25519.getPublicKey(seed))}`);
    const peerPackage = await createPackage(bob);
    const sender = await startSession(alice, bob, peerPackage.publicData, crypto.getRandomValues(new Uint8Array(32)));
    const receiver = await receiveWelcome(bob, alice, sender.welcome, peerPackage.privateData);
    const message = new TextEncoder().encode('Common device messaging check 🌿');
    const sealed = await encryptMessage(sender.state, message);
    const opened = await decryptMessage(receiver.state, sealed.ciphertext);
    if (opened.plaintext.length !== message.length || opened.plaintext.some((b, i) => b !== message[i])) {
      throw new Error('Device MLS message check failed.');
    }
    const reply = await encryptMessage(opened.state, message);
    const answer = await decryptMessage(sealed.state, reply.ciphertext);
    if (answer.plaintext.length !== message.length || answer.plaintext.some((b, i) => b !== message[i])) {
      throw new Error('Device MLS reply check failed.');
    }
    const last = reply.ciphertext.at(-1);
    const tampered = reply.ciphertext.slice(0, -1) + (last === '0' ? '1' : '0');
    let rejected = false;
    try { await decryptMessage(sealed.state, tampered); } catch { rejected = true; }
    if (!rejected) throw new Error('Device MLS authentication check failed.');
  } finally { seeds.forEach(seed => seed.fill(0)); }
}
