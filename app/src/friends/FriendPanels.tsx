import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVault } from '../security/VaultProvider';
import { fingerprint, inspectInvitation, invitationShareUrl, InviteDetails } from '../security/invitation';
import { Contact } from '../security/vaultCore';
import { InviteQR } from './InviteQR';

function usePanelStyles() {
  const { colors } = useAppearance();
  return { colors, text: { color: colors.ink, fontSize: 16, lineHeight: 25 }, helper: { color: colors.sub, fontSize: 13, lineHeight: 21 }, title: { color: colors.ink, fontSize: 28, lineHeight: 35, fontWeight: '600' as const, letterSpacing: -.6 }, card: { backgroundColor: colors.soft, padding: 22, borderRadius: 22, gap: 16 } };
}
function PanelButton({ label, onPress, disabled = false, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  const { colors } = useAppearance();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ padding: 16, minHeight: 54, borderRadius: controlRadius.button, alignItems: 'center', justifyContent: 'center', backgroundColor: secondary ? colors.secondary : colors.button, opacity: disabled ? .5 : pressed ? .82 : 1 })}><Text style={{ fontWeight: '600', fontSize: 16, color: secondary ? colors.ink : colors.onButton }}>{label}</Text></Pressable>;
}
function IdentityCode({ publicKey }: { publicKey: string }) { const { colors } = useAppearance(); return <Text selectable accessibilityLabel="Identity code" style={{ color: colors.ink, fontSize: 12, lineHeight: 21, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{fingerprint(publicKey)}</Text>; }
function VaultGate({ onVault }: { onVault: () => void }) {
  const vault = useVault(), s = usePanelStyles();
  return <View style={{ gap: 20 }}><Text style={s.title}>A place to connect.</Text><Text style={s.text}>{vault.status === 'preview' ? 'Set up your identity to invite friends and keep your contacts saved.' : 'Unlock your identity to invite friends and open your contacts.'}</Text><PanelButton label={vault.status === 'preview' ? 'Set up my identity' : 'Unlock my identity'} onPress={onVault} disabled={vault.status === 'loading'} /></View>;
}

export function InvitePanel({ onVault, onAdd }: { onVault: () => void; onAdd: () => void }) {
  const vault = useVault(), s = usePanelStyles();
  const [token, setToken] = useState(''), [details, setDetails] = useState<InviteDetails | null>(null), [problem, setProblem] = useState(''), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false);
  const link = token ? invitationShareUrl(token) : '';
  async function generate() { if (busy) return; setBusy(true); setProblem(''); try { const created = await vault.createInvite(); setDetails(inspectInvitation(created, Date.now())); setToken(created); setCopied(false); } catch (e) { setProblem(e instanceof Error ? e.message : 'Could not create your invitation.'); } finally { setBusy(false); } }
  async function copy() { try { const result = await Clipboard.setStringAsync(link); if (!result) throw new Error(); setCopied(true); setProblem(''); } catch { setProblem('Could not copy the link. You can select it below.'); } }
  return <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 44, gap: 24 }}>
    {vault.status !== 'unlocked' ? <VaultGate onVault={onVault} /> : <>
      <Text style={s.title}>Good chats start here.</Text><Text style={s.text}>Let a friend scan your code, or send them an invitation link. If they don’t have LinkUp, the link helps them install it first.</Text>
      {token && details ? <><View style={[s.card, { alignItems: 'center' }]}><Text style={{ ...s.text, fontWeight: '600' }}>{details.name}</Text><View style={{ backgroundColor: '#FFFFFF', padding: 8, borderRadius: 16, width: '100%', maxWidth: 268, aspectRatio: 1 }}><InviteQR value={link} /></View><Text style={s.helper}>Expires {new Date(details.expiresAt).toLocaleDateString()}</Text></View><PanelButton label={copied ? 'Link copied' : 'Copy invite link'} onPress={copy} /><Text selectable accessibilityLabel="Invitation link" style={{ ...s.helper, fontSize: 11 }}>{link}</Text><PanelButton label="Create another invite" onPress={generate} disabled={busy} secondary /></> : <PanelButton label={busy ? 'Creating invitation…' : 'Create my invitation'} onPress={generate} disabled={busy} />}
      <Text style={s.helper}>The link contains your display name and public identity. Anyone with it can add you until it expires.</Text>
    </>}
    <PanelButton label="I have a friend’s invite" onPress={onAdd} secondary />{problem ? <Text accessibilityRole="alert" style={{ color: s.colors.error }}>{problem}</Text> : null}
  </ScrollView>;
}

