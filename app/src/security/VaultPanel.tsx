// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Text, TextInput } from '../ui/Typography';
import { BrandLogo } from '../brand/BrandLogo';
import { useAppearance } from '../appearance/AppearanceProvider';
import { useVault } from './VaultProvider';
import { ConnectionButton, connectionStyles } from '../messaging/ConnectionUI';
import { PinPad } from './PinPad';
import { notificationsNative } from '../notifications/native';

export function VaultPanel() {
  const vault = useVault(), { colors } = useAppearance(), s = connectionStyles(colors);
  const [input, setInput] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const [showRecovery, setShowRecovery] = useState(false), [showPassword, setShowPassword] = useState(false), [newAccount, setNewAccount] = useState(false);
  const [pinAction, setPinAction] = useState<'create' | 'unlock' | 'change' | null>(null);
  const [otherMethods, setOtherMethods] = useState(false), [savedAccess, setSavedAccess] = useState(false);
  useEffect(() => { let active = true; void notificationsNative?.status().then(status => { if (active) setSavedAccess(status.enabled); }).catch(() => {}); return () => { active = false; }; }, [vault.generation, vault.status]);
  const inAction = useRef(false), locked = vault.status === 'locked' || vault.status === 'error';
  async function perform(action: () => Promise<void>) {
    if (inAction.current) return;
    inAction.current = true; setBusy(true); setProblem('');
    try { await action(); setInput(''); setPassword(''); setConfirm(''); setShowRecovery(false); setShowPassword(false); setNewAccount(false); }
    catch (e) { const message = e instanceof Error ? e.message : ''; setProblem(message && !message.includes('Call to function') ? message : 'Could not save that change. Please try again.'); }
    finally { inAction.current = false; setBusy(false); }
  }
  const title = { color: colors.ink, fontSize: 36, lineHeight: 44, fontWeight: '700' as const, letterSpacing: -1.2 };
  const resetConfirmation = <View style={[s.card, { borderWidth: 1, borderColor: colors.error }]}>
    <Feather name="trash-2" color={colors.error} size={24} />
    <Text style={s.name}>Delete this account’s data?</Text>
    <Text style={s.body}>This permanently removes your LinkUp profile, chats, friends, settings and old account archives from this phone. It can’t be undone.</Text>
    <Text style={s.small}>Your new account will have a new friend code. Copies on other people’s devices are not removed.</Text>
    <ConnectionButton label={busy ? 'Deleting data…' : 'Delete data and continue'} style={{ backgroundColor: colors.error }} onPress={() => perform(vault.startNewIdentity)} disabled={busy} />
    <ConnectionButton label="Keep this account" secondary onPress={() => setNewAccount(false)} disabled={busy} />
  </View>;
  return <><ScrollView contentContainerStyle={{ padding: 24, paddingTop: vault.status === 'unlocked' ? 16 : 36, paddingBottom: 44, gap: 24, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    {vault.status !== 'unlocked' && <BrandLogo color={colors.brand} height={32} />}
    {vault.status === 'loading' && <Text style={s.body}>Opening LinkUp…</Text>}
    {vault.status === 'resetting' && <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}><Text style={title}>A fresh start.</Text><Text style={s.body}>Removing the previous account’s data…</Text></View>}
    {vault.status === 'preview' && <>
      <View style={{ marginTop: 36, gap: 16 }}><Text style={{ ...title, fontSize: 44, lineHeight: 52, letterSpacing: -1.7 }}>Stay close.{`\n`}Talk freely.</Text><Text style={{ ...s.body, color: colors.sub, maxWidth: 300 }}>Private conversations, made simple.</Text></View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ gap: 14, paddingVertical: 24 }}>
        <View style={{ alignSelf: 'flex-start', borderRadius: 19, borderBottomLeftRadius: 5, backgroundColor: colors.soft, padding: 16 }}><Text style={{ ...s.body }}>Coffee later? ☕</Text></View>
        <View style={{ alignSelf: 'flex-end', borderRadius: 19, borderBottomRightRadius: 5, backgroundColor: colors.outgoing, padding: 16 }}><Text style={s.body}>Always. See you there.</Text></View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><Feather name="lock" size={15} color={colors.sub} /><Text style={s.small}>Encrypted. No phone number needed.</Text></View>
      <View style={{ flex: 1, minHeight: 4 }} /><Text style={s.small}>Creating a new account removes any previous LinkUp data on this device.</Text>
      {vault.pinUnlock.available && <>
        <ConnectionButton label="Get started" onPress={() => setPinAction('create')} disabled={busy} />
        <ConnectionButton label={showPassword ? 'Use a PIN instead' : 'Use a password instead'} secondary onPress={() => setShowPassword(v => !v)} disabled={busy} />
      </>}
      {(!vault.pinUnlock.available || showPassword) && <PasswordSetup creating password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} busy={busy} onSubmit={() => perform(() => vault.createIdentity('password', password))} />}
    </>}
    {locked && <>
      <View style={{ marginTop: 35, gap: 12 }}><Text style={title}>{vault.resetRequired ? 'Finish your fresh start.' : 'Welcome back.'}</Text><Text style={{ ...s.body, color: colors.sub }}>{vault.resetRequired ? 'The previous deletion was interrupted. Finish removing its data to continue.' : vault.pinUnlock.enabled ? 'Your conversations are just a PIN away.' : 'Open your account to keep talking.'}</Text></View>
      {vault.resetRequired ? <ConnectionButton label="Finish deleting data" onPress={() => perform(vault.startNewIdentity)} disabled={busy} /> : <>
        {vault.pinUnlock.enabled && <><View style={{ paddingVertical: 30, alignItems: 'center' }}><View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: colors.outgoing, alignItems: 'center', justifyContent: 'center' }}><Feather name="lock" color={colors.brand} size={29} /></View></View><ConnectionButton label="Enter your PIN" onPress={() => setPinAction('unlock')} disabled={busy} /><ConnectionButton label={otherMethods ? 'Hide other methods' : 'Other ways to unlock'} onPress={() => setOtherMethods(v => !v)} disabled={busy} secondary /></>}
        {(!vault.pinUnlock.enabled || otherMethods) && <>
          {vault.deviceUnlock.enabled && <ConnectionButton label="Use previous phone unlock" onPress={() => perform(vault.unlockWithDevice)} disabled={busy || !vault.deviceUnlock.available} secondary />}
          {vault.passwordEnabled && <View style={{ gap: 12 }}><TextInput accessibilityLabel="Account password" secureTextEntry value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} autoComplete="current-password" maxLength={256} editable={!busy} placeholder="Your password" placeholderTextColor={colors.sub} style={s.input} onSubmitEditing={() => { if (password.length >= 12) void perform(() => vault.unlockWithPassword(password)); }} /><ConnectionButton label="Unlock LinkUp" onPress={() => perform(() => vault.unlockWithPassword(password))} disabled={busy || password.length < 12} /></View>}
          {savedAccess && !vault.deviceUnlock.enabled && <View style={s.card}><Text style={s.name}>Keep your existing account</Text><Text style={s.small}>Verify with your phone once, then choose a LinkUp PIN.</Text>{Platform.OS === 'android' && Number(Platform.Version) >= 30 && <ConnectionButton label="Restore saved access" onPress={() => perform(() => vault.recoverOnThisPhone())} disabled={busy} secondary />}</View>}
          <ConnectionButton label={showRecovery ? 'Hide recovery key' : 'Use an old recovery key'} onPress={() => setShowRecovery(v => !v)} disabled={busy} secondary />
          {showRecovery && <View style={{ gap: 12 }}><TextInput accessibilityLabel="Vault key" secureTextEntry value={input} onChangeText={setInput} autoCapitalize="none" autoCorrect={false} maxLength={100} placeholder="Old saved recovery key" placeholderTextColor={colors.sub} editable={!busy} style={s.input} /><ConnectionButton label="Open older account" onPress={() => perform(() => vault.unlock(input))} disabled={busy || !input.trim()} /></View>}
        </>}
        <View style={{ flex: 1, minHeight: 16 }} />
        {newAccount ? resetConfirmation : <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: 22, gap: 12 }}><Text style={s.small}>Need a fresh start?</Text><ConnectionButton label="Create a new account" secondary onPress={() => setNewAccount(true)} disabled={busy} /></View>}
      </>}
    </>}
    {vault.status === 'unlocked' && <>
      <Text style={{ ...s.small, marginBottom: 2 }}>Choose how you open LinkUp.</Text>
      {vault.pinUnlock.available && <View style={s.card}><View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}><Feather name="lock" size={22} color={colors.brand} /><View style={{ flex: 1 }}><Text style={s.name}>LinkUp PIN</Text><Text style={s.small}>{vault.pinUnlock.enabled ? 'Six digits. Just for you.' : 'Your own six-digit PIN.'}</Text></View></View><ConnectionButton label={vault.pinUnlock.enabled ? 'Change PIN' : 'Set up PIN'} onPress={() => setPinAction('change')} disabled={busy} secondary /></View>}
      <View style={s.card}><Text style={s.name}>Password</Text><Text style={s.small}>{vault.passwordEnabled ? 'Another way into your account.' : 'Optional access with a longer password.'}</Text><ConnectionButton label={showPassword ? 'Cancel' : vault.passwordEnabled ? 'Change password' : 'Add password'} secondary onPress={() => setShowPassword(v => !v)} disabled={busy} />{showPassword && <PasswordSetup password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} busy={busy} onSubmit={() => perform(() => vault.setPassword(password))} />}</View>
      {vault.deviceUnlock.enabled && <View style={s.card}><Text style={s.name}>Previous phone unlock</Text>{(vault.passwordEnabled || vault.pinUnlock.enabled) && <ConnectionButton label="Turn off previous method" onPress={() => perform(vault.disableDeviceUnlock)} disabled={busy} secondary />}</View>}
      <ConnectionButton label="Lock LinkUp" onPress={vault.lock} disabled={busy} />
    </>}
    {!!vault.error && !vault.resetRequired && <Text accessibilityRole="alert" style={s.error}>{vault.error}</Text>}
    {!!problem && <Text accessibilityRole="alert" style={s.error}>{problem}</Text>}
  </ScrollView>
    {pinAction && <PinPad key={pinAction} setup={pinAction !== 'unlock'} onClose={() => setPinAction(null)} onSubmit={async pin => {
      if (pinAction === 'create') await vault.createIdentity('pin', pin);
      else if (pinAction === 'unlock') await vault.unlockWithPin(pin);
      else await vault.setPin(pin);
    }} />}
  </>;
}
function PasswordSetup({ creating = false, password, confirm, setPassword, setConfirm, busy, onSubmit }: { creating?: boolean; password: string; confirm: string; setPassword: (value: string) => void; setConfirm: (value: string) => void; busy: boolean; onSubmit: () => void }) {
  const { colors } = useAppearance(), s = connectionStyles(colors);
  return <View style={{ gap: 12 }}><Text style={s.label}>{creating ? 'Choose your password' : 'New password'}</Text><Text style={s.small}>At least 12 characters.</Text><TextInput accessibilityLabel="New password" secureTextEntry value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={256} editable={!busy} placeholder="Password" placeholderTextColor={colors.sub} style={s.input} /><TextInput accessibilityLabel="Confirm password" secureTextEntry value={confirm} onChangeText={setConfirm} autoCapitalize="none" autoCorrect={false} maxLength={256} editable={!busy} placeholder="Repeat password" placeholderTextColor={colors.sub} style={s.input} /><ConnectionButton label={busy ? 'Saving…' : creating ? 'Create account' : 'Save password'} disabled={busy || password.length < 12 || password !== confirm} onPress={onSubmit} /></View>;
}
