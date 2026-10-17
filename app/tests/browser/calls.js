// SPDX-License-Identifier: GPL-3.0-only
import { CallController } from '/controller.js';
import { openRtcMedia } from '/mediaCore.js';
const result = document.querySelector('#result'), button = document.querySelector('#run');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
async function until(predicate, message) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await pause(100); }
  throw new Error(message);
}
async function run(mode) {
  const peers = [], streams = [], cleanups = [], contexts = [], timers = [];
  const controllers = [], signals = [], ice = [];
  const make = (self, other) => new CallController({
    id: async () => crypto.randomUUID().replaceAll('-', ''), now: Date.now,
    allowed: peer => peer === other,
    network: async () => ({ iceServers: [], localOnly: true }),
    send: async (_peer, signal) => {
      signals.push(signal.type);
      queueMicrotask(() => controllers[other].receive(String(self), signal));
    },
    media: (kind, network, events, signal) => openRtcMedia({
      media: async () => {
        const context = new AudioContext(); contexts.push(context); await context.resume();
        const destination = context.createMediaStreamDestination(), oscillator = context.createOscillator();
        oscillator.frequency.value = 220 + self * 110; oscillator.connect(destination); oscillator.start();
        cleanups.push(() => { oscillator.stop(); void context.close(); });
        const stream = destination.stream;
        if (kind === 'video') {
          const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
          const drawing = canvas.getContext('2d'); let frame = 0;
          const draw = () => { drawing.fillStyle = `hsl(${frame++ % 360}, 50%, 50%)`; drawing.fillRect(0, 0, 160, 120); };
          draw(); timers.push(setInterval(draw, 100));
          stream.addTrack(canvas.captureStream(10).getVideoTracks()[0]);
        }
        streams.push(stream); return stream;
      },
      peer: config => {
        const pc = new RTCPeerConnection({ iceServers: config.iceServers });
        const add = pc.addIceCandidate.bind(pc);
        pc.addIceCandidate = async candidate => {
          const parts = candidate.candidate.split(' ');
          const record = { address: parts[4].endsWith('.local') ? 'mDNS' : 'IP', protocol: parts[2], mid: candidate.sdpMid, added: false };
          ice.push(record); await add(candidate); record.added = true;
        };
        peers.push(pc); return pc;
      },
      speaker: async () => {}, cleanup: () => {},
    }, kind, network, events, signal),
  });
  controllers.push(make(0, '1'), make(1, '0'));
  try {
    await controllers[0].start('1', mode);
    await until(() => controllers[1].getSnapshot().phase === 'incoming', 'Invitation did not arrive');
    check(streams.length === 0, 'Media opened before acceptance');
    await controllers[1].accept();
    await until(() => controllers.every(c => c.getSnapshot().phase === 'connected'), `Negotiation failed: ${controllers.map(c => c.getSnapshot().reason).join('; ')}`);
    const totals = async () => Promise.all(peers.slice(-2).map(async pc => {
      const stats = await pc.getStats(); let audio = 0, video = 0, dtls = '';
      stats.forEach(row => {
        if (row.type === 'inbound-rtp' && row.kind === 'audio') audio += row.bytesReceived ?? 0;
        if (row.type === 'inbound-rtp' && row.kind === 'video') video += row.bytesReceived ?? 0;
        if (row.type === 'transport') dtls = row.dtlsState;
      }); return { audio, video, dtls };
    }));
    await until(async () => (await totals()).every(row => row.audio > 0 && (mode === 'voice' || row.video > 0) && row.dtls === 'connected'), 'No authenticated media received in both directions');
    const firstReceived = await totals();
    const connectedAt = controllers[0].getSnapshot().connectedAt;
    controllers[0].recoverConnection(); controllers[1].recoverConnection();
    await until(() => peers.length === 4 && controllers.every(c => c.getSnapshot().phase === 'connected'), 'Recovery did not reconnect both peers');
    await until(async () => (await totals()).every(row => row.audio > 0 && (mode === 'voice' || row.video > 0) && row.dtls === 'connected'), 'Recovered connections did not carry encrypted media');
    check(streams.length === 2, 'Recovery reopened microphone/camera capture');
    check(peers.slice(0, 2).every(pc => pc.connectionState === 'closed'), 'Old connection leaked during recovery');
    check(controllers[0].getSnapshot().connectedAt === connectedAt, 'Recovery reset the call duration');
    const received = { initial: firstReceived, recovered: await totals() };
    controllers[0].mute(); check(streams[1].getAudioTracks().every(track => !track.enabled), 'Mute did not disable capture');
    if (mode === 'video') { controllers[0].toggleCamera(); check(streams[1].getVideoTracks().every(track => !track.enabled), 'Camera toggle failed'); }
    controllers[0].end(); await pause(100);
    check(peers.every(pc => pc.connectionState === 'closed'), 'Peer connection leaked after hangup');
    check(streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'Capture track leaked after hangup');
    return `${mode}: PASS — both peers received ${mode === 'video' ? 'audio/video' : 'audio'}, DTLS connected; mute${mode === 'video' ? '/camera' : ''} and hangup cleanup passed; simultaneous recovery reused capture and restored encrypted media.\n  Received bytes: ${JSON.stringify(received)}. Signals: ${signals.length}.`;
  } catch (error) {
    error.message += `\nStates: ${controllers.map(c => c.getSnapshot().phase + ':' + c.getSnapshot().reason).join(', ')}\nPeers: ${peers.map(pc => `${pc.connectionState}/${pc.iceConnectionState}/${pc.iceGatheringState}/${pc.signalingState}`).join(', ')}\nSignals: ${signals.join(', ')}`;
    const routes = await Promise.all(peers.map(async pc => {
      const rows = []; (await pc.getStats()).forEach(row => { if (['candidate-pair', 'local-candidate', 'remote-candidate'].includes(row.type)) rows.push({ type: row.type, candidateType: row.candidateType, state: row.state, nominated: row.nominated, bytesSent: row.bytesSent }); }); return rows;
    }));
    error.message += `\nRoutes: ${JSON.stringify(routes)}\nICE accepted: ${JSON.stringify(ice)}`;
    throw error;
  } finally {
    controllers.forEach(controller => controller.stop()); peers.forEach(pc => pc.close());
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    timers.forEach(clearInterval); cleanups.forEach(cleanup => cleanup());
    await Promise.all(contexts.filter(context => context.state !== 'closed').map(context => context.close().catch(() => {})));
  }
}
button.addEventListener('click', async () => {
  button.disabled = true; result.textContent = 'Running voice…';
  try {
    const voice = await run('voice'); result.textContent = voice + '\nRunning video…';
    const video = await run('video'); result.textContent = voice + '\n' + video + '\nBrowser transport checks passed. Physical phones and TURN remain separate checks.';
  } catch (error) { result.textContent += `\nFAIL: ${error.message}`; }
  finally { button.disabled = false; }
});
