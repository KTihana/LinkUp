// SPDX-License-Identifier: GPL-3.0-only
import { decodeMessaging, encodeMessaging } from './messenger.ts';

/** Called inside the same vault write that removes the accepted contact. */
export function removePeerMessaging(serialized: string | null, peer: string, now: number): string | null {
  if (!/^[a-f0-9]{64}$/.test(peer) || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid friend removal.');
  if (serialized === null) return null;
  const data = decodeMessaging(serialized), conversation = data.conversations[peer];
  data.pending = data.pending.filter(item => item.peer !== peer);
  data.outbox = data.outbox.filter(item => item.envelope.recipient !== peer);
  if (conversation) {
    // Stored messages already reached the other person's mailbox. We cannot
    // recall them or claim that they were cancelled by removing local access.
    for (const message of conversation.messages) if (message.mine && message.status === 'queued') message.error = 'Friend removed; message cancelled';
    const previous = (conversation.retiredGroups ?? []).filter(item => item.expiresAt > now && item.groupId !== conversation.groupId);
    if (conversation.groupId) previous.push({ groupId: conversation.groupId, expiresAt: now + 7 * 86400000 + 60000 });
    if (previous.length) conversation.retiredGroups = previous.slice(-16); else delete conversation.retiredGroups;
    conversation.state = ''; conversation.groupId = '';
    delete conversation.setupExpiresAt; delete conversation.callInvite; delete conversation.rotation;
  }
  if (data.nearby) data.nearby.inbox = data.nearby.inbox.filter(item => item.sender !== peer);
  // Keep inbound replay tombstones. Reaccepting a contact must not replay old
  // ciphertext or revive a previously used one-time package.
  if (data.admission?.peers.includes(peer)) {
    if (data.admission.revision === Number.MAX_SAFE_INTEGER) throw new Error('Mailbox permission revisions are exhausted.');
    data.admission.peers = data.admission.peers.filter(value => value !== peer);
    data.admission.revision += 1;
  }
  return encodeMessaging(data);
}
