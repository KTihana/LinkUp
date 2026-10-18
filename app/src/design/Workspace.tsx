// SPDX-License-Identifier: GPL-3.0-only
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { Text } from '../ui/Typography';
import { MotionPressable } from '../ui/MotionPressable';
import { Entrance } from '../ui/Entrance';
import { BrandLogo } from '../brand/BrandLogo';
import { useAppearance } from '../appearance/AppearanceProvider';
import type { Palette } from '../appearance/palette';

type Destination = 'Chats' | 'Calls' | 'Friends' | 'You' | 'Invite a friend' | 'Local vault';
const destinations = [
  { name: 'Chats', icon: 'message-circle' }, { name: 'Calls', icon: 'phone' },
  { name: 'Friends', icon: 'users' }, { name: 'You', icon: 'sliders' },
] as const;

export function WorkspaceRail({ selected, compact, name, preview, onNavigate }: {
  selected: string; compact: boolean; name: string; preview: boolean; onNavigate: (page: Destination) => void;
}) {
  const { colors: c } = useAppearance();
  const s = styles(c);
  return <ScrollView style={[s.rail, compact && s.compactRail]} contentContainerStyle={{ flexGrow: 1, paddingBottom: 20 }} showsVerticalScrollIndicator={false}>
    <View style={s.brand}><BrandLogo color={c.brand} height={compact ? 29 : 31} markOnly={compact} /></View>
    {!compact && <Text style={s.railIntro}>A space for your people.</Text>}
    <View style={s.navigation}>
      {destinations.map(item => {
        const section = ['Chats', 'Conversation', 'New group', 'Group info'].includes(selected) ? 'Chats' : ['Friends', 'Invite a friend', 'Add friend'].includes(selected) ? 'Friends' : selected === 'Calls' ? 'Calls' : 'You';
        const active = section === item.name;
        return <MotionPressable key={item.name} accessibilityRole="button" accessibilityLabel={item.name} accessibilityState={{ selected: active }} onPress={() => onNavigate(item.name)} style={[s.navItem, active && s.navActive, compact && s.navCompact]}>
          <Feather name={item.icon} size={21} color={active ? c.brand : c.sub} />
          {!compact && <Text style={[s.navLabel, active && { color: c.brand, fontWeight: '600' }]}>{item.name === 'You' ? 'Your space' : item.name}</Text>}
          {active && !compact && <View style={s.activeDot} />}
        </MotionPressable>;
      })}
    </View>
    <View style={{ flex: 1 }} />
    {!compact && <View style={s.inviteNote}><View style={s.inviteIcon}><Feather name="user-plus" size={22} color={c.brand} /></View><Text style={s.inviteTitle}>Good company starts here.</Text><Text style={s.inviteDescription}>Bring someone into your circle.</Text><MotionPressable accessibilityRole="button" onPress={() => onNavigate('Invite a friend')} style={s.inviteButton}><Text style={s.inviteButtonText}>Invite a friend</Text><Feather name="arrow-up-right" color={c.brand} size={17} /></MotionPressable></View>}
    <MotionPressable accessibilityRole="button" accessibilityLabel={preview ? 'Set up your profile' : 'Your profile'} onPress={() => onNavigate(preview ? 'Local vault' : 'You')} style={[s.account, compact && { justifyContent: 'center' }]}>
      <View style={s.accountAvatar}><Text style={s.accountInitial}>{name.trim()[0]?.toUpperCase() || 'Y'}</Text></View>
      {!compact && <View style={{ flex: 1, gap: 4 }}><Text style={s.accountName} numberOfLines={1}>{preview ? 'Make yourself at home' : name}</Text><Text style={s.accountCaption}>{preview ? 'Set up your profile' : 'Your personal space'}</Text></View>}
      {!compact && <Feather name="chevron-right" size={16} color={c.sub} />}
    </MotionPressable>
  </ScrollView>;
}

/** Two intersecting conversations: a quiet, scalable piece of LinkUp's identity. */
export function ConnectionArtwork({ size = 280 }: { size?: number }) {
  const { colors: c } = useAppearance();
  return <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size * .76 }}>
    <Svg width="100%" height="100%" viewBox="0 0 320 244">
      <Defs><LinearGradient id="back" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={c.dark ? '#718AC9' : '#DCE5FF'} /><Stop offset="1" stopColor={c.dark ? '#314B88' : '#AABDF4'} /></LinearGradient><LinearGradient id="front" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={c.dark ? '#E0E8FF' : '#F7FAFF'} /><Stop offset="1" stopColor={c.dark ? '#8CA4DE' : '#E2EAFF'} /></LinearGradient></Defs>
      <Circle cx="160" cy="123" r="110" fill="none" stroke={c.line} strokeWidth="1" />
      <Circle cx="160" cy="123" r="87" fill="none" stroke={c.line} strokeWidth="1" strokeDasharray="2 8" />
      <G transform="rotate(-12 122 108)"><Path d="M68 42H165Q192 42 192 69V127Q192 154 165 154H117L80 175V153Q54 151 54 127V69Q54 42 68 42Z" fill="url(#back)" stroke={c.dark ? '#819CD6' : '#C4D4FC'} strokeWidth="1" /><Rect x="81" y="77" width="82" height="7" rx="3.5" fill={c.brand} opacity=".25" /><Rect x="81" y="96" width="57" height="7" rx="3.5" fill={c.brand} opacity=".18" /></G>
      <G transform="rotate(10 205 150)"><Path d="M151 96H245Q267 96 267 118V173Q267 196 245 196H236V216L205 196H151Q129 196 129 173V118Q129 96 151 96Z" fill="url(#front)" stroke={c.dark ? '#7692CF' : '#FFFFFF'} strokeWidth="2" /><Circle cx="172" cy="147" r="6" fill="#4466C9" /><Circle cx="198" cy="147" r="6" fill="#4466C9" /><Circle cx="224" cy="147" r="6" fill="#4466C9" /></G>
      <Circle cx="53" cy="170" r="5" fill={c.brand} opacity=".3" /><Circle cx="263" cy="62" r="7" fill={c.brand} opacity=".18" />
    </Svg>
  </View>;
}

