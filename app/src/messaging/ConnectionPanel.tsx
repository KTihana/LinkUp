import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVault } from '../security/VaultProvider';
import { useMessaging } from './MessagingProvider';
import { VpnPanel } from '../vpn/VpnPanel';
import { useVpn } from '../vpn/VpnProvider';
import { NearbyPanel } from './NearbyPanel';
import { ensureMessagingCrypto } from './cryptoRuntime';
import { ConnectionButton, ConnectionIcon, connectionStyles, type ConnectionIconName } from './ConnectionUI';
import { mailboxAddressInput } from './mailboxClient';
import type { ConnectionView } from './connectionNavigation';

// Expo embeds this public service address in a distributed build; it contains no credentials.
const defaultMailbox = process.env.EXPO_PUBLIC_LINKUP_MAILBOX_URL?.trim() ?? '';

type Props = {
  view: ConnectionView; onView: (view: ConnectionView) => void; onBack: () => void;
  onVault: () => void; onFriends: () => void; initialNearbyInput?: string;
};

export function ConnectionPanel({ view, onView, onBack, onVault, onFriends, initialNearbyInput }: Props) {
  const { colors } = useAppearance(), vault = useVault();
  const s = connectionStyles(colors);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => subscription.remove();
  }, [onBack]);

  if (view === 'overview') return <ConnectionOverview onView={onView} onVault={onVault} />;
  return <ScrollView key={view} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    {vault.status !== 'unlocked' ? <>
      <View style={s.card}><ConnectionIcon name="lock" size={24} color={colors.brand} /><Text style={s.name}>Your identity comes first</Text>
        <Text style={s.body}>Create or unlock your identity to connect with friends and keep messages encrypted on this device.</Text></View>
      <ConnectionButton label={vault.status === 'preview' ? 'Create my identity' : 'Unlock my identity'} onPress={onVault} disabled={vault.status === 'loading'} />
    </> : view === 'mailbox' ? <MailboxPanel onNearby={() => onView('wifi')} /> : view === 'vpn' ? <VpnPanel onFriends={onFriends} initialInput={initialNearbyInput} /> : <NearbyPanel mode={view === 'nearby' ? 'all' : view} initialInput={initialNearbyInput} onFriends={onFriends} />}
  </ScrollView>;
}

