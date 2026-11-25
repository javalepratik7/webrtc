// Full-mesh group room: one RTCPeerConnection + one data channel PER other participant.
// Step 11: chat. Step 12: + audio/video. Step 13: perfect negotiation, per-peer
// recovery, survives a backend restart, screen share, stats, bitrate caps.
//
//   const mesh = useMeshRoom({ getLocalStream, getMediaState });
//     getLocalStream() → the local MediaStream (or null): its tracks go on every NEW connection
//     getMediaState()  → { audio, video }: sent to each peer when its data channel opens
//   await mesh.join(roomId, name)   → { ok, participants } | { ok:false, error }
//   mesh.leave()
//   mesh.sendChat(text) / mesh.broadcast(obj) / mesh.announceMedia()
//   mesh.replaceTrack(kind, track)  → camera switch on EVERY connection
//   mesh.startScreenShare() / mesh.stopScreenShare()   → renegotiates with EVERY peer
//   mesh.setMaxBitrate(peerId | 'all', kbps | null)    → sender.setParameters (no renegotiation)
//   mesh.getPeerStats()             → { [peerId]: summary } (bitrates since the previous call)
//   mesh.getAudioLevels()           → { [peerId]: 0..1, me: 0..1 }
//   mesh.status / room / error / peers / messages / screenStream / restartIceFor(peerId)
//
// ---------------------------------------------------------------------------
// Map(peerId → entry) in a ref (see step 11 for why a ref). peerId = the other
// TAB's clientId (step 13), not its socket id: socket ids change on every
// reconnect, clientIds don't. After a backend restart everyone re-joins with a
// new socket id and finds the SAME entries, so nobody is duplicated.
//
// ---------------------------------------------------------------------------
// Perfect negotiation (Webrtc.md §19), one instance PER peer connection
//   - Any side may need to (re)negotiate at any time: initial setup, screen share,
//     restartIce(), the answerer adding a track the offer had no slot for…
//     All of them go through ONE path: pc.onnegotiationneeded → setLocalDescription() → send.
//   - Two offers can cross (glare). Then the POLITE peer rolls back its own offer
//     and accepts theirs; the IMPOLITE peer ignores the incoming offer.
//   - polite = (my clientId > their clientId). Both sides compute the same answer
//     from the same two ids without talking, and the ids never change during a call.
//     (Socket ids would work too, until a reconnect: then for a moment each side
//     compares against a different id for the other, and both may decide "impolite".)
//   - The step 11 join rule is still used to START: the new joiner adds its tracks +
//     the data channel, which fires negotiationneeded. Existing users create their pc
//     when the first offer arrives. Perfect negotiation makes everything AFTER that safe.
//
// Every signal carries { pcId, toPcId }: random ids of the sender's and the receiver's
// RTCPeerConnection. An offer with a new pcId means "I started over" (they rebuilt the
// pc): replace ours. Anything addressed to a pc of ours that no longer exists
// (toPcId ≠ our current pcId), or coming from their old pc, is stale: ignored.
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientId as myClientId, socket } from '../services/socket.js';
import useLog from './useLog.js';
import { ICE_CONFIG } from '../services/webrtc.js';
import { summarizePeerStats } from '../services/meshStats.js';

const ACK_TIMEOUT_MS = 5000;
const DISCONNECTED_GRACE_MS = 5000; // 'disconnected' is often a Wi-Fi hiccup: wait before restarting ICE
const MAX_ICE_RESTARTS = 3;
const MISSING_GRACE_MS = 15000; // their socket dropped but P2P still works: wait this long for them to re-join
const KINDS = ['audio', 'video'];
const short = (id) => String(id).slice(0, 6);
const newId = () => Math.random().toString(36).slice(2, 10);
const describeCandidate = (c) => {
  const p = c.candidate.split(' ');
  return `${p[7]} ${p[2]} ${p[4]}:${p[5]}`;
};
let nextMsgId = 1;

