// SPDX-License-Identifier: GPL-3.0-only
import CommonApp from '../CommonApp';
import { useVault } from '../security/VaultProvider';
import { useLocalSearchParams } from 'expo-router';

export default function NearbyRoute() {
  const { generation } = useVault();
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const input = typeof token === 'string' ? token : token ? 'Invalid nearby code: multiple tokens' : '';
  return <CommonApp key={`${generation}:${input}`} nearbyInput={input} />;
}
