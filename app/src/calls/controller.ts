// SPDX-License-Identifier: GPL-3.0-only
import { validateCallSignal, validateSdp, type CallMode, type CallSignal, type IceCandidate } from './protocol.ts';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed';
export type CallState = {
  phase: CallPhase; callId: string; peer: string; mode: CallMode; incoming: boolean;
  muted: boolean; camera: boolean; speaker: boolean; connectedAt: number | null;
  reason: string; localStream: unknown; remoteStream: unknown;
};
export type CallNetwork = { iceServers: { urls: string[]; username?: string; credential?: string }[]; localOnly: boolean; expiresAt?: number };
export interface CallMedia {
  reconnect(network: CallNetwork, generation: number): void;
  offer(): Promise<string>;
  answer(offer: string): Promise<string>;
  receiveAnswer(answer: string): Promise<void>;
  addCandidate(candidate: IceCandidate): Promise<void>;
  mute(value: boolean): void;
  camera(value: boolean): void;
  speaker(value: boolean): Promise<void>;
  close(): void;
}
export type MediaEvents = {
  candidate: (candidate: IceCandidate, generation: number) => void;
  connection: (state: string) => void;
  streams: (local: unknown, remote: unknown) => void;
};
type Dependencies = {
  id: () => Promise<string>; now: () => number;
  send: (peer: string, signal: CallSignal) => Promise<void>;
  network: (refresh?: boolean) => Promise<CallNetwork>;
  media: (mode: CallMode, network: CallNetwork, events: MediaEvents, signal: AbortSignal) => Promise<CallMedia>;
  allowed: (peer: string) => boolean;
};
const empty = (): CallState => ({ phase: 'idle', callId: '', peer: '', mode: 'voice', incoming: false,
  muted: false, camera: false, speaker: false, connectedAt: null, reason: '', localStream: null, remoteStream: null });
