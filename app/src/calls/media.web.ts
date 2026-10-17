// SPDX-License-Identifier: GPL-3.0-only
import type { CallNetwork, MediaEvents } from './controller';
import type { CallMode } from './protocol';
import { openRtcMedia, type PeerLike } from './mediaCore';

export function createCallMedia(mode: CallMode, network: CallNetwork, events: MediaEvents, signal: AbortSignal) {
  return openRtcMedia({
    media: async () => {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Calls require HTTPS and a browser with microphone support.');
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: mode === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false });
    },
    peer: config => new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }) as unknown as PeerLike,
    speaker: async () => { /* Browsers use the output selected by the user/OS. */ }, cleanup: () => {},
  }, mode, network, events, signal);
}
