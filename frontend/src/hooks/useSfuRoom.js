// SFU room client (step 15): mediasoup-client against the step 14 backend.
//
//   const sfu = useSfuRoom();
//   await sfu.join(roomId, name, localStream)  → { ok } | { ok:false, error }
//   sfu.leave()
//   sfu.setPaused('audio' | 'video', paused)    → mute / camera off: producer.pause() + sfu:pauseProducer
//   sfu.replaceTrack('video', track)            → switch camera: producer.replaceTrack (no renegotiation)
//   sfu.setPreferredLayer(peerId, 0 | 1 | 2)    → simulcast layer for that peer's video (from the tile size)
//   sfu.getAudioLevels() / sfu.getTransportStats()
//   sfu.status / room / error / peers / paused / transports
//
// The whole flow (see notes/step14.md for the server side):
//   sfu:join → device.load(routerRtpCapabilities)
//   → recv transport (createRecvTransport) and send transport (createSendTransport)
//   → produce mic + camera (camera with 3 simulcast encodings)
//   → consume every existing producer, and every new one announced by sfu:new-producer
//   → sfu:resumeConsumer once each consumer is set up locally
//
// Compared with the mesh: exactly TWO RTCPeerConnections (send + recv) whatever
// the number of people, ONE encode per track (×3 small simulcast layers), and no
// SDP on the wire: mediasoup-client writes it locally from the server's parameters.
//
// Per remote peer we keep ONE MediaStream for the whole time they're in the room
// and add/remove consumer tracks in it, so <video>.srcObject is set once (step 12 rules).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import { socket } from '../services/socket.js';
import useLog from './useLog.js';
import { summarizePeerStats } from '../services/meshStats.js';

const ACK_TIMEOUT_MS = 8000;
const REJOIN_DELAY_MS = 1000;
const short = (id) => String(id).slice(0, 6);

// Simulcast (Webrtc.md §16): the camera is encoded 3 times at different sizes and
// ALL three go up to the SFU, which forwards ONE of them to each receiver.
//   r0: 1/4 size (320×180 from 720p) ~150 kbps · r1: 1/2 (640×360) ~500 kbps · r2: full (1280×720) ~1.5 Mbps
// Pixels: 1/16 + 1/4 + 1 = 1.31× one 720p encode: simulcast costs ~30 % more than
// one stream, not 3×. L1T3 adds 3 temporal layers inside each (30/15/7.5 fps).
export const SIMULCAST_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000, scalabilityMode: 'L1T3' },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000, scalabilityMode: 'L1T3' },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000, scalabilityMode: 'L1T3' },
];
export const LAYER_NAMES = ['low', 'medium', 'high'];
const DEFAULT_LAYER = 1; // until we know the tile size

