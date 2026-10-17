import CommonApp from '../CommonApp';
import { useVault } from '../security/VaultProvider';
export default function Index() { const { generation } = useVault(); return <CommonApp key={generation} />; }
