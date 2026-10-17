// SPDX-License-Identifier: GPL-3.0-only
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
export const RELEASE_DOMAIN = 'Tiho Android release v1\n';
export const MAX_APK_BYTES = 200 * 1024 * 1024;
export type Release = { schema: 1; packageName: string; version: string; versionCode: number; minSdk: number; abi: 'arm64-v8a'; file: string; sha256: string; bytes: number; publishedAt: string; notes: string };
export function validRepository(repo: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo) && !repo.endsWith('.git');
}
/** Follow the publisher's repository rename without changing custom sources. */
export function migrateReleaseRepository(repo: string): string {
  return repo.toLowerCase() === 'ktihana/tiho' ? 'KTihana/LinkUp' : repo;
}
export function verifyRelease(raw: string, publicKey: string, packageName: string, tag: string): Release {
  if (raw.length > 16384) throw new Error('Release information is too large.');
  const envelope = JSON.parse(raw);
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 8192 || !/^[a-f0-9]{128}$/.test(envelope.signature)) throw new Error('Invalid signed release information.');
  if (!ed25519.verify(hexToBytes(envelope.signature), utf8ToBytes(RELEASE_DOMAIN + envelope.payload), hexToBytes(publicKey))) throw new Error('This release wasn’t signed by your LinkUp publisher.');
  const p = JSON.parse(envelope.payload);
  if (!p || p.schema !== 1 || p.packageName !== packageName || !/^\d+\.\d+\.\d+$/.test(p.version) || tag !== `v${p.version}` ||
    !Number.isSafeInteger(p.versionCode) || p.versionCode < 1 || p.versionCode > 2147483647 || p.minSdk !== 24 || p.abi !== 'arm64-v8a' ||
    p.file !== `tiho-${p.version}-arm64.apk` || !/^[a-f0-9]{64}$/.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_APK_BYTES ||
    typeof p.notes !== 'string' || p.notes.length > 2000 || typeof p.publishedAt !== 'string' || !Number.isFinite(Date.parse(p.publishedAt))) throw new Error('Invalid release information.');
  return p;
}
export function assetUrl(repo: string, version: string, file: string): string {
  if (!validRepository(repo) || !/^\d+\.\d+\.\d+$/.test(version) || file !== `tiho-${version}-arm64.apk`) throw new Error('Invalid release asset.');
  return `https://github.com/${repo}/releases/download/v${version}/${file}`;
}
async function readUpdateText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Update information is too large.');
  }
  // Expo 57 installs streaming fetch on native. Never fall back to text(),
  // which would allocate an unbounded response before its size can be checked.
  if (!response.body?.getReader) throw new Error('A streaming fetch implementation is required for updates.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0, complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const check = () => { if (signal.aborted) throw new Error('Update check cancelled.'); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    check();
    while (true) {
      const { done, value } = await reader.read(); check();
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > limit) throw new Error('Update information is too large.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
export async function latestRelease(repo: string, publicKey: string, packageName: string, signal: AbortSignal): Promise<Release | null> {
  if (!validRepository(repo)) throw new Error('Use a GitHub repository in the form owner/name.');
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { signal, credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
  if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`GitHub update check failed (${response.status}). Try again later.`); }
  const text = await readUpdateText(response, 262144, signal);
  const data = JSON.parse(text);
  if (data.draft || data.prerelease || !/^v\d+\.\d+\.\d+$/.test(data.tag_name) || !Array.isArray(data.assets) || data.assets.length > 100) throw new Error('Invalid stable release.');
  const manifest = data.assets.filter((a: { name?: string }) => a.name === 'tiho-update-v1.json');
  if (manifest.length !== 1 || manifest[0].size > 16384 || manifest[0].size < 1) throw new Error('This release has no signed LinkUp update information.');
  const url = `https://github.com/${repo}/releases/download/${data.tag_name}/tiho-update-v1.json`;
  // GitHub release assets redirect to its CDN; the body still must pass the
  // pinned publisher signature before it can authorize an APK download.
  const signed = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
  if (!signed.ok) { void signed.body?.cancel().catch(() => {}); throw new Error('Couldn’t fetch the signed update information.'); }
  const release = verifyRelease(await readUpdateText(signed, 16384, signal), publicKey, packageName, data.tag_name);
  const assets = data.assets.filter((a: { name?: string; size?: number }) => a.name === release.file && a.size === release.bytes);
  if (assets.length !== 1) throw new Error('The APK doesn’t match its signed release information.');
  return release;
}
