// SPDX-License-Identifier: GPL-3.0-only
import { ThemedSwitch } from './ui/ThemedSwitch';
import { controlRadius } from './ui/shapes';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Modal, Platform, ScrollView, StatusBar, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text, TextInput } from './ui/Typography';
import { ChatBubbleIcon } from './ui/ChatBubbleIcon';
import { BrandLogo } from './brand/BrandLogo';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useVault } from './security/VaultProvider';
import { VaultPanel } from './security/VaultPanel';
import { AddFriendPanel, FriendsPanel, InvitePanel } from './friends/FriendPanels';
import { invitationSetupRoute, shouldResumeInvitation } from './friends/invitationNavigation';
import { isValidDisplayName } from './security/invitation';
import { useMessaging } from './messaging/MessagingProvider';
import { NewGroupPanel, GroupInfoPanel } from './messaging/GroupPanels';
import { notificationsNative } from './notifications/native';
import { NotificationsPanel } from './notifications/NotificationsPanel';
import { ConnectionPanel } from './messaging/ConnectionPanel';
import { connectionTitles, connectionViewFromParam, type ConnectionView } from './messaging/connectionNavigation';
import { cleanupGeneratedPhoto, cleanupPickerCopy } from './security/photoCleanup';
import { emojiItems } from './chatAssets';
import { isCustomSticker } from './stickers/content';
import { createCustomSticker } from './stickers/create';
import { UpdatesPanel } from './updates/UpdatesPanel';
import { useCalls } from './calls/CallsProvider';
import { useUpdates } from './updates/UpdatesProvider';
import { AppearancePanel } from './appearance/AppearancePanel';
import { useAppearance } from './appearance/AppearanceProvider';
import { Palette } from './appearance/palette';
import { MotionPressable as Pressable } from './ui/MotionPressable';
import { Entrance } from './ui/Entrance';
import { ConversationWelcome, WorkspaceRail } from './design/Workspace';
import { WebPolish } from './design/WebPolish';

type Screen = 'Chats' | 'Calls' | 'Friends' | 'You' | 'Conversation' | 'Edit profile' | 'Invite a friend' | 'Add friend' | 'Appearance' | 'Local vault' | 'Connection' | 'Updates' | 'New group' | 'Group info' | 'Notifications';
type Message = { id: string; content: string; mine: boolean; kind?: 'text' | 'sticker' | 'image' | 'group'; status?: 'queued' | 'stored' | 'delivered'; error?: string; createdAt?: number; sender?: string };
type ChatContact = { name: string; color: string; preview: string; time: string; unread: number; publicKey?: string; groupId?: string };
const contacts: ChatContact[] = [
  { name: 'Mia', color: '#E7EDFF', preview: 'That sounds perfect. See you soon.', time: '14:32', unread: 2 },
  { name: 'Luka', color: '#E7EDFF', preview: 'See you tomorrow.', time: '12:08', unread: 0 },
  { name: 'Nika', color: '#E7EDFF', preview: 'Let me know when you’re free.', time: 'Yesterday', unread: 0 },
  { name: 'Ivan', color: '#E7EDFF', preview: 'You: Thanks for the call!', time: 'Tue', unread: 0 },
  { name: 'Ana', color: '#E7EDFF', preview: 'You: On my way', time: 'Mon', unread: 0 },
];
const sampleTime = (minute: number) => new Date(new Date().setHours(14, minute, 0, 0)).getTime();
const samples: Message[] = [
  { id: '1', content: 'Coffee at four?', mine: false, createdAt: sampleTime(28) },
  { id: '2', content: 'The little place by the park.', mine: false, createdAt: sampleTime(28) },
  { id: '3', content: 'Sounds like a plan.', mine: true, createdAt: sampleTime(30) },
  { id: '5', content: 'That sounds perfect. See you soon.', mine: false, createdAt: sampleTime(32) },
];
type IconName = React.ComponentProps<typeof Feather>['name'];
function Icon({ name, color, size = 24, fit = false }: { name: IconName; color?: string; size?: number; fit?: boolean }) { const { colors } = useAppearance(); if (name === 'message-circle') return <ChatBubbleIcon color={color ?? colors.ink} size={size} />; return <Feather name={name} color={color ?? colors.ink} size={size} style={fit ? { width: size, height: size, lineHeight: size } : undefined} />; }
function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) { const { colors } = useAppearance(); const s = createStyles(colors); return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[s.button, secondary && s.secondary, disabled && { opacity: 0.5 }]}><Text style={[s.buttonText, secondary && { color: colors.ink }]}>{label}</Text></Pressable>; }
function Action({ icon, label, onPress, primary = false, disabled = false, fitIcon = false }: { icon: IconName; label: string; onPress: () => void; primary?: boolean; disabled?: boolean; fitIcon?: boolean }) { const { colors } = useAppearance(); const s = createStyles(colors); return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.action, primary && { backgroundColor: colors.button }, disabled && { opacity: .5 }]}><Icon name={icon} color={primary ? colors.onButton : colors.ink} fit={fitIcon} /></Pressable>; }
function Avatar({ name, photo, color, large = false }: { name: string; photo?: string; color?: string; large?: boolean }) { const { colors } = useAppearance(); const s = createStyles(colors); return <View style={[s.avatar, large && s.bigAvatar, { backgroundColor: color ?? colors.outgoing }]}>{photo ? <Image source={{ uri: photo }} style={s.avatarImage} accessibilityLabel={`${name}'s profile photo`} /> : <Text style={[s.initial, large && { fontSize: 38, lineHeight: 46, fontWeight: '800' }]}>{Array.from(name.trim())[0]?.toUpperCase() || '?'}</Text>}</View>; }

export default function CommonApp(props: { invitationInput?: string; nearbyInput?: string }) {
  const vault = useVault();
  return <><WebPolish /><AccountApp key={vault.generation} {...props} /></>;
}

