import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { ThemedSwitch } from '../ui/ThemedSwitch';
import { controlRadius } from '../ui/shapes';
import React, { useEffect, useState } from 'react';
import { AppState, Linking, PermissionsAndroid, Platform, ScrollView, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { Reply } from './backgroundCore';
import { Text } from '../ui/Typography';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVault } from '../security/VaultProvider';
import { useMessaging } from '../messaging/MessagingProvider';
import { notificationsNative as native, type NotificationStatus } from './native';

export function NotificationsPanel() {
  const { colors } = useAppearance(), vault = useVault(), messaging = useMessaging();
  const [status, setStatus] = useState<NotificationStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<Reply[]>([]);
  useEffect(() => {
    const refresh = () => { if (native) void native.status().then(setStatus).catch(() => {}); if (native && vault.status === 'unlocked') void native.replies().then(raw => setPending(JSON.parse(raw))).catch(() => {}); };
    refresh(); const interval = setInterval(refresh, 3000), listener = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { clearInterval(interval); listener.remove(); };
  }, [vault.status]);
  async function enable() {
    if (!native || busy) return; setBusy(true); setError('');
    try {
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33 && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow notifications in Android settings to receive message alerts.');
      const baseline = Object.entries(messaging.view.conversations).flatMap(([peer, chat]) => chat.messages.filter(m => !m.mine).map(m => `peer:${peer}:${peer}:${m.id}`));
      for (const [id, group] of Object.entries(messaging.view.groups ?? {})) {
        if (group.status === 'invited') baseline.push(`group:${id}:invite:${id}`);
        for (const m of group.messages) if (!m.mine) baseline.push(`group:${id}:${m.sender}:${m.id}`);
      }
      await vault.enableBackgroundMessaging(baseline); setStatus(await native.status());
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not enable notifications.'); } finally { setBusy(false); }
  }
  async function disable() {
    if (!native || busy) return; setBusy(true); setError('');
    try {
      // Local key removal is unconditional. An unreachable mailbox must never
      // keep the background-access key enabled against the user's choice.
      await native.disable(); setStatus(await native.status());
      if (messaging.view.policy !== 'nearby-only' && messaging.view.endpoint && messaging.view.enabled) await messaging.notificationRequest('push-unregister', {});
    } catch { setError('Background access is off. The server registration will expire if it could not be removed.'); } finally { setBusy(false); }
  }
  const action = (label: string, onPress: () => void, secondary = false) => <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={({ pressed }) => [s.button, { backgroundColor: secondary ? colors.secondary : colors.button, opacity: busy ? .5 : pressed ? .82 : 1 }]}><Text style={{ color: secondary ? colors.ink : colors.onButton, fontWeight: '600', textAlign: 'center' }}>{label}</Text></Pressable>;
  if (!native || status?.supported === false) return <View style={s.panel}><Text style={[s.title, { color: colors.ink }]}>Android notifications</Text><Text style={{ color: colors.sub, lineHeight: 23 }}>Background notifications and quick replies are available in the Android 9+ app. Web and iPhone notifications are still being built.</Text></View>;
  return <ScrollView contentContainerStyle={s.panel}><Text style={[s.title, { color: colors.ink }]}>Messages, without opening the app</Text><Text style={{ color: colors.sub, lineHeight: 23 }}>Receive alerts and reply from Android’s notification shade. Unlocking your phone is required to send a reply.</Text><View style={[s.card, { backgroundColor: colors.soft }]}><Text style={{ color: colors.ink, fontWeight: '600' }}>Background messages & replies</Text><Text style={{ color: colors.sub, lineHeight: 21 }}>This lets LinkUp access your encrypted vault in the background without a fingerprint prompt. Android’s Keystore and your phone’s screen lock protect this access. Turn it off here to require the app to be unlocked for all messaging.</Text>{status?.enabled ? action('Turn off background access', () => { void disable(); }, true) : action('Enable background messages & replies', () => { void enable(); })}</View>{status?.enabled && <><View style={[s.card, { backgroundColor: colors.soft }]}><Text style={{ color: colors.ink, fontWeight: '600' }}>Push provider</Text><Text style={{ color: colors.sub, lineHeight: 21 }}>LinkUp uses UnifiedPush. Install and configure a compatible provider such as ntfy, then select it below. Your mailbox server must also support push notifications.</Text>{status.distributors.map(distributor => action(status.distributorLabels?.[distributor] ?? 'Push provider', () => { setBusy(true); setError(''); void messaging.notificationRequest('push-config', {}).then(config => { if (!config.enabled || typeof config.publicKey !== 'string') throw new Error('Your mailbox needs push support enabled before you can register a provider.'); return native!.register(distributor, config.publicKey); }).then(() => native!.status()).then(setStatus).catch(e => setError(e instanceof Error ? e.message : 'Could not register the provider.')).finally(() => setBusy(false)); }, true))}{!status.distributors.length && action('About UnifiedPush providers', () => { void Linking.openURL('https://unifiedpush.org/users/distributors/'); }, true)}<Text style={{ color: colors.sub }}>{status.registered ? 'Registered with your mailbox' : 'Setup pending · choose a provider and connect a push-enabled mailbox'}</Text>{!!status.error && <Text style={{ color: colors.error }}>{status.error}</Text>}</View><View style={s.row}><View style={{ flex: 1, gap: 6 }}><Text style={{ color: colors.ink, fontWeight: '600' }}>Show message previews</Text><Text style={{ color: colors.sub }}>Show message text. Names identify who you’re replying to; Android controls lock-screen visibility.</Text></View><ThemedSwitch accessibilityLabel="Show notification message previews" value={status.previews} onValueChange={value => { void native!.previews(value).then(() => native!.status()).then(setStatus); }} /></View>{!status.permission && action('Open Android notification settings', () => { void Linking.openSettings(); }, true)}{pending.length > 0 && <View style={[s.card, { backgroundColor: colors.soft }]}><Text style={{ color: colors.ink, fontWeight: '600' }}>Unsent replies</Text><Text style={{ color: colors.sub }}>Saved on this phone. Delivery retries automatically while background delivery is enabled.</Text>{pending.map(reply => <View key={reply.id} style={{ gap: 10 }}><Text style={{ color: colors.ink }}>{reply.text}</Text>{action('Copy reply', () => { void Clipboard.setStringAsync(reply.text); }, true)}{action('Discard reply', () => { void native!.acknowledge(reply.id).then(() => setPending(rows => rows.filter(row => row.id !== reply.id))); }, true)}</View>)}</View>}{action('Check background delivery', () => { void native!.wake(); }, true)}</>}{!!error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}<Text style={{ color: colors.sub, fontSize: 12, lineHeight: 20 }}>Nearby only mode blocks background internet delivery. Android force-stop, battery restrictions, loss of connectivity or an unavailable push provider can delay alerts. Open LinkUp to catch up.</Text></ScrollView>;
}
const s = StyleSheet.create({ panel: { padding: 24, gap: 24, paddingBottom: 44 }, title: { fontSize: 27, lineHeight: 35, fontWeight: '600', letterSpacing: -.6 }, card: { padding: 22, borderRadius: 22, gap: 16 }, button: { minHeight: 54, borderRadius: controlRadius.button, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 }, row: { flexDirection: 'row', gap: 16, alignItems: 'center', minHeight: 64, paddingVertical: 8 } });