export function ConversationWelcome({ preview, onCompose, onInvite }: { preview: boolean; onCompose: () => void; onInvite: () => void }) {
  const { colors: c } = useAppearance();
  const s = styles(c);
  return <ScrollView style={s.welcome} contentContainerStyle={{ flexGrow: 1 }}>
    <View style={s.welcomeTop}><View style={s.quietLabel}><Feather name={preview ? 'eye' : 'lock'} size={14} color={c.sub} /><Text style={s.caption}>{preview ? 'A look inside LinkUp' : 'Your conversations, your space'}</Text></View><MotionPressable accessibilityRole="button" accessibilityLabel="Invite a friend" onPress={onInvite} style={s.topAction}><Feather name="user-plus" size={19} color={c.brand} /></MotionPressable></View>
    <Entrance style={s.welcomeBody} distance={12} duration={450}>
      <ConnectionArtwork size={282} />
      <Text accessibilityRole="header" style={s.welcomeTitle}>A little closer.{ '\n' }Even from here.</Text>
      <Text style={s.welcomeDescription}>The everyday hellos. The big little moments.{ '\n' }A quieter space to share them with your people.</Text>
      <MotionPressable accessibilityRole="button" onPress={onCompose} style={s.startButton}><Feather name="edit-3" color={c.onButton} size={18} /><Text style={s.startButtonText}>Start a conversation</Text></MotionPressable>
      {preview && <Text style={s.previewNote}>Explore a sample chat, or set up your own space.</Text>}
    </Entrance>
    <View style={s.welcomeFoot}><Feather name="shield" size={15} color={c.sub} /><Text style={s.caption}>{preview ? 'Sample conversations. Real possibilities.' : 'Built for connection. Designed for privacy.'}</Text></View>
  </ScrollView>;
}

const styles = (c: Palette) => StyleSheet.create({
  rail: { width: 224, flexBasis: 224, flexGrow: 0, flexShrink: 0, backgroundColor: c.soft, paddingHorizontal: 18, paddingTop: 34, paddingBottom: 20, borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.line }, compactRail: { width: 84, flexBasis: 84, paddingHorizontal: 12 },
  brand: { minHeight: 36, alignItems: 'flex-start', paddingHorizontal: 10 }, railIntro: { color: c.sub, fontSize: 12, marginTop: 12, paddingHorizontal: 10 }, navigation: { gap: 7, marginTop: 43 },
  navItem: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 16, borderRadius: 16 }, navActive: { backgroundColor: c.paper }, navCompact: { justifyContent: 'center', paddingHorizontal: 0 }, navLabel: { fontSize: 15, color: c.sub, flex: 1 }, activeDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.brand },
  inviteNote: { padding: 15, marginBottom: 28, gap: 10 }, inviteIcon: { marginBottom: 5 }, inviteTitle: { fontSize: 17, lineHeight: 23, fontWeight: '600', color: c.ink, letterSpacing: -.3 }, inviteDescription: { fontSize: 13, lineHeight: 20, color: c.sub }, inviteButton: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingTop: 10, minHeight: 44 }, inviteButtonText: { color: c.brand, fontSize: 13, fontWeight: '600' },
  account: { minHeight: 70, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.line, paddingTop: 18, flexDirection: 'row', alignItems: 'center', gap: 10 }, accountAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.outgoing, alignItems: 'center', justifyContent: 'center' }, accountInitial: { color: c.avatarText, fontSize: 15, fontWeight: '600' }, accountName: { color: c.ink, fontSize: 12, fontWeight: '600' }, accountCaption: { color: c.sub, fontSize: 11 },
  welcome: { flex: 1, backgroundColor: c.paper }, welcomeTop: { minHeight: 92, paddingHorizontal: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, quietLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 }, caption: { color: c.sub, fontSize: 12, lineHeight: 18 }, topAction: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.soft },
  welcomeBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 20 }, welcomeTitle: { fontSize: 46, lineHeight: 51, letterSpacing: -2, fontWeight: '500', color: c.ink, textAlign: 'center', marginTop: 19 }, welcomeDescription: { fontSize: 15, lineHeight: 25, color: c.sub, textAlign: 'center', marginTop: 22 }, startButton: { minHeight: 50, paddingHorizontal: 25, borderRadius: 25, backgroundColor: c.button, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 30 }, startButtonText: { color: c.onButton, fontSize: 14, fontWeight: '600' }, previewNote: { fontSize: 11, lineHeight: 17, color: c.sub, marginTop: 15, textAlign: 'center' }, welcomeFoot: { minHeight: 66, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
});
