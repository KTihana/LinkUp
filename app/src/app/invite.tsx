import CommonApp from '../CommonApp';
import { useVault } from '../security/VaultProvider';
import { useLocalSearchParams } from 'expo-router';

export default function InviteRoute() {
  const { generation } = useVault();
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  // Do not silently choose one of multiple invitation parameters.
  const input = typeof token === 'string' ? token : token ? 'Invalid invitation: multiple tokens' : '';
  return <CommonApp key={`${generation}:${input}`} invitationInput={input} />;
}
