import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { CallController } from '../src/calls/controller.ts';
import { validateCallSignal, validateSdp } from '../src/calls/protocol.ts';
import { openRtcMedia, localCandidate, enforceLocalSdp } from '../src/calls/mediaCore.ts';

const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=fingerprint:sha-256 ' + Array(32).fill('AB').join(':') + '\r\na=setup:actpass\r\n';
const idA = '1'.repeat(32), idB = '2'.repeat(32), peerA = 'a'.repeat(64), peerB = 'b'.repeat(64);
const signal = (type, extra = {}, callId = idA) => ({ version: 1, callId, createdAt: Date.now(), type, ...(['offer', 'answer', 'ice', 'restart'].includes(type) ? { generation: 0 } : {}), ...extra });
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
function fixture(t, options = {}) {
  const sent = [], media = [], controllers = [];
  function make(self, other, id) {
    const controller = new CallController({
      now: Date.now, id: options.id ?? (async () => id), allowed: peer => peer === other,
      network: async () => ({ iceServers: [], localOnly: true }),
      send: async (peer, value) => { sent.push({ self, peer, value }); if (options.deliver) queueMicrotask(() => options.deliver(self, value)); },
      media: options.media ?? (async (_mode, _network, events) => {
        const record = { closed: 0, reconnects: [], candidates: [], muted: false, camera: false, events };
        media.push(record);
        return { reconnect: (network, generation) => { record.reconnects.push({ network, generation }); }, offer: async () => sdp, answer: async () => sdp, receiveAnswer: async () => { events.connection('connected'); },
          addCandidate: async value => record.candidates.push(value), mute: value => { record.muted = value; },
          camera: value => { record.camera = value; }, speaker: async () => {}, close: () => { record.closed++; } };
      }),
    });
    controllers.push(controller); return controller;
  }
  const alice = make(peerA, peerB, idA), bob = make(peerB, peerA, idB);
  t.after(() => controllers.forEach(controller => controller.stop()));
  return { alice, bob, sent, media };
}

test('call signals reject stale invites, extra fields, unknown types, and malformed media', () => {
  validateCallSignal(signal('invite', { mode: 'voice' }), Date.now());
  assert.throws(() => validateCallSignal({ ...signal('invite', { mode: 'voice' }), createdAt: Date.now() - 100000 }, Date.now()));
  assert.throws(() => validateCallSignal(signal('invite', { mode: 'voice', secret: 'unexpected' }), Date.now()));
  assert.throws(() => validateCallSignal(signal('auto-answer'), Date.now()));
  assert.throws(() => validateCallSignal(signal('ice', { candidate: { candidate: 'candidate:x\r\na=evil', sdpMid: '0', sdpMLineIndex: 0 } }), Date.now()));
});

test('SDP requires authenticated DTLS-SRTP and cannot enable unrequested video or a data channel', () => {
  validateSdp(sdp, 'voice');
  assert.throws(() => validateSdp(sdp.replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP')));
  assert.throws(() => validateSdp(sdp.replace(/a=fingerprint:[^\r]+\r\n/, '')));
  assert.throws(() => validateSdp(sdp + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'));
  assert.throws(() => validateSdp(sdp + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', 'voice'));
  assert.throws(() => validateSdp(sdp + 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:secret\r\n'));
});

test('incoming ringing and unsolicited negotiation never start the microphone', async t => {
  const f = fixture(t);
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }));
  f.bob.receive(peerA, signal('offer', { sdp }));
  await settle();
  assert.equal(f.bob.getSnapshot().phase, 'incoming'); assert.equal(f.media.length, 0);
  f.bob.end('declined', 'Call declined'); await settle();
  assert.equal(f.media.length, 0); assert.equal(f.bob.getSnapshot().phase, 'ended');
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }));
  assert.equal(f.bob.getSnapshot().phase, 'ended');
});

test('accept negotiates one session, mute works, and hangup releases both peers', async t => {
  let f;
  f = fixture(t, { deliver: (self, value) => (self === peerA ? f.bob : f.alice).receive(self, value) });
  await f.alice.start(peerB, 'voice'); await settle();
  assert.equal(f.media.length, 0);
  await f.bob.accept(); await settle();
  assert.equal(f.media.length, 2); assert.equal(f.alice.getSnapshot().phase, 'connected');
  f.alice.mute(); assert.equal(f.media[1].muted, true);
  f.alice.receive(peerB, signal('accept')); await settle(); assert.equal(f.media.length, 2);
  f.alice.end(); await settle();
  assert.ok(f.media.every(item => item.closed === 1)); assert.equal(f.bob.getSnapshot().phase, 'ended');
});

test('candidate arriving before SDP waits for the remote description', async t => {
  const f = fixture(t), candidate = { candidate: 'candidate:1 1 UDP 123 192.168.1.2 4444 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  f.bob.receive(peerA, signal('invite', { mode: 'voice' })); await f.bob.accept();
  f.bob.receive(peerA, signal('ice', { candidate })); await settle();
  assert.equal(f.media[0].candidates.length, 0);
  f.bob.receive(peerA, signal('offer', { sdp })); await settle();
  assert.deepEqual(f.media[0].candidates, [candidate]);
});

test('a late permission result is closed after hangup and never sends acceptance', async t => {
  let resolveMedia, closes = 0;
  const f = fixture(t, { media: () => new Promise(resolve => { resolveMedia = resolve; }) });
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }));
  const accepting = f.bob.accept(); await settle(); f.bob.end();
  resolveMedia({ close: () => { closes++; }, mute() {}, camera() {}, speaker: async () => {} });
  await accepting; await settle();
  assert.equal(closes, 1); assert.equal(f.sent.filter(item => item.value.type === 'accept').length, 0);
});