function ConnectionOverview({ onView, onVault }: Pick<Props, 'onView' | 'onVault'>) {
  const { colors } = useAppearance(), vault = useVault(), messaging = useMessaging(), vpn = useVpn();
  const s = connectionStyles(colors);
  const [problem, setProblem] = useState(''), [working, setWorking] = useState(false), [checking, setChecking] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [encryptionChecked, setEncryptionChecked] = useState(false), inAction = useRef(false);
  const { nearby, view } = messaging;
  const status = messaging.internet.phase === 'online' ? `Internet P2P ready · ${messaging.internet.peers.length} friends online` : messaging.internet.phase === 'connecting' ? 'Connecting to the P2P network…' : nearby.phase === 'connected' ? nearby.kind === 'bluetooth' ? 'Bluetooth link ready' : nearby.kind === 'vpn' ? 'Private link ready' : 'Wi-Fi link ready'
    : nearby.phase === 'starting' ? 'Starting nearby…' : nearby.phase === 'waiting' ? 'Waiting for a friend'
    : view.policy === 'automatic' && view.enabled && view.endpoint ? messaging.busy ? 'Checking mailbox…' : messaging.problem ? 'Mailbox unreachable' : 'Mailbox configured'
    : 'Not connected';

  async function setPolicy(policy: 'automatic' | 'nearby-only') {
    if (vault.status !== 'unlocked') { onVault(); return; }
    if (inAction.current || !messaging.preferencesReady || view.policy === policy) return;
    inAction.current = true; setWorking(true); setProblem('');
    try { await messaging.setPolicy(policy); }
    catch (e) { setProblem(e instanceof Error ? e.message : 'Could not change message delivery.'); }
    finally { inAction.current = false; setWorking(false); }
  }
  async function checkEncryption() {
    if (inAction.current) return;
    inAction.current = true; setChecking(true); setProblem('');
    try { await ensureMessagingCrypto(); setEncryptionChecked(true); }
    catch (e) { setProblem(e instanceof Error ? e.message : 'Could not check device encryption.'); }
    finally { inAction.current = false; setChecking(false); }
  }
  function method(icon: ConnectionIconName, label: string, target: ConnectionView, value: string) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={`Open ${label} settings`} onPress={() => onView(target)}
      style={({ pressed }) => ({ minHeight: 66, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 14, opacity: pressed ? .6 : 1 })}>
      <ConnectionIcon name={icon} size={22} color={colors.brand} /><Text style={[s.body, { flex: 1, fontWeight: '600' }]}>{label}</Text>
      <Text style={s.small}>{value}</Text><ConnectionIcon name="chevron-right" size={24} color={colors.sub} />
    </Pressable>;
  }
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ paddingHorizontal: 24, paddingTop: 24, gap: 26 }}>
      <View accessibilityLiveRegion="polite" style={[s.card, { minHeight: 80, flexDirection: 'row', alignItems: 'center' }]}>
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><ConnectionIcon name="link" size={24} color={colors.brand} /></View>
        <View style={{ flex: 1, gap: 4 }}><Text style={s.name}>{status}</Text><Text style={s.small}>{view.queued} {view.queued === 1 ? 'message' : 'messages'} waiting</Text></View>
      </View>
      <View style={s.card}>
        <Text style={s.name}>Internet P2P</Text>
        <Text style={s.body}>{messaging.internetSupported ? 'LinkUp connects automatically. Add each other as friends and keep both apps open to chat. No mailbox, website or server setup.' : 'Automatic internet P2P is available in the updated Android app. Install it on both phones to connect without setup.'}</Text>
        <Text style={s.small}>Messages wait on your phone when your friend is offline and send when you are both connected.</Text>
        {messaging.internetSupported && (!view.enabled || view.policy === 'nearby-only' || !!messaging.internet.problem) && <ConnectionButton label="Resume internet P2P" onPress={() => { void messaging.resumeInternet().catch(error => setProblem(error instanceof Error ? error.message : 'Could not resume internet P2P.')); }} />}
        {messaging.internetSupported && view.enabled && view.policy !== 'nearby-only' && !view.endpoint && <ConnectionButton label="Pause internet connection" onPress={() => { void messaging.disconnect().catch(error => setProblem(error instanceof Error ? error.message : 'Could not pause internet P2P.')); }} secondary />}
        {view.endpoint && <Text style={s.small}>This account uses a custom mailbox. Manage it in More connection options.</Text>}
      </View>
      <View style={s.card}>
        <Text style={s.name}>Chat with someone nearby</Text>
        <Text style={s.body}>{Platform.OS === 'web' ? 'Use LinkUp on both Android phones for direct Wi-Fi, hotspot or Bluetooth messaging.' : 'No website, mailbox or internet needed. Add each other as friends, then connect your phones.'}</Text>
        <ConnectionButton label="Connect nearby" onPress={() => onView('wifi')} secondary />
        <Text style={s.small}>On the same Wi-Fi? One person starts; the other scans their connection code. Keep both apps open while chatting.</Text>
      </View>
      <ConnectionButton label={advanced ? 'Hide more options' : 'More connection options'} onPress={() => setAdvanced(value => !value)} secondary />
      {advanced && <>
        <View style={{ backgroundColor: colors.soft, borderRadius: 22, overflow: 'hidden' }}>
          {method('download-cloud', 'Optional mailbox', 'mailbox', view.endpoint ? 'Saved' : 'Advanced')}
          {method('bluetooth', 'Bluetooth', 'bluetooth', nearby.kind === 'bluetooth' ? nearby.phase === 'connected' ? 'Active' : 'Waiting' : 'Nearby')}
          {method('shield', 'Private network', 'vpn', vpn.status.connected ? 'Active' : vpn.status.configured ? 'Saved' : 'Set up')}
        </View>
        <View style={{ gap: 12 }}>
          <Text style={s.micro}>MESSAGE DELIVERY</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Message delivery" style={{ flexDirection: 'row', gap: 12 }}>{(['automatic', 'nearby-only'] as const).map(policy => <ConnectionButton key={policy}
            label={policy === 'automatic' ? 'Automatic' : 'Nearby only'} onPress={() => setPolicy(policy)} selected={view.policy === policy}
            secondary={view.policy !== policy} disabled={working || checking || (vault.status === 'unlocked' && !messaging.preferencesReady)} style={{ flex: 1 }} />)}</View>
          <Text style={s.small}>{view.policy === 'nearby-only' ? 'Internet delivery is off. Resume internet P2P above to connect automatically.' : 'Connects over the internet automatically. A custom mailbox is optional.'}</Text>
        </View>
        <ConnectionButton label={checking ? 'Checking encryption…' : encryptionChecked ? 'Encryption check passed' : 'Check device encryption'} onPress={checkEncryption} secondary disabled={working || checking} />
        {encryptionChecked && <Text accessibilityLiveRegion="polite" style={s.small}>This device can run LinkUp’s messaging encryption.</Text>}
      </>}
      {problem || messaging.internet.problem || messaging.problem ? <Text accessibilityRole="alert" style={s.error}>{problem || messaging.internet.problem || messaging.problem}</Text> : null}
    </View>
    <View style={{ flex: 1, minHeight: 1 }} />
    <View style={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 12 }}>
      <Text style={s.small}>Calls use Wi-Fi or internet. Bluetooth is for messages.</Text>
    </View>
  </ScrollView>;
}

