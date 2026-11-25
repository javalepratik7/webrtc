// Full-mesh group room: one RTCPeerConnection + one data channel PER other participant.
// Step 11: chat. Step 12: + audio/video (the SAME local tracks on every connection).
//
//   const mesh = useMeshRoom({ getLocalStream, getMediaState });
//     getLocalStream() → the local MediaStream (or null): its tracks go on every NEW connection
//     getMediaState()  → { audio, video }: sent to each peer as soon as its data channel opens
//   await mesh.join(roomId, name)   → { ok, participants } | { ok:false, error }
//   mesh.leave()
//   mesh.sendChat(text)             → number of peers it was sent to (one data channel each)
//   mesh.broadcast(obj)             → send any JSON message over every open data channel
//   mesh.replaceTrack(kind, track)  → sender.replaceTrack on EVERY connection (camera switch)
//   mesh.getAudioLevels()           → { [peerId]: 0..1, me: 0..1 } from getStats (active speaker)
//   mesh.status    socket: 'connecting' | 'connected' | 'disconnected'
//   mesh.room      { id, you } | null
//   mesh.peers     [{ id, name, role, connection, ice, signaling, channel, counts,
//                     remoteStream, media: { audio, video } }]  (render snapshot)
//   mesh.messages  [{ id, from: 'me'|'peer'|'system', name, text, time, sentTo? }]
//
// ---------------------------------------------------------------------------
// The data structure: peersRef.current = Map(peerId → entry)
//   peerId = the other participant's socket id (what the server uses for `to`/`from`)
//   entry  = { id, name, joinedAt, role, pc, dataChannel, state, pending, counts,
//              remoteStream, media }
//   remoteStream is created ONCE per connection (from ontrack) and then only ever
//   handed out as the same object, so <video>.srcObject never has to be re-set.
//
// It's a REF, not state: socket callbacks and pc event handlers fire long after
// the render that created them, and they must all see the CURRENT Map. React
// state would give each closure a stale copy. After every change we call
// publish(), which copies the Map into `peers` state for rendering.
//
// ---------------------------------------------------------------------------
// Who offers? (avoiding glare without perfect negotiation)
//   The NEW joiner creates one offer per participant already in the room
//   (the list comes back in the group:join ack). Existing users never offer:
//   they create a connection only when an offer arrives, and answer it.
//
//   Why it works: for every PAIR of users, exactly one of them joined later. The
//   server processes joins one at a time, so that order is unambiguous: the
//   later one sees the earlier one in its participant list, the earlier one
//   only gets "participant-joined". So exactly one side of each pair sends an
//   offer → two offers can never cross → no glare.
//
//   When it isn't enough (see notes/step11.md): renegotiation later on (adding
//   video / screen share: then EITHER side may need to offer), ICE restarts,
//   reconnects that give someone a new socket id, and multiple signaling
//   servers with no single join order. That is what perfect negotiation is for.
//
// Trickle ICE: candidates go out as soon as they're found, addressed to ONE
// peer. Candidates that arrive before that peer's setRemoteDescription are
// queued in entry.pending (one queue PER peer: B's early candidates must never
// end up on the connection to C).
import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../services/socket.js';
import useLog from './useLog.js';
import { ICE_CONFIG } from '../services/webrtc.js';

const ACK_TIMEOUT_MS = 5000;
const describeCandidate = (c) => {
  const p = c.candidate.split(' ');
  return `${p[7]} ${p[2]} ${p[4]}:${p[5]}`;
};
const short = (id) => id.slice(0, 6);
const KINDS = ['audio', 'video'];
let nextMsgId = 1;

