import { MotionPressable as Pressable } from '../ui/MotionPressable';
// SPDX-License-Identifier: GPL-3.0-only
import { controlRadius } from '../ui/shapes';
import React, { useRef, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Text } from '../ui/Typography';
import { useAppearance } from '../appearance/AppearanceProvider';
import { ConnectionButton, connectionStyles } from '../messaging/ConnectionUI';

export function PinPad({ setup, onSubmit, onClose }: { setup: boolean; onSubmit: (pin: string) => Promise<void>; onClose: () => void }) {
  const { colors } = useAppearance(), s = connectionStyles(colors);
  const [digits, setDigits] = useState(''), [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const running = useRef(false);
  async function submit() {
    if (digits.length !== 6 || running.current) return;
    if (setup && !first) { setFirst(digits); setDigits(''); setProblem(''); return; }
    if (setup && digits !== first) { setDigits(''); setProblem('Those PINs didn’t match. Try confirming again.'); return; }
    running.current = true; setBusy(true); setProblem('');
    try { await onSubmit(digits); setDigits(''); setFirst(''); onClose(); }
    catch (e) { setDigits(''); setProblem(e instanceof Error ? e.message : 'Could not open LinkUp. Please try again.'); }
    finally { running.current = false; setBusy(false); }
  }
  return <Modal transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={{ flex: 1, backgroundColor: '#101B1780', justifyContent: 'flex-end', padding: 10 }}>
      <ScrollView bounces={false} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}>
        <View accessibilityViewIsModal style={{ width: '100%', maxWidth: 430, alignSelf: 'center', backgroundColor: colors.paper, borderRadius: 28, padding: 24, paddingTop: 30, gap: 22 }}>
          <View style={{ alignItems: 'center', gap: 12 }}>
            <View style={{ width: 54, height: 54, borderRadius: 19, backgroundColor: colors.outgoing, alignItems: 'center', justifyContent: 'center' }}><Feather name="lock" size={23} color={colors.brand} /></View>
            <Text accessibilityRole="header" style={{ ...s.name, textAlign: 'center', fontSize: 24, lineHeight: 32, letterSpacing: -.6 }}>{setup ? first ? 'Confirm your PIN' : 'Choose your LinkUp PIN' : 'Enter your LinkUp PIN'}</Text>
            <Text style={{ ...s.small, textAlign: 'center' }}>{setup ? first ? 'Enter the same six numbers again.' : 'Six numbers, just for LinkUp.' : 'Your messages are waiting for you.'}</Text>
          </View>
          <View accessibilityLabel={`${digits.length} of 6 digits entered`} style={{ flexDirection: 'row', gap: 16, justifyContent: 'center', paddingVertical: 14 }}>
            {Array.from({ length: 6 }, (_, index) => <View key={index} style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: index < digits.length ? colors.brand : colors.secondary }} />)}
          </View>
          {!!problem && <Text accessibilityRole="alert" style={{ ...s.error, textAlign: 'center' }}>{problem}</Text>}
          <View style={{ gap: 10 }}>
            {[[1,2,3],[4,5,6],[7,8,9],['',0,'delete']].map((row, index) => <View key={index} style={{ flexDirection: 'row', gap: 10 }}>
              {row.map(value => value === '' ? <View key="blank" style={{ flex: 1 }} /> : <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === 'delete' ? 'Delete last digit' : String(value)} disabled={busy || (value !== 'delete' && digits.length === 6)} onPress={() => { if (!busy) setDigits(current => value === 'delete' ? current.slice(0, -1) : (current + value).slice(0, 6)); }} style={({ pressed }) => ({ flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', borderRadius: controlRadius.button, backgroundColor: pressed ? colors.secondary : colors.soft, opacity: busy ? 0.5 : 1 })}>
                {value === 'delete' ? <Feather name="delete" size={23} color={colors.ink} /> : <Text style={{ color: colors.ink, fontSize: 27, fontWeight: '500' }}>{value}</Text>}
              </Pressable>)}
            </View>)}
          </View>
          <ConnectionButton label={busy ? setup ? 'Saving PIN…' : 'Unlocking…' : setup ? first ? 'Save PIN' : 'Continue' : 'Unlock LinkUp'} disabled={busy || digits.length !== 6} onPress={() => { void submit(); }} />
          {setup && !!first && <ConnectionButton label="Choose different numbers" secondary disabled={busy} onPress={() => { setFirst(''); setDigits(''); setProblem(''); }} />}
          <ConnectionButton label="Cancel" secondary disabled={busy} onPress={onClose} />
        </View>
      </ScrollView>
    </View>
  </Modal>;
}