function MailboxPanel({ onNearby }: { onNearby: () => void }) {
  const { colors } = useAppearance(), messaging = useMessaging(), s = connectionStyles(colors);
  const [url, setUrl] = useState(messaging.view.endpoint || defaultMailbox), [problem, setProblem] = useState(''), [working, setWorking] = useState(false);
  const inAction = useRef(false), nearbyActive = messaging.nearby.phase !== 'idle', nearbyOnly = messaging.view.policy === 'nearby-only';
  const ready = messaging.preferencesReady && !nearbyActive;
  const [editAddress, setEditAddress] = useState(!messaging.view.endpoint && !defaultMailbox);
  async function perform(task: () => Promise<void>) {
    if (inAction.current) return;
    inAction.current = true; setWorking(true); setProblem('');
    try { await task(); } catch (e) { setProblem(e instanceof Error ? e.message : 'Could not update your mailbox.'); }
    finally { inAction.current = false; setWorking(false); }
  }
  return <>
    <View style={s.card}><ConnectionIcon name="download-cloud" size={24} color={colors.brand} />
      <Text style={s.name}>{nearbyOnly ? 'Mailbox delivery is off' : messaging.view.enabled && messaging.view.endpoint ? 'Mailbox configured' : 'Set up a mailbox'}</Text>
      <Text style={s.small}>{messaging.view.queued} queued on this device</Text>
      <Text style={s.body}>A mailbox is a LinkUp delivery service, not an email account or a website you need to build. Both friends must add each other and use the same mailbox address.</Text>
    </View>
    {!messaging.view.endpoint && !defaultMailbox && <View style={s.card}><Text style={s.label}>Don’t have an address?</Text><Text style={s.body}>There is no default mailbox yet. Ask the person running your LinkUp service for its address. A normal website or email address will not work.</Text><ConnectionButton label="Use nearby instead" onPress={onNearby} secondary /></View>}
    {editAddress ? <View style={{ gap: 12 }}><Text style={s.label}>Mailbox address</Text>
      <TextInput accessibilityLabel="Mailbox address" value={url} onChangeText={setUrl} placeholder="https://mailbox.example.org" placeholderTextColor={colors.sub}
        autoCorrect={false} autoCapitalize="none" maxLength={300} keyboardType="url" editable={!working} style={s.input} />
    </View> : <View style={{ gap: 12 }}><Text style={s.small}>Service: {url}</Text><ConnectionButton label="Change service address" onPress={() => setEditAddress(true)} secondary disabled={working} /></View>}
    {nearbyOnly && <Text style={s.small}>Connecting will turn internet delivery on. Messages will retry automatically while LinkUp is open.</Text>}
    {nearbyActive && <Text style={s.small}>Stop the nearby session before changing mailbox delivery.</Text>}
    <ConnectionButton label={working ? 'Updating mailbox…' : messaging.view.endpoint && messaging.view.enabled && !nearbyOnly ? 'Reconnect mailbox' : 'Connect mailbox'} onPress={() => perform(() => messaging.connect(mailboxAddressInput(url)))}
      disabled={working || !url.trim() || !ready} />
    {messaging.view.enabled && <>
      <ConnectionButton label={messaging.busy ? 'Checking messages…' : 'Check messages now'} onPress={() => perform(messaging.sync)} secondary disabled={working || messaging.busy || !ready || nearbyOnly || !messaging.view.endpoint} />
      <ConnectionButton label="Pause delivery" onPress={() => perform(messaging.disconnect)} secondary disabled={working || nearbyActive || !messaging.preferencesReady} />
    </>}
    <Text style={s.small}>Queued means saved here. Stored means a mailbox or nearby device saved the encrypted packet. Delivered means your friend’s app confirmed receipt.</Text>
    {problem || messaging.problem ? <Text accessibilityRole="alert" style={s.error}>{problem || messaging.problem}</Text> : null}
  </>;
}
