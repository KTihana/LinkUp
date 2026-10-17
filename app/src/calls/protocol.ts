// SPDX-License-Identifier: GPL-3.0-only
// Signaling is carried inside authenticated MLS application messages. Media
// uses WebRTC DTLS-SRTP; the authenticated SDP binds the peer certificate.
export type CallMode = 'voice' | 'video';
export type IceCandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
type Base = { version: 1; callId: string; createdAt: number };
export type CallSignal = Base & (
  { type: 'invite'; mode: CallMode }
  | { type: 'ringing' | 'accept' }
  | { type: 'offer' | 'answer'; generation: number; sdp: string }
  | { type: 'ice'; generation: number; candidate: IceCandidate }
  | { type: 'restart'; generation: number }
  | { type: 'end'; reason: 'hangup' | 'declined' | 'busy' | 'timeout' | 'failed' }
);
export const CALL_SIGNAL_TTL = 90_000;
const id = /^[a-f0-9]{32}$/;
const encode = new TextEncoder();
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid call signal.');
}
/** Require DTLS-SRTP audio/video. Never accept data channels, SDES, or plain RTP. */
export function validateSdp(sdp: unknown, mode?: CallMode): asserts sdp is string {
  if (typeof sdp !== 'string' || encode.encode(sdp).length > 7_400 || /\0/.test(sdp)
    || !sdp.startsWith('v=0\r\n') || /[\r\n]/.test(sdp.replace(/\r\n/g, ''))
    || /(?:^|\r\n)a=crypto:/i.test(sdp)) throw new Error('Unsupported call description.');
  const lines = sdp.split('\r\n');
  const media = lines.filter(line => line.startsWith('m='));
  if (media.length < 1 || media.length > 2 || !media.some(line => line.startsWith('m=audio '))
    || media.some(line => !/^m=(audio|video) \d+ UDP\/TLS\/RTP\/SAVPF [\d ]+$/.test(line))
    || (mode === 'voice' && media.some(line => line.startsWith('m=video ')))) throw new Error('Unsupported call media.');
  const fingerprint = /^a=fingerprint:sha-256 (?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;
  const firstMedia = lines.findIndex(line => line.startsWith('m='));
  const sessionFingerprint = lines.slice(0, firstMedia).some(line => fingerprint.test(line));
  const sections = sdp.split(/(?=^m=)/m).slice(1);
  if (!sessionFingerprint && sections.some(section => !section.split('\r\n').some(line => fingerprint.test(line)))) {
    throw new Error('The call is missing an authenticated DTLS fingerprint.');
  }
}
export function validateCallSignal(value: unknown, now: number, checkTime = true): asserts value is CallSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid call signal.');
  const v = value as Record<string, unknown>;
  const extra = v.type === 'invite' ? ['mode'] : v.type === 'offer' || v.type === 'answer' ? ['generation', 'sdp']
    : v.type === 'ice' ? ['generation', 'candidate'] : v.type === 'restart' ? ['generation'] : v.type === 'end' ? ['reason'] : [];
  exact(v, ['version', 'callId', 'createdAt', 'type', ...extra]);
  if (v.version !== 1 || typeof v.callId !== 'string' || !id.test(v.callId)
    || !Number.isSafeInteger(v.createdAt) || (v.createdAt as number) < 0
    || (checkTime && ((v.createdAt as number) > now + 15_000 || (v.createdAt as number) + CALL_SIGNAL_TTL <= now))) throw new Error('Expired or invalid call signal.');
  if (['offer', 'answer', 'ice', 'restart'].includes(v.type as string)
    && (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || (v.generation as number) > 1024)) throw new Error('Invalid call generation.');
  if (v.type === 'invite') { if (v.mode !== 'voice' && v.mode !== 'video') throw new Error('Unsupported call type.'); }
  else if (v.type === 'offer' || v.type === 'answer') validateSdp(v.sdp);
  else if (v.type === 'ice') {
    exact(v.candidate, ['candidate', 'sdpMid', 'sdpMLineIndex']);
    const c = v.candidate;
    if (typeof c.candidate !== 'string' || c.candidate.length > 2048 || !c.candidate.startsWith('candidate:')
      || /[\r\n\0]/.test(c.candidate) || (c.sdpMid !== null && (typeof c.sdpMid !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(c.sdpMid)))
      || (c.sdpMLineIndex !== null && (!Number.isInteger(c.sdpMLineIndex) || (c.sdpMLineIndex as number) < 0 || (c.sdpMLineIndex as number) > 1))) throw new Error('Invalid call candidate.');
  } else if (v.type === 'end') {
    if (!['hangup', 'declined', 'busy', 'timeout', 'failed'].includes(v.reason as string)) throw new Error('Invalid call ending.');
  } else if (v.type !== 'ringing' && v.type !== 'accept' && v.type !== 'restart') throw new Error('Unsupported call signal.');
}
