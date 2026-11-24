// One RTCPeerConnection, negotiated over the step 8 signaling channel.
//
//   const peer = usePeerConnection({ send });   // send(type, payload) from useSignaling
//   peer.startAsCaller(peerKey)   → data channel "chat" + offer        (the user already in the room)
//   peer.handleSignal(msg)        → offer / answer / candidate         (call from onSignal)
//   peer.close(reason)
//   peer.state      { connection, iceConnection, signaling, iceGathering }
//   peer.channel    RTCDataChannel | null
//   peer.pair       selected candidate pair from getStats (local/remote type, RTT)
//   peer.peerKey    clientId of the tab we're connected to
//
// Trickle ICE: every candidate is sent as soon as onicecandidate fires.
// Remote candidates that arrive before setRemoteDescription has finished are
// QUEUED and added right after it (see applyRemoteDescription).
//
// StrictMode safety: a connection is only ever created from an event handler
// (peer-joined / incoming offer), never in an effect, so StrictMode's double
// effects can't create a second one. createPc() also closes any previous one.
import { useCallback, useEffect, useRef, useState } from 'react';
import useLog from './useLog.js';
import { ICE_CONFIG, getSelectedCandidatePair } from '../services/webrtc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describeCandidate = (c) => {
  const p = c.candidate.split(' ');
  return `${p[7]} ${p[2]} ${p[4]}:${p[5]}`;
};

export default function usePeerConnection({ send, slowRemoteMs = 0 }) {
  const { log } = useLog();
  const [state, setState] = useState(null); // null = no connection
  const [role, setRole] = useState(null); // 'caller' | 'callee'
  const [channel, setChannel] = useState(null);
  const [pair, setPair] = useState(null);
  const [peerKey, setPeerKey] = useState(null);
  const [counts, setCounts] = useState({ sent: 0, received: 0, queued: 0 });

  const pcRef = useRef(null);
  const peerKeyRef = useRef(null);
  const pendingRef = useRef([]); // remote candidates waiting for setRemoteDescription
  const genRef = useRef(0); // bumped on create/close: async work for an old pc stops
  const sendRef = useRef(send);
  sendRef.current = send;
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
      if (pc) {
        pc.close();
        log(`Peer connection closed${reason ? ` (${reason})` : ''}`, 'warn');
      }
      setState(null);
      setRole(null);
      setChannel(null);
      setPair(null);
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
        if (s === 'failed') close('connection failed');
      };

      // Trickle ICE: ship every candidate immediately.
      pc.onicecandidate = (e) => {
        if (!mine() || !e.candidate || !e.candidate.candidate) return; // null = gathering done
        sendRef.current('candidate', e.candidate.toJSON());
        bump('sent');
        log(`→ candidate ${describeCandidate(e.candidate)}`);
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
        // Teaching switch: simulates real-world delays before setRemoteDescription
        // (e.g. awaiting getUserMedia on the callee in step 10).
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

  const startAsCaller = useCallback(
    async (key) => {
      const { pc, mine } = createPc('caller', key);
      log('Peer joined → I am the CALLER: creating data channel "chat" + offer', 'success');
      // Must exist before createOffer so the offer contains m=application.
      setChannel(pc.createDataChannel('chat'));
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
    [createPc, close, log],
  );

  const handleSignal = useCallback(
    async ({ type, payload, fromClientId }) => {
      try {
        if (type === 'offer') {
          log(`← offer (${payload.sdp.length} chars) → I am the CALLEE`, 'success');
          const { pc, mine } = createPc('callee', fromClientId);
          if (!(await applyRemoteDescription(pc, mine, payload))) return;
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
    [createPc, applyRemoteDescription, log],
  );

  // Selected candidate pair, every 2 s while connected.
  const connected = state?.connection === 'connected';
  useEffect(() => {
    if (!connected) return undefined;
    let cancelled = false;
    const poll = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      const p = await getSelectedCandidatePair(pc);
      if (!cancelled) setPair(p);
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected]);

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
    pair,
    peerKey,
    counts,
    isActive: () => Boolean(pcRef.current) && !['failed', 'closed'].includes(pcRef.current.connectionState),
    currentPeerKey: () => peerKeyRef.current,
    startAsCaller,
    handleSignal,
    close,
  };
}
