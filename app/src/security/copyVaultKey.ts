import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { requireNativeModule } from 'expo-modules-core';

export async function copyVaultKey(key: string): Promise<void> {
  if (Platform.OS === 'android') {
    // Android marks this clip sensitive so system clipboard previews hide it.
    const native = requireNativeModule<{ copyVaultKey: (value: string) => Promise<void> }>('TihoUpdates');
    await native.copyVaultKey(key);
  } else if (!await Clipboard.setStringAsync(key)) {
    throw new Error('Couldn’t copy the key. Select it and copy it manually.');
  }
}
