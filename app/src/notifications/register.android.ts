// SPDX-License-Identifier: GPL-3.0-only
// Android-only: React Native Web does not implement headless tasks.
import { AppRegistry } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytesAsync } from 'expo-crypto';
import { BackgroundPort, type Reply } from './backgroundCore';
import { notificationsNative as native } from './native';
import { Messenger, decodeMessaging } from '../messaging/messenger';
import { MailboxClient, type MailSigner } from '../messaging/mailboxClient';
import { ensureMessagingCrypto } from '../messaging/cryptoRuntime';
import { withVaultWrite } from '../security/withVaultWrite';

let queue = Promise.resolve();
async function receive(jobId: string) {
  if (!native) return;
  let port: BackgroundPort | undefined, messenger: Messenger | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let success = false;
  try {
    await ensureMessagingCrypto();
    port = new BackgroundPort(await native.key(), AsyncStorage, withVaultWrite, getRandomBytesAsync, () => native!.canAccess());
    messenger = new Messenger(port, getRandomBytesAsync, Date.now, fetch, ensureMessagingCrypto);
    timer = setTimeout(() => { messenger?.suspend(); port?.close(); }, 50_000);
    const status = await native.status(), subscription = await native.subscription();
    if (subscription && !status.registered) {
      const snapshot = await port.transact<{ endpoint: string; signer: MailSigner }>(async (state, signer) => ({ state: state!, result: { endpoint: decodeMessaging(state).endpoint, signer } }));
      const result = await new MailboxClient(snapshot.endpoint).request('push-register', { subscription: JSON.parse(subscription) }, snapshot.signer);
      if (result.registered !== true) throw new Error('Push registration was not confirmed.');
      await native.registered();
    }
    const replies = JSON.parse(await native.replies()) as Reply[];
    if (!Array.isArray(replies) || replies.length > 32) throw new Error('Invalid reply queue.');
    let replyError = false;
    for (const reply of replies) {
      try {
        if (reply.thread.startsWith('group:')) await messenger.sendGroup(reply.thread.slice(6), reply.text, 'text', reply.id);
        else if (reply.thread.startsWith('peer:')) await messenger.send(reply.thread.slice(5), reply.text, 'text', reply.id);
        else throw new Error('Invalid reply destination.');
      } catch { replyError = true; }
      // Keep this reply until transport storage is confirmed. Retrying the
      // stable ID cannot queue a second copy after process death. A reply to
      // a departed group must not block other replies or incoming messages.
    }
    // Drain full mailbox batches after a period offline. A bounded task deadline
    // and durable ratchet/ack state let WorkManager resume any remaining work.
    let syncError: unknown;
    for (let round = 0; round < 10; round++) {
      try { await messenger.sync(); syncError = undefined; } catch (e) { syncError = e; }
      if (messenger.lastReceivedBatchSize < 50) break;
    }
    const view = await messenger.view();
    for (const reply of replies) {
      const messages = reply.thread.startsWith('group:') ? view.groups?.[reply.thread.slice(6)]?.messages : view.conversations[reply.thread.slice(5)]?.messages;
      const row = messages?.find(m => m.mine && m.id === reply.id);
      if (row && !row.error && row.status !== 'queued') { await native.acknowledge(reply.id); await native.clear(reply.thread); }
    }
    const contacts = await port.transact<{ publicKey: string; name: string }[]>(async (state, _signer, people) => ({ state: state!, result: people.map(p => ({ publicKey: p.publicKey, name: p.name })) }));
    // Posting system UI must not hold the encrypted-vault write serializer.
    for (const [peer, conversation] of Object.entries(view.conversations)) {
        const name = contacts.find(c => c.publicKey === peer)?.name ?? 'Friend';
        for (const message of conversation.messages.slice(-30)) if (!message.mine) await native!.show(`peer:${peer}`, `${peer}:${message.id}`, name, name, message.kind === 'sticker' ? 'Sticker' : message.content.slice(0, 500), message.createdAt, true);
      }
      for (const [id, group] of Object.entries(view.groups ?? {})) {
        if (group.status === 'invited') await native!.show(`group:${id}`, `invite:${id}`, group.descriptor.name, group.descriptor.members.find(m => m.publicKey === group.descriptor.owner)?.name ?? 'Friend', 'Group invitation · open LinkUp to review the members', group.descriptor.createdAt, false);
        if (group.status !== 'joined') continue;
        for (const message of group.messages.slice(-30)) if (!message.mine) await native!.show(`group:${id}`, `${message.sender}:${message.id}`, group.descriptor.name, contacts.find(c => c.publicKey === message.sender)?.name ?? group.descriptor.members.find(m => m.publicKey === message.sender)?.name ?? 'Member', message.kind === 'sticker' ? 'Sticker' : message.content.slice(0, 500), message.createdAt, true);
      }
    if (syncError) throw syncError;
    if (replyError) throw new Error('A saved reply needs attention.');
    success = true; await native.healthy();
  } catch { await native.problem().catch(() => {}); /* Native WorkManager retries; no private logs. */ }
  finally { clearTimeout(timer); messenger?.suspend(); port?.close(); await native.finish(jobId, success); }
}
AppRegistry.registerHeadlessTask('LinkUpMessages', () => ({ jobId }: { jobId: string }) => {
  const work = queue.then(() => receive(jobId)); queue = work.catch(() => {}); return work;
});
