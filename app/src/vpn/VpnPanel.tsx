// SPDX-License-Identifier: GPL-3.0-only
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Text, TextInput } from '../ui/Typography';
import { useAppearance } from '../appearance/AppearanceProvider';
import { ConnectionButton, ConnectionIcon, connectionStyles } from '../messaging/ConnectionUI';
import { useMessaging } from '../messaging/MessagingProvider';
import { NearbyPanel } from '../messaging/NearbyPanel';
import { useVpn } from './VpnProvider';

export function VpnPanel({ onFriends, initialInput }: { onFriends: () => void; initialInput?: string }) {
  const { colors } = useAppearance(), vpn = useVpn(), messaging = useMessaging(), s = connectionStyles(colors);
  const [input, setInput] = useState(''), [problem, setProblem] = useState(''), [working, setWorking] = useState(false), [copied, setCopied] = useState(false), [removing, setRemoving] = useState(false);
  const acting = useRef(false), { status } = vpn;
  async function perform(task: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; setWorking(true); setProblem('');
    try { await task(); } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not update your private network.'); }
    finally { acting.current = false; setWorking(false); }
  }
  return <View style={{ gap: 24, paddingBottom: 8 }}>
    <View style={s.card}>
      <ConnectionIcon name="shield" size={28} color={colors.brand} />
      <Text style={s.name}>{status.connected ? 'Private tunnel is on' : status.connecting ? 'Connecting private tunnel…' : 'Your friends. Your network.'}</Text>
      <Text style={s.body}>An encrypted WireGuard connection through a server you control. Your messages keep their own end-to-end encryption.</Text>
      {status.connected && <Text style={s.small}>Tunnel ready. Your friend’s connection below confirms message delivery.</Text>}
    </View>
    {!status.supported ? <Text style={s.body}>Private networks are available in the new LinkUp Android build. This browser can still use an internet mailbox.</Text> : <>
      {!status.connected && <>
        <Text style={s.micro}>SET UP THIS PHONE</Text>
        <ConnectionButton label={copied ? 'Public enrollment copied' : status.initialized ? 'Copy public enrollment' : 'Create & copy public enrollment'} secondary disabled={working}
          onPress={() => perform(async () => { const value = await vpn.enrollment(); if (!await Clipboard.setStringAsync(value)) throw new Error('Could not copy the enrollment.'); setCopied(true); })} />
        <Text style={s.small}>Give this public enrollment to your server administrator through a trusted channel. Your private key stays on this phone.</Text>
        <TextInput accessibilityLabel="Private network configuration" placeholder="Paste the configuration from your server" placeholderTextColor={colors.sub}
          value={input} onChangeText={setInput} multiline autoCorrect={false} autoCapitalize="none" maxLength={8192} editable={!working} style={[s.input, { minHeight: 100, textAlignVertical: 'top', fontSize: 13 }]} />
        <ConnectionButton label="Save network configuration" secondary disabled={working || !input.trim() || !status.initialized}
          onPress={() => perform(async () => { await messaging.stopNearby(); await vpn.configure(input); setInput(''); })} />
      </>}
      {status.config && <View style={[s.card, { backgroundColor: colors.secondary }]}>
        <Text style={s.label}>{status.config.label}</Text>
        <Text selectable style={s.small}>Server: {status.config.endpoint}</Text>
        <Text selectable style={s.small}>Hub key: {status.config.hubPublicKey}</Text>
        <Text style={s.small}>Your address: {status.config.address} · {status.config.peers.length} allowed {status.config.peers.length === 1 ? 'device' : 'devices'}</Text>
        <Text style={s.small}>Enrollment expires {new Date(status.config.expiresAt).toLocaleString()}</Text>
      </View>}
      {status.configured && !status.connected && <>
        <Text style={s.small}>Check the server and hub key with your administrator before connecting. Android allows one VPN at a time; connecting may replace another VPN.</Text>
        <ConnectionButton label={working ? 'Connecting…' : 'Connect private network'} disabled={working || status.connecting}
          onPress={() => perform(async () => { await messaging.stopNearby(); await messaging.setPolicy('nearby-only'); await vpn.connect(); })} />
      </>}
      {(status.connected || status.connecting) && <ConnectionButton label="Stop private network" secondary disabled={working}
        onPress={() => perform(async () => { await messaging.stopNearby(); await vpn.stop(); })} />}
      {status.connected && <NearbyPanel mode="vpn" onFriends={onFriends} initialInput={initialInput} />}
      {status.initialized && !status.connected && !status.connecting && <>
        {removing ? <><Text style={s.small}>Remove this phone’s private network key and saved configuration? You will need a new enrollment from your server to connect again.</Text>
          <ConnectionButton label="Remove network & device key" disabled={working} secondary onPress={() => perform(async () => { await messaging.stopNearby(); await vpn.erase(); setInput(''); setCopied(false); setRemoving(false); })} />
          <ConnectionButton label="Keep network" secondary disabled={working} onPress={() => setRemoving(false)} /></>
          : <ConnectionButton label="Remove saved network…" secondary disabled={working} onPress={() => setRemoving(true)} />}
      </>}
      <Text style={s.small}>Only enrolled friend addresses use this tunnel. Mailbox delivery stays off in this mode. Messages wait if the tunnel stops; calls are not enabled in this mode yet.</Text>
      <Text style={s.small}>The tunnel stops when you lock LinkUp or the enrollment expires. Friend sessions stop when you leave the app. Web, iPhone, and other phone apps do not use this tunnel.</Text>
    </>}
    {problem && <Text accessibilityRole="alert" style={s.error}>{problem}</Text>}
  </View>;
}