const active = (state: CallState) => !['idle', 'ended', 'failed'].includes(state.phase);
/** One call per device. No incoming signal can grant media permission. */
export class CallController {
  private state = empty();
  private listeners = new Set<() => void>();
  private media: CallMedia | null = null;
  private token = 0;
  private signaling: Promise<unknown> = Promise.resolve();
  private outbound: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private candidates: { candidate: IceCandidate; generation: number }[] = [];
  private generation = 0;
  private candidateIds = new Map<number, Set<string>>();
  private recovering = false;
  private lastRecovery = -Infinity;
  private renewal: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteReady = false;
  private started = false;
  private accepted = false;
  private closed = new Map<string, number>();
  private deps: Dependencies;
  private abort = new AbortController();
  constructor(deps: Dependencies) { this.deps = deps; }
  setCallbacks(callbacks: Pick<Dependencies, 'allowed' | 'send' | 'network'>) { this.deps = { ...this.deps, ...callbacks }; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(patch: Partial<CallState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private live(token: number) { return token === this.token && active(this.state); }
  private deadline(ms: number, reason: string) {
    clearTimeout(this.timer); const token = this.token;
    this.timer = setTimeout(() => { if (this.live(token)) this.end('timeout', reason); }, ms);
  }
  private send(fields: Omit<CallSignal, 'version' | 'callId' | 'createdAt'> | Record<string, unknown>) {
    const signal = { version: 1, callId: this.state.callId, createdAt: this.deps.now(), ...fields } as CallSignal;
    const peer = this.state.peer, token = this.token;
    const task = this.outbound.then(async () => {
      if (!this.live(token)) return;
      validateCallSignal(signal, this.deps.now()); await this.deps.send(peer, signal);
    });
    this.outbound = task.catch(() => {}); return task;
  }
  private fail(token: number, message = 'The call could not connect. Try again.') {
    if (this.live(token)) this.end('failed', message);
  }
  private begin(peer: string, callId: string, mode: CallMode, incoming: boolean) {
    this.abort = new AbortController();
    // Permission prompts from a finished call may resolve much later. New
    // calls must not wait behind that call's signaling work.
    this.signaling = Promise.resolve(); this.outbound = Promise.resolve();
    clearTimeout(this.renewal); clearTimeout(this.recoveryTimer);
    this.candidateIds.clear(); this.generation = 0; this.recovering = false; this.lastRecovery = -Infinity;
    this.token += 1; this.media = null; this.candidates = []; this.remoteReady = false; this.started = false; this.accepted = false;
    this.update({ ...empty(), peer, callId, mode, incoming, camera: mode === 'video', speaker: mode === 'video', phase: incoming ? 'incoming' : 'outgoing' });
    this.deadline(60_000, incoming ? 'Missed call' : 'No answer');
  }
  start = async (peer: string, mode: CallMode) => {
    if (active(this.state)) throw new Error('Finish the current call first.');
    if (!this.deps.allowed(peer)) throw new Error('Unlock LinkUp and choose an accepted friend before calling.');
    // Reserve before awaiting random generation or configuration.
    this.begin(peer, '', mode, false); const token = this.token;
    try {
      const callId = await this.deps.id(); if (!this.live(token)) return;
      this.update({ callId });
      await this.deps.network(); if (!this.live(token)) return;
      await this.send({ type: 'invite', mode });
    } catch (error) { this.fail(token, error instanceof Error ? error.message : 'Could not start the call.'); }
  };
  receive = (peer: string, signal: CallSignal) => {
    try { validateCallSignal(signal, this.deps.now()); } catch { return; }
    if (!this.deps.allowed(peer)) return;
    for (const [id, until] of this.closed) if (until <= this.deps.now()) this.closed.delete(id);
    const key = `${peer}:${signal.callId}`;
    if (this.closed.has(key)) return;
    // Hangup must cancel permission acquisition immediately, not wait behind it.
    if (signal.type === 'end') {
      this.remember(peer, signal.callId);
      if (active(this.state) && peer === this.state.peer && signal.callId === this.state.callId) {
        this.finish(signal.reason === 'failed' ? 'failed' : 'ended',
          ({ hangup: 'Call ended', declined: 'Call declined', busy: 'Already on a call', timeout: 'No answer', failed: 'Connection failed' })[signal.reason]);
      }
      return;
    }
    if (signal.type === 'invite') {
      if (active(this.state)) {
        if (peer === this.state.peer && signal.callId === this.state.callId) return;
        // Simultaneous dialing converges to the lower random call ID. The
        // losing local call becomes an incoming call requiring explicit Accept.
        if (this.state.phase === 'outgoing' && peer === this.state.peer && (!this.state.callId || signal.callId < this.state.callId)) this.finish('ended', 'Incoming call');
        else {
          this.remember(peer, signal.callId);
          void this.deps.send(peer, { version: 1, type: 'end', callId: signal.callId, createdAt: this.deps.now(), reason: 'busy' }).catch(() => {});
          return;
        }
      }
      this.begin(peer, signal.callId, signal.mode, true);
      const token = this.token;
      void this.send({ type: 'ringing' }).catch(() => this.fail(token));
      return;
    }
    if (!active(this.state) || peer !== this.state.peer || signal.callId !== this.state.callId) return;
    const token = this.token;
    const task = this.signaling.then(async () => { if (this.live(token)) await this.handle(signal, token); });
    this.signaling = task.catch(() => this.fail(token));
  };
  accept = async () => {
    if (this.state.phase !== 'incoming' || this.accepted) return;
    this.accepted = true; this.update({ phase: 'connecting' }); const token = this.token;
    this.deadline(60_000, 'Could not establish the call');
    try { await this.openMedia(token); if (this.live(token)) await this.send({ type: 'accept' }); }
    catch (error) { this.fail(token, error instanceof Error ? error.message : 'Microphone or camera access was unavailable.'); }
  };
  private async openMedia(token: number) {
    const network = await this.deps.network(); if (!this.live(token)) return;
    const media = await this.deps.media(this.state.mode, network, {
      candidate: (candidate, generation) => { if (this.live(token)) void this.send({ type: 'ice', generation, candidate }).catch(() => this.fail(token)); },
      streams: (localStream, remoteStream) => { if (this.live(token)) this.update({ localStream, remoteStream }); },
      connection: value => {
        if (!this.live(token)) return;
        if (value === 'connected') {
          this.recovering = false; clearTimeout(this.timer); clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
          this.update({ phase: 'connected', reason: '', connectedAt: this.state.connectedAt ?? this.deps.now() });
        } else if (value === 'disconnected' || value === 'failed') {
          if (this.state.phase !== 'reconnecting') {
            this.update({ phase: 'reconnecting' }); this.deadline(30_000, 'The connection was lost');
          }
          if (!this.recoveryTimer) this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined; if (this.live(token)) this.recoverConnection();
          }, value === 'failed' ? 0 : 3_000);
        } else if (value === 'closed') this.fail(token, 'The connection was lost');
      },
    }, this.abort.signal);
    if (!this.live(token)) { media.close(); return; }
    this.media = media; media.mute(this.state.muted); media.camera(this.state.camera);
    await media.speaker(this.state.speaker);
    if (this.live(token)) this.scheduleRenewal(network, token);
  }
  private scheduleRenewal(network: CallNetwork, token: number) {
    clearTimeout(this.renewal);
    if (!network.expiresAt || !network.iceServers.length) return;
    // Refresh both endpoints before short-lived TURN credentials expire.
    this.renewal = setTimeout(() => { if (this.live(token)) this.recoverConnection(); },
      Math.max(10_000, network.expiresAt - this.deps.now() - 60_000));
  }
  /** Only the original caller creates offers, so simultaneous route changes cannot glare. */
  recoverConnection = () => {
    if (!active(this.state) || !this.media || !this.remoteReady || this.recovering) return;
    const token = this.token;
    const task = this.signaling.then(async () => {
      if (!this.live(token) || !this.media || !this.remoteReady || this.recovering) return;
      if (this.deps.now() - this.lastRecovery < 5_000) return;
      this.lastRecovery = this.deps.now();
      if (this.state.incoming) {
        this.recovering = true; this.update({ phase: 'reconnecting' });
        this.deadline(30_000, 'The connection was lost');
        await this.send({ type: 'restart', generation: this.generation });
      } else await this.reoffer(token);
    });
    this.signaling = task.catch(() => this.fail(token, 'The call could not reconnect. Try calling again.'));
  };
  private async resetConnection(generation: number, token: number) {
    const network = await this.deps.network(true);
    if (!this.live(token) || !this.media) return false;
    for (const key of this.candidateIds.keys()) if (key < generation) this.candidateIds.delete(key);
    this.generation = generation; this.remoteReady = false; this.recovering = true;
    this.candidates = this.candidates.filter(item => item.generation === generation);
    this.update({ phase: 'reconnecting' }); this.deadline(30_000, 'The connection was lost');
    this.media.reconnect(network, generation); this.scheduleRenewal(network, token);
    return true;
  }
  private async reoffer(token: number) {
    if (this.generation >= 1024) throw new Error('Call connection limit reached.');
    if (!await this.resetConnection(this.generation + 1, token)) return;
    const sdp = await this.media!.offer(); if (!this.live(token)) return;
    validateSdp(sdp, this.state.mode); await this.send({ type: 'offer', generation: this.generation, sdp });
  }
  private async handle(signal: CallSignal, token: number) {
    if (signal.type === 'ringing') { if (this.state.phase === 'outgoing') this.update({ reason: 'Ringing…' }); }
    else if (signal.type === 'accept' && !this.state.incoming && !this.started) {
      this.started = true; this.update({ phase: 'connecting', reason: '' }); this.deadline(60_000, 'Could not establish the call');
      await this.openMedia(token); if (!this.live(token) || !this.media) return;
      const sdp = await this.media.offer(); if (!this.live(token)) return;
      validateSdp(sdp, this.state.mode); await this.send({ type: 'offer', generation: 0, sdp });
    } else if (signal.type === 'offer' && this.state.incoming && this.accepted && this.media) {
      if (signal.generation === this.generation + 1 && this.remoteReady) {
        if (!await this.resetConnection(signal.generation, token)) return;
      } else if (signal.generation !== this.generation || this.remoteReady) return;
      validateSdp(signal.sdp, this.state.mode);
      const sdp = await this.media.answer(signal.sdp); if (!this.live(token)) return;
      this.remoteReady = true; validateSdp(sdp, this.state.mode);
      await this.send({ type: 'answer', generation: this.generation, sdp }); await this.flushCandidates(token);
    } else if (signal.type === 'answer' && !this.state.incoming && this.started && !this.remoteReady && this.media) {
      if (signal.generation !== this.generation) return;
      validateSdp(signal.sdp, this.state.mode); await this.media.receiveAnswer(signal.sdp);
      if (!this.live(token)) return;
      this.remoteReady = true; await this.flushCandidates(token);
    } else if (signal.type === 'restart' && !this.state.incoming && this.remoteReady && signal.generation === this.generation) {
      if (!this.recovering && this.deps.now() - this.lastRecovery >= 5_000) { this.lastRecovery = this.deps.now(); await this.reoffer(token); }
    } else if (signal.type === 'ice') {
      if (signal.generation < this.generation || signal.generation > this.generation + (this.state.incoming && this.remoteReady ? 1 : 0)) return;
      const seen = this.candidateIds.get(signal.generation) ?? new Set<string>();
      const id = JSON.stringify(signal.candidate); if (seen.has(id)) return;
      if (seen.size >= 64) throw new Error('Too many call candidates.');
      seen.add(id); this.candidateIds.set(signal.generation, seen);
      if (this.candidates.length >= 64) throw new Error('Too many call candidates.');
      if (this.media && this.remoteReady && signal.generation === this.generation) await this.media.addCandidate(signal.candidate);
      else this.candidates.push({ candidate: signal.candidate, generation: signal.generation });
    }
  }
  private async flushCandidates(token: number) {
    const ready = this.candidates.filter(item => item.generation === this.generation);
    this.candidates = this.candidates.filter(item => item.generation > this.generation);
    for (const { candidate } of ready) {
      if (!this.live(token) || !this.media) return;
      await this.media.addCandidate(candidate);
    }
  }
  private remember(peer: string, callId: string) {
    if (!callId) return;
    if (this.closed.size >= 128) this.closed.delete(this.closed.keys().next().value!);
    this.closed.set(`${peer}:${callId}`, this.deps.now() + 180_000);
  }
  private finish(phase: 'ended' | 'failed', reason: string) {
    this.remember(this.state.peer, this.state.callId); this.token += 1; clearTimeout(this.timer); clearTimeout(this.renewal); clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; this.abort.abort();
    const media = this.media; this.media = null; media?.close(); this.candidates = []; this.candidateIds.clear();
    this.update({ phase, reason, localStream: null, remoteStream: null });
  }
  end = (reason: 'hangup' | 'declined' | 'timeout' | 'failed' = 'hangup', message = 'Call ended') => {
    if (!active(this.state)) return;
    const { peer, callId } = this.state;
    this.finish(reason === 'failed' ? 'failed' : 'ended', message);
    if (callId) void this.deps.send(peer, { version: 1, callId, createdAt: this.deps.now(), type: 'end', reason }).catch(() => {});
  };
  mute = () => { const muted = !this.state.muted; this.media?.mute(muted); this.update({ muted }); };
  toggleCamera = () => { if (this.state.mode !== 'video') return; const camera = !this.state.camera; this.media?.camera(camera); this.update({ camera }); };
  toggleSpeaker = async () => {
    const speaker = !this.state.speaker; if (!this.media) return;
    try { await this.media.speaker(speaker); this.update({ speaker }); } catch { this.update({ reason: 'This audio output is unavailable.' }); }
  };
  dismiss = () => { if (!active(this.state)) this.update(empty()); };
  stop = () => { if (active(this.state)) this.end('hangup', 'Call ended'); };
}
