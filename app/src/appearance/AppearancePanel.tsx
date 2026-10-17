// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import { Feather } from '@expo/vector-icons';
import { useAppearance } from './AppearanceProvider';
import { ColorWheel } from './ColorWheel';
import { colorFields, copyPreferences, formatTime, modeNames, palette, parseTime, patchPreferences, themeNames, themePresets, type ColorField, type Theme } from './palette';
import { useVault } from '../security/VaultProvider';

type Picker = { theme: Theme; field: ColorField };
const mainColors = [
  { field: 'backgroundColor', label: 'Background' },
  { field: 'textColor', label: 'Text' },
  { field: 'accentColor', label: 'Accent' },
  { field: 'buttonColor', label: 'Buttons' },
  { field: 'incomingColor', label: 'Received bubbles' },
  { field: 'outgoingColor', label: 'Sent bubbles' },
] as const;

export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { preferences, activeTheme, colors, update } = useAppearance();
  const vault = useVault();
  // Both palettes and the schedule stay local until Save.
  const [draft, setDraft] = useState(() => copyPreferences(preferences));
  const [editing, setEditing] = useState<Theme>(activeTheme);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [lightTime, setLightTime] = useState(() => formatTime(preferences.schedule.lightStart));
  const [darkTime, setDarkTime] = useState(() => formatTime(preferences.schedule.darkStart));
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const lightStart = parseTime(lightTime), darkStart = parseTime(darkTime);
  const validTimes = lightStart !== null && darkStart !== null && lightStart !== darkStart;
  const candidate = { ...draft, schedule: validTimes ? { lightStart, darkStart } : draft.schedule };
  const dirty = JSON.stringify(candidate) !== JSON.stringify(preferences);
  const preview = palette(draft, editing), selectedColors = draft.palettes[editing];
  const text = { color: colors.ink, fontSize: 15, lineHeight: 23 };
  const small = { color: colors.sub, fontSize: 12, lineHeight: 18 };
  const timeInput = { backgroundColor: colors.soft, color: colors.ink, minHeight: 48, padding: 12, borderRadius: 12, fontSize: 16 };
  async function save() {
    if (saving || (draft.theme === 'Automatic' && !validTimes)) return;
    setSaving(true); setError('');
    try { await update(candidate); onClose(); }
    catch { setError('Couldn’t save. Your previous appearance is still in place. Unlock your vault and try again.'); }
    finally { setSaving(false); }
  }
  return <>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, gap: 16 }}>
      <View accessibilityLabel="Theme mode" style={{ flexDirection: 'row', gap: 8 }}>
        {modeNames.map(mode => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`${mode} theme`} accessibilityState={{ selected: draft.theme === mode }} disabled={saving}
          onPress={() => { setDraft(d => ({ ...d, theme: mode })); if (mode !== 'Automatic') setEditing(mode); }}
          style={{ flex: 1, minHeight: 52, paddingHorizontal: 8, borderRadius: controlRadius.button, borderWidth: 2, borderColor: draft.theme === mode ? colors.onButton : colors.button, backgroundColor: colors.button, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.onButton, fontSize: 13, lineHeight: 20, fontWeight: draft.theme === mode ? '700' : '500' }}>{mode}</Text>
        </Pressable>)}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ ...text, fontWeight: '600' }}>{draft.theme === 'Automatic' ? 'Colors' : `${editing} colors`}</Text>
        {draft.theme === 'Automatic' && <View style={{ flexDirection: 'row', gap: 4 }}>
          {themeNames.map(theme => <Pressable key={theme} accessibilityRole="button" accessibilityLabel={`Edit ${theme} colors`} accessibilityState={{ selected: editing === theme }} disabled={saving} onPress={() => setEditing(theme)}
            style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: controlRadius.compact, borderWidth: 1, borderColor: editing === theme ? colors.onButton : colors.button, backgroundColor: colors.button, justifyContent: 'center' }}>
            <Text style={{ color: colors.onButton, fontSize: 13, fontWeight: editing === theme ? '700' : '500' }}>{theme}</Text>
          </Pressable>)}
        </View>}
      </View>
      <View style={{ gap: 4 }}>
        {mainColors.map(({ field, label }) => <Pressable key={`${editing}-${field}`} accessibilityRole="button" accessibilityLabel={`Choose ${editing} ${label.toLowerCase()} color`} disabled={saving} onPress={() => setPicker({ theme: editing, field })}
          style={{ minHeight: 52, gap: 12, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ ...text, flex: 1 }}>{label}</Text>
          <View style={{ width: 30, height: 30, borderRadius: controlRadius.compact, backgroundColor: selectedColors[field] ?? selectedColors.accentColor, borderWidth: 1, borderColor: colors.line }} />
          <Feather name="chevron-right" size={22} color={colors.sub} />
        </Pressable>)}
      </View>
      <Text style={{ ...small, fontWeight: '600' }}>Preview</Text>
      <View pointerEvents="none" accessibilityLabel={`${editing} conversation preview`} style={{ padding: 14, gap: 10, borderRadius: 16, borderWidth: 1, borderColor: preview.line, backgroundColor: preview.paper }}>
        <View style={{ alignSelf: 'flex-start', padding: 14, borderRadius: 16, backgroundColor: preview.incoming }}><Text style={{ color: preview.ink, fontSize: 15, lineHeight: 23 }}>Coffee at four?</Text></View>
        <View style={{ alignSelf: 'flex-end', padding: 14, borderRadius: 16, backgroundColor: preview.outgoing }}><Text style={{ color: preview.ink, fontSize: 15, lineHeight: 23 }}>Sounds like a plan.</Text></View>
        <View accessibilityLabel="Button color preview" style={{ alignSelf: 'flex-end', paddingVertical: 10, paddingHorizontal: 20, borderRadius: controlRadius.button, backgroundColor: preview.button }}><Text style={{ color: preview.onButton, fontSize: 14, fontWeight: '600' }}>Send</Text></View>
      </View>
      {draft.theme === 'Automatic' && <View style={{ gap: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Automatic schedule" accessibilityState={{ expanded: showSchedule }} disabled={saving} onPress={() => setShowSchedule(v => !v)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Feather name="clock" size={20} color={colors.ink} /><View style={{ flex: 1, gap: 2 }}><Text style={text}>Automatic schedule</Text><Text style={small}>Light {lightTime} · Dark {darkTime}</Text></View><Feather name={showSchedule ? 'chevron-up' : 'chevron-down'} size={20} color={colors.sub} />
        </Pressable>
        {showSchedule && <View style={{ backgroundColor: colors.soft, borderRadius: 16, padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1, gap: 6 }}><Text style={small}>Light starts</Text><TextInput accessibilityLabel="Light starts" placeholder="07:00" placeholderTextColor={colors.sub} value={lightTime} onChangeText={setLightTime} maxLength={5} autoCorrect={false} editable={!saving} style={timeInput} /></View>
            <View style={{ flex: 1, gap: 6 }}><Text style={small}>Dark starts</Text><TextInput accessibilityLabel="Dark starts" placeholder="19:00" placeholderTextColor={colors.sub} value={darkTime} onChangeText={setDarkTime} maxLength={5} autoCorrect={false} editable={!saving} style={timeInput} /></View>
          </View>
          <Text style={small}>24-hour time, using your device’s local clock.</Text>
        </View>}
        {!validTimes && <Text accessibilityRole="alert" style={{ color: colors.error, fontSize: 12, lineHeight: 18 }}>Enter two different times, like 07:00 and 19:00.</Text>}
      </View>}
      <Pressable accessibilityRole="button" accessibilityLabel={`Reset ${editing} colors`} disabled={saving} onPress={() => setDraft(d => patchPreferences(d, { palettes: { [editing]: { ...themePresets[editing], buttonColor: undefined } } }))} style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: colors.ink, fontSize: 12 }}>Reset {editing.toLowerCase()} colors</Text>
      </Pressable>
      {vault.status === 'preview' && <Text style={small}>Create your vault to keep your appearance after closing LinkUp.</Text>}
      {!!error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}
    </ScrollView>
    <View style={{ padding: 24, gap: 12, flexDirection: 'row', backgroundColor: colors.paper }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel appearance changes" disabled={saving} onPress={onClose} style={{ width: 96, height: 52, borderRadius: controlRadius.button, backgroundColor: colors.button, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: colors.onButton, fontSize: 14, fontWeight: '600' }}>Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Save appearance" disabled={saving || !dirty || (draft.theme === 'Automatic' && !validTimes)} onPress={save} style={{ flex: 1, height: 52, borderRadius: controlRadius.button, backgroundColor: colors.button, opacity: saving || !dirty || (draft.theme === 'Automatic' && !validTimes) ? .5 : 1, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: colors.onButton, fontWeight: '600', fontSize: 14 }}>{saving ? 'Saving…' : 'Save appearance'}</Text></Pressable>
    </View>
    <Modal visible={picker !== null} transparent animationType="slide" onRequestClose={() => setPicker(null)}>
      <View style={{ flex: 1, backgroundColor: '#17241E66', justifyContent: 'flex-end', alignItems: 'center' }}>
        <Pressable accessibilityLabel="Close color picker" style={{ flex: 1, width: '100%' }} onPress={() => setPicker(null)} />
        <View style={{ backgroundColor: colors.paper, padding: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '90%', maxWidth: 480, width: '100%' }}>
          <Text style={{ ...text, fontSize: 22, lineHeight: 30, fontWeight: '700', marginBottom: 20 }}>{picker && `${picker.theme} · ${colorFields.find(({ field }) => field === picker.field)?.label}`}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">{picker && <ColorWheel key={`${picker.theme}-${picker.field}`} initial={draft.palettes[picker.theme][picker.field] ?? draft.palettes[picker.theme].accentColor} onApply={value => { setDraft(d => patchPreferences(d, { palettes: { [picker.theme]: { [picker.field]: value } } })); setPicker(null); }} onCancel={() => setPicker(null)} />}</ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