export function AddFriendPanel({ initialInput = '', onInputChange, onVault, onAdded }: { initialInput?: string; onInputChange: (value: string) => void; onVault: () => void; onAdded: () => void }) {
  const vault = useVault(), s = usePanelStyles();
  const [input, setInput] = useState(initialInput), [candidate, setCandidate] = useState<InviteDetails | null>(null), [problem, setProblem] = useState(''), [busy, setBusy] = useState(false), [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanHandled = useRef(false);
  const initialReview = useRef(initialInput);
  const inspect = useCallback((value: string) => { setProblem(''); setCandidate(null); setScanning(false); try { const details = inspectInvitation(value, Date.now()); if (`common:${details.publicKey}` === vault.identity) throw new Error('This is your own invitation. Ask your friend for theirs.'); if (vault.contacts.some(c => c.publicKey === details.publicKey)) throw new Error('This friend is already in your contacts.'); setCandidate(details); } catch (e) { setProblem(e instanceof Error ? e.message : 'This invitation could not be verified.'); } }, [vault.identity, vault.contacts]);
  useEffect(() => {
    if (!initialReview.current || vault.status === 'loading') return;
    const value = initialReview.current; initialReview.current = ''; inspect(value);
  }, [inspect, vault.status]);
  async function scan() { setProblem(''); scanHandled.current = false; try { const allowed = permission?.granted || (await requestPermission()).granted; if (allowed) setScanning(true); else setProblem('Camera access was declined. You can paste an invitation instead.'); } catch { setProblem('Camera unavailable. You can paste an invitation instead.'); } }
  async function accept() { if (busy) return; setBusy(true); setProblem(''); try { await vault.acceptInvite(input); setInput(''); setCandidate(null); onAdded(); } catch (e) { setCandidate(null); setProblem(e instanceof Error ? e.message : 'Could not save this friend.'); } finally { setBusy(false); } }
  return <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 44, gap: 22 }} keyboardShouldPersistTaps="handled">
    <>
      <Text style={s.title}>Meet you here.</Text>{!candidate && <><Text style={s.text}>Scan a friend’s QR code or paste their invitation.</Text>
      {scanning ? <><CameraView style={{ height: 300, borderRadius: 20, overflow: 'hidden' }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => { if (scanHandled.current) return; scanHandled.current = true; setInput(data); onInputChange(data); inspect(data); }} onMountError={() => { setScanning(false); setProblem('Camera unavailable. You can paste an invitation instead.'); }} /><PanelButton label="Cancel scan" onPress={() => setScanning(false)} secondary /></> : <PanelButton label="Scan a QR code" onPress={scan} secondary />}
      <TextInput accessibilityLabel="Friend invitation" placeholder="Paste an invitation link" placeholderTextColor={s.colors.sub} value={input} onChangeText={value => { setInput(value); onInputChange(value); setCandidate(null); setProblem(''); }} multiline autoCapitalize="none" autoCorrect={false} maxLength={2048} style={{ color: s.colors.ink, backgroundColor: s.colors.soft, borderRadius: 17, minHeight: 110, padding: 16, textAlignVertical: 'top', ...Platform.select({ web: { outlineWidth: 0, outlineStyle: 'solid' as const } }) }} /></>}
      {!candidate && <PanelButton label="Review invitation" onPress={() => inspect(input)} disabled={!input.trim() || busy} />}
      {candidate && <View style={s.card}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Feather name="user-check" size={28} color={s.colors.brand} /><Text style={{ ...s.title, flex: 1 }}>{candidate.name}</Text></View><Text style={s.helper}>Signed by this identity. Compare the code with your friend to confirm who sent it.</Text><IdentityCode publicKey={candidate.publicKey} /><Text style={s.helper}>Adding them saves their identity on this device. Messages can reach them through a nearby connection or a shared mailbox.</Text><PanelButton label={vault.status === 'unlocked' ? busy ? 'Adding friend…' : 'Add friend' : vault.status === 'preview' ? 'Set up to add friend' : 'Unlock to add friend'} onPress={vault.status === 'unlocked' ? accept : onVault} disabled={busy || vault.status === 'loading'} /><PanelButton label="Cancel" onPress={() => setCandidate(null)} secondary /></View>}
    </>{problem ? <Text accessibilityRole="alert" style={{ color: s.colors.error }}>{problem}</Text> : null}
  </ScrollView>;
}

export function FriendsPanel({ onVault, onInvite, onAdd, onChat }: { onVault: () => void; onInvite: () => void; onAdd: () => void; onChat: (contact: Contact) => void }) {
  const vault = useVault(), s = usePanelStyles(); const [selected, setSelected] = useState<Contact | null>(null);
  return <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 44, gap: 18 }}>
    <PanelButton label="Add a friend" onPress={onAdd} /><PanelButton label="Invite a friend" onPress={onInvite} secondary />
    {vault.status !== 'unlocked' ? <VaultGate onVault={onVault} /> : <>
      {!vault.contacts.length && <View style={{ paddingVertical: 32, gap: 12, alignItems: 'center' }}><Feather name="users" size={38} color={s.colors.brand} /><Text style={s.title}>Add your first friend.</Text><Text style={[s.helper, { textAlign: 'center' }]}>Your friends will appear here after you add their invitations.</Text></View>}
      {vault.contacts.map(contact => <Pressable key={contact.publicKey} accessibilityRole="button" accessibilityLabel={`View ${contact.name}`} onPress={() => setSelected(contact)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 76, padding: 14, backgroundColor: s.colors.soft, borderRadius: 20, opacity: pressed ? .8 : 1 })}><View style={{ height: 48, width: 48, borderRadius: 24, backgroundColor: s.colors.outgoing, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: s.colors.avatarText, fontSize: 20, fontWeight: '600' }}>{Array.from(contact.name)[0]?.toUpperCase()}</Text></View><View style={{ flex: 1, gap: 3 }}><Text style={{ ...s.text, fontWeight: '600' }}>{contact.name}</Text><Text style={s.helper}>Saved contact</Text></View><Feather name="chevron-right" size={20} color={s.colors.sub} /></Pressable>)}
      {selected && <View style={s.card}><Text style={s.title}>{selected.name}</Text><Text style={s.helper}>Identity code · compare with your friend</Text><IdentityCode publicKey={selected.publicKey} /><PanelButton label="Message friend" onPress={() => onChat(selected)} /><PanelButton label="Close identity" onPress={() => setSelected(null)} secondary /></View>}
    </>}
  </ScrollView>;
}
