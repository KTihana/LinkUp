import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { ThemedSwitch } from '../ui/ThemedSwitch';
import appConfig from '../../app.json';
import { controlRadius } from '../ui/shapes';
import React, { useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import { Feather } from '@expo/vector-icons';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useUpdates } from './UpdatesProvider';
export function UpdatesPanel() {
  const updates = useUpdates(), { colors } = useAppearance();
  if (!updates.ready) return <Text style={{ color: colors.sub, padding: 24 }}>Loading update settings…</Text>;
  return <ReadyUpdatesPanel />;
}
function ReadyUpdatesPanel() {
  const { colors } = useAppearance(), updates = useUpdates();
  const [repository, setRepository] = useState(updates.settings.repository), [automatic, setAutomatic] = useState(updates.settings.automatic);
  const [problem, setProblem] = useState(''), [saving, setSaving] = useState(false);
  const busy = saving || !updates.ready || ['checking', 'downloading'].includes(updates.status);
  const dirty = repository.trim() !== updates.settings.repository || automatic !== updates.settings.automatic;
  const text = { color: colors.ink, fontSize: 15, lineHeight: 23 };
  const messages = { idle: updates.settings.repository ? 'Ready to check for updates.' : 'Choose a GitHub release source to get started.', checking: 'Checking GitHub Releases…', available: `LinkUp ${updates.release?.version} is available`, current: 'You have the latest LinkUp release.', empty: 'No published stable release yet.', downloading: 'Downloading and verifying the APK…', ready: 'Update verified and ready to install.', permission: 'Allow updates from LinkUp in Android settings, then return here and tap Install update.', installer: 'Follow Android’s installer to finish the update.', error: updates.error };
  async function save() { setSaving(true); setProblem(''); try { await updates.save({ repository: repository.trim(), automatic }); } catch (e) { setProblem(e instanceof Error ? e.message : 'Couldn’t save update settings.'); } finally { setSaving(false); } }
  function button(label: string, action: () => void, disabled = false, secondary = false) { return <Pressable accessibilityRole="button" disabled={disabled} onPress={action} style={({ pressed }) => ({ minHeight: 54, padding: 16, borderRadius: controlRadius.button, backgroundColor: secondary ? colors.secondary : colors.button, opacity: disabled ? .5 : pressed ? .82 : 1, alignItems: 'center', justifyContent: 'center' })}><Text style={{ ...text, fontWeight: '600', color: secondary ? colors.ink : colors.onButton }}>{label}</Text></Pressable>; }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, paddingBottom: 44, gap: 22 }}>
    <View style={{ gap: 12, paddingBottom: 4 }}><View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: colors.outgoing, alignItems: 'center', justifyContent: 'center' }}><Feather name="download-cloud" size={29} color={colors.brand} /></View><Text style={{ ...text, fontSize: 28, lineHeight: 36, letterSpacing: -.6, fontWeight: '600' }}>Keep LinkUp up to date</Text><Text style={{ color: colors.sub }}>Installed version {updates.installed?.version ?? appConfig.expo.version}</Text></View>
    {Platform.OS !== 'android' ? <Text style={text}>{Platform.OS === 'web' ? 'APK updates are available in the Android app. Reload the website to use its latest published version.' : 'Android updates use GitHub Releases. iPhone distribution is still being built.'}</Text> : <>
      <Text accessibilityLiveRegion="polite" style={{ ...text, color: updates.status === 'error' ? colors.error : colors.ink }}>{messages[updates.status]}</Text>
      {updates.release && <View style={{ padding: 22, borderRadius: 22, gap: 12, backgroundColor: colors.soft }}><Text style={text}>{updates.release.notes}</Text><Text style={{ color: colors.sub }}>{(updates.release.bytes / 1048576).toFixed(1)} MB · Signed Android update</Text></View>}
      {['ready', 'permission', 'installer'].includes(updates.status) ? button('Install update', () => void updates.install(), busy) : updates.release ? button('Download update', () => void updates.download(), busy || dirty) : button('Check for updates', () => void updates.check(), busy || dirty || !updates.settings.repository)}
      {['checking', 'downloading'].includes(updates.status) && button('Cancel', updates.cancel, false, true)}
      <Text style={{ ...text, fontWeight: '600' }}>GitHub release source</Text>
      <TextInput accessibilityLabel="GitHub release repository" value={repository} onChangeText={setRepository} editable={!busy} placeholder="owner/repository" placeholderTextColor={colors.sub} autoCapitalize="none" autoCorrect={false} style={{ ...text, backgroundColor: colors.soft, borderRadius: 16, minHeight: 54, padding: 16 }} />
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 56 }}><Text style={{ ...text, flex: 1 }}>Check automatically</Text><ThemedSwitch accessibilityLabel="Check automatically for updates" disabled={busy} value={automatic} onValueChange={setAutomatic} /></View>
      <Text style={{ color: colors.sub, fontSize: 13, lineHeight: 20 }}>{updates.automaticPaused ? 'Automatic checks are paused while Nearby only is on. Check for updates contacts GitHub when you choose it.' : 'Automatic checks run after you unlock LinkUp. Downloads and installation always need your approval.'}</Text>
      {button(saving ? 'Saving…' : 'Save update settings', () => void save(), busy || !dirty, true)}
      {problem && <Text accessibilityRole="alert" style={{ color: colors.error }}>{problem}</Text>}
    </>}
  </ScrollView>;
}
