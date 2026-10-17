// SPDX-License-Identifier: GPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function configuration({ mailbox, turn, publicIp, origin = '' }, secret) {
  if (!domainPattern.test(mailbox ?? '') || !domainPattern.test(turn ?? '') || mailbox === turn) throw new Error('Provide separate valid mailbox and TURN domain names.');
  const octets = (publicIp ?? '').split('.').map(Number);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(publicIp ?? '') || octets.some(n => n > 255)
    || octets.some((n, i) => String(n) !== publicIp.split('.')[i])
    || [0, 10, 127].includes(octets[0]) || octets[0] >= 224 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 198 && [18, 19].includes(octets[1]))
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)) throw new Error('Provide the server’s public IPv4 address.');
  if (origin) { const url = new URL(origin); if (url.origin !== origin || url.protocol !== 'https:') throw new Error('The web origin must be an exact HTTPS origin.'); }
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Expected a random 32-byte relay secret.');
  return {
    environment: `MAILBOX_DOMAIN=${mailbox}\n`,
    mailbox: `ALLOWED_ORIGINS=${origin}\nTURN_URLS=turns:${turn}:5349?transport=tcp\nTURN_SECRET=${secret}\n`,
    turn: `realm=${turn}\nserver-name=${turn}\nexternal-ip=${publicIp}\nlistening-port=3478\ntls-listening-port=5349\nmin-port=49160\nmax-port=49200\nfingerprint\nuse-auth-secret\nstatic-auth-secret=${secret}\ncert=/etc/tiho/certificates/fullchain.pem\npkey=/etc/tiho/certificates/privkey.pem\nno-cli\nno-udp\nno-tcp\nno-dtls\nno-multicast-peers\nno-tcp-relay\nno-tlsv1\nno-tlsv1_1\nuser-quota=4\ntotal-quota=64\nmax-bps=262144\nbps-capacity=8388608\nstale-nonce=600\nno-stdout-log\nlog-file=/dev/null\nsimple-log\npidfile=/tmp/turnserver.pid\n` +
      ['0.0.0.0-0.255.255.255','10.0.0.0-10.255.255.255','100.64.0.0-100.127.255.255','127.0.0.0-127.255.255.255','169.254.0.0-169.254.255.255','172.16.0.0-172.31.255.255','192.168.0.0-192.168.255.255','224.0.0.0-255.255.255.255','::1','fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff','fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'].map(range => `denied-peer-ip=${range}\n`).join(''),
  };
}
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  const [mailbox, turn, publicIp, origin = ''] = process.argv.slice(2);
  const files = configuration({ mailbox, turn, publicIp, origin }, randomBytes(32).toString('hex'));
  const root = dirname(fileURLToPath(import.meta.url)), privateDir = resolve(root, '.private');
  try { await lstat(privateDir); throw new Error('Configuration exists. Refusing to overwrite the relay secret.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(privateDir, { mode: 0o700 });
  await writeFile(resolve(privateDir, 'mailbox.env'), files.mailbox, { mode: 0o600, flag: 'wx' });
  // The host parent stays 0700; the individually mounted file must be readable
  // by coturn's unprivileged container UID, which differs from the host owner.
  await writeFile(resolve(privateDir, 'turnserver.conf'), files.turn, { mode: 0o444, flag: 'wx' });
  await mkdir(resolve(privateDir, 'certificates'), { mode: 0o700 });
  await writeFile(resolve(root, '.env'), files.environment, { mode: 0o600, flag: 'wx' });
  console.log('Prepared private relay configuration. Add the TURN TLS certificate before starting the services. No server has been deployed.');
}