export default function useMeshRoom({ getLocalStream = () => null, getMediaState = () => null } = {}) {
  const { log } = useLog();
  // Latest callbacks in refs: pc/socket handlers created long ago must call the CURRENT ones.
  const localRef = useRef(getLocalStream);
  localRef.current = getLocalStream;
  const mediaStateRef = useRef(getMediaState);
  mediaStateRef.current = getMediaState;
  const [status, setStatus] = useState(socket.connected ? 'connected' : 'connecting');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState(null);
  const [peers, setPeers] = useState([]);
  const [messages, setMessages] = useState([]);

  const peersRef = useRef(new Map());
  const joinedRef = useRef(null); // { roomId, name } while in a room (to re-join after a reconnect)

  // ---- helpers ----------------------------------------------------------

  // Map (ref) → array (state) for rendering. Cheap: at most 5 entries.
  const publish = useCallback(() => {
    setPeers(
      [...peersRef.current.values()].map((e) => ({
        id: e.id,
        name: e.name,
        joinedAt: e.joinedAt,
        role: e.role,
        ...e.state,
        channel: e.dataChannel?.readyState ?? 'none',
        counts: { ...e.counts },
        remoteStream: e.remoteStream, // same object every time → no srcObject churn
        media: e.media,
      })),
    );
  }, []);

  const addMessage = useCallback((from, text, extra = {}) => {
    setMessages((m) => [...m, { id: nextMsgId++, from, text, time: new Date(), ...extra }]);
  }, []);

  const sendSignal = useCallback(
    async (to, type, payload) => {
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

  // Name + bookkeeping for a peer, WITHOUT a connection yet. Existing users call
  // this on participant-joined; the pc only appears when the offer does.
  const ensureEntry = useCallback((p, role) => {
    let entry = peersRef.current.get(p.socketId);
    if (!entry) {
      entry = {
        id: p.socketId,
        name: p.name ?? short(p.socketId),
        joinedAt: p.joinedAt ?? Date.now(),
        role,
        pc: null,
        dataChannel: null,
        state: { connection: 'none', ice: 'none', signaling: 'none' },
        pending: [],
        counts: { sent: 0, received: 0, queued: 0 },
        remoteStream: null,
        // What they told us over the data channel. Until then, assume on.
        media: { audio: true, video: true },
      };
      peersRef.current.set(p.socketId, entry);
    }
    return entry;
  }, []);

  // Close ONE peer's connection and forget it. The other entries are untouched:
  // each pc has its own ICE agent, DTLS session, ports and data channel, so
  // closing one cannot affect the others.
  const removePeer = useCallback(
    (id, reason) => {
      const entry = peersRef.current.get(id);
      if (!entry) return;
      peersRef.current.delete(id); // first: late events from this pc now see alive() === false
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

  const attachChannel = useCallback(
    (entry, dc) => {
      entry.dataChannel = dc;
      const alive = () => peersRef.current.get(entry.id) === entry;
      dc.onopen = () => {
        if (!alive()) return;
        log(`[${entry.name}] data channel "${dc.label}" open`, 'success');
        // A newcomer missed every earlier media-state broadcast: tell them where we are now.
        const media = mediaStateRef.current();
        if (media) dc.send(JSON.stringify({ type: 'media-state', ...media }));
        addMessage('system', `Chat with ${entry.name} connected`);
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
        // The author is whoever is at the other end of THIS channel: in a mesh
        // nobody forwards messages, so we know exactly who sent it.
        if (msg?.type === 'chat') addMessage('peer', String(msg.text), { name: entry.name, peerId: entry.id });
        else if (msg?.type === 'media-state') {
          entry.media = { audio: msg.audio !== false, video: msg.video !== false };
          log(`[${entry.name}] media-state: mic ${entry.media.audio ? 'on' : 'off'}, camera ${entry.media.video ? 'on' : 'off'}`);
          publish();
        }
      };
      publish();
    },
    [log, addMessage, publish],
  );

  // A fresh RTCPeerConnection for this entry, with every handler scoped to it.
  const createPc = useCallback(
    (entry) => {
      if (entry.pc) {
        log(`[${entry.name}] replacing the existing connection`, 'warn');
        entry.dataChannel?.close();
        entry.pc.close();
        entry.dataChannel = null;
      }
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;
      entry.remoteStream = null; // a new connection brings new remote tracks
      // The handlers below close over THIS pc; if it's replaced or removed, they go quiet.
      const alive = () => peersRef.current.get(entry.id) === entry && entry.pc === pc;

      const update = () => {
        if (!alive()) return;
        entry.state = { connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState };
        publish();
      };
      update();
      pc.onsignalingstatechange = update;
      pc.oniceconnectionstatechange = update;
      pc.onconnectionstatechange = () => {
        if (!alive()) return;
        const s = pc.connectionState;
        log(`[${entry.name}] connectionState → ${s}`, s === 'connected' ? 'success' : s === 'failed' ? 'error' : 'info');
        if (s === 'failed') addMessage('system', `Connection to ${entry.name} failed (the others are not affected)`);
        update();
      };

      // Trickle ICE, addressed to this one peer.
      pc.onicecandidate = (e) => {
        if (!alive() || !e.candidate?.candidate) return; // null / "" = gathering finished
        entry.counts.sent++;
        sendSignal(entry.id, 'candidate', e.candidate.toJSON());
        log(`[${entry.name}] → candidate ${describeCandidate(e.candidate)}`);
        publish();
      };

      // Remote media: once per track (audio, video). Both arrive in the stream the
      // sender named in addTrack(track, stream) (a=msid), so e.streams[0] is the
      // SAME object both times. Store it once; publish() hands out that same object.
      pc.ontrack = (e) => {
        if (!alive()) return;
        log(`[${entry.name}] ontrack: remote ${e.track.kind}`, 'success');
        if (e.streams[0]) {
          entry.remoteStream = e.streams[0];
        } else {
          entry.remoteStream ??= new MediaStream();
          entry.remoteStream.addTrack(e.track);
        }
        publish();
      };

      // Answerer side: the offerer's "chat" channel arrives through the connection.
      pc.ondatachannel = (e) => {
        if (!alive()) return;
        log(`[${entry.name}] ondatachannel "${e.channel.label}"`, 'success');
        attachChannel(entry, e.channel);
      };
      return { pc, alive };
    },
    [log, publish, sendSignal, attachChannel, addMessage],
  );

  // setRemoteDescription, then drain THIS peer's candidate queue.
  const applyRemoteDescription = useCallback(
    async (entry, pc, alive, description) => {
      await pc.setRemoteDescription(description);
      if (!alive()) return false;
      const queued = entry.pending;
      entry.pending = [];
      for (const c of queued) await pc.addIceCandidate(c);
      if (queued.length) log(`[${entry.name}] added ${queued.length} queued candidate(s) after setRemoteDescription`, 'success');
      return alive();
    },
    [log],
  );

  // The SAME local track objects go on every connection. Offerer: before createOffer
  // (a missing kind becomes recvonly, so we can still receive it). Answerer: after
  // setRemoteDescription, so addTrack reuses the transceivers the offer created.
  const addLocalMedia = useCallback(
    (pc, asOfferer, name) => {
      const stream = localRef.current();
      for (const kind of KINDS) {
        const track = stream?.getTracks().find((t) => t.kind === kind);
        if (track) pc.addTrack(track, stream);
        else if (asOfferer) pc.addTransceiver(kind, { direction: 'recvonly' });
      }
      log(`[${name}] added local ${stream ? stream.getTracks().map((t) => t.kind).join(' + ') : 'nothing (receive only)'}`);
    },
    [log],
  );

  // NEW joiner → one existing participant: tracks + data channel + offer.
  const callPeer = useCallback(
    async (p) => {
      const entry = ensureEntry(p, 'offerer');
      entry.role = 'offerer';
      const { pc, alive } = createPc(entry);
      addLocalMedia(pc, true, entry.name);
      // Before createOffer, so the offer contains m=application (SCTP).
      attachChannel(entry, pc.createDataChannel('chat'));
      try {
        await pc.setLocalDescription(await pc.createOffer());
        if (!alive()) return;
        sendSignal(entry.id, 'offer', pc.localDescription.toJSON());
        log(`[${entry.name}] → offer (${pc.localDescription.sdp.length} chars)`);
      } catch (err) {
        log(`[${entry.name}] creating the offer failed: ${err.message}`, 'error');
      }
    },
    [ensureEntry, createPc, addLocalMedia, attachChannel, sendSignal, log],
  );

  const handleSignal = useCallback(
    async ({ from, type, payload }) => {
      let entry = peersRef.current.get(from);
      try {
        if (type === 'offer') {
          // Normally participant-joined already created the entry (server orders it first).
          entry ??= ensureEntry({ socketId: from }, 'answerer');
          if (entry.role === 'offerer' && entry.pc?.signalingState === 'have-local-offer') {
            // Can't happen with the join rule. If it does, that's GLARE: be the "impolite" peer.
            log(`[${entry.name}] ← offer while my own offer is pending: GLARE, ignoring it`, 'error');
            return;
          }
          entry.role = 'answerer';
          log(`[${entry.name}] ← offer (${payload.sdp.length} chars) → answering`, 'success');
          const { pc, alive } = createPc(entry);
          if (!(await applyRemoteDescription(entry, pc, alive, payload))) return;
          addLocalMedia(pc, false, entry.name); // AFTER setRemoteDescription
          await pc.setLocalDescription(await pc.createAnswer());
          if (!alive()) return;
          sendSignal(entry.id, 'answer', pc.localDescription.toJSON());
          log(`[${entry.name}] → answer (${pc.localDescription.sdp.length} chars)`);
        } else if (type === 'answer') {
          const pc = entry?.pc;
          if (!pc || pc.signalingState !== 'have-local-offer') {
            log(`[${entry?.name ?? short(from)}] ← answer ignored (signalingState: ${pc?.signalingState ?? 'no connection'})`, 'warn');
            return;
          }
          log(`[${entry.name}] ← answer (${payload.sdp.length} chars)`, 'success');
          const e = entry;
          await applyRemoteDescription(e, pc, () => peersRef.current.get(e.id) === e && e.pc === pc, payload);
        } else if (type === 'candidate') {
          entry ??= ensureEntry({ socketId: from }, 'answerer');
          entry.counts.received++;
          const pc = entry.pc;
          if (!pc || !pc.remoteDescription) {
            // No connection yet (offer still being processed), or setRemoteDescription
            // hasn't finished: addIceCandidate would throw. Queue it for THIS peer.
            entry.pending.push(payload);
            entry.counts.queued++;
            log(`[${entry.name}] ← candidate ${describeCandidate(payload)} QUEUED (no remote description yet)`, 'warn');
          } else {
            await pc.addIceCandidate(payload);
            log(`[${entry.name}] ← candidate ${describeCandidate(payload)}`);
          }
          publish();
        } else {
          log(`signal "${type}" from ${short(from)} (not handled)`);
        }
      } catch (err) {
        log(`[${entry?.name ?? short(from)}] handling "${type}" failed: ${err.name}: ${err.message}`, 'error');
      }
    },
    [ensureEntry, createPc, applyRemoteDescription, addLocalMedia, sendSignal, publish, log],
  );

  // ---- join / leave -----------------------------------------------------

  const doJoin = useCallback(
    async (roomId, name) => {
      setError(null);
      let res;
      try {
        res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('group:join', { roomId, name });
      } catch {
        res = { ok: false, error: 'No answer from the server (timeout).' };
      }
      if (!res.ok) {
        const msg = res.error === 'room-full' ? `Room "${roomId}" is full (max 6 people in a mesh).` : res.error;
        joinedRef.current = null;
        setRoom(null);
        setError(msg);
        log(`Join failed: ${msg}`, 'error');
        return res;
      }
      joinedRef.current = { roomId: res.roomId, name };
      setRoom({ id: res.roomId, you: res.you });
      const n = res.participants.length;
      log(
        n
          ? `Joined "${res.roomId}" as ${res.you.name}. Already here: ${res.participants.map((p) => p.name).join(', ')} → I am the NEW joiner: sending ${n} offer(s)`
          : `Joined "${res.roomId}" as ${res.you.name}. Room is empty: I'll answer whoever joins next`,
        'success',
      );
      // One offer per existing participant, all in parallel: separate connections.
      for (const p of res.participants) callPeer(p);
      return res;
    },
    [log, callPeer],
  );

  const join = useCallback(
    (roomId, name) => {
      setMessages([]);
      return doJoin(roomId.trim(), name);
    },
    [doJoin],
  );

  const leave = useCallback(async () => {
    joinedRef.current = null;
    closeAll('I left');
    setRoom(null);
    setError(null);
    try {
      await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('group:leave');
    } catch {
      // disconnected: the server already dropped us
    }
    log('Left the group room');
  }, [closeAll, log]);

  // ---- socket events ----------------------------------------------------
  // Registered in an effect with a cleanup that removes the SAME functions, so
  // StrictMode's mount → unmount → mount never leaves duplicate listeners.
  // Peer connections are only created from event handlers, never in the effect.
  useEffect(() => {
    const onConnect = () => {
      setStatus('connected');
      if (joinedRef.current) {
        // New socket id → to everyone else we are a brand-new participant (the server
        // sent participant-left for the old id). Rebuild every connection from scratch,
        // with us as the new joiner, instead of trying to patch old ones.
        log(`Socket reconnected: re-joining "${joinedRef.current.roomId}" and rebuilding the mesh`, 'warn');
        closeAll('signaling reconnected');
        doJoin(joinedRef.current.roomId, joinedRef.current.name);
      }
    };
    const onDisconnect = (reason) => {
      setStatus('disconnected');
      log(`Socket disconnected: ${reason} (open peer connections keep working)`, 'warn');
    };
    const onConnectError = (err) => {
      setStatus('disconnected');
      log(`Socket connect error: ${err.message}`, 'error');
    };
    const onReconnectAttempt = () => setStatus('connecting');

    const onParticipantJoined = (p) => {
      if (!joinedRef.current || p.socketId === socket.id) return;
      ensureEntry(p, 'answerer');
      log(`group:participant-joined: ${p.name} (${short(p.socketId)}) → waiting for their offer`, 'success');
      addMessage('system', `${p.name} joined`);
      publish();
    };
    const onParticipantLeft = (p) => {
      if (!joinedRef.current) return;
      const name = peersRef.current.get(p.socketId)?.name ?? p.name ?? short(p.socketId);
      log(`group:participant-left: ${name} (${p.reason})`, 'warn');
      addMessage('system', `${name} left`);
      removePeer(p.socketId, `${name} ${p.reason}`);
    };
    const onSignal = (msg) => {
      if (joinedRef.current) handleSignal(msg);
    };

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
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('group:participant-joined', onParticipantJoined);
      socket.off('group:participant-left', onParticipantLeft);
      socket.off('group:signal', onSignal);
      // Leaving the page = leaving the room and closing every connection.
      if (joinedRef.current) {
        socket.emit('group:leave');
        joinedRef.current = null;
      }
      closeAll('page closed');
    };
  }, [log, doJoin, closeAll, ensureEntry, removePeer, handleSignal, addMessage, publish]);

  // Tab close / reload: close connections right away so the others see it
  // immediately (the socket drop makes the server send participant-left too).
  useEffect(() => {
    const onPageHide = () => {
      for (const e of peersRef.current.values()) e.pc?.close();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // ---- data channel messages ---------------------------------------------

  // Same JSON to every peer with an open channel. → how many got it.
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

  // ---- media across all connections ---------------------------------------

  // Camera switch: one new track, put into EVERY connection's sender of that kind.
  // No renegotiation (same transceiver, m-line, SSRC, codec), see step 10.
  const replaceTrack = useCallback(
    async (kind, track) => {
      const entries = [...peersRef.current.values()].filter((e) => e.pc && e.pc.connectionState !== 'closed');
      const results = await Promise.allSettled(
        entries.map((e) => {
          const t = e.pc.getTransceivers().find((tr) => tr.sender.track?.kind === kind || tr.receiver.track.kind === kind);
          if (!t) return Promise.reject(new Error('no transceiver'));
          return t.sender.replaceTrack(track);
        }),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      log(`replaceTrack(${kind}) on ${ok}/${entries.length} connection(s), no renegotiation`, ok === entries.length ? 'success' : 'warn');
      return ok;
    },
    [log],
  );

  // Audio levels (0..1) from getStats: inbound-rtp = what each peer sends us,
  // media-source = our own mic (the same on every pc, so any one will do).
  const getAudioLevels = useCallback(async () => {
    const levels = {};
    const entries = [...peersRef.current.values()].filter((e) => e.pc && e.pc.connectionState === 'connected');
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
          // pc closed between the filter and getStats: skip it
        }
      }),
    );
    return levels;
  }, []);

  // ---- chat -------------------------------------------------------------

  // No server, no relay: the same message is sent separately over EVERY open
  // data channel (N−1 sends). A peer whose channel isn't open simply misses it.
  const sendChat = useCallback(
    (text) => {
      const t = text.trim();
      if (!t) return 0;
      const data = JSON.stringify({ type: 'chat', text: t, ts: Date.now() });
      const all = [...peersRef.current.values()];
      let sent = 0;
      for (const e of all) {
        if (e.dataChannel?.readyState === 'open') {
          e.dataChannel.send(data);
          sent++;
        }
      }
      if (sent) addMessage('me', t, { sentTo: sent, of: all.length });
      log(`chat sent over ${sent}/${all.length} data channel(s)`, sent === all.length ? 'info' : 'warn');
      return sent;
    },
    [addMessage, log],
  );

  return { status, room, error, peers, messages, join, leave, sendChat, broadcast, replaceTrack, getAudioLevels };
}