test('unknown peers and mismatched call IDs cannot answer or end a call', async t => {
  const f = fixture(t); await f.alice.start(peerB, 'voice');
  f.alice.receive('c'.repeat(64), signal('accept')); f.alice.receive(peerB, signal('end', { reason: 'hangup' }, idB));
  await settle(); assert.equal(f.alice.getSnapshot().phase, 'outgoing'); assert.equal(f.media.length, 0);
});

test('an end arriving before its invitation prevents a stale ring', t => {
  const f = fixture(t);
  f.bob.receive(peerA, signal('end', { reason: 'hangup' }));
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }));
  assert.equal(f.bob.getSnapshot().phase, 'idle');
});

test('nearby call routes reject public, relay, and malformed candidates', () => {
  const c = address => ({ candidate: `candidate:1 1 UDP 123 ${address} 4444 typ host`, sdpMid: '0', sdpMLineIndex: 0 });
  assert.equal(localCandidate(c('192.168.1.2')), true); assert.equal(localCandidate(c('10.0.0.2')), true);
  assert.equal(localCandidate(c('fd12::1')), true); assert.equal(localCandidate(c('peer-123.local')), true);
  assert.equal(localCandidate(c('8.8.8.8')), false); assert.equal(localCandidate(c('192.168.1.999')), false);
  assert.throws(() => enforceLocalSdp(sdp + 'a=candidate:1 1 UDP 123 8.8.8.8 4444 typ host\r\n'));
  assert.throws(() => enforceLocalSdp(sdp.replace('c=IN IP4 0.0.0.0', 'c=IN IP4 8.8.8.8')));
});

test('mixed SDP line endings cannot hide candidates or media from policy checks', () => {
  for (const separator of ['\n', '\r']) {
    for (const hidden of ['a=candidate:1 1 UDP 123 8.8.8.8 4444 typ host', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:secret']) {
      assert.throws(() => validateSdp(sdp.trimEnd() + separator + hidden + '\r\n'), /Unsupported call description/);
    }
  }
});

test('nearby offers and answers reject public routes embedded in outgoing SDP', async () => {
  for (const method of ['offer', 'answer']) {
    for (const unsafeSdp of [sdp + 'a=candidate:1 1 UDP 123 8.8.8.8 4444 typ host\r\n', sdp.replace('c=IN IP4 0.0.0.0', 'c=IN IP4 8.8.8.8')]) {
      let applied = 0;
      const media = await openRtcMedia({
        media: async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }),
        peer: () => ({ addTrack() {}, close() {}, createOffer: async () => ({ sdp: unsafeSdp }), createAnswer: async () => ({ sdp: unsafeSdp }), setRemoteDescription: async () => {}, setLocalDescription: async () => { applied++; } }),
        speaker: async () => {}, cleanup() {},
      }, 'voice', { iceServers: [], localOnly: true }, { candidate() {}, connection() {}, streams() {} }, new AbortController().signal);
      try { await assert.rejects(media[method](sdp), /local Wi-Fi routes only/); assert.equal(applied, 0); }
      finally { media.close(); }
    }
  }
});

