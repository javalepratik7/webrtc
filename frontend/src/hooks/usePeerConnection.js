// One RTCPeerConnection, negotiated over the step 8 signaling channel.
//
//   const peer = usePeerConnection({ send, getLocalStream });
//   peer.startAsCaller(peerKey)   → local tracks + data channel "chat" + offer   (the user already in the room)
//   peer.handleSignal(msg)        → offer / answer / candidate                   (call from onSignal)
//   peer.replaceTrack(track)      → swap what a sender sends (camera switch), NO renegotiation
//   peer.getStats()               → summary for StatsOverlay (bitrates need the previous sample, kept here)
//   peer.close(reason)
//   peer.state        { connection, iceConnection, signaling, iceGathering } | null
//   peer.remoteStream MediaStream from ontrack | null
//   peer.channel      RTCDataChannel | null
//   peer.closeReason  why the last connection ended ('peer left', 'connection failed'…)
//
// Media order matters (JSEP):
//   caller: addTrack BEFORE createOffer, so the offer has m=audio / m=video sendrecv
//   callee: setRemoteDescription(offer) FIRST, then addTrack. addTrack then REUSES the
//           transceivers the offer created. Adding tracks before setRemoteDescription
//           would create separate transceivers that the answer can't include, and the
//           callee's camera would never be sent.
//
// Trickle ICE out; remote candidates that arrive before setRemoteDescription are queued.
// StrictMode safety: a connection is only ever created from an event handler
// (peer-joined / incoming offer), never in an effect, so StrictMode's double
// effects can't create a second one. createPc() also closes any previous one.
import { useCallback, useEffect, useRef, useState } from 'react';
import useLog from './useLog.js';
import { ICE_CONFIG, collectStats } from '../services/webrtc.js';