export default function useSfuRoom() {
  const { log } = useLog();
  const [status, setStatus] = useState(socket.connected ? 'connected' : 'connecting');
  const [room, setRoom] = useState(null); // { id, you: { peerId, name } }
  const [error, setError] = useState(null);
  const [peers, setPeers] = useState([]);
  const [paused, setPausedState] = useState({ audio: false, video: false });
  const [transports, setTransports] = useState({ send: 'new', recv: 'new' });

  const joinedRef = useRef(null); // { roomId, name, stream } while in a room
  const genRef = useRef(0); // bumped on every join/teardown: stale async work stops
  const deviceRef = useRef(null);
  const sendRef = useRef(null);
  const recvRef = useRef(null);
  const producersRef = useRef({}); // kind → Producer
  const peersRef = useRef(new Map()); // peerId → { id, name, joinedAt, stream, consumers: Map }
  const consumerOwner = useRef(new Map()); // consumerId → peerId
  const pendingProducers = useRef([]); // sfu:new-producer before the recv transport is ready
  const prevStats = useRef({});
  // A ref, not the `paused` state: doJoin must not change identity on every mute
  // (the socket effect depends on it, and its cleanup leaves the room).
  const pausedRef = useRef({ audio: false, video: false });

  // ---- helpers ------------------------------------------------------------

  const req = useCallback(async (event, data = {}) => {
    let res;
    try {
      res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, data);
    } catch {
      throw new Error(`${event}: no answer from the server`);
    }
    if (!res.ok) throw new Error(`${event}: ${res.error}`);
    return res;
  }, []);

  const publish = useCallback(() => {
    setPeers(
      [...peersRef.current.values()].map((p) => {
        const cs = [...p.consumers.values()];
        const audio = cs.find((c) => c.kind === 'audio');
        const video = cs.find((c) => c.kind === 'video');
        return {
          id: p.id,
          name: p.name,
          joinedAt: p.joinedAt,
          stream: p.stream, // same object for the peer's whole stay
          micOn: Boolean(audio) && !audio.producerPaused,
          camOn: Boolean(video) && !video.producerPaused,
          hasVideo: Boolean(video),
          simulcast: video?.type === 'simulcast',
          layer: video?.layers?.spatialLayer ?? null, // forwarded now
          preferredLayer: video?.preferredLayer ?? null, // asked for
          recv: video?.recv ?? null, // { w, h, fps } from getStats
        };
      }),
    );
  }, []);

  const ensurePeer = useCallback((peerId, name, joinedAt = Date.now()) => {
    let p = peersRef.current.get(peerId);
    if (!p) {
      p = { id: peerId, name: name ?? short(peerId), joinedAt, stream: new MediaStream(), consumers: new Map() };
      peersRef.current.set(peerId, p);
    } else if (name) {
      p.name = name;
    }
    return p;
  }, []);

  const dropConsumer = useCallback((consumerId) => {
    const peerId = consumerOwner.current.get(consumerId);
    consumerOwner.current.delete(consumerId);
    const p = peerId && peersRef.current.get(peerId);
    const c = p?.consumers.get(consumerId);
    if (!c) return null;
    p.consumers.delete(consumerId);
    p.stream.removeTrack(c.consumer.track);
    c.consumer.close();
    return { peer: p, c };
  }, []);

  // ---- consuming ------------------------------------------------------------

  const consume = useCallback(
    async (info) => {
      const gen = genRef.current;
      const recv = recvRef.current;
      if (!recv) {
        pendingProducers.current.push(info);
        return;
      }
      const peer = ensurePeer(info.peerId, info.name);
      const preferredLayer = info.kind === 'video' ? (peer.wantLayer ?? DEFAULT_LAYER) : null;
      try {
        const params = await req('sfu:consume', {
          transportId: recv.id,
          producerId: info.producerId,
          rtpCapabilities: deviceRef.current.rtpCapabilities,
          ...(info.kind === 'video' && { preferredLayers: { spatialLayer: preferredLayer } }),
        });
        if (gen !== genRef.current) return;
        // Builds the remote SDP locally, setRemoteDescription, answer → a MediaStreamTrack.
        const consumer = await recv.consume({ id: params.id, producerId: params.producerId, kind: params.kind, rtpParameters: params.rtpParameters });
        if (gen !== genRef.current) {
          consumer.close();
          return;
        }
        const entry = {
          consumer,
          kind: params.kind,
          type: params.type,
          producerPaused: params.producerPaused, // newcomers learn "muted" from here
          preferredLayer: params.preferredLayers?.spatialLayer ?? null,
          layers: null,
          recv: null,
        };
        peer.consumers.set(consumer.id, entry);
        consumerOwner.current.set(consumer.id, peer.id);
        peer.stream.addTrack(consumer.track);
        publish();
        // Ready locally → NOW let the server forward (and request a keyframe).
        await req('sfu:resumeConsumer', { consumerId: consumer.id });
        log(`consuming ${params.kind} of ${peer.name} (${params.type}${params.producerPaused ? ', producer paused' : ''})`, 'success');
      } catch (err) {
        log(`consume ${info.kind} of ${info.name}: ${err.message}`, 'error');
      }
    },
    [req, ensurePeer, publish, log],
  );

  // ---- teardown / join --------------------------------------------------------

  // Close everything local. The local MediaStream belongs to useLocalMedia (not stopped here).
  const teardown = useCallback(() => {
    genRef.current++;
    for (const p of Object.values(producersRef.current)) p.close();
    producersRef.current = {};
    sendRef.current?.close(); // closes its RTCPeerConnection
    recvRef.current?.close();
    sendRef.current = null;
    recvRef.current = null;
    for (const p of peersRef.current.values()) for (const c of p.consumers.values()) c.consumer.close();
    peersRef.current.clear();
    consumerOwner.current.clear();
    pendingProducers.current = [];
    prevStats.current = {};
    setTransports({ send: 'new', recv: 'new' });
    publish();
  }, [publish]);

  const watchTransport = useCallback(
    (transport, direction) => {
      transport.on('connectionstatechange', (s) => {
        setTransports((t) => ({ ...t, [direction]: s }));
        log(`${direction} transport → ${s}`, s === 'connected' ? 'success' : s === 'failed' ? 'error' : 'info');
      });
    },
    [log],
  );

  const doJoin = useCallback(
    async (roomId, name, stream) => {
      teardown();
      const gen = genRef.current;
      setError(null);
      try {
        const joined = await req('sfu:join', { roomId, name });
        if (gen !== genRef.current) return { ok: false, error: 'cancelled' };
        joinedRef.current = { roomId: joined.roomId, name, stream };
        setRoom({ id: joined.roomId, you: { peerId: joined.peerId, name } });
        for (const p of joined.peers) ensurePeer(p.peerId, p.name, p.joinedAt);
        publish();

        // 1. Device: which codecs can THIS browser use in THIS room?
        const device = new Device();
        await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
        deviceRef.current = device;
        log(`device.load: ${device.handlerName}, ${joined.peers.length} peer(s), ${joined.producers.length} producer(s) to consume`);

        // 2. Receive transport (RTCPeerConnection #1). 'connect' fires on the first consume.
        const r = await req('sfu:createTransport', { direction: 'recv' });
        const recv = device.createRecvTransport(r);
        recv.on('connect', ({ dtlsParameters }, ok, fail) => {
          req('sfu:connectTransport', { transportId: recv.id, dtlsParameters }).then(() => ok(), fail);
        });
        watchTransport(recv, 'recv');

        // 3. Send transport (RTCPeerConnection #2). 'connect' fires on the first produce,
        //    'produce' on every produce(): we tell the server, it answers the Producer id.
        const s = await req('sfu:createTransport', { direction: 'send' });
        const send = device.createSendTransport(s);
        send.on('connect', ({ dtlsParameters }, ok, fail) => {
          req('sfu:connectTransport', { transportId: send.id, dtlsParameters }).then(() => ok(), fail);
        });
        send.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
          req('sfu:produce', { transportId: send.id, kind, rtpParameters, appData }).then(({ id }) => ok({ id }), fail);
        });
        watchTransport(send, 'send');
        if (gen !== genRef.current) {
          recv.close();
          send.close();
          return { ok: false, error: 'cancelled' };
        }
        recvRef.current = recv;
        sendRef.current = send;

        // 4. Produce. ONE producer per track, whatever the number of receivers.
        const audioTrack = stream?.getAudioTracks()[0];
        const videoTrack = stream?.getVideoTracks()[0];
        const common = { stopTracks: false, zeroRtpOnPause: true }; // the tracks belong to useLocalMedia
        if (audioTrack && device.canProduce('audio')) {
          producersRef.current.audio = await send.produce({ track: audioTrack, ...common, appData: { source: 'mic' } });
        }
        if (videoTrack && device.canProduce('video')) {
          const vp8 = device.rtpCapabilities.codecs.find((c) => c.mimeType.toLowerCase() === 'video/vp8');
          producersRef.current.video = await send.produce({
            track: videoTrack,
            ...common,
            encodings: SIMULCAST_ENCODINGS,
            codecOptions: { videoGoogleStartBitrate: 1000 },
            ...(vp8 && { codec: vp8 }), // VP8 simulcast is supported everywhere
            appData: { source: 'camera' },
          });
        }
        // Re-apply a mute that was on before a re-join.
        for (const [kind, p] of Object.entries(producersRef.current)) {
          if (pausedRef.current[kind]) {
            p.pause();
            await req('sfu:pauseProducer', { producerId: p.id });
          }
        }
        log(`producing ${Object.keys(producersRef.current).join(' + ') || 'nothing'}${producersRef.current.video ? ' (video: 3 simulcast layers)' : ''}`, 'success');

        // 5. Consume what's already there, plus anything announced meanwhile.
        const queued = pendingProducers.current;
        pendingProducers.current = [];
        await Promise.all([...joined.producers, ...queued].map((p) => consume(p)));
        return { ok: true };
      } catch (err) {
        if (gen === genRef.current) {
          setError(err.message);
          log(`SFU join failed: ${err.message}`, 'error');
          teardown();
          joinedRef.current = null;
          setRoom(null);
          req('sfu:leave').catch(() => {});
        }
        return { ok: false, error: err.message };
      }
    },
    [req, teardown, ensurePeer, publish, watchTransport, consume, log],
  );

  const join = useCallback((roomId, name, stream) => doJoin(roomId.trim(), name, stream), [doJoin]);

  const leave = useCallback(async () => {
    joinedRef.current = null;
    teardown();
    setRoom(null);
    setError(null);
    pausedRef.current = { audio: false, video: false };
    setPausedState(pausedRef.current);
    try {
      await req('sfu:leave');
    } catch {
      // disconnected: the server already cleaned up
    }
    log('Left the SFU room');
  }, [teardown, req, log]);

  // ---- server events ------------------------------------------------------------

  useEffect(() => {
    const rejoin = (why) => {
      const j = joinedRef.current;
      if (!j) return;
      log(`${why}: re-joining "${j.roomId}"`, 'warn');
      setTimeout(() => {
        if (joinedRef.current === j) doJoin(j.roomId, j.name, j.stream);
      }, REJOIN_DELAY_MS);
    };
    const onConnect = () => {
      setStatus('connected');
      // The server dropped our transports when the socket went away (it IS in the media
      // path now, unlike the mesh): everything must be rebuilt.
      rejoin('Signaling reconnected');
    };
    const onDisconnect = (reason) => {
      setStatus('disconnected');
      if (joinedRef.current) log(`Socket disconnected (${reason}): media stops too, the SFU removes us`, 'warn');
    };
    const onReconnectAttempt = () => setStatus('connecting');

    const onPeerJoined = ({ peerId, name }) => {
      if (!joinedRef.current) return;
      ensurePeer(peerId, name);
      log(`sfu:peer-joined ${name}`, 'success');
      publish();
    };
    const onPeerLeft = ({ peerId, name }) => {
      if (!joinedRef.current) return;
      const p = peersRef.current.get(peerId);
      if (p) for (const id of [...p.consumers.keys()]) dropConsumer(id);
      peersRef.current.delete(peerId);
      log(`sfu:peer-left ${name}`, 'warn');
      publish();
    };
    const onNewProducer = (info) => {
      if (!joinedRef.current) return;
      log(`sfu:new-producer ${info.kind}/${info.source} from ${info.name}`);
      consume(info);
    };
    const onProducerClosed = ({ consumerId }) => {
      const res = dropConsumer(consumerId);
      if (res) log(`sfu:producer-closed: ${res.c.kind} of ${res.peer.name}`, 'warn');
      publish();
    };
    const setProducerPaused = (value) => ({ consumerId }) => {
      const peerId = consumerOwner.current.get(consumerId);
      const c = peerId && peersRef.current.get(peerId)?.consumers.get(consumerId);
      if (!c) return;
      c.producerPaused = value;
      log(`sfu:producer-${value ? 'paused' : 'resumed'}: ${c.kind} of ${peersRef.current.get(peerId).name}`);
      publish();
    };
    const onPaused = setProducerPaused(true);
    const onResumed = setProducerPaused(false);
    const onLayers = ({ consumerId, spatialLayer, temporalLayer }) => {
      const peerId = consumerOwner.current.get(consumerId);
      const c = peerId && peersRef.current.get(peerId)?.consumers.get(consumerId);
      if (!c) return;
      c.layers = spatialLayer == null ? null : { spatialLayer, temporalLayer };
      publish();
    };
    const onRoomClosed = ({ reason }) => rejoin(`Room closed by the server (${reason})`);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.on('sfu:peer-joined', onPeerJoined);
    socket.on('sfu:peer-left', onPeerLeft);
    socket.on('sfu:new-producer', onNewProducer);
    socket.on('sfu:producer-closed', onProducerClosed);
    socket.on('sfu:producer-paused', onPaused);
    socket.on('sfu:producer-resumed', onResumed);
    socket.on('sfu:consumer-layers', onLayers);
    socket.on('sfu:room-closed', onRoomClosed);
    if (!socket.connected) {
      setStatus('connecting');
      socket.connect();
    }

    // What each consumer is actually receiving (resolution, fps), for the tiles.
    const timer = setInterval(async () => {
      let changed = false;
      for (const p of peersRef.current.values()) {
        for (const c of p.consumers.values()) {
          if (c.kind !== 'video' || c.consumer.closed) continue;
          try {
            let recv = null;
            (await c.consumer.getStats()).forEach((r) => {
              if (r.type === 'inbound-rtp' && r.frameWidth) recv = { w: r.frameWidth, h: r.frameHeight, fps: Math.round(r.framesPerSecond ?? 0) };
            });
            if (JSON.stringify(recv) !== JSON.stringify(c.recv)) {
              c.recv = recv;
              changed = true;
            }
          } catch {
            // closed meanwhile
          }
        }
      }
      if (changed) publish();
    }, 2000);

    return () => {
      clearInterval(timer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('sfu:peer-joined', onPeerJoined);
      socket.off('sfu:peer-left', onPeerLeft);
      socket.off('sfu:new-producer', onNewProducer);
      socket.off('sfu:producer-closed', onProducerClosed);
      socket.off('sfu:producer-paused', onPaused);
      socket.off('sfu:producer-resumed', onResumed);
      socket.off('sfu:consumer-layers', onLayers);
      socket.off('sfu:room-closed', onRoomClosed);
      // Leaving the page = leaving the room.
      if (joinedRef.current) {
        socket.emit('sfu:leave');
        joinedRef.current = null;
      }
      teardown();
    };
  }, [log, doJoin, ensurePeer, publish, consume, dropConsumer, teardown]);

  // ---- controls ---------------------------------------------------------------

  // Mute / camera off. Locally: producer.pause() (with zeroRtpOnPause the sender stops
  // sending RTP entirely: 0 kbps up). On the server: producer.pause() → mediasoup fires
  // 'producerpause' on EVERY consumer of it → each receiver gets sfu:producer-paused.
  // No data channel message needed: the SFU knows, so it can tell everyone (and newcomers).
  const setPaused = useCallback(
    async (kind, value) => {
      pausedRef.current = { ...pausedRef.current, [kind]: value };
      setPausedState(pausedRef.current);
      const producer = producersRef.current[kind];
      if (!producer) return;
      if (value) producer.pause();
      else producer.resume();
      try {
        await req(value ? 'sfu:pauseProducer' : 'sfu:resumeProducer', { producerId: producer.id });
        log(`${kind} ${value ? 'paused' : 'resumed'} (producer + server)`);
      } catch (err) {
        log(err.message, 'error');
      }
    },
    [req, log],
  );

  // Camera switch: the producer's RTCRtpSender gets the new track. No renegotiation,
  // and the SFU doesn't notice anything except new pixels.
  const replaceTrack = useCallback(
    async (kind, track) => {
      const producer = producersRef.current[kind];
      if (!producer || !track) return false;
      await producer.replaceTrack({ track });
      log(`producer.replaceTrack(${kind}) → "${track.label}"`, 'success');
      return true;
    },
    [log],
  );

  // Simulcast layer for one peer's video, chosen by the UI from the tile size.
  // Deduplicated: ResizeObserver fires often, the server only hears about changes.
  const setPreferredLayer = useCallback(
    async (peerId, spatialLayer) => {
      const p = peersRef.current.get(peerId);
      if (!p) return;
      p.wantLayer = spatialLayer; // also used for consumers created later
      const c = [...p.consumers.values()].find((x) => x.kind === 'video');
      if (!c || c.type !== 'simulcast' || c.preferredLayer === spatialLayer) return;
      c.preferredLayer = spatialLayer;
      publish();
      try {
        await req('sfu:setPreferredLayers', { consumerId: c.consumer.id, spatialLayer });
        log(`preferred layer for ${p.name} → ${LAYER_NAMES[spatialLayer]} (L${spatialLayer})`);
      } catch (err) {
        log(err.message, 'warn');
      }
    },
    [req, publish, log],
  );

  // Audio levels for useActiveSpeaker: inbound audio per consumer, own mic from the producer.
  const getAudioLevels = useCallback(async () => {
    const levels = {};
    const jobs = [];
    for (const p of peersRef.current.values()) {
      for (const c of p.consumers.values()) {
        if (c.kind !== 'audio' || c.consumer.closed) continue;
        jobs.push(
          c.consumer
            .getStats()
            .then((report) =>
              report.forEach((r) => {
                if (r.type === 'inbound-rtp' && r.audioLevel != null) levels[p.id] = r.audioLevel;
              }),
            )
            .catch(() => {}),
        );
      }
    }
    const mic = producersRef.current.audio;
    if (mic && !mic.closed) {
      jobs.push(
        mic
          .getStats()
          .then((report) =>
            report.forEach((r) => {
              if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel != null) levels.me = r.audioLevel;
            }),
          )
          .catch(() => {}),
      );
    }
    await Promise.all(jobs);
    return levels;
  }, []);

  // For PeerStatsTable: one row per TRANSPORT (= RTCPeerConnection): just two.
  const getTransportStats = useCallback(async () => {
    const out = {};
    for (const [key, t] of [
      ['send', sendRef.current],
      ['recv', recvRef.current],
    ]) {
      if (!t || t.closed) continue;
      try {
        out[key] = summarizePeerStats(await t.getStats(), prevStats.current[key]);
        prevStats.current[key] = out[key];
      } catch {
        // closed meanwhile
      }
    }
    return out;
  }, []);

  return { status, room, error, peers, paused, transports, join, leave, setPaused, replaceTrack, setPreferredLayer, getAudioLevels, getTransportStats };
}
