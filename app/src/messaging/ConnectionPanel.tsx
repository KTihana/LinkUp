// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVault } from '../security/VaultProvider';
import { useMessaging } from './MessagingProvider';
import { VpnPanel } from '../vpn/VpnPanel';
import { useVpn } from '../vpn/VpnProvider';
import { NearbyPanel } from './NearbyPanel';
import { ensureMessagingCrypto } from './cryptoRuntime';
import { ConnectionButton, ConnectionIcon, connectionStyles, type ConnectionIconName } from './ConnectionUI';
import type { ConnectionView } from './connectionNavigation';

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
    </> : view === 'mailbox' ? <MailboxPanel /> : view === 'vpn' ? <VpnPanel onFriends={onFriends} initialInput={initialNearbyInput} /> : <NearbyPanel mode={view === 'nearby' ? 'all' : view} initialInput={initialNearbyInput} onFriends={onFriends} />}
  </ScrollView>;
}

function ConnectionOverview({ onView, onVault }: Pick<Props, 'onView' | 'onVault'>) {
  const { colors } = useAppearance(), vault = useVault(), messaging = useMessaging(), vpn = useVpn();
  const s = connectionStyles(colors);
  const [problem, setProblem] = useState(''), [working, setWorking] = useState(false), [checking, setChecking] = useState(false);
  const [encryptionChecked, setEncryptionChecked] = useState(false), inAction = useRef(false);
  const { nearby, view } = messaging;
  const status = nearby.phase === 'connected' ? nearby.kind === 'bluetooth' ? 'Bluetooth link ready' : nearby.kind === 'vpn' ? 'Private link ready' : 'Wi-Fi link ready'
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
      style={({ pressed }) => ({ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? .6 : 1 })}>
      <ConnectionIcon name={icon} size={24} color={colors.ink} /><Text style={[s.body, { flex: 1 }]}>{label}</Text>
      <Text style={s.small}>{value}</Text><ConnectionIcon name="chevron-right" size={24} color={colors.sub} />
    </Pressable>;
  }
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ paddingHorizontal: 24, paddingTop: 24, gap: 20 }}>
      <View accessibilityLiveRegion="polite" style={[s.card, { minHeight: 80, flexDirection: 'row', alignItems: 'center' }]}>
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><ConnectionIcon name="link" size={24} color={colors.brand} /></View>
        <View style={{ flex: 1, gap: 4 }}><Text style={s.name}>{status}</Text><Text style={s.small}>{view.queued} {view.queued === 1 ? 'message' : 'messages'} waiting</Text></View>
      </View>
      <View style={{ gap: 12 }}>
        <Text style={s.micro}>MESSAGE DELIVERY</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Message delivery" style={{ flexDirection: 'row', gap: 12 }}>{(['automatic', 'nearby-only'] as const).map(policy => <ConnectionButton key={policy}
          label={policy === 'automatic' ? 'Automatic' : 'Nearby only'} onPress={() => setPolicy(policy)} selected={view.policy === policy}
          hint={vault.status !== 'unlocked' ? 'Create or unlock your identity to change delivery' : undefined}
          secondary={view.policy !== policy} disabled={working || checking || (vault.status === 'unlocked' && !messaging.preferencesReady)} style={{ flex: 1 }} />)}</View>
        <Text style={s.small}>{view.policy === 'nearby-only' ? 'Mailbox delivery is off. Messages wait here until you connect nearby.' : 'Uses nearby while connected, or your mailbox when nearby is off.'}</Text>
      </View>
      <View>
        <Text style={s.micro}>CONNECT WITH</Text>
        {method('wifi', 'Wi-Fi & hotspot', 'wifi', nearby.kind === 'wifi' || nearby.kind === 'hotspot' ? nearby.phase === 'connected' ? 'Active' : 'Waiting' : 'Nearby')}
        {method('bluetooth', 'Bluetooth', 'bluetooth', nearby.kind === 'bluetooth' ? nearby.phase === 'connected' ? 'Active' : 'Waiting' : 'Nearby')}
        {method('shield', 'Private network', 'vpn', vpn.status.connected ? 'Active' : vpn.status.configured ? 'Saved' : 'Set up')}
        {method('download-cloud', 'Internet mailbox', 'mailbox', !view.endpoint ? 'Set up' : view.policy === 'nearby-only' || !view.enabled ? 'Paused' : 'Configured')}
      </View>
      <View style={[s.card, { flexDirection: 'row', alignItems: 'flex-start' }]}>
        <ConnectionIcon name="shield" size={20} color={colors.brand} />
        <View style={{ flex: 1, gap: 4 }}><Text style={s.label}>Private friend network</Text><Text style={s.small}>Connect enrolled phones through your own WireGuard server.</Text></View>
      </View>
      {problem || messaging.problem ? <Text accessibilityRole="alert" style={s.error}>{problem || messaging.problem}</Text> : null}
    </View>
    <View style={{ flex: 1, minHeight: 1 }} />
    <View style={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 12 }}>
      <ConnectionButton label={checking ? 'Checking encryption…' : encryptionChecked ? 'Encryption check passed' : 'Check device encryption'} onPress={checkEncryption} secondary disabled={working || checking} />
      {encryptionChecked && <Text accessibilityLiveRegion="polite" style={s.small}>This device can run LinkUp’s messaging encryption.</Text>}
      <Text style={s.small}>Calls use Wi-Fi or internet. Bluetooth is for messages.</Text>
    </View>
  </ScrollView>;
}

