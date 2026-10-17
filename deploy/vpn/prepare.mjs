// SPDX-License-Identifier: GPL-3.0-only
// Public data only. Generate the hub private key separately, on the server.
import { createPublicKey, verify } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const DAY = 86400000;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();
const identity = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function publicKey(value) {
  return typeof value === 'string' && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').some(Boolean) && Buffer.from(value, 'base64').toString('base64') === value;
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 260 || value.split(':').length !== 2) return false;
  const [host, port] = value.split(':');
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return false;
  if (/^[0-9.]+$/.test(host)) {
    const p = host.split('.');
    return p.length === 4 && p.every(n => /^(0|[1-9][0-9]{0,2})$/.test(n) && +n <= 255) && +p[0] >= 1 && +p[0] <= 223 && +p[0] !== 127 && !(+p[0] === 169 && +p[1] === 254) && !(+p[0] === 10 && +p[1] === 203);
  }
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2 && host === host.toLowerCase() && labels.every(p => p.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)) && /^[a-z]{2,63}$/.test(labels.at(-1)) && !['localhost','local','internal'].includes(labels.at(-1));
}
export function verifyEnrollment(e, now) {
  if (!exact(e, ['schema','identity','devicePublicKey','issuedAt','signature']) || e.schema !== 1 || !identity(e.identity) || !publicKey(e.devicePublicKey) || !Number.isSafeInteger(e.issuedAt) || e.issuedAt < now - 7 * DAY || e.issuedAt > now + 30000 || !/^[a-f0-9]{128}$/.test(e.signature)) throw new Error('Invalid or expired signed phone enrollment.');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), Buffer.from(e.identity,'hex')]), format: 'der', type: 'spki' });
  const payload = 'linkup/vpn-enrollment/v1\n' + JSON.stringify({schema:1,identity:e.identity,devicePublicKey:e.devicePublicKey,issuedAt:e.issuedAt});
  if (!verify(null, Buffer.from(payload), key, Buffer.from(e.signature,'hex'))) throw new Error('Phone enrollment signature failed.');
}
export function prepare(policy, hubPublicKey, now = Date.now()) {
  if (!exact(policy, ['schema','label','endpoint','expiresAt','devices','friends']) || policy.schema !== 1 || typeof policy.label !== 'string' || !/^[\x20-\x7e]{1,40}$/.test(policy.label) || !endpoint(policy.endpoint) || !publicKey(hubPublicKey)) throw new Error('Invalid hub policy.');
  if (!Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= now || policy.expiresAt - now > 7 * DAY) throw new Error('Network policy must expire within seven days.');
  if (!Array.isArray(policy.devices) || policy.devices.length < 2 || policy.devices.length > 64 || !Array.isArray(policy.friends) || policy.friends.length > 2016) throw new Error('Use 2–64 phones and explicit friend pairs.');
  const ids = new Set(), keys = new Set(), devices = policy.devices.map((e, index) => {
    verifyEnrollment(e, now);
    if (ids.has(e.identity) || keys.has(e.devicePublicKey) || hubPublicKey === e.devicePublicKey) throw new Error('Each account, phone key and hub key must be distinct.');
    ids.add(e.identity); keys.add(e.devicePublicKey);
    return { ...e, address: `10.203.0.${index + 2}/32`, peers: [] };
  });
  const pairs = new Set();
  for (const pair of policy.friends) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(identity) || pair[0] === pair[1] || pair.some(id => !ids.has(id))) throw new Error('Unknown or invalid friend pair.');
    const canonical = [...pair].sort().join(':');
    if (pairs.has(canonical)) throw new Error('Duplicate friend pair.');
    pairs.add(canonical);
    const [a,b] = pair.map(id => devices.find(d => d.identity === id));
    a.peers.push(b.address); b.peers.push(a.address);
  }
  if (devices.some(d => !d.peers.length)) throw new Error('Every phone needs at least one explicitly permitted friend.');
  const configurations = devices.map(d => ({ schema:1, identity:d.identity, devicePublicKey:d.devicePublicKey, label:policy.label, address:d.address, hubPublicKey, endpoint:policy.endpoint, peers:d.peers.sort(), expiresAt:policy.expiresAt }));
  const wg = ['[Interface]','Address = 10.203.0.1/32',`ListenPort = ${policy.endpoint.split(':')[1]}`,'PreUp = /usr/sbin/nft -f /etc/wireguard/linkup.nft','PostUp = /usr/bin/wg set %i private-key /etc/wireguard/linkup.key','',...devices.flatMap(d => ['[Peer]',`PublicKey = ${d.devicePublicKey}`,`AllowedIPs = ${d.address}`,''])].join('\n');
  const acl = configurations.flatMap(d => d.peers.map(p => `    iifname "wg-linkup" oifname "wg-linkup" ip saddr ${d.address} ip daddr ${p} tcp dport 47443 accept\n    iifname "wg-linkup" oifname "wg-linkup" ip saddr ${d.address} ip daddr ${p} tcp sport 47443 ct state established accept`));
  const nft = ['# Atomic replacement of this dedicated table; never flush the host ruleset.','add table inet linkup_vpn','flush table inet linkup_vpn','table inet linkup_vpn {','  chain input { type filter hook input priority -10; policy accept; iifname "wg-linkup" drop; }','  chain output { type filter hook output priority -10; policy accept; oifname "wg-linkup" drop; }','  chain forward { type filter hook forward priority -10; policy accept;', ...acl, '    iifname "wg-linkup" drop','    oifname "wg-linkup" drop','  }','}',''].join('\n');
  // The service runs before wg-quick and the timer removes all peer keys at expiry,
  // including from a restarted server. Local app expiry is not the only boundary.
  const expire = `#!/bin/sh\nset -eu\nexpiry=${Math.floor(policy.expiresAt / 1000)}\nnow=$(date +%s)\nif [ "$now" -ge "$expiry" ]; then\n  exit 1\nfi\n`;
  const timer = `[Unit]\nDescription=Expire LinkUp private network enrollment\n[Timer]\nOnCalendar=${new Date(policy.expiresAt).toISOString().replace('T',' ').slice(0,19)} UTC\nPersistent=true\nAccuracySec=1us\nRandomizedDelaySec=0\nUnit=linkup-vpn-expire.service\n[Install]\nWantedBy=timers.target\n`;
  return { configurations, wg, nft, expire, timer };
}
async function main() {
  if (process.argv.length !== 5) throw new Error('Usage: node deploy/vpn/prepare.mjs POLICY.json HUB-PUBLIC-KEY.txt OUTPUT-DIRECTORY');
  const [policyFile,keyFile,out] = process.argv.slice(2), policyText = await readFile(policyFile,'utf8');
  if (Buffer.byteLength(policyText) > 200000) throw new Error('Policy too large.');
  const result = prepare(JSON.parse(policyText), (await readFile(keyFile,'utf8')).trim());
  await mkdir(out,{recursive:false,mode:0o700});
  const files = { 'wg-linkup.conf': result.wg, 'linkup.nft': result.nft, 'linkup-vpn-check': result.expire, 'linkup-vpn-expire.timer': result.timer,
    'linkup-vpn-expire.service':'[Unit]\nDescription=Stop expired LinkUp private network\n[Service]\nType=oneshot\nExecStart=/usr/bin/systemctl stop wg-quick@wg-linkup.service\n',
    'wg-linkup-guard.conf':'[Unit]\nRequires=linkup-vpn-expire.timer\nAfter=linkup-vpn-expire.timer\n[Service]\nExecStartPre=/usr/local/sbin/linkup-vpn-check\n',
    ...Object.fromEntries(result.configurations.map(c => [c.identity + '.json',JSON.stringify(c,null,2)+'\n'])) };
  for (const [name,body] of Object.entries(files)) await writeFile(resolve(out,name),body,{mode:name==='linkup-vpn-check'?0o700:0o600,flag:'wx'});
  process.stdout.write(`Prepared ${result.configurations.length} public phone configurations and the server policy. No server was changed or started.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode=1; });
