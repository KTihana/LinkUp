import { UpdatesProvider } from '../updates/UpdatesProvider';
import { Slot } from 'expo-router';
import Head from 'expo-router/head';
import { useFonts, Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { AppearanceProvider } from '../appearance/AppearanceProvider';
import { useVault, VaultProvider } from '../security/VaultProvider';
import { VpnProvider } from '../vpn/VpnProvider';
import { MessagingProvider } from '../messaging/MessagingProvider';
import { ensureMessagingCrypto } from '../messaging/cryptoRuntime';
import { CallsProvider } from '../calls/CallsProvider';
import { CallPanel } from '../calls/CallPanel';
function AccountUpdates({ children }: { children: React.ReactNode }) {
  const { generation, identity } = useVault();
  return <UpdatesProvider key={`${generation}:${identity ?? ''}`}>{children}</UpdatesProvider>;
}
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ LinkUpManrope: Manrope_400Regular, LinkUpManropeMedium: Manrope_500Medium, LinkUpManropeSemiBold: Manrope_600SemiBold, LinkUpManropeBold: Manrope_700Bold, LinkUpManropeExtraBold: Manrope_800ExtraBold });
  useEffect(() => {
    if (Platform.OS === 'web') return;
    // Verify the native engine on the installed binary, using only ephemeral
    // self-test material. No user profile, key, message or identity is logged.
    void ensureMessagingCrypto().then(() => console.info('LinkUp: native encryption self-test passed.'))
      .catch(() => console.warn('LinkUp: native encryption self-test failed; messaging remains unavailable.'));
  }, []);
  if (!fontsLoaded && !fontError) return null;
  return <><Head><title>LinkUp</title><meta name="application-name" content="LinkUp" /></Head><VaultProvider><AppearanceProvider><VpnProvider><MessagingProvider><CallsProvider><AccountUpdates><Slot /><CallPanel /></AccountUpdates></CallsProvider></MessagingProvider></VpnProvider></AppearanceProvider></VaultProvider></>;
}
