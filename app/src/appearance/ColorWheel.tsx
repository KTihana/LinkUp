import { controlRadius } from '../ui/shapes';
import React, { useState } from 'react';
import { GestureResponderEvent, Pressable, View } from 'react-native';
import { Text, TextInput } from '../ui/Typography';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { hexToHsv, hsvToHex, isHex } from './color';
import { useAppearance } from './AppearanceProvider';

export function ColorWheel({ initial, onApply, onCancel }: { initial: string; onApply: (color: string) => void; onCancel: () => void }) {
  const { colors } = useAppearance();
  const [hsv, setHsv] = useState(() => hexToHsv(initial));
  const [hex, setHex] = useState(initial.toUpperCase());
  const [barWidth, setBarWidth] = useState(240);
  const selected = hsvToHex(hsv.h, hsv.s, hsv.v);
  function select(h: number, s: number, v: number) { setHsv({ h, s, v }); setHex(hsvToHex(h, s, v)); }
  function moveWheel(e: GestureResponderEvent) { const dx = e.nativeEvent.locationX - 120, dy = e.nativeEvent.locationY - 120; select((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(dx, dy) / 116), hsv.v); }
  function moveBrightness(e: GestureResponderEvent) { select(hsv.h, hsv.s, Math.max(0, Math.min(1, e.nativeEvent.locationX / barWidth))); }
  const segments = Array.from({ length: 120 }, (_, i) => {
    const a = i * 3 * Math.PI / 180, b = (i * 3 + 3.2) * Math.PI / 180;
    return <Path key={i} d={`M120 120 L${120 + 116 * Math.cos(a)} ${120 + 116 * Math.sin(a)} A116 116 0 0 1 ${120 + 116 * Math.cos(b)} ${120 + 116 * Math.sin(b)} Z`} fill={hsvToHex(i * 3, 1, 1)} />;
  });
  return <View style={{ gap: 16 }}>
    <View onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={moveWheel} onResponderMove={moveWheel} accessibilityLabel="Color wheel" style={{ width: 240, height: 240, alignSelf: 'center' }}>
      <Svg width={240} height={240} pointerEvents="none"><Defs><RadialGradient id="saturation"><Stop offset="0" stopColor="#FFFFFF" /><Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" /></RadialGradient></Defs>{segments}<Circle cx={120} cy={120} r={116} fill="url(#saturation)" /><Circle cx={120} cy={120} r={116} fill="#000000" opacity={1 - hsv.v} /><Circle cx={120 + 116 * hsv.s * Math.cos(hsv.h * Math.PI / 180)} cy={120 + 116 * hsv.s * Math.sin(hsv.h * Math.PI / 180)} r={7} fill={selected} stroke="#FFFFFF" strokeWidth={3} /></Svg>
    </View>
    <Text style={{ color: colors.ink, fontWeight: '600' }}>Brightness</Text>
    <View onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderGrant={moveBrightness} onResponderMove={moveBrightness} onLayout={e => setBarWidth(e.nativeEvent.layout.width)} accessibilityLabel="Color brightness" style={{ height: 36 }}>
      <Svg width="100%" height={36} pointerEvents="none"><Defs><LinearGradient id="brightness" x1="0%" x2="100%"><Stop offset="0" stopColor="#000000" /><Stop offset="1" stopColor={hsvToHex(hsv.h, hsv.s, 1)} /></LinearGradient></Defs><Rect y={8} width="100%" height={20} rx={10} fill="url(#brightness)" /></Svg><View pointerEvents="none" style={{ position: 'absolute', left: `${hsv.v * 100}%`, marginLeft: -9, top: 8, width: 18, height: 20, borderRadius: 10, backgroundColor: selected, borderColor: colors.ink, borderWidth: 2 }} />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: selected, borderWidth: 1, borderColor: colors.line }} /><TextInput accessibilityLabel="Hex color" autoCapitalize="characters" autoCorrect={false} maxLength={7} value={hex} onChangeText={value => { setHex(value); if (isHex(value)) { const next = hexToHsv(value); setHsv(next); } }} style={{ flex: 1, backgroundColor: colors.soft, color: colors.ink, padding: 14, borderRadius: 12, fontSize: 16 }} /></View>
    {!isHex(hex) && <Text accessibilityRole="alert" style={{ color: colors.error }}>Enter a color like #2D5944.</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel="Apply color" disabled={!isHex(hex)} onPress={() => onApply(hex.toUpperCase())} style={{ backgroundColor: colors.button, opacity: isHex(hex) ? 1 : .5, padding: 16, borderRadius: controlRadius.button, alignItems: 'center' }}><Text style={{ color: colors.onButton, fontWeight: '600' }}>Apply color</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={onCancel} style={{ padding: 12, alignItems: 'center' }}><Text style={{ color: colors.link }}>Cancel</Text></Pressable>
  </View>;
}