test('aborting getUserMedia stops a late stream without creating a peer connection', async () => {
  let release, stopped = 0, created = 0;
  const abort = new AbortController();
  const opening = openRtcMedia({ media: () => new Promise(resolve => { release = resolve; }), peer: () => { created++; }, speaker: async () => {}, cleanup() {} },
    'voice', { iceServers: [], localOnly: true }, { candidate() {}, connection() {}, streams() {} }, abort.signal);
  abort.abort(); release({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await assert.rejects(opening, /Call ended/); assert.equal(stopped, 1); assert.equal(created, 0);
});

test('simultaneous dialing converges on one invitation and still requires acceptance', async t => {
  const f = fixture(t);
  await Promise.all([f.alice.start(peerB, 'voice'), f.bob.start(peerA, 'voice')]);
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }, idA));
  f.alice.receive(peerB, signal('invite', { mode: 'voice' }, idB));
  await settle();
  assert.equal(f.alice.getSnapshot().phase, 'outgoing');
  assert.equal(f.bob.getSnapshot().phase, 'incoming');
  assert.equal(f.alice.getSnapshot().callId, f.bob.getSnapshot().callId);
  assert.equal(f.media.length, 0);
  f.bob.receive(peerA, signal('end', { reason: 'busy' }, idB));
  assert.equal(f.bob.getSnapshot().phase, 'incoming');
});

test('incoming invitation during ID generation cancels the unsent outgoing call', async t => {
  let release;
  const f = fixture(t, { id: () => new Promise(resolve => { release = resolve; }) });
  const starting = f.bob.start(peerA, 'voice');
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }, idA));
  release(idB); await starting; await settle();
  assert.equal(f.bob.getSnapshot().phase, 'incoming');
  assert.equal(f.bob.getSnapshot().callId, idA);
  assert.equal(f.sent.filter(item => item.value.type === 'invite').length, 0);
  assert.equal(f.media.length, 0);
});

test('denied media permission fails cleanly and tells the caller without acceptance', async t => {
  const f = fixture(t, { media: async () => { throw new Error('Microphone permission denied.'); } });
  f.bob.receive(peerA, signal('invite', { mode: 'voice' }));
  await f.bob.accept(); await settle();
  assert.equal(f.bob.getSnapshot().phase, 'failed');
  assert.match(f.bob.getSnapshot().reason, /permission denied/);
  assert.equal(f.sent.filter(item => item.value.type === 'accept').length, 0);
  assert.ok(f.sent.some(item => item.value.type === 'end' && item.value.reason === 'failed'));
});

test('unanswered calls time out without opening media', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await f.alice.start(peerB, 'voice');
  t.mock.timers.tick(60_001); await settle();
  assert.equal(f.alice.getSnapshot().phase, 'ended');
  assert.equal(f.alice.getSnapshot().reason, 'No answer');
  assert.equal(f.media.length, 0);
  assert.ok(f.sent.some(item => item.value.type === 'end' && item.value.reason === 'timeout'));
});

test('a disconnected call recovers briefly, then closes if recovery times out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.bob.receive(peerA, signal('invite', { mode: 'voice' })); await f.bob.accept();
  f.media[0].events.connection('connected');
  f.media[0].events.connection('disconnected');
  assert.equal(f.bob.getSnapshot().phase, 'reconnecting');
  t.mock.timers.tick(5_000); f.media[0].events.connection('connected'); t.mock.timers.tick(20_000);
  assert.equal(f.bob.getSnapshot().phase, 'connected');
  f.media[0].events.connection('disconnected'); t.mock.timers.tick(30_001); await settle();
  assert.equal(f.bob.getSnapshot().phase, 'ended'); assert.equal(f.media[0].closed, 1);
});

test('call generations reject missing, negative, fractional, and unbounded values', () => {
  for (const generation of [undefined, -1, 1.5, 1025]) {
    assert.throws(() => validateCallSignal(signal('offer', { sdp, generation }), Date.now()));
  }
  validateCallSignal(signal('restart', { generation: 12 }), Date.now());
});

