// SPDX-License-Identifier: GPL-3.0-only
import { PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { CallNetwork, MediaEvents } from './controller';
import type { CallMode } from './protocol';
import { openRtcMedia, type PeerLike } from './mediaCore';

const audio = requireOptionalNativeModule<{ speaker(value: boolean): Promise<void>; stop(): Promise<void> }>('TihoCallAudio');
export function createCallMedia(mode: CallMode, network: CallNetwork, events: MediaEvents, signal: AbortSignal) {
  return openRtcMedia({
    media: async () => {
      if (Platform.OS === 'android') {
        const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
        if (mode === 'video') permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
        const result = await PermissionsAndroid.requestMultiple(permissions);
        if (permissions.some(permission => result[permission] !== PermissionsAndroid.RESULTS.GRANTED)) throw new Error('Allow microphone access to join a call; video calls also need the camera.');
      }
      if (signal.aborted) throw new Error('Call ended.');
      return mediaDevices.getUserMedia({ audio: true, video: mode === 'video' ? { facingMode: 'user', width: 640, height: 480, frameRate: 24 } : false });
    },
    peer: config => new RTCPeerConnection({ iceServers: config.iceServers.map(server => ({ ...server, urls: [...server.urls] })), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }) as unknown as PeerLike,
    speaker: async value => { if (audio) await audio.speaker(value); },
    cleanup: () => { void audio?.stop().catch(() => {}); },
  }, mode, network, events, signal);
}