function MailboxPanel() {
  const { colors } = useAppearance(), messaging = useMessaging(), s = connectionStyles(colors);
  const [url, setUrl] = useState(messaging.view.endpoint), [problem, setProblem] = useState(''), [working, setWorking] = useState(false);
  const inAction = useRef(false), nearbyActive = messaging.nearby.phase !== 'idle', nearbyOnly = messaging.view.policy === 'nearby-only';
  const ready = messaging.preferencesReady && !nearbyActive && !nearbyOnly;
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
      <Text style={s.body}>A mailbox holds encrypted packets so friends can receive messages when you aren’t online together.</Text>
    </View>
    <View style={{ gap: 12 }}><Text style={s.label}>Mailbox address</Text>
      <TextInput accessibilityLabel="Mailbox address" value={url} onChangeText={setUrl} placeholder="https://mailbox.example.org" placeholderTextColor={colors.sub}
        autoCorrect={false} autoCapitalize="none" maxLength={300} keyboardType="url" editable={!working} style={s.input} />
    </View>
    {nearbyOnly && <Text style={s.small}>Choose Automatic on the Connection screen to use a mailbox.</Text>}
    {nearbyActive && <Text style={s.small}>Stop the nearby session before changing mailbox delivery.</Text>}
    <ConnectionButton label={working ? 'Updating mailbox…' : messaging.view.endpoint ? 'Resume mailbox' : 'Connect mailbox'} onPress={() => perform(() => messaging.connect(url))}
      disabled={working || !url.trim() || !ready} />
    {messaging.view.enabled && <>
      <ConnectionButton label={messaging.busy ? 'Checking messages…' : 'Check messages now'} onPress={() => perform(messaging.sync)} secondary disabled={working || messaging.busy || !ready || !messaging.view.endpoint} />
      <ConnectionButton label="Pause delivery" onPress={() => perform(messaging.disconnect)} secondary disabled={working || nearbyActive || !messaging.preferencesReady} />
    </>}
    <Text style={s.small}>Queued means saved here. Stored means a mailbox or nearby device saved the encrypted packet. Delivered means your friend’s app confirmed receipt.</Text>
    {problem || messaging.problem ? <Text accessibilityRole="alert" style={s.error}>{problem || messaging.problem}</Text> : null}
  </>;
}