export default function useMeshRoom({ getLocalStream = () => null, getMediaState = () => null } = {}) {
  const { log } = useLog();
  const [status, setStatus] = useState(socket.connected ? 'connected' : 'connecting');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState(null);
  const [peers, setPeers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [screenStream, setScreenStream] = useState(null);

  const localRef = useRef(getLocalStream);
  localRef.current = getLocalStream;
  const mediaStateRef = useRef(getMediaState);
  mediaStateRef.current = getMediaState;
  const peersRef = useRef(new Map());
  const joinedRef = useRef(null); // { roomId, name } while in a room
  const screenRef = useRef(null); // { stream, track } while sharing

  // ---- helpers ----------------------------------------------------------

  const publish = useCallback(() => {
    setPeers(
      [...peersRef.current.values()].map((e) => {
        const screenId = e.media.screenStreamId;
        const streams = [...e.streams.values()];
        return {
          id: e.id,
          name: e.name,
          joinedAt: e.joinedAt,
          initiator: e.initiator,
          polite: e.polite,
          ...e.state,
          channel: e.dataChannel?.readyState ?? 'none',
          counts: { ...e.counts },
          maxKbps: e.maxKbps,
          missing: Boolean(e.missingSince),
          // Same MediaStream objects every time (stored once in ontrack) → no srcObject churn.
          remoteStream: streams.find((s) => s.id !== screenId) ?? null,
          screenStream: (screenId && e.streams.get(screenId)) || null,
          media: e.media,
        };
      }),
    );
  }, []);

  const addMessage = useCallback((from, text, extra = {}) => {
    setMessages((m) => [...m, { id: nextMsgId++, from, text, time: new Date(), ...extra }]);
  }, []);

  const sendSignal = useCallback(
    async (to, type, payload) => {
      // Don't let Socket.IO buffer signaling while offline: it would be flushed on
      // reconnect BEFORE we re-joined (server: "not in room"). Resync handles it instead.
      if (!socket.connected) {
        log(`signal "${type}" → ${short(to)} dropped: signaling offline`, 'warn');
        return { ok: false, error: 'offline' };
      }
      try {
        const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('group:signal', { to, type, payload });
        if (!res.ok) log(`signal "${type}" → ${short(to)} not delivered: ${res.error}`, 'warn');
        return res;
      } catch {
        log(`signal "${type}" → ${short(to)}: no ack from server (timeout)`, 'error');
        return { ok: false, error: 'timeout' };
      }
    },
    [log],
  );

  const ensureEntry = useCallback((p, initiator) => {
    let entry = peersRef.current.get(p.clientId);
    if (!entry) {
      entry = {
        id: p.clientId,
        socketId: p.socketId ?? null,
        name: p.name ?? short(p.clientId),
        joinedAt: p.joinedAt ?? Date.now(),
        initiator, // did I start this connection (I joined later)?
        polite: myClientId > p.clientId,
        pc: null,
        pcId: null, // my pc's id, sent with every signal
        remotePcId: null, // their pc's id, from their signals
        dataChannel: null,
        state: { connection: 'none', ice: 'none', signaling: 'none' },
        pending: [],
        counts: { sent: 0, received: 0, queued: 0, offers: 0, glare: 0, restarts: 0 },
        streams: new Map(), // remote MediaStreams by id (camera, screen)
        media: { audio: true, video: true, screenStreamId: null },
        // perfect negotiation
        makingOffer: false,
        ignoreOffer: false,
        settingRemoteAnswer: false,
        // senders
        localAdded: false,
        cameraSenders: {},
        screenTransceiver: null,
        maxKbps: null,
        // recovery
        recoveryTimer: null,
        restartAttempts: 0,
        missingSince: null,
        prevStats: null,
      };
      peersRef.current.set(p.clientId, entry);
    } else if (p.socketId) {
      entry.socketId = p.socketId;
    }
    return entry;
  }, []);

  // Close ONE peer's connection and forget it. The others are untouched.
  const removePeer = useCallback(
    (id, reason) => {
      const entry = peersRef.current.get(id);
      if (!entry) return;
      peersRef.current.delete(id);
      clearTimeout(entry.recoveryTimer);
      entry.dataChannel?.close();
      entry.pc?.close();
      log(`[${entry.name}] connection closed (${reason}); ${peersRef.current.size} other connection(s) untouched`, 'warn');
      publish();
    },
    [log, publish],
  );

  const closeAll = useCallback(
    (reason) => {
      for (const id of [...peersRef.current.keys()]) removePeer(id, reason);
    },
    [removePeer],
  );

  const mediaStatePayload = useCallback(
    () => ({ type: 'media-state', ...(mediaStateRef.current() ?? {}), screenStreamId: screenRef.current?.stream.id ?? null }),
    [],
  );

  // ---- bitrate cap --------------------------------------------------------

  // RTCRtpSender.setParameters: changes encoder settings of ONE sender, live, no
  // renegotiation. maxBitrate caps what the congestion controller may use for this
  // peer; the encoder then lowers quality/resolution/fps to fit.
  const applyBitrate = useCallback(
    async (entry) => {
      const pc = entry.pc;
      if (!pc) return;
      const senders = pc.getSenders().filter((s) => s.track?.kind === 'video');
      for (const sender of senders) {
        const params = sender.getParameters();
        if (!params.encodings?.length) continue; // not negotiated yet: applied again on 'stable'
        const enc = params.encodings[0];
        const want = entry.maxKbps ? entry.maxKbps * 1000 : undefined;
        if (enc.maxBitrate === want) continue;
        if (want) enc.maxBitrate = want;
        else delete enc.maxBitrate;
        try {
          await sender.setParameters(params);
        } catch (err) {
          log(`[${entry.name}] setParameters failed: ${err.message}`, 'error');
        }
      }
    },
    [log],
  );

  const setMaxBitrate = useCallback(
    async (peerId, kbps) => {
      const targets = peerId === 'all' ? [...peersRef.current.values()] : [peersRef.current.get(peerId)].filter(Boolean);
      for (const e of targets) {
        e.maxKbps = kbps || null;
        await applyBitrate(e);
      }
      log(`max video bitrate ${kbps ? `${kbps} kbps` : 'unlimited'} → ${peerId === 'all' ? `all ${targets.length} peers` : targets[0]?.name}`);
      publish();
    },
    [applyBitrate, log, publish],
  );

  // ---- data channel -------------------------------------------------------

  const attachChannel = useCallback(
    (entry, dc) => {
      entry.dataChannel = dc;
      const alive = () => peersRef.current.get(entry.id) === entry && entry.dataChannel === dc;
      dc.onopen = () => {
        if (!alive()) return;
        log(`[${entry.name}] data channel "${dc.label}" open`, 'success');
        addMessage('system', `Chat with ${entry.name} connected`);
        dc.send(JSON.stringify(mediaStatePayload())); // a newcomer missed earlier broadcasts
        publish();
      };
      dc.onclose = () => {
        if (!alive()) return;
        log(`[${entry.name}] data channel closed`, 'warn');
        publish();
      };
      dc.onmessage = (e) => {
        if (!alive()) return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          msg = { type: 'chat', text: String(e.data) };
        }
        if (msg?.type === 'chat') {
          addMessage('peer', String(msg.text), { name: entry.name, peerId: entry.id });
        } else if (msg?.type === 'media-state') {
          entry.media = { audio: msg.audio !== false, video: msg.video !== false, screenStreamId: msg.screenStreamId ?? null };
          publish();
        } else if (msg?.type === 'bye') {
          // Explicit goodbye over P2P: faster than waiting for the server's participant-left.
          addMessage('system', `${entry.name} left`);
          removePeer(entry.id, `${entry.name} said bye`);
        }
      };
      publish();
    },
    [log, addMessage, publish, mediaStatePayload, removePeer],
  );

  // ---- the peer connection -------------------------------------------------

  const restartIce = useCallback(
    (entry, reason) => {
      const pc = entry.pc;
      if (!pc || pc.signalingState === 'closed') return;
      if (entry.restartAttempts >= MAX_ICE_RESTARTS) {
        log(`[${entry.name}] ${reason}: gave up after ${MAX_ICE_RESTARTS} ICE restarts`, 'error');
        return;
      }
      entry.restartAttempts++;
      entry.counts.restarts++;
      log(`[${entry.name}] ${reason} → restartIce() #${entry.restartAttempts} (only this peer)`, 'warn');
      // New ICE ufrag/pwd → negotiationneeded → an offer through perfect negotiation.
      // DTLS, tracks, data channel all stay: only the network path is re-discovered.
      pc.restartIce();
      publish();
    },
    [log, publish],
  );

  const createPc = useCallback(
    (entry, why) => {
      if (entry.pc) {
        log(`[${entry.name}] replacing the existing connection (${why})`, 'warn');
        clearTimeout(entry.recoveryTimer);
        entry.dataChannel?.close();
        entry.pc.close();
      }
      const pc = new RTCPeerConnection(ICE_CONFIG);
      Object.assign(entry, {
        pc,
        pcId: newId(),
        remotePcId: null,
        dataChannel: null,
        pending: [],
        streams: new Map(),
        makingOffer: false,
        ignoreOffer: false,
        settingRemoteAnswer: false,
        localAdded: false,
        cameraSenders: {},
        screenTransceiver: null,
        restartAttempts: 0,
        prevStats: null,
      });
      const alive = () => peersRef.current.get(entry.id) === entry && entry.pc === pc;

      const update = () => {
        if (!alive()) return;
        entry.state = { connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState };
        publish();
      };
      update();
      pc.oniceconnectionstatechange = update;
      pc.onsignalingstatechange = () => {
        update();
        // A new sender (e.g. screen) only gets encodings after negotiation: re-apply the cap.
        if (alive() && pc.signalingState === 'stable' && entry.maxKbps) applyBitrate(entry);
      };

      // Per-peer recovery. Only THIS pc is touched; the others don't even notice.
      pc.onconnectionstatechange = () => {
        if (!alive()) return;
        const s = pc.connectionState;
        log(`[${entry.name}] connectionState → ${s}`, s === 'connected' ? 'success' : s === 'failed' ? 'error' : 'info');
        clearTimeout(entry.recoveryTimer);
        if (s === 'connected') {
          entry.restartAttempts = 0;
          if (entry.maxKbps) applyBitrate(entry);
        } else if (s === 'disconnected') {
          // Usually temporary (Wi-Fi hiccup, network switch). ICE keeps checking by itself.
          entry.recoveryTimer = setTimeout(() => {
            if (alive() && pc.connectionState === 'disconnected') restartIce(entry, `still disconnected after ${DISCONNECTED_GRACE_MS / 1000} s`);
          }, DISCONNECTED_GRACE_MS);
        } else if (s === 'failed') {
          addMessage('system', `Connection to ${entry.name} failed, restarting ICE (others not affected)`);
          restartIce(entry, 'connection failed');
        }
        update();
      };

      // THE one place offers are made, for every reason.
      pc.onnegotiationneeded = async () => {
        if (!alive()) return;
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription(); // no argument = createOffer() + set, atomically w.r.t. state
          if (!alive() || pc.signalingState !== 'have-local-offer') return;
          entry.counts.offers++;
          log(`[${entry.name}] negotiationneeded → offer #${entry.counts.offers} (${entry.polite ? 'polite' : 'impolite'})`);
          sendSignal(entry.id, 'description', { pcId: entry.pcId, toPcId: entry.remotePcId, description: pc.localDescription.toJSON() });
        } catch (err) {
          log(`[${entry.name}] creating an offer failed: ${err.message}`, 'error');
        } finally {
          entry.makingOffer = false;
          publish();
        }
      };

      pc.onicecandidate = (e) => {
        if (!alive() || !e.candidate?.candidate) return;
        entry.counts.sent++;
        sendSignal(entry.id, 'candidate', { pcId: entry.pcId, toPcId: entry.remotePcId, candidate: e.candidate.toJSON() });
      };

      pc.ontrack = (e) => {
        if (!alive()) return;
        let stream = e.streams[0];
        if (!stream) {
          stream = entry.streams.values().next().value ?? new MediaStream();
          stream.addTrack(e.track);
        }
        log(`[${entry.name}] ontrack: ${e.track.kind} (stream ${stream.id.slice(0, 8)})`, 'success');
        if (!entry.streams.has(stream.id)) {
          entry.streams.set(stream.id, stream);
          // The sender stopped sending this track (e.g. screen share ended + renegotiated):
          // the track is removed from its stream. An empty stream → drop it → tile disappears.
          stream.addEventListener('removetrack', () => {
            if (stream.getTracks().length === 0 && entry.streams.get(stream.id) === stream) {
              entry.streams.delete(stream.id);
              publish();
            }
          });
        }
        publish();
      };

      pc.ondatachannel = (e) => {
        if (!alive()) return;
        attachChannel(entry, e.channel);
      };
      return { pc, alive };
    },
    [log, publish, sendSignal, attachChannel, addMessage, applyBitrate, restartIce],
  );

  // The SAME local tracks on this connection, + the screen if I'm sharing.
  const addLocalMedia = useCallback(
    (entry, asInitiator) => {
      const { pc } = entry;
      const stream = localRef.current();
      for (const kind of KINDS) {
        const track = stream?.getTracks().find((t) => t.kind === kind);
        if (track) entry.cameraSenders[kind] = pc.addTrack(track, stream);
        else if (asInitiator) pc.addTransceiver(kind, { direction: 'recvonly' });
      }
      const share = screenRef.current;
      if (share) {
        // Answerer: the offer has no slot for my screen → a NEW m-line → negotiationneeded
        // fires on MY side after this answer. Perfect negotiation makes that safe.
        entry.screenTransceiver = pc.addTransceiver(share.track, { direction: 'sendonly', streams: [share.stream] });
      }
      entry.localAdded = true;
    },
    [],
  );

  // New joiner → existing participant: tracks + data channel → negotiationneeded → offer.
  const callPeer = useCallback(
    (p, why = 'I joined later') => {
      const entry = ensureEntry(p, true);
      entry.initiator = true;
      const { pc } = createPc(entry, why);
      addLocalMedia(entry, true);
      attachChannel(entry, pc.createDataChannel('chat'));
      log(`[${entry.name}] new connection (${why}), I am ${entry.polite ? 'POLITE' : 'IMPOLITE'}`);
    },
    [ensureEntry, createPc, addLocalMedia, attachChannel, log],
  );

  const handleSignal = useCallback(
    async ({ from, type, payload }) => {
      let entry = peersRef.current.get(from);
      const theirPcId = payload?.pcId;
      if (entry?.pc && payload?.toPcId && payload.toPcId !== entry.pcId) {
        log(`[${entry.name}] ← ${type} addressed to my previous connection, ignored`, 'warn');
        return;
      }
      try {
        if (type === 'description') {
          const description = payload.description;
          entry ??= ensureEntry({ clientId: from }, false);
          // A different pc on their side than the one we're talking to? Start over too.
          if (!entry.pc || (description.type === 'offer' && entry.remotePcId && theirPcId !== entry.remotePcId)) {
            if (description.type !== 'offer') return; // an answer for a pc we don't have
            entry.initiator = false;
            createPc(entry, entry.pc ? 'they started a new connection' : 'their first offer');
          }
          if (entry.remotePcId && theirPcId !== entry.remotePcId) {
            log(`[${entry.name}] ← ${description.type} for an old connection, ignored`, 'warn');
            return;
          }
          entry.remotePcId = theirPcId;
          const { pc } = entry;
          const alive = () => peersRef.current.get(entry.id) === entry && entry.pc === pc;

          // ---- perfect negotiation ----
          const readyForOffer = !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingRemoteAnswer);
          const collision = description.type === 'offer' && !readyForOffer;
          entry.ignoreOffer = !entry.polite && collision;
          if (collision) {
            entry.counts.glare++;
            publish();
          }
          if (entry.ignoreOffer) {
            log(`[${entry.name}] ← offer COLLIDED with mine: I'm impolite → ignoring theirs (they'll roll back)`, 'warn');
            return;
          }
          if (collision) log(`[${entry.name}] ← offer COLLIDED with mine: I'm polite → rolling back mine, accepting theirs`, 'warn');
          entry.settingRemoteAnswer = description.type === 'answer';
          await pc.setRemoteDescription(description); // polite + collision → implicit rollback
          entry.settingRemoteAnswer = false;
          if (!alive()) return;
          log(`[${entry.name}] ← ${description.type} applied`);
          const queued = entry.pending;
          entry.pending = [];
          for (const c of queued) await pc.addIceCandidate(c).catch(() => {});

          if (description.type === 'offer') {
            if (!entry.localAdded) addLocalMedia(entry, false); // after SRD: reuse the offer's transceivers
            await pc.setLocalDescription(); // no argument = createAnswer() + set
            if (!alive()) return;
            sendSignal(entry.id, 'description', { pcId: entry.pcId, toPcId: entry.remotePcId, description: pc.localDescription.toJSON() });
          }
        } else if (type === 'candidate') {
          entry ??= ensureEntry({ clientId: from }, false);
          entry.counts.received++;
          if (entry.remotePcId && theirPcId !== entry.remotePcId && entry.pc?.remoteDescription) return; // stale
          const pc = entry.pc;
          if (!pc || !pc.remoteDescription) {
            entry.pending.push(payload.candidate);
            entry.counts.queued++;
            log(`[${entry.name}] ← candidate ${describeCandidate(payload.candidate)} QUEUED (no remote description yet)`, 'warn');
          } else {
            try {
              await pc.addIceCandidate(payload.candidate);
            } catch (err) {
              // Candidates of an offer we deliberately ignored are expected to fail.
              if (!entry.ignoreOffer) throw err;
            }
          }
          publish();
        } else {
          log(`signal "${type}" from ${short(from)} (not handled)`);
        }
      } catch (err) {
        log(`[${entry?.name ?? short(from)}] handling "${type}" failed: ${err.name}: ${err.message}`, 'error');
      }
    },
    [ensureEntry, createPc, addLocalMedia, sendSignal, publish, log],
  );

  // After signaling was down, a negotiation may have been cut in half.
  const resync = useCallback(
    async (entry) => {
      const pc = entry.pc;
      if (!pc) return;
      if (pc.signalingState === 'have-local-offer') {
        // Our offer was probably lost. Roll back; if something still needs
        // negotiating, the browser fires negotiationneeded again by itself.
        log(`[${entry.name}] resync: rolling back an offer that may have been lost`, 'warn');
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      }
      if (['disconnected', 'failed'].includes(pc.connectionState)) {
        entry.restartAttempts = 0;
        restartIce(entry, 'resync after re-join');
      }
    },
    [log, restartIce],
  );

  // ---- join / leave -----------------------------------------------------

  const doJoin = useCallback(
    async (roomId, name, { rejoin = false } = {}) => {
      setError(null);
      let res;
      try {
        res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('group:join', { roomId, name, clientId: myClientId });
      } catch {
        res = { ok: false, error: 'No answer from the server (timeout).' };
      }
      if (!res.ok) {
        const msg = res.error === 'room-full' ? `Room "${roomId}" is full (max 6 people in a mesh).` : res.error;
        if (!rejoin) {
          joinedRef.current = null;
          setRoom(null);
        }
        setError(msg);
        log(`${rejoin ? 'Re-join' : 'Join'} failed: ${msg}`, 'error');
        return res;
      }
      joinedRef.current = { roomId: res.roomId, name };
      setRoom({ id: res.roomId, you: res.you });

      // Reconcile: whoever is listed AND still has a working pc with us is kept as is.
      let kept = 0;
      let created = 0;
      const listed = new Set();
      for (const p of res.participants) {
        listed.add(p.clientId);
        const entry = peersRef.current.get(p.clientId);
        const usable = entry?.pc && !['closed', 'failed'].includes(entry.pc.connectionState);
        if (usable) {
          entry.socketId = p.socketId;
          entry.missingSince = null;
          kept++;
          resync(entry);
        } else {
          callPeer(p, rejoin ? 'rebuilding after re-join' : 'I joined later');
          created++;
        }
      }
      // Entries the server doesn't list (yet): they may still be re-joining. Give them time.
      for (const e of peersRef.current.values()) if (!listed.has(e.id)) e.missingSince ??= Date.now();
      publish();
      log(
        rejoin
          ? `Re-joined "${res.roomId}" after a signaling reconnect: kept ${kept} existing P2P connection(s), created ${created}`
          : res.participants.length
            ? `Joined "${res.roomId}" as ${res.you.name}. Already here: ${res.participants.map((p) => p.name).join(', ')} → I start ${created} connection(s)`
            : `Joined "${res.roomId}" as ${res.you.name}. Room is empty`,
        'success',
      );
      return res;
    },
    [log, callPeer, resync, publish],
  );

  const join = useCallback(
    (roomId, name) => {
      setMessages([]);
      return doJoin(roomId.trim(), name);
    },
    [doJoin],
  );

  const broadcast = useCallback((obj) => {
    const data = JSON.stringify(obj);
    let sent = 0;
    for (const e of peersRef.current.values()) {
      if (e.dataChannel?.readyState === 'open') {
        e.dataChannel.send(data);
        sent++;
      }
    }
    return sent;
  }, []);

  const announceMedia = useCallback(() => broadcast(mediaStatePayload()), [broadcast, mediaStatePayload]);

  const stopScreenShare = useCallback(() => {
    const share = screenRef.current;
    if (!share) return;
    screenRef.current = null;
    setScreenStream(null);
    for (const e of peersRef.current.values()) {
      const t = e.screenTransceiver;
      if (!t || e.pc?.signalingState === 'closed') continue;
      // Keep the transceiver (and its m-line) for next time: stop sending on it.
      // Direction change → negotiationneeded → offer → their stream loses the track.
      t.sender.replaceTrack(null);
      t.direction = 'inactive';
    }
    share.track.stop();
    announceMedia();
    log('Screen share stopped → renegotiating with every peer', 'warn');
  }, [announceMedia, log]);

  const startScreenShare = useCallback(async () => {
    if (screenRef.current) return;
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    } catch (err) {
      log(`Screen share cancelled: ${err.name}`, 'warn');
      return;
    }
    const track = display.getVideoTracks()[0];
    track.contentHint = 'detail'; // favour sharp text over smooth motion
    screenRef.current = { stream: display, track };
    setScreenStream(display);
    let n = 0;
    for (const e of peersRef.current.values()) {
      if (!e.pc || !e.localAdded || e.pc.signalingState === 'closed') continue; // gets it in addLocalMedia later
      const t = e.screenTransceiver;
      if (t) {
        // Re-use the m-line from an earlier share: new track + new stream id.
        t.sender.replaceTrack(track);
        t.sender.setStreams(display);
        t.direction = 'sendonly';
      } else {
        // A new m-line → negotiationneeded on this pc. On ALL pcs at once.
        e.screenTransceiver = e.pc.addTransceiver(track, { direction: 'sendonly', streams: [display] });
      }
      n++;
    }
    track.addEventListener('ended', () => stopScreenShare(), { once: true }); // browser's "Stop sharing" bar
    announceMedia();
    log(`Screen share started → renegotiating with ${n} peer(s) (any of them may be polite or impolite)`, 'success');
  }, [announceMedia, stopScreenShare, log]);

  const leave = useCallback(async () => {
    broadcast({ type: 'bye' });
    joinedRef.current = null;
    stopScreenShare();
    closeAll('I left');
    setRoom(null);
    setError(null);
    try {
      await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('group:leave');
    } catch {
      // disconnected: the server already dropped us
    }
    log('Left the group room');
  }, [broadcast, stopScreenShare, closeAll, log]);

  // ---- socket events ----------------------------------------------------
  useEffect(() => {
    const onConnect = () => {
      setStatus('connected');
      if (joinedRef.current) {
        // Backend restart or network blip: we have a NEW socket id but the same
        // clientId. The P2P connections never needed the server: keep them.
        log(`Socket reconnected: re-joining "${joinedRef.current.roomId}" (P2P connections kept)`, 'warn');
        doJoin(joinedRef.current.roomId, joinedRef.current.name, { rejoin: true });
      }
    };
    const onDisconnect = (reason) => {
      setStatus('disconnected');
      log(`Socket disconnected: ${reason} (peer connections keep working)`, 'warn');
    };
    const onConnectError = (err) => {
      setStatus('disconnected');
      log(`Socket connect error: ${err.message}`, 'error');
    };
    const onReconnectAttempt = () => setStatus('connecting');

    const onParticipantJoined = (p) => {
      if (!joinedRef.current || p.clientId === myClientId) return;
      const existing = peersRef.current.get(p.clientId);
      if (existing?.pc && !['closed', 'failed'].includes(existing.pc.connectionState)) {
        existing.socketId = p.socketId;
        existing.missingSince = null;
        log(`${p.name} re-joined after a reconnect: keeping our P2P connection`, 'success');
        resync(existing);
        publish();
        return;
      }
      if (existing) removePeer(p.clientId, 'they re-joined, old connection unusable');
      ensureEntry(p, false);
      log(`group:participant-joined: ${p.name} → waiting for their offer`, 'success');
      addMessage('system', `${p.name} joined`);
      publish();
    };
    const onParticipantLeft = (p) => {
      if (!joinedRef.current) return;
      const entry = peersRef.current.get(p.clientId);
      if (!entry) return;
      if (p.reason === 'disconnected' && entry.pc?.connectionState === 'connected') {
        // Their SOCKET dropped, but our P2P link works. Probably a signaling blip:
        // keep the call and give them time to re-join.
        entry.missingSince = Date.now();
        log(`[${entry.name}] signaling dropped but P2P is still connected: waiting up to ${MISSING_GRACE_MS / 1000} s`, 'warn');
        publish();
        return;
      }
      addMessage('system', `${entry.name} left`);
      removePeer(p.clientId, `${entry.name} ${p.reason}`);
    };
    const onSignal = (msg) => {
      if (joinedRef.current) handleSignal(msg);
    };

    // Peers that vanished from signaling and never came back.
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const e of [...peersRef.current.values()]) {
        if (!e.missingSince || now - e.missingSince < MISSING_GRACE_MS) continue;
        if (e.pc?.connectionState === 'connected' && !socket.connected) continue; // WE are the one offline
        addMessage('system', `${e.name} did not come back`);
        removePeer(e.id, `not back after ${MISSING_GRACE_MS / 1000} s`);
      }
    }, 2000);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.on('group:participant-joined', onParticipantJoined);
    socket.on('group:participant-left', onParticipantLeft);
    socket.on('group:signal', onSignal);
    if (!socket.connected) {
      setStatus('connecting');
      socket.connect();
    }

    return () => {
      clearInterval(sweep);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('group:participant-joined', onParticipantJoined);
      socket.off('group:participant-left', onParticipantLeft);
      socket.off('group:signal', onSignal);
      if (joinedRef.current) {
        socket.emit('group:leave');
        joinedRef.current = null;
      }
      screenRef.current?.track.stop();
      screenRef.current = null;
      closeAll('page closed');
    };
  }, [log, doJoin, closeAll, ensureEntry, removePeer, handleSignal, addMessage, publish, resync]);

  // Tab close / reload: say bye over P2P (instant), then close.
  useEffect(() => {
    const onPageHide = () => {
      const bye = JSON.stringify({ type: 'bye' });
      for (const e of peersRef.current.values()) {
        if (e.dataChannel?.readyState === 'open') e.dataChannel.send(bye);
        e.pc?.close();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // ---- chat / media helpers ---------------------------------------------

  const sendChat = useCallback(
    (text) => {
      const t = text.trim();
      if (!t) return 0;
      const total = peersRef.current.size;
      const sent = broadcast({ type: 'chat', text: t, ts: Date.now() });
      if (sent) addMessage('me', t, { sentTo: sent, of: total });
      return sent;
    },
    [broadcast, addMessage],
  );

  // Camera switch: the camera sender of every connection (NOT the screen sender).
  const replaceTrack = useCallback(
    async (kind, track) => {
      const entries = [...peersRef.current.values()].filter((e) => e.cameraSenders[kind] && e.pc?.signalingState !== 'closed');
      const results = await Promise.allSettled(entries.map((e) => e.cameraSenders[kind].replaceTrack(track)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      log(`replaceTrack(${kind}) on ${ok}/${entries.length} connection(s), no renegotiation`, ok === entries.length ? 'success' : 'warn');
      return ok;
    },
    [log],
  );

  const getAudioLevels = useCallback(async () => {
    const levels = {};
    const entries = [...peersRef.current.values()].filter((e) => e.pc?.connectionState === 'connected');
    await Promise.all(
      entries.map(async (e) => {
        try {
          const report = await e.pc.getStats();
          report.forEach((r) => {
            if (r.kind !== 'audio' || r.audioLevel == null) return;
            if (r.type === 'inbound-rtp') levels[e.id] = r.audioLevel;
            else if (r.type === 'media-source') levels.me = Math.max(levels.me ?? 0, r.audioLevel);
          });
        } catch {
          // closed meanwhile
        }
      }),
    );
    return levels;
  }, []);

  // One getStats() per connection; bitrates = bytes since the previous call.
  const getPeerStats = useCallback(async () => {
    const out = {};
    await Promise.all(
      [...peersRef.current.values()].map(async (e) => {
        if (!e.pc || e.pc.signalingState === 'closed') return;
        try {
          const summary = summarizePeerStats(await e.pc.getStats(), e.prevStats);
          e.prevStats = summary;
          out[e.id] = summary;
        } catch {
          // closed meanwhile
        }
      }),
    );
    return out;
  }, []);

  const restartIceFor = useCallback(
    (peerId) => {
      const e = peersRef.current.get(peerId);
      if (!e) return;
      e.restartAttempts = 0;
      restartIce(e, 'manual');
    },
    [restartIce],
  );

  return {
    status,
    room,
    error,
    peers,
    messages,
    screenStream,
    join,
    leave,
    sendChat,
    broadcast,
    announceMedia,
    replaceTrack,
    startScreenShare,
    stopScreenShare,
    setMaxBitrate,
    getAudioLevels,
    getPeerStats,
    restartIceFor,
  };
}
