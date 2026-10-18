import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Text, TextInput } from '../ui/Typography';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVault } from '../security/VaultProvider';
import { useMessaging } from './MessagingProvider';
import { MAX_GROUP_MEMBERS } from './groups';

export function NewGroupPanel({ onCreated }: { onCreated: (id: string) => void }) {
  const { colors } = useAppearance(), vault = useVault(), messaging = useMessaging();
  const [name, setName] = useState(''), [members, setMembers] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function create() {
    if (busy) return; setBusy(true); setError('');
    try { onCreated(await messaging.createGroup(name, members)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not create this group.'); } finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={s.panel} keyboardShouldPersistTaps="handled"><Text style={{ color: colors.sub }}>Group name</Text><TextInput accessibilityLabel="Group name" value={name} onChangeText={setName} maxLength={60} placeholder="Weekend plans" placeholderTextColor={colors.sub} style={[s.input, { color: colors.ink, backgroundColor: colors.soft }]} /><Text style={[s.title, { color: colors.ink }]}>Choose friends · {members.length}/{MAX_GROUP_MEMBERS - 1}</Text><Text style={{ color: colors.sub, lineHeight: 21 }}>Choose at least two friends. Everyone reviews the invitation before joining. Everyone needs LinkUp 0.2.1 or newer. Members need to add each other as friends.</Text>{vault.contacts.map(c => {
    const selected = members.includes(c.publicKey);
    return <Pressable key={c.publicKey} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={c.name} onPress={() => setMembers(items => selected ? items.filter(p => p !== c.publicKey) : items.length < MAX_GROUP_MEMBERS - 1 ? [...items, c.publicKey] : items)} style={[s.member, { backgroundColor: selected ? colors.secondary : colors.soft }]}><View style={[s.avatar, { backgroundColor: colors.outgoing }]}><Text style={{ color: colors.avatarText }}>{Array.from(c.name)[0]}</Text></View><Text style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: '600' }}>{c.name}</Text><Feather name={selected ? 'check-circle' : 'circle'} color={selected ? colors.brand : colors.sub} size={22} /></Pressable>;
  })}{!vault.contacts.length && <Text style={{ color: colors.sub }}>Add friends using their QR code or invite link first.</Text>}{!!error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}<Pressable accessibilityRole="button" disabled={busy || !name.trim() || members.length < 2} onPress={() => { void create(); }} style={[s.button, { backgroundColor: colors.button, opacity: busy || !name.trim() || members.length < 2 ? .5 : 1 }]}><Text style={{ color: colors.onButton, fontWeight: '700' }}>{busy ? 'Creating…' : 'Create group'}</Text></Pressable></ScrollView>;
}

export function GroupInfoPanel({ id, onJoined, onLeft }: { id: string; onJoined: () => void; onLeft: () => void }) {
  const { colors } = useAppearance(), vault = useVault(), messaging = useMessaging();
  const group = messaging.view.groups?.[id];
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function answer(join: boolean) {
    setBusy(true); setError('');
    try { await messaging.answerGroup(id, join); if (join) onJoined(); else onLeft(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your choice.'); } finally { setBusy(false); }
  }
  if (!group) return <View style={s.panel}><Text style={{ color: colors.sub }}>This group is unavailable. Unlock your vault to view it.</Text></View>;
  return <ScrollView contentContainerStyle={s.panel}><View style={[s.largeAvatar, { backgroundColor: colors.outgoing }]}><Feather name="users" size={36} color={colors.brand} /></View><Text style={[s.title, { color: colors.ink, textAlign: 'center', fontSize: 28 }]}>{group.descriptor.name}</Text><Text style={{ color: colors.sub, textAlign: 'center' }}>{group.descriptor.members.length} members · Encrypted messages</Text>{group.status === 'invited' && <Text style={{ color: colors.sub, lineHeight: 22 }}>You’ve been invited. Review everyone below before joining. Other members will see your messages and your identity.</Text>}{group.descriptor.members.map(m => <View key={m.publicKey} style={[s.member, { backgroundColor: colors.soft }]}><View style={[s.avatar, { backgroundColor: colors.outgoing }]}><Text style={{ color: colors.avatarText }}>{Array.from(m.name)[0]}</Text></View><View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{m.publicKey === vault.identity?.replace('common:', '') ? `${vault.profile.name} (you)` : vault.contacts.find(c => c.publicKey === m.publicKey)?.name ?? m.name}</Text><Text style={{ color: colors.sub, fontSize: 12 }}>{group.departed.includes(m.publicKey) ? 'Left the group' : m.publicKey === group.descriptor.owner ? 'Created this group' : vault.contacts.some(c => c.publicKey === m.publicKey) ? 'Friend' : m.publicKey === vault.identity?.replace('common:', '') ? '' : 'Add as a friend before joining'}</Text></View></View>)}{!!error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}{group.status === 'invited' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void answer(true); }} style={[s.button, { backgroundColor: colors.button }]}><Text style={{ color: colors.onButton, fontWeight: '700' }}>Join group</Text></Pressable>}{group.status !== 'left' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void answer(false); }} style={[s.button, { backgroundColor: colors.secondary }]}><Text style={{ color: colors.error }}>{group.status === 'invited' ? 'Decline invitation' : 'Leave group'}</Text></Pressable>}{group.status === 'left' && <Text style={{ color: colors.sub }}>You left this group.</Text>}<Text style={{ color: colors.sub, fontSize: 12, lineHeight: 19 }}>The member list is fixed in this version. Create a new group to change it. Group calls are still being built.</Text></ScrollView>;
}
const s = StyleSheet.create({ panel: { padding: 24, gap: 20, paddingBottom: 44 }, input: { borderRadius: 16, minHeight: 56, padding: 16, fontSize: 16 }, title: { fontWeight: '600', fontSize: 20, lineHeight: 28 }, member: { flexDirection: 'row', gap: 14, alignItems: 'center', minHeight: 72, paddingHorizontal: 16, borderRadius: 18 }, avatar: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' }, largeAvatar: { width: 92, height: 92, borderRadius: 46, justifyContent: 'center', alignItems: 'center', alignSelf: 'center' }, button: { minHeight: 54, borderRadius: controlRadius.button, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 } });
