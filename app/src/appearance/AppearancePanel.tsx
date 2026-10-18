// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { MotionPressable as Pressable } from '../ui/MotionPressable';
import { useReducedMotion } from '../ui/useReducedMotion';
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
const moreColors = colorFields.filter(({ field }) => !mainColors.some(main => main.field === field));
const modeIcons = { Light: 'sun', Dark: 'moon', Automatic: 'sunrise' } as const;

export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { preferences, activeTheme, colors, update } = useAppearance();
  const vault = useVault();
  const reducedMotion = useReducedMotion();
  // Both palettes and the schedule stay local until Save.
  const [draft, setDraft] = useState(() => copyPreferences(preferences));
  const [editing, setEditing] = useState<Theme>(activeTheme);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [showSchedule, setShowSchedule] = useState(false), [showAdvanced, setShowAdvanced] = useState(false);
  const [lightTime, setLightTime] = useState(() => formatTime(preferences.schedule.lightStart));
  const [darkTime, setDarkTime] = useState(() => formatTime(preferences.schedule.darkStart));
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const lightStart = parseTime(lightTime), darkStart = parseTime(darkTime);
  const validTimes = lightStart !== null && darkStart !== null && lightStart !== darkStart;
  const candidate = { ...draft, schedule: validTimes ? { lightStart, darkStart } : draft.schedule };
  const dirty = JSON.stringify(candidate) !== JSON.stringify(preferences);
  const preview = palette(draft, editing), selectedColors = draft.palettes[editing];
  const text = { color: colors.ink, fontSize: 16, lineHeight: 24 };
  const small = { color: colors.sub, fontSize: 13, lineHeight: 20 };
  const timeInput = { backgroundColor: colors.paper, color: colors.ink, minHeight: 50, padding: 14, borderRadius: 14, fontSize: 17 };
  const saveDisabled = saving || !dirty || (draft.theme === 'Automatic' && !validTimes);
  async function save() {
    if (saving || (draft.theme === 'Automatic' && !validTimes)) return;
    setSaving(true); setError('');
    try { await update(candidate); onClose(); }
    catch { setError('Couldn’t save. Your previous appearance is still in place. Unlock your vault and try again.'); }
    finally { setSaving(false); }
  }
  function colorRow({ field, label }: { field: ColorField; label: string }, index: number) {
    const value = selectedColors[field] ?? selectedColors.accentColor;
    return <Pressable key={`${editing}-${field}`} accessibilityRole="button" accessibilityLabel={`Choose ${editing} ${label.toLowerCase()} color`} disabled={saving} onPress={() => setPicker({ theme: editing, field })}
      style={{ minHeight: 62, gap: 14, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
      <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: value, borderWidth: 1, borderColor: colors.line }} />
      <Text style={{ ...text, flex: 1 }}>{label}</Text>
      <Feather name="chevron-right" size={18} color={colors.sub} />
    </Pressable>;
  }
  return <>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, paddingTop: 12, paddingBottom: 28, gap: 26 }}>
      <View style={{ gap: 10 }}>
        <Text style={{ color: colors.ink, fontSize: 34, lineHeight: 39, letterSpacing: -1.2, fontWeight: '600' }}>Make it feel like you.</Text>
        <Text style={{ ...text, color: colors.sub }}>A little light. A little color. Your own quiet corner.</Text>
      </View>
      <View accessibilityLabel="Theme mode" style={{ flexDirection: 'row', gap: 10 }}>
        {modeNames.map(mode => {
          const selected = draft.theme === mode;
          return <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`${mode} theme`} accessibilityState={{ selected }} disabled={saving}
            onPress={() => { setDraft(d => ({ ...d, theme: mode })); if (mode !== 'Automatic') setEditing(mode); }}
            style={{ flex: 1, minHeight: 100, padding: 12, gap: 13, borderRadius: 20, borderWidth: selected ? 1.5 : 1, borderColor: selected ? colors.brand : colors.line, backgroundColor: selected ? colors.secondary : colors.soft, alignItems: 'center', justifyContent: 'center' }}>
            <Feather name={modeIcons[mode]} size={24} color={selected ? colors.brand : colors.sub} />
            <Text style={{ color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: selected ? '600' : '400' }}>{mode}</Text>
          </Pressable>;
        })}
      </View>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text style={{ ...text, fontWeight: '600' }}>A look inside</Text>
          {draft.theme === 'Automatic' && <View style={{ flexDirection: 'row', gap: 3, backgroundColor: colors.soft, borderRadius: controlRadius.button, padding: 3 }}>
            {themeNames.map(theme => <Pressable key={theme} accessibilityRole="button" accessibilityLabel={`Edit ${theme} colors`} accessibilityState={{ selected: editing === theme }} disabled={saving} onPress={() => setEditing(theme)}
              style={{ minHeight: 38, paddingHorizontal: 14, borderRadius: controlRadius.button, backgroundColor: editing === theme ? colors.paper : 'transparent', justifyContent: 'center' }}>
              <Text style={{ color: editing === theme ? colors.ink : colors.sub, fontSize: 13, fontWeight: editing === theme ? '600' : '400' }}>{theme}</Text>
            </Pressable>)}
          </View>}
        </View>
        <View pointerEvents="none" accessibilityLabel={`${editing} conversation preview`} style={{ padding: 20, gap: 14, borderRadius: 24, borderWidth: 1, borderColor: preview.line, backgroundColor: preview.paper }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: preview.line }}>
            <View style={{ height: 34, width: 34, borderRadius: 17, backgroundColor: preview.secondary, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: preview.avatarText, fontWeight: '600' }}>J</Text></View>
            <Text style={{ color: preview.ink, fontWeight: '600', fontSize: 15 }}>Jamie</Text><Feather name="lock" size={12} color={preview.sub} />
          </View>
          <View style={{ alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 20, borderBottomLeftRadius: 6, backgroundColor: preview.incoming }}><Text style={{ color: preview.ink, fontSize: 15, lineHeight: 23 }}>Coffee at four?</Text></View>
          <View style={{ alignSelf: 'flex-end', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 20, borderBottomRightRadius: 6, backgroundColor: preview.outgoing }}><Text style={{ color: preview.ink, fontSize: 15, lineHeight: 23 }}>Sounds like a plan.</Text></View>
          <View accessibilityLabel="Button color preview" style={{ alignSelf: 'flex-end', flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 18, borderRadius: controlRadius.button, backgroundColor: preview.button }}><Text style={{ color: preview.onButton, fontSize: 14, fontWeight: '600' }}>Send</Text><Feather name="arrow-up" size={16} color={preview.onButton} /></View>
        </View>
      </View>
      <View style={{ gap: 12 }}>
        <View style={{ gap: 3 }}><Text style={{ ...text, fontWeight: '600' }}>{editing} palette</Text><Text style={small}>Choose a color to make it your own.</Text></View>
        <View style={{ borderRadius: 22, backgroundColor: colors.soft, overflow: 'hidden' }}>{mainColors.map(colorRow)}</View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAdvanced }} onPress={() => setShowAdvanced(v => !v)} style={{ flexDirection: 'row', gap: 8, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '500' }}>More colors</Text><Feather name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={16} color={colors.sub} />
        </Pressable>
        {showAdvanced && <View style={{ borderRadius: 22, backgroundColor: colors.soft, overflow: 'hidden' }}>{moreColors.map(colorRow)}</View>}
      </View>
      {draft.theme === 'Automatic' && <View style={{ gap: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Automatic schedule" accessibilityState={{ expanded: showSchedule }} disabled={saving} onPress={() => setShowSchedule(v => !v)} style={{ minHeight: 68, padding: 18, borderRadius: 20, backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Feather name="clock" size={22} color={colors.brand} /><View style={{ flex: 1, gap: 3 }}><Text style={text}>Automatic schedule</Text><Text style={small}>Light {lightTime} · Dark {darkTime}</Text></View><Feather name={showSchedule ? 'chevron-up' : 'chevron-down'} size={18} color={colors.sub} />
        </Pressable>
        {showSchedule && <View style={{ backgroundColor: colors.soft, borderRadius: 20, padding: 18, gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1, gap: 8 }}><Text style={small}>Light starts</Text><TextInput accessibilityLabel="Light starts" placeholder="07:00" placeholderTextColor={colors.sub} value={lightTime} onChangeText={setLightTime} maxLength={5} autoCorrect={false} editable={!saving} style={timeInput} /></View>
            <View style={{ flex: 1, gap: 8 }}><Text style={small}>Dark starts</Text><TextInput accessibilityLabel="Dark starts" placeholder="19:00" placeholderTextColor={colors.sub} value={darkTime} onChangeText={setDarkTime} maxLength={5} autoCorrect={false} editable={!saving} style={timeInput} /></View>
          </View>
          <Text style={small}>24-hour time, using your device’s local clock.</Text>
        </View>}
        {!validTimes && <Text accessibilityRole="alert" style={{ color: colors.error, fontSize: 13, lineHeight: 20 }}>Enter two different times, like 07:00 and 19:00.</Text>}
      </View>}
      <Pressable accessibilityRole="button" accessibilityLabel={`Reset ${editing} colors`} disabled={saving} onPress={() => setDraft(d => patchPreferences(d, { palettes: { [editing]: { ...themePresets[editing], buttonColor: undefined } } }))} style={{ minHeight: 44, flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center' }}>
        <Feather name="rotate-ccw" size={15} color={colors.sub} /><Text style={{ color: colors.sub, fontSize: 13 }}>Reset {editing.toLowerCase()} colors</Text>
      </Pressable>
      {vault.status === 'preview' && <Text style={small}>Create your vault to keep your appearance after closing LinkUp.</Text>}
      {!!error && <Text accessibilityRole="alert" style={{ color: colors.error, lineHeight: 22 }}>{error}</Text>}
    </ScrollView>
    <View style={{ padding: 24, paddingTop: 16, gap: 12, flexDirection: 'row', backgroundColor: colors.paper, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel appearance changes" disabled={saving} onPress={onClose} style={{ width: 96, minHeight: 54, borderRadius: controlRadius.button, backgroundColor: colors.soft, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: colors.ink, fontSize: 15, fontWeight: '500' }}>Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Save appearance" disabled={saveDisabled} onPress={save} style={{ flex: 1, minHeight: 54, borderRadius: controlRadius.button, backgroundColor: colors.button, opacity: saveDisabled ? .45 : 1, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: colors.onButton, fontWeight: '600', fontSize: 15 }}>{saving ? 'Saving…' : 'Save appearance'}</Text></Pressable>
    </View>
    <Modal visible={picker !== null} transparent animationType={reducedMotion === false ? 'slide' : 'none'} onRequestClose={() => setPicker(null)}>
      <View style={{ flex: 1, backgroundColor: '#10181366', justifyContent: 'flex-end', alignItems: 'center' }}>
        <Pressable accessibilityLabel="Close color picker" style={{ flex: 1, width: '100%' }} onPress={() => setPicker(null)} />
        <View style={{ backgroundColor: colors.paper, padding: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '90%', maxWidth: 480, width: '100%' }}>
          <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.line, marginBottom: 24 }} />
          <Text style={{ color: colors.sub, fontSize: 12, fontWeight: '600', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 6 }}>{picker?.theme} palette</Text>
          <Text style={{ ...text, fontSize: 28, lineHeight: 34, letterSpacing: -.8, fontWeight: '600', marginBottom: 24 }}>{picker && colorFields.find(({ field }) => field === picker.field)?.label}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">{picker && <ColorWheel key={`${picker.theme}-${picker.field}`} initial={draft.palettes[picker.theme][picker.field] ?? draft.palettes[picker.theme].accentColor} onApply={value => { setDraft(d => patchPreferences(d, { palettes: { [picker.theme]: { [picker.field]: value } } })); setPicker(null); }} onCancel={() => setPicker(null)} />}</ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
