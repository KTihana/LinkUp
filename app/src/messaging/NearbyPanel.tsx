import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVpn } from '../vpn/VpnProvider';
import { useVault } from '../security/VaultProvider';
import { InviteQR } from '../friends/InviteQR';
import { useMessaging } from './MessagingProvider';
import { inspectNearbyOffer, type NearbyOffer } from './nearbyOffer';
import { ConnectionButton, ConnectionIcon, connectionStyles } from './ConnectionUI';

function NearbyButton({ label, onPress, disabled = false, secondary = true }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <ConnectionButton label={label} onPress={onPress} disabled={disabled} secondary={secondary} />;
}

export function NearbyPanel({ initialInput = '', mode = 'all', onFriends }: { initialInput?: string; mode?: 'wifi' | 'bluetooth' | 'vpn' | 'all'; onFriends?: () => void }) {
  const { colors } = useAppearance(), vault = useVault(), messaging = useMessaging(), vpn = useVpn();
  const [peer, setPeer] = useState(''), [input, setInput] = useState(initialInput), [candidate, setCandidate] = useState<NearbyOffer | null>(null);
  const [working, setWorking] = useState(false), [problem, setProblem] = useState(''), [scanning, setScanning] = useState(false), [copied, setCopied] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const inAction = useRef(false), scanHandled = useRef(false);
  const unlocked = vault.status === 'unlocked', active = messaging.nearby.phase !== 'idle';
  const s = connectionStyles(colors), text = s.body, helper = s.small;
  async function perform(task: () => Promise<void>) {
    if (inAction.current) return;
    inAction.current = true; setWorking(true); setProblem('');
    try { await task(); } catch (e) { setProblem(e instanceof Error ? e.message : 'Could not update nearby.'); }
    finally { inAction.current = false; setWorking(false); }
  }
  function review(value = input) {
    setScanning(false); setCandidate(null); setProblem('');
    try {
      const offer = inspectNearbyOffer(value, Date.now());
      if (!vault.contacts.some(c => c.publicKey === offer.publicKey)) throw new Error('Add this friend using their invitation before joining nearby.');
      if (`common:${offer.peer}` !== vault.identity) throw new Error('This code was made for a different identity.');
      setCandidate(offer);
    } catch (e) { setProblem(e instanceof Error ? e.message : 'Could not verify this nearby code.'); }
  }
  async function scan() {
    setProblem(''); scanHandled.current = false;
    try { if (cameraPermission?.granted || (await requestCameraPermission()).granted) setScanning(true); else setProblem('Camera access was declined. You can paste the code instead.'); }
    catch { setProblem('Camera unavailable. You can paste the code instead.'); }
  }
  async function copy() {
    try { if (!await Clipboard.setStringAsync(messaging.nearby.offer)) throw new Error(); setCopied(true); }
    catch { setProblem('Could not copy the code. Your friend can scan it here.'); }
  }
  const joinedName = vault.contacts.find(c => c.publicKey === messaging.nearby.peer)?.name;
  const candidateName = vault.contacts.find(c => c.publicKey === candidate?.publicKey)?.name;
  return <View style={{ gap: 18 }}>
    <View style={{ gap: 16 }}>
      <View style={{ ...s.card, flexDirection: 'row', alignItems: 'flex-start' }}><ConnectionIcon name={mode === 'bluetooth' ? 'bluetooth' : mode === 'vpn' ? 'shield' : 'wifi'} size={24} color={colors.brand} /><View style={{ flex: 1, gap: 4 }}><Text style={s.label}>{mode === 'vpn' ? 'Connect a friend privately' : 'Connect nearby'}</Text>
        <Text style={helper}>{mode === 'vpn' ? 'Both phones need an active private network. Add each other as friends, then share a connection code.' : mode === 'bluetooth' ? 'Exchange encrypted messages over Bluetooth. Add each other as friends first.' : mode === 'wifi' ? 'Use the same Wi-Fi or create a private hotspot. Add each other as friends first.' : 'Use Wi-Fi, a private hotspot or Bluetooth. Add each other as friends first.'}</Text></View></View>
      {(mode === 'vpn' ? !vpn.status.connected : mode === 'bluetooth' ? !messaging.capabilities.bluetooth : mode === 'wifi' ? !messaging.capabilities.wifi && !messaging.capabilities.hotspot : !messaging.capabilities.wifi && !messaging.capabilities.bluetooth) && <Text style={helper}>{Platform.OS === 'web' ? 'Nearby connections are available in LinkUp for Android. This browser can use an internet mailbox.' : 'This device or build does not support this nearby connection.'}</Text>}
      {unlocked && !active && <>
        <Text style={{ ...text, fontWeight: '600' }}>Choose a friend</Text>
        {!vault.contacts.length && <><Text style={helper}>Add a friend before starting a nearby connection.</Text>{onFriends && <NearbyButton label="Add a friend" onPress={onFriends} />}</>}
        {vault.contacts.map(c => <Pressable key={c.publicKey} accessibilityRole="button" accessibilityLabel={`Connect nearby with ${c.name} ${c.publicKey.slice(0, 8)}`} accessibilityState={{ selected: peer === c.publicKey }} disabled={working} onPress={() => setPeer(c.publicKey)} style={{ minHeight: 58, padding: 16, borderRadius: controlRadius.button, backgroundColor: peer === c.publicKey ? colors.button : colors.soft, justifyContent: 'center' }}><Text style={{ ...text, color: peer === c.publicKey ? colors.onButton : colors.ink, fontWeight: '600' }}>{c.name} · {c.publicKey.slice(0, 8)}</Text></Pressable>)}
      </>}
      {!active && <>
        <Text style={helper}>One person starts the session. The other scans their nearby code below.</Text>
        {mode === 'vpn' && <NearbyButton label="Start private connection" onPress={() => perform(() => messaging.hostNearby(peer, 'vpn'))} disabled={working || !unlocked || !peer || !vpn.status.connected} secondary={false} />}
        {mode !== 'bluetooth' && mode !== 'vpn' && <><NearbyButton label="Host on this Wi-Fi" onPress={() => perform(() => messaging.hostNearby(peer, 'wifi'))} disabled={working || !unlocked || !peer || !messaging.capabilities.wifi} secondary={false} />
          <NearbyButton label="Create a nearby network" onPress={() => perform(() => messaging.hostNearby(peer, 'hotspot'))} disabled={working || !unlocked || !peer || !messaging.capabilities.hotspot} /></>}
        {mode !== 'wifi' && mode !== 'vpn' && <NearbyButton label="Start Bluetooth" onPress={() => perform(() => messaging.hostNearby(peer, 'bluetooth'))} disabled={working || !unlocked || !peer || !messaging.capabilities.bluetooth} secondary={mode === 'all'} />}
      </>}
      {active && <>
        <Text style={{ ...text, fontWeight: '600' }}>{messaging.nearby.phase === 'starting' ? 'Starting nearby…' : messaging.nearby.phase === 'connected' ? `${messaging.nearby.kind === 'bluetooth' ? 'Bluetooth' : messaging.nearby.kind === 'vpn' ? 'Private network' : 'Wi-Fi'} link ready` : 'Waiting for a nearby phone'}</Text>
        {joinedName && <Text style={helper}>Selected friend: {joinedName}. Their identity is checked during encrypted message sync.</Text>}
        {candidate?.kind === 'wifi' && messaging.nearby.phase === 'waiting' && <NearbyButton label="Reconnect nearby Wi-Fi" onPress={() => perform(() => messaging.joinNearby(input))} disabled={working} />}
        {messaging.nearby.offer && <><View style={{ backgroundColor: '#FFFFFF', padding: 8, borderRadius: 16, width: '100%', maxWidth: 268, aspectRatio: 1, alignSelf: 'center' }}><InviteQR value={messaging.nearby.offer} label="Nearby connection QR code" /></View><Text style={helper}>Let your selected friend scan this code in Connection.</Text><NearbyButton label={copied ? 'Nearby code copied' : 'Copy nearby code'} onPress={copy} disabled={working} /></>}
        {messaging.nearby.ssid && <><Text selectable style={helper}>Wi-Fi: {messaging.nearby.ssid}</Text><Text selectable style={helper}>Password: {messaging.nearby.password}</Text><Text style={helper}>Your friend joins this Wi-Fi in their phone settings before connecting.</Text></>}
        {messaging.nearby.kind === 'bluetooth' && !messaging.nearby.offer && messaging.nearby.phase === 'waiting' && messaging.nearby.devices.map(d => <NearbyButton key={d.deviceId} label={`Connect ${d.label}`} onPress={() => perform(() => messaging.connectBluetooth(d.deviceId))} disabled={working} />)}
        <NearbyButton label="Stop nearby" onPress={() => { setCandidate(null); setCopied(false); void messaging.stopNearby().catch(e => setProblem(e instanceof Error ? e.message : 'Could not stop nearby.')); }} />
        <Text style={helper}>Nearby sessions end when you leave LinkUp or after ten minutes.</Text>
      </>}
      {unlocked && <>
        {scanning ? <><CameraView style={{ height: 280, borderRadius: 18, overflow: 'hidden' }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => { if (scanHandled.current) return; scanHandled.current = true; setInput(data); review(data); }} onMountError={() => { setScanning(false); setProblem('Camera unavailable. Paste the code instead.'); }} /><NearbyButton label="Cancel scan" onPress={() => setScanning(false)} /></> : <NearbyButton label="Scan a nearby code" onPress={scan} disabled={working || active} />}
        <TextInput accessibilityLabel="Nearby connection code" value={input} onChangeText={value => { setInput(value); setCandidate(null); }} placeholder="Or paste your friend’s nearby code" placeholderTextColor={colors.sub} autoCorrect={false} autoCapitalize="none" multiline maxLength={2048} style={{ padding: 16, borderRadius: 18, backgroundColor: colors.soft, color: colors.ink, fontSize: 14, minHeight: 100, textAlignVertical: 'top', ...Platform.select({ web: { outlineWidth: 0, outlineStyle: 'solid' as const } }) }} />
        <NearbyButton label="Review nearby code" onPress={() => review()} disabled={working || !input.trim() || active} />
        {candidate?.kind === 'vpn' && !vpn.status.connected && <Text style={helper}>Connect your private network from Connection → Private network, then open this code again.</Text>}
        {candidate && <><Text style={{ ...text, fontWeight: '600' }}>Connect with {candidateName} over {candidate.kind === 'vpn' ? 'private network' : candidate.kind === 'wifi' ? 'Wi-Fi' : 'Bluetooth'}?</Text>{candidate.kind === 'wifi' && candidate.ssid && <><Text selectable style={helper}>Join Wi-Fi: {candidate.ssid}</Text><Text selectable style={helper}>Password: {candidate.password}</Text></>}<NearbyButton label={candidate.kind === 'vpn' ? 'Join private connection' : candidate.kind === 'wifi' ? 'Join nearby Wi-Fi' : 'Find friend over Bluetooth'} onPress={() => perform(() => messaging.joinNearby(input))} disabled={working || active || (candidate.kind === 'vpn' ? !vpn.status.connected : candidate.kind === 'wifi' ? !messaging.capabilities.wifi : !messaging.capabilities.bluetooth)} secondary={false} /></>}
      </>}
    </View>
    {problem || messaging.nearby.problem ? <Text accessibilityRole="alert" style={{ color: colors.error }}>{problem || messaging.nearby.problem}</Text> : null}
  </View>;
}
