import * as SecureStore from 'expo-secure-store';
import { createDeviceUnlock } from './deviceUnlockCore';
export const deviceUnlock = createDeviceUnlock(SecureStore);
