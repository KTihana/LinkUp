// SPDX-License-Identifier: GPL-3.0-only
import type { CallMedia, CallNetwork, MediaEvents } from './controller.ts';
import { validateSdp, type CallMode, type IceCandidate } from './protocol.ts';

type Track = { kind: string; enabled: boolean; stop: () => void };
export type StreamLike = { getTracks(): Track[]; getAudioTracks(): Track[]; getVideoTracks(): Track[] };
export interface PeerLike {
  connectionState: string;
  onicecandidate: ((event: { candidate: { toJSON(): IceCandidate } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: { streams: StreamLike[] }) => void) | null;
  addTrack(track: Track, stream: StreamLike): unknown;
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>;
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>;
  setLocalDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  close(): void;
}
export type RtcBindings = {
  media: (mode: CallMode, signal: AbortSignal) => Promise<StreamLike>;
  peer: (network: CallNetwork) => PeerLike;
  speaker: (value: boolean) => Promise<void>;
  cleanup: () => void;
};
function localAddress(address: string): boolean {
  if (/^[a-zA-Z0-9-]+\.local$/.test(address)) return true;
  const octets = address.split('.');
  if (octets.length === 4 && octets.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
    const [a, b] = octets.map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+$/i.test(address);
}
export function localCandidate(candidate: IceCandidate): boolean {
  const parts = candidate.candidate.split(/\s+/);
  return parts.length >= 8 && parts[6] === 'typ' && parts[7] === 'host' && localAddress(parts[4]);
}
export function enforceLocalSdp(sdp: string) {
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('a=candidate:') && !localCandidate({ candidate: line.slice(2), sdpMid: null, sdpMLineIndex: null })) throw new Error('Nearby calls accept local Wi-Fi routes only.');
    if (line.startsWith('c=IN ')) {
      const address = line.split(' ')[2];
      if (!['0.0.0.0', '::'].includes(address) && !localAddress(address)) throw new Error('Nearby calls accept local Wi-Fi routes only.');
    }
  }
}
export async function openRtcMedia(bindings: RtcBindings, mode: CallMode, network: CallNetwork, events: MediaEvents, signal: AbortSignal): Promise<CallMedia> {
  let peer: PeerLike | null = null, stream: StreamLike | null = null, closed = false;
  const close = () => {
    if (closed) return; closed = true;
    signal.removeEventListener('abort', close);
    if (peer) { peer.onicecandidate = null; peer.onconnectionstatechange = null; peer.ontrack = null; peer.close(); }
    stream?.getTracks().forEach(track => track.stop()); bindings.cleanup();
  };
  const check = () => { if (closed || signal.aborted) throw new Error('Call ended.'); };
  signal.addEventListener('abort', close, { once: true });
  try {
    check(); stream = await bindings.media(mode, signal);
    if (closed || signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw new Error('Call ended.'); }
    let generation = 0;
    const connect = (configuration: CallNetwork, nextGeneration: number) => {
      if (configuration.localOnly !== network.localOnly) throw new Error('Call routing changed. Start a new call with the selected privacy setting.');
      check();
      const previous = peer;
      // Keep the user's existing capture tracks. Each connection owns its
      // callbacks so late candidates from a closed connection are discarded.
      if (previous) { previous.onicecandidate = null; previous.onconnectionstatechange = null; previous.ontrack = null; previous.close(); }
      const pc = bindings.peer(configuration); peer = pc; generation = nextGeneration;
      pc.onicecandidate = event => {
        if (closed || peer !== pc || !event.candidate) return;
        const value = event.candidate.toJSON();
        const candidate = { candidate: value.candidate, sdpMid: value.sdpMid ?? null, sdpMLineIndex: value.sdpMLineIndex ?? null };
        if (!network.localOnly || localCandidate(candidate)) events.candidate(candidate, nextGeneration);
      };
      pc.onconnectionstatechange = () => { if (!closed && peer === pc) events.connection(pc.connectionState); };
      pc.ontrack = event => { if (!closed && peer === pc && event.streams[0]) events.streams(stream, event.streams[0]); };
      for (const track of stream!.getTracks()) pc.addTrack(track, stream!);
      events.streams(stream, null);
    };
    connect(network, 0);
    const remote = async (type: 'offer' | 'answer', sdp: string) => {
      check(); validateSdp(sdp, mode); if (network.localOnly) enforceLocalSdp(sdp);
      const pc = peer!, expected = generation;
      await pc.setRemoteDescription({ type, sdp }); check();
      if (peer !== pc || generation !== expected) throw new Error('Call connection changed.');
    };
    const local = async (type: 'offer' | 'answer') => {
      check(); const pc = peer!, expected = generation; const description = await (type === 'offer' ? pc.createOffer() : pc.createAnswer()); check();
      if (peer !== pc || generation !== expected) throw new Error('Call connection changed.');
      validateSdp(description.sdp, mode);
      // Some engines include candidates in the initial SDP as well as emitting
      // trickle events. Apply the same routing policy before using or sharing it.
      if (network.localOnly) enforceLocalSdp(description.sdp);
      await pc.setLocalDescription({ type, sdp: description.sdp }); check();
      if (peer !== pc || generation !== expected) throw new Error('Call connection changed.');
      return description.sdp;
    };
    return {
      reconnect: (configuration, nextGeneration) => connect(configuration, nextGeneration),
      offer: () => local('offer'), answer: async sdp => { await remote('offer', sdp); return local('answer'); },
      receiveAnswer: sdp => remote('answer', sdp),
      addCandidate: async candidate => { check(); if (network.localOnly && !localCandidate(candidate)) throw new Error('A non-local call route was rejected.'); await peer!.addIceCandidate(candidate); },
      mute: value => stream?.getAudioTracks().forEach(track => { track.enabled = !value; }),
      camera: value => stream?.getVideoTracks().forEach(track => { track.enabled = value; }),
      speaker: value => bindings.speaker(value), close,
    };
  } catch (error) { close(); throw error; }
}
