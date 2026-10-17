// SPDX-License-Identifier: GPL-3.0-only
import { createHmac, randomBytes } from 'node:crypto';

export function readCallConfiguration(env = process.env) {
  const urls = (env.TURN_URLS ?? '').split(',').filter(Boolean);
  if (urls.length > 4 || urls.some(url => !/^(?:turn|turns):[a-zA-Z0-9.-]+:\d{1,5}(?:\?transport=(?:udp|tcp))?$/.test(url))) {
    throw new Error('TURN_URLS must contain at most four turn/turns host:port addresses.');
  }
  const secret = env.TURN_SECRET ?? '';
  if (urls.length && (secret.length < 32 || secret.length > 256)) throw new Error('TURN_SECRET must contain 32–256 characters when TURN is enabled.');
  return { urls, secret };
}
/** coturn REST credentials: a short lifetime, random username, no identity key. */
export function issueCallConfiguration(configuration, now = Date.now()) {
  if (!configuration.urls.length) return { expiresAt: now + 60_000, iceServers: [] };
  const expiresAt = Math.floor(now / 1000) * 1000 + 600_000;
  const username = `${expiresAt / 1000}:${randomBytes(12).toString('hex')}`;
  const credential = createHmac('sha1', configuration.secret).update(username).digest('base64');
  return { expiresAt, iceServers: [{ urls: [...configuration.urls], username, credential }] };
}