function AccountApp({ invitationInput, nearbyInput }: { invitationInput?: string; nearbyInput?: string }) {
  const { preferences, colors } = useAppearance();
  const { width } = useWindowDimensions();
  const wide = width >= 1000;
  const s = createStyles(colors);
  const [search, setSearch] = useState('');
  const params = useLocalSearchParams<{ page?: string; screen?: string; connectionView?: string; peer?: string; group?: string; returnTo?: string }>();
  const vault = useVault();
  const messaging = useMessaging();
  const screens: Screen[] = ['Chats', 'Calls', 'Friends', 'You', 'Conversation', 'Edit profile', 'Invite a friend', 'Add friend', 'Appearance', 'Local vault', 'Connection', 'Updates', 'New group', 'Group info', 'Notifications'];
  const resumeInvitation = shouldResumeInvitation(invitationInput, params.returnTo, vault.status);
  const requestedScreen = resumeInvitation ? 'Add friend' : params.page ?? params.screen;
  useEffect(() => {
    if (resumeInvitation) router.setParams({ page: 'Add friend', screen: undefined, returnTo: undefined });
  }, [resumeInvitation]);
  const needsNativeUnlock = Platform.OS !== 'web' && (vault.status === 'locked' || vault.status === 'error' || vault.status === 'resetting');
  const screen: Screen = !needsNativeUnlock && requestedScreen === 'Conversation' && params.group && messaging.view.groups?.[params.group]?.status === 'invited' ? 'Group info' : needsNativeUnlock ? 'Local vault' : screens.includes(requestedScreen as Screen) ? requestedScreen as Screen : invitationInput !== undefined ? 'Add friend' : nearbyInput !== undefined ? 'Connection' : Platform.OS !== 'web' && vault.status === 'preview' ? 'Local vault' : 'Chats';
  // `screen` is reserved by the navigator and disappears from serialized URLs.
  // Accept old links, but write `page` so refresh preserves the selected view.
  const setScreen = (next: Screen) => { if ((invitationInput !== undefined && next !== 'Local vault' && next !== 'Add friend') || (nearbyInput !== undefined && next !== 'Local vault' && next !== 'Connection')) router.replace({ pathname: '/', params: { page: next } }); else router.setParams({ page: next, screen: undefined, connectionView: undefined, ...(next !== 'Conversation' && next !== 'Group info' ? { peer: undefined, group: undefined } : {}) }); };
  const connectionView = connectionViewFromParam(params.connectionView, nearbyInput !== undefined);
  const setConnectionView = (next: ConnectionView) => router.setParams({ page: 'Connection', screen: undefined, connectionView: next });
  const backFromConnection = () => connectionView === 'overview' ? setScreen('You') : setConnectionView('overview');
  const updates = useUpdates();
  const calls = useCalls();
  const startCall = (mode: 'voice' | 'video') => { if (!selected.publicKey) { setNotice('Add a friend and connect delivery to place a call.'); return; } void calls.controller.start(selected.publicKey, mode).catch(e => setNotice(e instanceof Error ? e.message : 'Could not start the call.')); };
  const { profile, online } = vault;
  const [draft, setDraft] = useState(profile);
  const setOnline = (value: boolean) => { void vault.setOnline(value).catch(e => setNotice(e instanceof Error ? e.message : 'Could not save this preference.')); };
  const [fallbackSelected, setSelected] = useState<ChatContact>(contacts[0]);
  const routedGroup = params.group ? messaging.view.groups?.[params.group] : undefined;
  const routedPeer = params.peer ? vault.contacts.find(c => c.publicKey === params.peer) : undefined;
  const archivedPeer = params.peer && /^[a-f0-9]{64}$/.test(params.peer) && messaging.view.conversations[params.peer] ? params.peer : undefined;
  const selected: ChatContact = params.group && /^[a-f0-9]{32}$/.test(params.group) ? { name: routedGroup?.descriptor.name ?? 'Group', groupId: params.group, color: colors.outgoing, preview: '', time: '', unread: 0 } : routedPeer ? { ...routedPeer, color: colors.outgoing, preview: '', time: '', unread: 0 } : archivedPeer ? { publicKey: archivedPeer, name: `Removed friend · ${archivedPeer.slice(0, 6)}`, color: colors.outgoing, preview: '', time: '', unread: 0 } : fallbackSelected;
  const removedFriend = vault.status === 'unlocked' && !!selected.publicKey && !vault.contacts.some(contact => contact.publicKey === selected.publicKey);
  const [chatFilter, setChatFilter] = useState<'all' | 'unread' | 'groups'>('all');
  const [newChatMenu, setNewChatMenu] = useState(false);
  const [readPreviewChats, setReadPreviewChats] = useState<string[]>([]);
  useEffect(() => {
    const thread = vault.status === 'unlocked' && screen === 'Conversation' ? selected.groupId ? `group:${selected.groupId}` : selected.publicKey ? `peer:${selected.publicKey}` : '' : '';
    void notificationsNative?.activeThread(thread).catch(() => {});
    if (thread) void notificationsNative?.clear(thread).catch(() => {});
    return () => { void notificationsNative?.activeThread('').catch(() => {}); };
  }, [screen, vault.status, selected.groupId, selected.publicKey]);
  const [history, setHistory] = useState<Record<string, Message[]>>({ Mia: samples });
  const conversationScroll = useRef<ScrollView>(null);
  const followLatest = useRef(true);
  const [message, setMessage] = useState('');
  const [picker, setPicker] = useState<'Emoji' | 'Stickers' | null>(null);
  const [stickers, setStickers] = useState<string[]>([]);
  const [creatingSticker, setCreatingSticker] = useState(false);
  const customStickers = useMemo(() => {
    const saved = [...Object.values(messaging.view.conversations).flatMap(c => c.messages), ...Object.values(messaging.view.groups ?? {}).flatMap(g => g.messages), ...Object.values(history).flat()];
    return [...new Set([...stickers, ...saved.filter(m => m.mine && m.kind === 'sticker').map(m => m.content)])].filter(isCustomSticker).slice(0, 24);
  }, [stickers, messaging.view.conversations, messaging.view.groups, history]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Clear temporary photo data when the vault locks.
  useEffect(() => { if (vault.status !== 'unlocked' && !(Platform.OS === 'web' && vault.status === 'preview')) setStickers([]); }, [vault.status]);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [friendInput, setFriendInput] = useState(invitationInput ?? '');
  const [chatOptions, setChatOptions] = useState(false);
  const [confirmRemoveFriend, setConfirmRemoveFriend] = useState(false);
  const [removingFriend, setRemovingFriend] = useState(false);
  const removing = useRef(false);
  const [isSending, setIsSending] = useState(false);
  const sending = useRef(false);
  const messages: Message[] = selected.groupId ? messaging.view.groups?.[selected.groupId]?.messages ?? [] : selected.publicKey ? messaging.view.conversations[selected.publicKey]?.messages ?? [] : history[selected.name] || [];
  const chatSecurity = selected.publicKey ? messaging.view.conversations[selected.publicKey]?.security : undefined;
  function openChat(contact: ChatContact) { followLatest.current = true; if (!contact.publicKey && !contact.groupId) setReadPreviewChats(previous => previous.includes(contact.name) ? previous : [...previous, contact.name]); setSelected(contact); setMessage(''); setPicker(null); router.setParams({ page: 'Conversation', screen: undefined, peer: contact.publicKey, group: contact.groupId }); }
  async function send(content: string, kind?: Message['kind']) {
    if (!content.trim() || sending.current) return;
    followLatest.current = true;
    if (removedFriend || removing.current) { setNotice('Add this friend again before sending a new message.'); return; }
    sending.current = true; setIsSending(true);
    try {
      if (selected.groupId) await messaging.sendGroup(selected.groupId, content.trim(), kind === 'sticker' ? 'sticker' : 'text');
      else if (selected.publicKey) await messaging.send(selected.publicKey, content.trim(), kind === 'sticker' ? 'sticker' : 'text');
      else setHistory(v => ({ ...v, [selected.name]: [...(v[selected.name] || []), { id: `${Date.now()}-${Math.random()}`, content: content.trim(), mine: true, kind, createdAt: Date.now() }] }));
      setMessage(current => current.trim() === content.trim() ? '' : current); setPicker(null);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not save your message.'); }
    finally { sending.current = false; setIsSending(false); }
  }
  async function removeFriend() {
    const peer = selected.publicKey;
    if (!peer || removing.current) return;
    removing.current = true; setRemovingFriend(true);
    // Stop active media immediately, before the encrypted contact write or any
    // network request. The messaging provider also suspends delivery and VPN.
    calls.controller.stop();
    try {
      const result = await messaging.removeFriend(peer);
      setMessage(''); setPicker(null); setChatOptions(false); setConfirmRemoveFriend(false); setNotice(result);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not remove this friend.'); }
    finally { removing.current = false; setRemovingFriend(false); }
  }
  async function save() { if (!draft.name.trim()) { setError('Please enter a display name.'); return; } if (!isValidDisplayName(draft.name.trim())) { setError('Use a name of up to 50 characters without line breaks or hidden direction controls.'); return; } try { await vault.saveProfile({ ...draft, name: draft.name.trim(), about: draft.about.trim() }); setScreen('You'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your profile.'); } }
  async function choosePhoto(target: 'profile' | 'sticker', camera = false) {
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) { setNotice('Camera access was declined. You can still choose a photo.'); return; }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8, exif: false };
      const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return;
      const image = result.assets[0];
      if (image.fileSize && image.fileSize > 5 * 1024 * 1024) { setNotice('Choose an image smaller than 5 MB.'); return; }
      if (target === 'profile') { const context = ImageManipulator.manipulate(image.uri); const side = Math.min(image.width, image.height); context.crop({ originX: (image.width - side) / 2, originY: (image.height - side) / 2, width: side, height: side }).resize({ width: 384, height: 384 }); const rendered = await context.renderAsync(); const photo = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true }); if (photo.uri !== image.uri) cleanupGeneratedPhoto(photo.uri); cleanupPickerCopy(image.uri); if (!photo.base64 || photo.base64.length > 700000) throw new Error('Photo too large.'); setDraft(v => ({ ...v, photo: `data:image/jpeg;base64,${photo.base64}` })); setPhotoMenu(false); } else {
        setCreatingSticker(true);
        try { const sticker = await createCustomSticker(image); setStickers(v => [sticker, ...v.filter(item => item !== sticker)].slice(0, 24)); }
        finally { setCreatingSticker(false); cleanupPickerCopy(image.uri); }
      }
    } catch { setNotice('The image could not be opened. Please try a different image.'); }
  }
  function header(title: string, back?: () => void, right?: React.ReactNode) { return <View style={[s.header, !back && s.largeHeader]}>{back && <Action icon="arrow-left" label="Back" onPress={back} fitIcon={screen === 'Connection'} />}<Text accessibilityRole="header" style={[s.headerTitle, !back && s.largeHeaderTitle]}>{title}</Text>{right}</View>; }
  function setting(label: string, icon: IconName, target: Screen, value = '') { return <Pressable accessibilityRole="button" accessibilityLabel={label} style={s.setting} onPress={() => setScreen(target)}><View style={s.settingIcon}><Icon name={icon} size={20} color={colors.brand} /></View><Text style={s.settingName}>{label}</Text>{!!value && <Text style={s.small}>{value}</Text>}<Icon name="chevron-right" color={colors.sub} /></Pressable>; }
  const realContacts: ChatContact[] = vault.contacts.map(c => { const recent = messaging.view.conversations[c.publicKey]?.messages.at(-1); return { ...c, color: colors.outgoing, preview: recent ? `${recent.mine ? 'You: ' : ''}${recent.kind === 'sticker' ? 'Sticker' : recent.content}` : 'No messages yet', time: recent ? new Date(recent.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '', unread: 0 }; });
  const archivedContacts: ChatContact[] = Object.entries(messaging.view.conversations).filter(([peer, conversation]) => conversation.messages.length && !vault.contacts.some(contact => contact.publicKey === peer)).map(([peer, conversation]) => ({ publicKey: peer, name: `Removed friend · ${peer.slice(0, 6)}`, color: colors.outgoing, preview: 'Saved messages · Read only', time: new Date(conversation.messages.at(-1)!.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), unread: 0 }));
  const demo = Platform.OS === 'web' && vault.status === 'preview';
  const chatContacts = demo ? contacts.map(c => ({ ...c, unread: readPreviewChats.includes(c.name) ? 0 : c.unread })) : [...realContacts, ...archivedContacts];

  const visibleContacts = chatFilter === 'groups' ? [] : chatContacts.filter(c => (chatFilter !== 'unread' || c.unread > 0) && [c.name, c.preview, ...(c.publicKey ? messaging.view.conversations[c.publicKey]?.messages ?? [] : history[c.name] ?? []).filter(m => !m.kind || m.kind === 'text').map(m => m.content)].some(value => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const activeGroups = Object.values(messaging.view.groups ?? {}).filter(g => g.status !== 'left' && chatFilter !== 'unread' && [g.descriptor.name, ...g.messages.filter(m => !m.kind || m.kind === 'text').map(m => m.content)].some(value => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const isTab = ['Chats', 'Calls', 'Friends', 'You'].includes(screen);
  const conversationList = <View style={[s.conversationList, wide && s.desktopList]}>

      <View style={s.chatsHeader}>{wide ? <Text style={s.spaceLabel}>Your conversations</Text> : <BrandLogo color={colors.brand} height={27} />}<Action icon="edit-3" label="New conversation" primary onPress={() => setNewChatMenu(true)} /></View>
      <View style={s.listTitleRow}><Text accessibilityRole="header" style={s.listTitle}>Chats</Text>{demo && <Text style={s.demoLabel}>Preview</Text>}</View>
      <View style={s.searchBar}><Icon name="search" size={18} color={colors.sub} /><TextInput accessibilityLabel="Search conversations" placeholder="Find a conversation" placeholderTextColor={colors.sub} value={search} onChangeText={setSearch} style={s.searchInput} />{!!search && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearch('')} style={s.searchClear}><Icon name="x" size={16} color={colors.sub} /></Pressable>}</View>
      <View style={s.filters}>{(demo ? ['all', 'unread', 'groups'] as const : ['all', 'groups'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: chatFilter === value }} onPress={() => setChatFilter(value)} style={[s.filter, chatFilter === value && { backgroundColor: colors.secondary }]}><Text style={{ color: chatFilter === value ? colors.brand : colors.sub, fontSize: 13, fontWeight: '600' }}>{value === 'all' ? 'All' : value === 'unread' ? 'Unread' : 'Groups'}</Text></Pressable>)}</View>
      <ScrollView contentContainerStyle={s.list}>
        {activeGroups.map(g => <Pressable key={g.descriptor.id} accessibilityRole="button" accessibilityLabel={`Open group ${g.descriptor.name}`} onPress={() => { openChat({ name: g.descriptor.name, groupId: g.descriptor.id, color: colors.outgoing, preview: '', time: '', unread: 0 }); if (g.status === 'invited') router.setParams({ page: 'Group info' }); }} style={[s.contact, wide && screen === 'Conversation' && selected.groupId === g.descriptor.id && s.selectedContact]}><View style={[s.avatar, { backgroundColor: colors.soft }]}><Icon name="users" color={colors.brand} /></View><View style={s.contactBody}><Text style={s.name}>{g.descriptor.name}</Text><Text style={s.snippet} numberOfLines={1}>{g.status === 'invited' ? 'Group invitation' : g.messages.at(-1)?.kind === 'sticker' ? 'Sticker' : g.messages.at(-1)?.content ?? `${g.descriptor.members.length} members`}</Text></View><Icon name="chevron-right" color={colors.sub} size={18} /></Pressable>)}
        {visibleContacts.map(c => <Pressable accessibilityRole="button" accessibilityLabel={`Open ${c.name}`} key={c.publicKey ?? c.name} onPress={() => openChat(c)} style={[s.contact, wide && screen === 'Conversation' && !selected.groupId && (c.publicKey ? selected.publicKey === c.publicKey : !selected.publicKey && selected.name === c.name) && s.selectedContact]}><Avatar name={c.name} color={colors.outgoing} /><View style={s.contactBody}><Text style={s.name}>{c.name}</Text><Text style={s.snippet} numberOfLines={1}>{c.publicKey ? c.preview : history[c.name]?.at(-1)?.mine ? `You: ${history[c.name]?.at(-1)?.kind ? 'Sent a sticker' : history[c.name]?.at(-1)?.content}` : c.preview}</Text></View><View style={s.contactMeta}><Text style={s.small}>{c.time}</Text>{!!c.unread && <View style={s.badge}><Text style={s.badgeText}>{c.unread}</Text></View>}</View></Pressable>)}
        {!visibleContacts.length && !activeGroups.length && <View style={s.chatEmpty}><View style={s.emptyIcon}><Icon name={chatFilter === 'groups' ? 'users' : 'message-circle'} color={colors.brand} size={28} /></View><Text style={s.panelTitle}>{search ? 'No conversations found' : chatFilter === 'unread' ? 'All caught up.' : chatFilter === 'groups' ? 'No groups yet' : 'No conversations yet'}</Text><Text style={s.helper}>{search ? 'Try another name or message.' : chatFilter === 'unread' ? 'Your unread conversations will appear here.' : chatFilter === 'groups' ? 'Bring your friends into one conversation.' : 'Invite a friend with a link or QR code.'}</Text>{!search && chatFilter !== 'unread' && <Button label={vault.status !== 'unlocked' ? 'Get started' : chatFilter === 'groups' ? 'Create a group' : 'Invite a friend'} onPress={() => setScreen(vault.status !== 'unlocked' ? 'Local vault' : chatFilter === 'groups' ? 'New group' : 'Invite a friend')} />}</View>}
      </ScrollView>
      {wide && <View style={s.listFoot}><Icon name={demo ? "eye" : "lock"} size={13} color={colors.sub} /><Text style={s.listFootText}>{demo ? 'Sample conversations' : 'End-to-end encrypted'}</Text></View>}
    </View>;
  return <SafeAreaView style={[s.outer, wide && s.desktopOuter]}><StatusBar barStyle={colors.dark ? 'light-content' : 'dark-content'} /><View style={[s.app, wide && s.desktopApp]}>
    {wide && <WorkspaceRail selected={screen} compact={width < 1280} name={profile.name} preview={demo} onNavigate={setScreen} />}
    {wide && (screen === 'Chats' || screen === 'Conversation') && conversationList}
    <View style={[s.mainContent, wide && screen !== 'Chats' && screen !== 'Conversation' && s.settingsContent]}>
    {updates.release && screen !== 'Updates' && <Pressable accessibilityRole="button" onPress={() => setScreen('Updates')} style={{ padding: 12, backgroundColor: colors.button }}><Text style={{ color: colors.onButton, textAlign: 'center' }}>LinkUp {updates.release.version} is available · View update</Text></Pressable>}
    {!wide && screen === 'Chats' && conversationList}
    {wide && screen === 'Chats' && <ConversationWelcome preview={demo} onCompose={() => setNewChatMenu(true)} onInvite={() => setScreen('Invite a friend')} />}

    {screen === 'Conversation' && <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.flex}><View style={s.chatHeader}>{!wide && <Action icon="arrow-left" label="Back to chats" onPress={() => setScreen('Chats')} />}<Avatar name={selected.name} color={colors.outgoing} /><View style={s.flex}><Text style={s.name} numberOfLines={1}>{selected.name}</Text><Text style={s.small}>{!selected.publicKey && !selected.groupId ? 'Preview conversation' : selected.groupId ? 'Your group conversation' : removedFriend ? 'Saved conversation' : 'Your private conversation'}</Text></View>{selected.groupId ? <Action icon="users" label="Group info" onPress={() => setScreen('Group info')} /> : <><Action icon="phone" label="Voice call" disabled={removedFriend || removingFriend} onPress={() => startCall('voice')} /><Action icon="video" label="Video call" disabled={removedFriend || removingFriend} onPress={() => startCall('video')} /></>}{selected.publicKey && !removedFriend && <Action icon="more-horizontal" label="Chat options" onPress={() => { setConfirmRemoveFriend(false); setChatOptions(true); }} />}</View><ScrollView ref={conversationScroll} onContentSizeChange={() => { if (followLatest.current) conversationScroll.current?.scrollToEnd({ animated: false }); }} onScroll={({ nativeEvent: e }) => { followLatest.current = e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 100; }} scrollEventThrottle={100} style={s.flex} contentContainerStyle={s.messages} keyboardShouldPersistTaps="handled">{!removedFriend && chatSecurity && chatSecurity !== 'ready' && <View style={{ padding: 16, gap: 10, borderRadius: 14, backgroundColor: colors.soft }}><Text style={s.helper}>{chatSecurity === 'refreshing' ? 'Refreshing encryption keys. New messages will wait until your friend confirms the update.' : chatSecurity === 'legacy' ? 'Update LinkUp on both phones, then reconnect this chat to enable key renewal. Your saved messages stay here.' : 'The encryption update could not finish. Reconnect this chat on both phones before sending again.'}</Text>{chatSecurity !== 'refreshing' && <Button label="Reconnect chat" secondary onPress={() => { setConfirmRemoveFriend(false); setChatOptions(true); }} />}</View>}<Text style={s.date}>{selected.publicKey || selected.groupId ? 'Messages' : 'Today'}</Text>{messages.map(m => <View key={`${m.sender ?? ''}:${m.id}`} style={[s.messageWrap, m.mine && { alignSelf: 'flex-end' }]}>{selected.groupId && !m.mine && <Text style={s.small}>{vault.contacts.find(contact => contact.publicKey === m.sender)?.name ?? routedGroup?.descriptor.members.find(member => member.publicKey === m.sender)?.name ?? 'Member'}</Text>}{m.kind === 'image' ? <Image source={{ uri: m.content }} style={s.messageImage} accessibilityLabel="Custom sticker" /> : m.kind === 'sticker' ? isCustomSticker(m.content) ? <Image source={{ uri: m.content }} style={s.messageImage} accessibilityLabel="Custom sticker" /> : <Text style={s.helper}>Sticker from an earlier version</Text> : <View style={[s.bubble, m.mine && s.outBubble]}><Text style={s.messageText}>{m.content}</Text></View>}<Text style={[s.receipt, m.mine && { textAlign: 'right' }]}>{m.createdAt ? `${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.mine ? ' · ' : ''}` : ''}{m.mine ? selected.publicKey || selected.groupId ? m.error || (m.status === 'delivered' ? 'Delivered' : m.status === 'stored' ? 'Stored' : 'Queued on this device') : 'Preview' : ''}</Text></View>)}{!messages.length && <Text style={s.empty}>{selected.publicKey || selected.groupId ? 'Send your first message.' : 'Try your first preview message.'}</Text>}</ScrollView>{!removedFriend && picker && <View style={s.picker}><View style={s.between}><View style={s.inline}>{(['Emoji', 'Stickers'] as const).map(p => <Pressable key={p} accessibilityRole="button" onPress={() => setPicker(p)} style={s.filter}><Text style={{ color: p === picker ? colors.link : colors.sub, fontWeight: '600' }}>{p}</Text></Pressable>)}</View><Action icon="x" label="Close picker" onPress={() => setPicker(null)} /></View><View style={s.emojiGrid}>{picker === 'Emoji' ? emojiItems.map(e => <Pressable key={e.name} accessibilityRole="button" accessibilityLabel={`Add emoji ${e.name}`} onPress={() => setMessage(v => v + e.symbol)} style={s.emojiButton}><Image source={e.source} style={{ width: 32, height: 32 }} /></Pressable>) : customStickers.map((uri, i) => <Pressable key={uri} accessibilityRole="button" accessibilityLabel={`Send custom sticker ${i + 1}`} disabled={isSending} onPress={() => send(uri, 'sticker')} style={s.emojiButton}><Image source={{ uri }} style={s.stickerThumb} /></Pressable>)}</View>{picker === 'Stickers' && <>{!customStickers.length && <Text style={s.helper}>Create a sticker from a photo.</Text>}<Button label={creatingSticker ? 'Creating sticker…' : 'Create sticker'} secondary disabled={creatingSticker} onPress={() => choosePhoto('sticker')} /></>}</View>}{!removedFriend && (selected.publicKey || selected.groupId) && !messaging.view.enabled && <Pressable accessibilityRole="button" accessibilityLabel="Choose message delivery" onPress={() => setScreen('Connection')} style={{ backgroundColor: colors.button, padding: 12 }}><Text style={{ color: colors.onButton, textAlign: 'center', fontSize: 13 }}>Choose a nearby connection or mailbox to deliver messages</Text></Pressable>}<View style={s.composer}>{removedFriend ? <View style={{ flex: 1, gap: 12 }}><Text style={s.helper}>This friend was removed. Your saved messages are kept here. Add them again to start a new encrypted conversation.</Text><Button label="Add friend again" secondary onPress={() => setScreen('Add friend')} /></View> : <View style={s.composeBar}><Action icon="plus" label="Sticker picker" onPress={() => setPicker(picker === 'Stickers' ? null : 'Stickers')} /><TextInput accessibilityLabel="Message" placeholder="Message…" placeholderTextColor={colors.sub} value={message} onChangeText={setMessage} maxLength={1800} multiline style={s.messageInput} /><Action icon="smile" label="Emoji picker" onPress={() => setPicker(picker === 'Emoji' ? null : 'Emoji')} /><Action icon="arrow-up" label={selected.publicKey || selected.groupId ? 'Send message' : 'Send preview message'} primary disabled={isSending || !message.trim() || (!!selected.groupId && routedGroup?.status !== 'joined')} onPress={() => send(message)} /></View>}</View></KeyboardAvoidingView>}
    {screen === 'Friends' && <>{header('Friends', undefined, <Action icon="user-plus" label="Invite a friend" onPress={() => setScreen('Invite a friend')} />)}<FriendsPanel onVault={() => setScreen('Local vault')} onInvite={() => setScreen('Invite a friend')} onAdd={() => setScreen('Add friend')} onChat={contact => openChat({ ...contact, color: colors.outgoing, preview: 'No messages yet', time: '', unread: 0 })} /></>}
    {screen === 'Calls' && <>{header('Calls')}<Entrance style={s.emptyPanel}><View style={s.callArtwork}><Icon name="phone" color={colors.brand} size={36} /></View><Text style={s.emptyTitle}>Voice and video calls</Text><Text style={s.helper}>Open a conversation to start an encrypted voice or video call. Both people need to keep LinkUp open.</Text><Button label="Browse friends" secondary onPress={() => setScreen('Friends')} /></Entrance></>}
    {screen === 'You' && <>{header('You')}<ScrollView contentContainerStyle={s.profile}>
      <View style={s.profileHero}><Avatar name={profile.name} photo={profile.photo} large /><View style={s.flex}><Text style={s.profileName}>{profile.name}</Text>{!!profile.about && <Text style={s.bio}>{profile.about}</Text>}<Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={() => { setDraft(profile); setError(''); setScreen('Edit profile'); }} style={{ paddingVertical: 8 }}><Text style={s.save}>Edit profile</Text></Pressable></View><Action icon="grid" label="My invitation QR code" onPress={() => setScreen('Invite a friend')} /></View>
      <Text style={s.sectionLabel}>Preferences</Text><View style={s.settingsGroup}>{setting('Appearance', 'sun', 'Appearance', preferences.theme)}{setting('App lock', 'lock', 'Local vault')}{setting('Notifications', 'bell', 'Notifications')}</View>
      <Text style={s.sectionLabel}>Connection</Text><View style={s.settingsGroup}>{setting('Connection', 'wifi', 'Connection')}{setting('Invite a friend', 'user-plus', 'Invite a friend')}{setting('Updates', 'download-cloud', 'Updates', updates.release?.version ?? '')}</View>
      <View style={s.setting}><Icon name="activity" size={21} /><View style={s.flex}><Text style={s.settingName}>Online status</Text><Text style={s.small}>Sharing is not enabled yet</Text></View><ThemedSwitch accessibilityLabel="Show when I’m online" value={online} onValueChange={setOnline} /></View>
      <Text style={s.buildLabel}>LinkUp</Text>
    </ScrollView></>}

    {screen === 'New group' && <>{header('New group', () => setScreen('Chats'))}<NewGroupPanel onCreated={id => { router.setParams({ page: 'Conversation', group: id, peer: undefined }); }} /></>}
    {screen === 'Group info' && <>{header('Group info', () => setScreen('Chats'))}<GroupInfoPanel id={params.group ?? ''} onJoined={() => setScreen('Conversation')} onLeft={() => setScreen('Chats')} /></>}
    {screen === 'Notifications' && <>{header('Notifications', () => setScreen('You'))}<NotificationsPanel /></>}
    {screen === 'Local vault' && <>{vault.status === 'unlocked' && header('App lock', () => setScreen('You'))}<VaultPanel /></>}
    {screen === 'Connection' && <>{header(connectionTitles[connectionView], backFromConnection)}<ConnectionPanel view={connectionView} onView={setConnectionView} onBack={backFromConnection} onVault={() => setScreen('Local vault')} onFriends={() => setScreen('Add friend')} initialNearbyInput={nearbyInput} /></>}
    {screen === 'Updates' && <>{header('Updates', () => setScreen('You'))}<UpdatesPanel /></>}
    {screen === 'Appearance' && <>{header('Appearance', () => setScreen('You'))}<AppearancePanel onClose={() => setScreen('You')} /></>}
    {screen === 'Edit profile' && <>{header('Edit profile', () => setScreen('You'), <Pressable accessibilityRole="button" accessibilityLabel="Save profile" onPress={save} style={s.action}><Text style={s.save}>Save</Text></Pressable>)}<ScrollView contentContainerStyle={s.editProfile} keyboardShouldPersistTaps="handled"><Pressable accessibilityRole="button" accessibilityLabel="Change profile photo" onPress={() => setPhotoMenu(true)} style={s.photoEdit}><Avatar name={draft.name} photo={draft.photo} large /></Pressable><Pressable accessibilityRole="button" onPress={() => setPhotoMenu(true)}><View style={s.uploadPhoto}><Icon name="camera" color={colors.brand} size={20} /><Text style={s.changePhoto}>Upload photo</Text></View></Pressable><View style={s.field}><Text style={s.label}>Display name</Text><TextInput accessibilityLabel="Display name" value={draft.name} onChangeText={name => setDraft(v => ({ ...v, name }))} maxLength={50} style={s.input} />{!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}</View><View style={s.field}><Text style={s.label}>About</Text><TextInput accessibilityLabel="About you" value={draft.about} onChangeText={about => setDraft(v => ({ ...v, about }))} maxLength={160} multiline placeholder="About you…" placeholderTextColor={colors.sub} style={[s.input, { minHeight: 108, textAlignVertical: 'top' }]} /></View></ScrollView></>}
    {screen === 'Invite a friend' && <>{header('Invite a friend', () => setScreen('Friends'))}<InvitePanel onVault={() => setScreen('Local vault')} onAdd={() => setScreen('Add friend')} /></>}
    {screen === 'Add friend' && <>{header('Add friend', () => setScreen('Friends'))}<AddFriendPanel initialInput={friendInput} onInputChange={setFriendInput} onVault={() => router.replace(invitationSetupRoute(friendInput))} onAdded={() => { setFriendInput(''); setScreen('Friends'); }} /></>}
    {!wide && isTab && <View style={s.tabs}>{(['Chats', 'Calls', 'Friends', 'You'] as const).map((t, i) => <Pressable key={t} accessibilityRole="button" accessibilityState={{ selected: screen === t }} onPress={() => setScreen(t)} style={[s.tab, screen === t && { backgroundColor: colors.secondary }]}><View style={s.tabIcon}><Icon name={(['message-circle', 'phone', 'users', 'user'] as IconName[])[i]} color={screen === t ? colors.brand : colors.sub} size={21} /></View><Text style={[s.tabLabel, screen === t && { color: colors.brand }]}>{t}</Text></Pressable>)}</View>}
    </View>
    <Modal visible={newChatMenu} transparent animationType="slide" onRequestClose={() => setNewChatMenu(false)}><View style={s.modalBackground}><Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={() => setNewChatMenu(false)} /><View style={s.sheet}><Text style={s.panelTitle}>New conversation</Text><Button label="Invite a friend" onPress={() => { setNewChatMenu(false); setScreen('Invite a friend'); }} /><Button label="New group" secondary onPress={() => { setNewChatMenu(false); setScreen('New group'); }} /><Button label="Cancel" secondary onPress={() => setNewChatMenu(false)} /></View></View></Modal>
    <Modal visible={chatOptions} transparent animationType="slide" onRequestClose={() => { if (!removingFriend) setChatOptions(false); }}><View style={s.modalBackground}><Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close chat options" disabled={removingFriend} onPress={() => setChatOptions(false)} /><View style={s.sheet}>
      {confirmRemoveFriend ? <>
        <Text style={s.panelTitle}>Remove {selected.name}?</Text>
        <Text style={s.helper}>Your saved messages stay here. Unsent messages are cancelled, calls stop, and new messages from this friend are blocked on this phone.</Text>
        <Text style={s.helper}>Mailbox access is revoked when you next connect to it. Messages already sent may still arrive and remain on your friend’s phone. A private-network administrator must separately remove their VPN access.</Text>
        <Button label={removingFriend ? 'Removing…' : 'Remove friend'} disabled={removingFriend} onPress={() => void removeFriend()} />
        <Button label="Keep friend" secondary disabled={removingFriend} onPress={() => setConfirmRemoveFriend(false)} />
      </> : <>
        <Text style={s.panelTitle}>Chat options</Text><Text style={s.helper}>If setup expired, reconnect on both devices, then have one person send first. Your saved messages stay here; queued messages need to be sent again.</Text><Button label="Reconnect this chat" onPress={async () => { setChatOptions(false); if (!selected.publicKey) return; try { await messaging.reconnect(selected.publicKey); setNotice('Reconnect this chat on your friend’s device too, then have one person send first. Previous queued messages can be copied and sent again.'); } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not reconnect this chat.'); } }} />
        <Button label="Remove friend" secondary onPress={() => setConfirmRemoveFriend(true)} />
        <Button label="Cancel" secondary onPress={() => setChatOptions(false)} />
      </>}
    </View></View></Modal>
    <Modal visible={photoMenu} transparent animationType="slide" onRequestClose={() => setPhotoMenu(false)}><View style={s.modalBackground}><Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close photo options" onPress={() => setPhotoMenu(false)} /><View style={s.sheet}><Text style={s.panelTitle}>Profile photo</Text><Button label="Upload a photo" secondary onPress={() => choosePhoto('profile')} /><Button label="Take a photo" secondary onPress={() => choosePhoto('profile', true)} />{draft.photo && <Pressable accessibilityRole="button" onPress={() => { setDraft(v => ({ ...v, photo: undefined })); setPhotoMenu(false); }} style={s.textButton}><Text style={{ color: colors.error }}>Remove current photo</Text></Pressable>}<Pressable accessibilityRole="button" onPress={() => setPhotoMenu(false)} style={s.textButton}><Text style={s.save}>Cancel</Text></Pressable></View></View></Modal>
    <Modal visible={!!notice} transparent animationType="fade" onRequestClose={() => setNotice('')}><View style={s.noticeBackground}><View style={s.notice}><Text style={s.panelTitle}>LinkUp</Text><Text style={s.helper}>{notice}</Text><Button label="Got it" onPress={() => setNotice('')} /></View></View></Modal>
  </View></SafeAreaView>;
}

const createStyles = (c: Palette) => StyleSheet.create({
  desktopOuter: { padding: 20 }, desktopApp: { maxWidth: 1600, flexDirection: 'row', borderRadius: 28, overflow: 'hidden', borderWidth: 1, borderColor: c.line, boxShadow: '0 20px 70px rgba(24,40,90,0.07)' },
  mainContent: { flex: 1, minWidth: 0, minHeight: 0 }, settingsContent: { maxWidth: 820, marginHorizontal: 'auto' }, conversationList: { flex: 1, minHeight: 0, backgroundColor: c.paper }, desktopList: { flexGrow: 0, flexShrink: 0, flexBasis: 354, width: 354, borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.line },
  largeHeader: { paddingTop: 20, paddingBottom: 12, minHeight: 108, paddingHorizontal: 28 }, largeHeaderTitle: { fontSize: 36, lineHeight: 44, fontWeight: '600', letterSpacing: -1.3 }, spaceLabel: { color: c.sub, fontSize: 13 }, listSubtitle: { color: c.sub, fontSize: 13, lineHeight: 21, marginTop: 5, marginHorizontal: 28 },
  searchBar: { minHeight: 46, marginHorizontal: 26, marginTop: 24, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.soft, borderRadius: 15 }, searchInput: { flex: 1, minWidth: 0, height: 46, fontSize: 14, color: c.ink }, searchClear: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', marginRight: -12 }, selectedContact: { backgroundColor: c.soft },
  listFoot: { flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 18 }, listFootText: { fontSize: 11, color: c.sub, lineHeight: 17 }, settingIcon: { width: 34, height: 34, backgroundColor: c.paper, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }, callArtwork: { width: 108, height: 108, borderRadius: 42, backgroundColor: c.outgoing, alignItems: 'center', justifyContent: 'center', marginBottom: 12, transform: [{ rotate: '-8deg' }] }, emptyTitle: { fontSize: 34, lineHeight: 40, letterSpacing: -1, fontWeight: '500', color: c.ink, textAlign: 'center' },
  outer: { flex: 1, backgroundColor: c.outer, alignItems: 'center' }, app: { flex: 1, width: '100%', maxWidth: 720, backgroundColor: c.paper }, flex: { flex: 1, minWidth: 0, minHeight: 0 },
  header: { minHeight: 84, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 10 }, headerTitle: { flex: 1, fontSize: 25, lineHeight: 34, fontWeight: '700', letterSpacing: -.6, color: c.ink },
  chatsHeader: { minHeight: 85, paddingHorizontal: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, action: { width: 44, height: 44, borderRadius: controlRadius.button, justifyContent: 'center', alignItems: 'center' },
  listTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 28, marginTop: 4 }, listTitle: { color: c.ink, fontSize: 38, lineHeight: 46, fontWeight: '600', letterSpacing: -1.4 }, demoLabel: { color: c.sub, fontSize: 11, backgroundColor: c.soft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  filters: { flexDirection: 'row', gap: 5, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 16 }, filter: { minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 19, borderRadius: 22 },
  listHeading: { paddingHorizontal: 22, color: c.sub, fontSize: 12 }, list: { paddingHorizontal: 12, paddingBottom: 24 }, contact: { minHeight: 90, flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 17, paddingHorizontal: 14, borderRadius: 18, marginBottom: 4 }, contactBody: { flex: 1, gap: 5 }, contactMeta: { width: 52, alignItems: 'flex-end', gap: 9 }, between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, inline: { flexDirection: 'row' }, name: { fontSize: 16, lineHeight: 23, fontWeight: '600', color: c.ink }, snippet: { fontSize: 14, lineHeight: 21, color: c.sub }, small: { fontSize: 11, lineHeight: 17, color: c.sub, fontWeight: '400' },
  avatar: { width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }, bigAvatar: { width: 88, height: 88, borderRadius: 44 }, initial: { color: c.avatarText, fontSize: 21, lineHeight: 30, fontWeight: '600' }, avatarImage: { width: '100%', height: '100%', resizeMode: 'cover' }, badge: { minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' }, badgeText: { fontSize: 11, color: c.onBrand, fontWeight: '600' },
  tabs: { flexDirection: 'row', padding: 6, marginHorizontal: 18, marginTop: 6, marginBottom: 12, borderRadius: 32, backgroundColor: c.tabBackground, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, boxShadow: '0 5px 22px rgba(24,40,90,0.06)' }, tab: { flex: 1, minHeight: 56, borderRadius: 26, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 4 }, tabIcon: { width: 46, height: 31, alignItems: 'center', justifyContent: 'center' }, tabLabel: { color: c.sub, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  button: { backgroundColor: c.button, borderRadius: controlRadius.button, padding: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center' }, secondary: { backgroundColor: c.soft }, buttonText: { color: c.onButton, fontSize: 14, lineHeight: 21, fontWeight: '600' }, textButton: { padding: 14, alignItems: 'center' }, helper: { fontSize: 15, color: c.sub, lineHeight: 24 }, empty: { padding: 24, textAlign: 'center', color: c.sub }, emptyPanel: { flex: 1, padding: 32, justifyContent: 'center', alignItems: 'center', gap: 22, maxWidth: 480, width: '100%', alignSelf: 'center' }, chatEmpty: { paddingVertical: 52, gap: 15 }, emptyIcon: { width: 64, height: 64, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: c.outgoing, marginBottom: 6 }, panelTitle: { fontSize: 23, lineHeight: 31, color: c.ink, fontWeight: '600', letterSpacing: -.5 },
  chatHeader: { minHeight: 86, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.line }, messages: { padding: 28, paddingBottom: 36, gap: 20, flexGrow: 1 }, date: { color: c.sub, fontSize: 12, lineHeight: 17, fontWeight: '500', textAlign: 'center', paddingVertical: 8 }, messageWrap: { maxWidth: '85%', alignSelf: 'flex-start', gap: 5 }, bubble: { borderRadius: 19, borderBottomLeftRadius: 6, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.incoming }, outBubble: { backgroundColor: c.outgoing, borderBottomLeftRadius: 19, borderBottomRightRadius: 6 }, messageText: { fontSize: 16, color: c.ink, lineHeight: 25 }, receipt: { color: c.sub, fontSize: 11, lineHeight: 16, paddingHorizontal: 2 }, messageImage: { width: 104, height: 104, resizeMode: 'contain' }, composer: { padding: 18, paddingBottom: 20 }, composeBar: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 2, padding: 5, borderRadius: 30, backgroundColor: c.soft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line }, messageInput: { flex: 1, minWidth: 0, height: 44, paddingVertical: 10, maxHeight: 120, fontSize: 15, lineHeight: 23, color: c.ink,  }, picker: { backgroundColor: c.soft, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, gap: 12 }, emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, emojiButton: { minWidth: 52, minHeight: 52, alignItems: 'center', justifyContent: 'center' }, stickerThumb: { width: 64, height: 64, resizeMode: 'contain' },
  profile: { padding: 24, paddingBottom: 40 }, profileHero: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingVertical: 24, marginBottom: 28 }, profileName: { fontSize: 25, lineHeight: 34, fontWeight: '700', letterSpacing: -.6, color: c.ink }, bio: { color: c.sub, fontSize: 13, lineHeight: 20, marginTop: 3 }, settings: { alignSelf: 'stretch' }, settingsGroup: { marginBottom: 30, backgroundColor: c.soft, borderRadius: 24, paddingHorizontal: 16, overflow: 'hidden' }, sectionLabel: { color: c.sub, fontSize: 13, lineHeight: 20, fontWeight: '500', marginBottom: 12, paddingLeft: 5 }, setting: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line }, settingName: { fontSize: 15, lineHeight: 22, color: c.ink, flex: 1 }, divider: { height: 1, backgroundColor: c.line, marginVertical: 8 }, buildLabel: { color: c.sub, fontSize: 11, marginTop: 30, textAlign: 'center' },
  editProfile: { padding: 22, gap: 22, paddingBottom: 44 }, photoEdit: { alignSelf: 'center' }, uploadPhoto: { minHeight: 44, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, changePhoto: { color: c.brand, fontWeight: '600', fontSize: 14 }, field: { gap: 9 }, label: { fontSize: 12, lineHeight: 18, fontWeight: '500', color: c.sub }, input: { minHeight: 56, backgroundColor: c.soft, borderRadius: 12, padding: 16, fontSize: 15, lineHeight: 23, color: c.ink }, save: { color: c.brand, fontSize: 13, fontWeight: '600' }, error: { color: c.error, fontSize: 13 },
  modalBackground: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', backgroundColor: '#15254D55' }, sheet: { backgroundColor: c.paper, borderTopLeftRadius: 30, borderTopRightRadius: 30, padding: 28, paddingBottom: 34, gap: 14, maxWidth: 480, width: '100%' }, noticeBackground: { flex: 1, backgroundColor: '#0B132B66', justifyContent: 'center', alignItems: 'center', padding: 24 }, notice: { maxWidth: 400, width: '100%', borderRadius: 20, padding: 24, backgroundColor: c.paper, gap: 18 },
});