test('recovery reuses capture and ignores stale answers, offers, and ICE', async t => {
  let f;
  f = fixture(t, { deliver: (self, value) => (self === peerA ? f.bob : f.alice).receive(self, value) });
  await f.alice.start(peerB, 'voice'); await settle(); await f.bob.accept(); await settle();
  f.media[0].events.connection('connected');
  const connectedAt = f.alice.getSnapshot().connectedAt;
  f.alice.mute(); f.alice.recoverConnection(); f.bob.recoverConnection(); await settle();
  assert.equal(f.media.length, 2, 'recovery must not ask for capture again');
  assert.deepEqual(f.media.map(item => item.reconnects.map(entry => entry.generation)), [[1], [1]]);
  assert.equal(f.media[1].muted, true);
  assert.equal(f.alice.getSnapshot().connectedAt, connectedAt);
  const count = f.sent.length;
  f.alice.receive(peerB, signal('answer', { sdp }));
  f.bob.receive(peerA, signal('offer', { sdp }));
  f.alice.receive(peerB, signal('ice', { candidate: { candidate: 'candidate:old 1 UDP 123 10.0.0.3 4444 typ host', sdpMid: '0', sdpMLineIndex: 0 } }));
  await settle(); assert.equal(f.sent.length, count); assert.equal(f.media[1].candidates.length, 0);
});

test('fresh ICE can precede a recovery offer, while future generations are discarded', async t => {
  const f = fixture(t), candidate = { candidate: 'candidate:fresh 1 UDP 123 10.0.0.3 4444 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  f.bob.receive(peerA, signal('invite', { mode: 'voice' })); await f.bob.accept();
  f.bob.receive(peerA, signal('offer', { sdp })); await settle(); f.media[0].events.connection('connected');
  f.bob.receive(peerA, signal('ice', { candidate, generation: 2 }));
  f.bob.receive(peerA, signal('ice', { candidate, generation: 1 })); await settle();
  assert.equal(f.media[0].candidates.length, 0);
  f.bob.receive(peerA, signal('offer', { sdp, generation: 1 })); await settle();
  assert.deepEqual(f.media[0].candidates, [candidate]);
  f.bob.receive(peerA, signal('ice', { candidate, generation: 1 })); await settle();
  assert.equal(f.media[0].candidates.length, 1, 'duplicate candidate is ignored');
});

test('media recovery stops the previous connection, rejects late callbacks, and preserves mute', async () => {
  let captureCount = 0, stopped = 0; const peers = [], received = [];
  const track = { kind: 'audio', enabled: true, stop() { stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
  const media = await openRtcMedia({ media: async () => { captureCount++; return stream; },
    peer: () => { const pc = { close() { this.closed = true; }, addTrack() {}, createOffer: async () => ({ sdp }), setLocalDescription: async () => {}, addIceCandidate: async () => {} }; peers.push(pc); return pc; },
    speaker: async () => {}, cleanup() {},
  }, 'voice', { iceServers: [], localOnly: true }, { candidate: (...args) => received.push(args), connection() {}, streams() {} }, new AbortController().signal);
  const old = peers[0].onicecandidate;
  media.mute(true); media.reconnect({ iceServers: [], localOnly: true }, 1);
  const candidate = { candidate: 'candidate:x 1 UDP 123 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  old({ candidate: { toJSON: () => candidate } }); peers[1].onicecandidate({ candidate: { toJSON: () => candidate } });
  assert.equal(captureCount, 1); assert.equal(stopped, 0); assert.equal(track.enabled, false);
  assert.equal(peers[0].closed, true); assert.deepEqual(received, [[candidate, 1]]);
  assert.throws(() => media.reconnect({ iceServers: [], localOnly: false }, 2), /routing changed/);
  media.close(); assert.equal(stopped, 1); assert.equal(peers[1].closed, true);
});

test('relay renewal requests fresh configuration before expiry and hangup cancels renewal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let captures = 0, refreshed = 0, events;
  const sent = [], controller = new CallController({ now: Date.now, id: async () => idA, allowed: () => true,
    send: async (_peer, value) => sent.push(value),
    network: async refresh => { if (refresh) refreshed++; return { localOnly: false, iceServers: [{ urls: ['turns:relay.example:5349'] }], expiresAt: Date.now() + 600_000 }; },
    media: async (_mode, _network, callbacks) => { captures++; events = callbacks; return { offer: async () => sdp, receiveAnswer: async () => {}, reconnect() {}, mute() {}, camera() {}, speaker: async () => {}, close() {} }; },
  });
  t.after(() => controller.stop());
  await controller.start(peerB, 'voice'); controller.receive(peerB, signal('accept')); await settle();
  controller.receive(peerB, signal('answer', { sdp })); await settle(); events.connection('connected');
  t.mock.timers.tick(540_000); await settle();
  assert.equal(refreshed, 1); assert.equal(captures, 1);
  assert.ok(sent.some(value => value.type === 'offer' && value.generation === 1));
  controller.end(); t.mock.timers.tick(600_000); await settle(); assert.equal(refreshed, 1);
});
