import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useEffect, useState } from 'react';
import { Modal, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../ui/Typography';
import { Feather } from '@expo/vector-icons';
import { useCalls } from './CallsProvider';
import { useVault } from '../security/VaultProvider';
import { CallVideo } from './CallVideo';
import { useAppearance } from '../appearance/AppearanceProvider';

export function CallPanel() {
  const { colors } = useAppearance();
  const call = { paper: colors.paper, surface: colors.soft, ink: colors.ink, muted: colors.sub, accent: colors.brand, avatar: colors.outgoing, avatarText: colors.avatarText, onAccent: colors.onBrand, button: colors.button, onButton: colors.onButton, danger: colors.error };
  const { state, controller } = useCalls(), vault = useVault();
  const [now, setNow] = useState(Date.now), [detailsCall, setDetailsCall] = useState('');
  useEffect(() => { if (!state.connectedAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [state.connectedAt]);
  const details = !!state.callId && detailsCall === state.callId;
  const name = vault.contacts.find(contact => contact.publicKey === state.peer)?.name ?? 'Friend';
  const ended = ['ended', 'failed'].includes(state.phase), seconds = state.connectedAt ? Math.max(0, Math.floor((now - state.connectedAt) / 1000)) : 0;
  const status = ended ? state.reason : state.phase === 'incoming' ? `Incoming ${state.mode} call` : state.phase === 'outgoing' ? state.reason || 'Calling…'
    : state.phase === 'connected' ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : state.phase === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  const action = (icon: React.ComponentProps<typeof Feather>['name'], label: string, onPress: () => void, selected = false, danger = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ alignItems: 'center', gap: 10, minWidth: 84, minHeight: 90, opacity: pressed ? .75 : 1 })}><View style={{ width: danger ? 68 : 64, height: danger ? 68 : 64, borderRadius: controlRadius.call, alignItems: 'center', justifyContent: 'center', backgroundColor: danger ? call.danger : selected ? call.button : call.surface }}><Feather name={icon} color={danger ? call.paper : selected ? call.onButton : call.ink} size={24} /></View><Text style={{ color: call.muted, fontSize: 13, lineHeight: 19, fontWeight: '500' }}>{label}</Text></Pressable>;
  return <Modal visible={state.phase !== 'idle'} animationType="slide" onRequestClose={() => ended ? controller.dismiss() : controller.end()}>
    <SafeAreaView style={{ flex: 1, backgroundColor: call.paper, alignItems: 'center' }}><View style={{ flex: 1, width: '100%', maxWidth: 480 }}>
      <View style={{ height: 72, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center' }}><Text style={{ color: call.ink, fontSize: 22, lineHeight: 30, fontWeight: '700', flex: 1 }}>{state.mode === 'voice' ? 'Voice call' : 'Video call'}</Text><Pressable accessibilityRole="button" accessibilityLabel="Call information" accessibilityState={{ expanded: details }} onPress={() => setDetailsCall(details ? '' : state.callId)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Feather name="more-horizontal" size={24} color={call.ink} /></Pressable></View>
      {details && <Text style={{ color: call.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 24, paddingBottom: 16 }}>Keep LinkUp open during your call. To use video, start a video call from your conversation.</Text>}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingHorizontal: 24, paddingBottom: 36 }}>
        {state.mode === 'video' && state.remoteStream ? <View style={{ width: '100%', flex: 1, borderRadius: 16, overflow: 'hidden', marginTop: 12 }}><CallVideo stream={state.remoteStream} /></View>
          : <View style={{ width: 116, height: 116, borderRadius: 58, backgroundColor: call.avatar, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 42, lineHeight: 50, fontWeight: '700', color: call.avatarText }}>{Array.from(name.trim())[0]?.toUpperCase() || '?'}</Text></View>}
        {state.mode === 'voice' && <CallVideo stream={state.remoteStream} video={false} />}
        <Text style={{ color: call.ink, fontSize: 30, lineHeight: 38, fontWeight: '600', textAlign: 'center', letterSpacing: -.6 }}>{name}</Text><Text accessibilityLiveRegion="polite" style={{ color: call.muted, fontSize: 16, lineHeight: 24, textAlign: 'center' }}>{status}</Text>
        {!ended && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Feather name="lock" size={14} color={call.muted} /><Text style={{ color: call.muted, fontSize: 12, lineHeight: 18, fontWeight: '500' }}>End-to-end encrypted</Text></View>}
        {state.mode === 'video' && !!state.localStream && <View style={{ width: 100, height: 135, position: 'absolute', top: 20, right: 24, borderRadius: 14, overflow: 'hidden' }}><CallVideo stream={state.localStream} local /></View>}
      </View>
      {ended ? <Pressable accessibilityRole="button" onPress={controller.dismiss} style={{ margin: 24, minHeight: 54, padding: 16, backgroundColor: call.button, borderRadius: controlRadius.button, justifyContent: 'center' }}><Text style={{ color: call.onButton, textAlign: 'center', fontWeight: '600' }}>Done</Text></Pressable>
        : state.phase === 'incoming' ? <View style={{ flexDirection: 'row', justifyContent: 'space-evenly', padding: 24, paddingBottom: 36 }}>{action('phone-off', 'Decline', () => controller.end('declined', 'Call declined'), false, true)}{action('phone', 'Accept', () => { void controller.accept(); }, true)}</View>
          : <><View style={{ flexDirection: 'row', justifyContent: 'space-evenly', paddingHorizontal: 24, paddingBottom: 24, gap: 12 }}>{action(state.muted ? 'mic-off' : 'mic', state.muted ? 'Unmute' : 'Mute', controller.mute, state.muted)}
            {state.mode === 'video' && action(state.camera ? 'video' : 'video-off', 'Camera', controller.toggleCamera, !state.camera)}
            {Platform.OS !== 'web' && action(state.speaker ? 'volume-2' : 'volume', 'Speaker', () => { void controller.toggleSpeaker(); }, state.speaker)}
          </View><View style={{ alignItems: 'center', paddingBottom: 24 }}>{action('phone-off', 'End call', () => controller.end(), false, true)}</View></>}
    </View></SafeAreaView>
  </Modal>;
}