const KINDS = ['audio', 'video'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describeCandidate = (c) => {
  const p = c.candidate.split(' ');
  return `${p[7]} ${p[2]} ${p[4]}:${p[5]}`;
};

export default function usePeerConnection({ send, getLocalStream = () => null, slowRemoteMs = 0 }) {
  const { log } = useLog();
  const [state, setState] = useState(null); // null = no connection
  const [role, setRole] = useState(null); // 'caller' | 'callee'
  const [channel, setChannel] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [peerKey, setPeerKey] = useState(null);
  const [closeReason, setCloseReason] = useState(null);
  const [counts, setCounts] = useState({ sent: 0, received: 0, queued: 0 });

  const pcRef = useRef(null);
  const peerKeyRef = useRef(null);
  const pendingRef = useRef([]); // remote candidates waiting for setRemoteDescription
  const genRef = useRef(0); // bumped on create/close: async work for an old pc stops
  const prevStatsRef = useRef(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const localRef = useRef(getLocalStream);
  localRef.current = getLocalStream;
  const slowRef = useRef(slowRemoteMs);
  slowRef.current = slowRemoteMs;

  const bump = (key) => setCounts((c) => ({ ...c, [key]: c[key] + 1 }));

  const close = useCallback(
    (reason) => {
      genRef.current++;
      const pc = pcRef.current;
      pcRef.current = null;
      pendingRef.current = [];
      peerKeyRef.current = null;
      prevStatsRef.current = null;
      if (pc) {
        // close() stops sending/receiving and releases sockets. It does NOT stop the
        // local camera tracks (they belong to useLocalMedia; the page decides).
        pc.close();
        log(`Peer connection closed${reason ? ` (${reason})` : ''}`, 'warn');
        setCloseReason(reason ?? null);
      }
      setState(null);
      setRole(null);
      setChannel(null);
      setRemoteStream(null);
      setPeerKey(null);
    },
    [log],
  );

  const createPc = useCallback(
    (newRole, key) => {
      if (pcRef.current) close('replaced by a new connection');
      const gen = ++genRef.current;
      const pc = new RTCPeerConnection(ICE_CONFIG);
      pcRef.current = pc;
      peerKeyRef.current = key;
      pendingRef.current = [];
      setRole(newRole);
      setPeerKey(key);
      setCloseReason(null);
      setCounts({ sent: 0, received: 0, queued: 0 });
      const mine = () => gen === genRef.current;

      const update = () => {
        if (!mine()) return;
        setState({
          connection: pc.connectionState,
          iceConnection: pc.iceConnectionState,
          signaling: pc.signalingState,
          iceGathering: pc.iceGatheringState,
        });
      };
      update();
      pc.onsignalingstatechange = update;
      pc.onicegatheringstatechange = update;
      pc.oniceconnectionstatechange = () => {
        log(`iceConnectionState → ${pc.iceConnectionState}`);
        update();
      };
      pc.onconnectionstatechange = () => {
        if (!mine()) return;
        const s = pc.connectionState;
        log(`connectionState → ${s}`, s === 'connected' ? 'success' : s === 'failed' ? 'error' : 'info');
        update();
        // 'disconnected' is often temporary (Wi-Fi hiccup): wait. 'failed' is final here.
        if (s === 'failed') close('connection failed');
      };

      // Trickle ICE: ship every candidate immediately.
      pc.onicecandidate = (e) => {
        if (!mine() || !e.candidate || !e.candidate.candidate) return; // null = gathering done
        sendRef.current('candidate', e.candidate.toJSON());
        bump('sent');
        log(`→ candidate ${describeCandidate(e.candidate)}`);
      };

      // Remote media: fires once per track (audio, video). Both share the stream
      // the sender named in addTrack(track, stream) (a=msid in the SDP).
      let fallbackStream = null;
      pc.ontrack = (e) => {
        if (!mine()) return;
        log(`ontrack: remote ${e.track.kind} (mid ${e.transceiver.mid})`, 'success');
        if (e.streams[0]) {
          setRemoteStream(e.streams[0]);
        } else {
          fallbackStream ??= new MediaStream();
          fallbackStream.addTrack(e.track);
          setRemoteStream(fallbackStream);
        }
      };

      // Callee: the caller's "chat" channel arrives through the connection.
      pc.ondatachannel = (e) => {
        if (!mine()) return;
        log(`ondatachannel "${e.channel.label}"`, 'success');
        setChannel(e.channel);
      };
      return { pc, mine };
    },
    [close, log],
  );

  // setRemoteDescription, then add every candidate that arrived too early.
  const applyRemoteDescription = useCallback(
    async (pc, mine, description) => {
      if (slowRef.current) {
        log(`(slow callee simulation: waiting ${slowRef.current} ms before setRemoteDescription)`, 'warn');
        await sleep(slowRef.current);
      }
      if (!mine()) return false;
      await pc.setRemoteDescription(description);
      if (!mine()) return false;
      const queued = pendingRef.current;
      pendingRef.current = [];
      if (queued.length) {
        for (const c of queued) await pc.addIceCandidate(c);
        log(`Added ${queued.length} queued candidate(s) after setRemoteDescription`, 'success');
      }
      return true;
    },
    [log],
  );

  // Attach local tracks. Caller: missing kinds become recvonly transceivers, so we
  // can still RECEIVE video even without a camera.
  const addLocalMedia = (pc, asCaller) => {
    const stream = localRef.current();
    for (const kind of KINDS) {
      const track = stream?.getTracks().find((t) => t.kind === kind);
      if (track) {
        pc.addTrack(track, stream);
      } else if (asCaller) {
        pc.addTransceiver(kind, { direction: 'recvonly' });
        log(`No local ${kind}: offering to receive only`, 'warn');
      }
    }
  };

  const startAsCaller = useCallback(
    async (key) => {
      const { pc, mine } = createPc('caller', key);
      log('Peer joined → I am the CALLER: adding tracks + data channel "chat", creating the offer', 'success');
      addLocalMedia(pc, true);
      setChannel(pc.createDataChannel('chat')); // before createOffer → m=application
      try {
        const offer = await pc.createOffer();
        if (!mine()) return;
        await pc.setLocalDescription(offer);
        if (!mine()) return;
        sendRef.current('offer', pc.localDescription.toJSON());
        log(`→ offer (${pc.localDescription.sdp.length} chars)`);
      } catch (err) {
        log(`Creating the offer failed: ${err.message}`, 'error');
        close('error');
      }
    },
    [createPc, close, log], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleSignal = useCallback(
    async ({ type, payload, fromClientId }) => {
      try {
        if (type === 'offer') {
          log(`← offer (${payload.sdp.length} chars) → I am the CALLEE`, 'success');
          const { pc, mine } = createPc('callee', fromClientId);
          if (!(await applyRemoteDescription(pc, mine, payload))) return;
          addLocalMedia(pc, false); // AFTER setRemoteDescription: reuse the offer's transceivers
          const answer = await pc.createAnswer();
          if (!mine()) return;
          await pc.setLocalDescription(answer);
          if (!mine()) return;
          sendRef.current('answer', pc.localDescription.toJSON());
          log(`→ answer (${pc.localDescription.sdp.length} chars)`);
        } else if (type === 'answer') {
          const pc = pcRef.current;
          if (!pc || pc.signalingState !== 'have-local-offer') {
            log(`← answer ignored (signalingState: ${pc?.signalingState ?? 'no connection'})`, 'warn');
            return;
          }
          log(`← answer (${payload.sdp.length} chars)`, 'success');
          const gen = genRef.current;
          await applyRemoteDescription(pc, () => gen === genRef.current, payload);
        } else if (type === 'candidate') {
          bump('received');
          const pc = pcRef.current;
          // THE classic bug: addIceCandidate before the remote description is set
          // throws InvalidStateError (or the candidate is lost). Queue instead.
          if (!pc || !pc.remoteDescription) {
            pendingRef.current.push(payload);
            bump('queued');
            log(`← candidate ${describeCandidate(payload)} QUEUED (no remote description yet)`, 'warn');
            return;
          }
          await pc.addIceCandidate(payload);
          log(`← candidate ${describeCandidate(payload)}`);
        }
      } catch (err) {
        log(`Handling "${type}" failed: ${err.name}: ${err.message}`, 'error');
      }
    },
    [createPc, applyRemoteDescription, log], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Camera switch: the sender keeps its slot (transceiver, m-line, SSRC, codec) and
  // just starts encoding frames from another source. Nothing in the SDP changes, so
  // no new offer/answer. (Only possible when the new track fits the negotiated m-section.)
  const replaceTrack = useCallback(
    async (track) => {
      const pc = pcRef.current;
      if (!pc || !track) return false;
      const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === track.kind);
      if (!transceiver) return false;
      await transceiver.sender.replaceTrack(track);
      log(`sender.replaceTrack(${track.kind}: "${track.label}"): no renegotiation, signalingState still ${pc.signalingState}`, 'success');
      return true;
    },
    [log],
  );

  const getStats = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return null;
    // collectStats reads outbound-rtp from the 1st pc and inbound-rtp from the 2nd:
    // in a real call both directions live on the same pc.
    const summary = await collectStats(pc, pc, prevStatsRef.current);
    prevStatsRef.current = summary;
    return summary;
  }, []);

  // Leaving the page closes the connection.
  useEffect(
    () => () => {
      genRef.current++;
      pcRef.current?.close();
      pcRef.current = null;
    },
    [],
  );

  return {
    state,
    role,
    channel,
    remoteStream,
    peerKey,
    closeReason,
    counts,
    isActive: () => Boolean(pcRef.current) && !['failed', 'closed'].includes(pcRef.current.connectionState),
    currentPeerKey: () => peerKeyRef.current,
    startAsCaller,
    handleSignal,
    replaceTrack,
    getStats,
    close,
  };
}
