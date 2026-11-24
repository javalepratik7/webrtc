// Two RTCPeerConnections in the same tab, A (caller) and B (callee), wired to
// each other directly. The "signaling channel" is just a function call.
//
//   A.createOffer → A.setLocalDescription → B.setRemoteDescription
//   B.createAnswer → B.setLocalDescription → A.setRemoteDescription
//   A.onicecandidate → B.addIceCandidate     (and vice versa)       ← trickle ICE
//
// Non-trickle ("vanilla") mode instead waits until each side has gathered ALL
// candidates and sends localDescription, which then contains them as a=candidate lines.
// Useful here: in a loopback ICE connects in ~60 ms, and Chrome ends gathering
// once connected, usually before the STUN reply (srflx) has arrived.
//
// Exposes everything the Connection Inspector shows: SDPs (as created and after
// ICE gathering), every candidate, the four state machines of each peer, streams, stats.
import { useCallback, useEffect, useRef, useState } from 'react';
import useLog from './useLog.js';
import { ICE_CONFIG, NO_STUN_CONFIG, collectStats, waitForIceGathering } from '../services/webrtc.js';

const EMPTY_STATES = {
  A: { signaling: '-', iceGathering: '-', iceConnection: '-', connection: '-' },
  B: { signaling: '-', iceGathering: '-', iceConnection: '-', connection: '-' },
};
const EMPTY_SDP = { offer: null, offerFinal: null, answer: null, answerFinal: null };

let nextCandidateId = 1;

// pc.close() fires no state events, so mirror what the properties now say.
const closedState = (st) =>
  st.connection === '-' ? st : { ...st, signaling: 'closed', iceConnection: 'closed', connection: 'closed' };

export default function useLoopback() {
  const { log } = useLog();
  const [states, setStates] = useState(EMPTY_STATES);
  const [sdp, setSdp] = useState(EMPTY_SDP);
  const [candidates, setCandidates] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [label, setLabel] = useState(''); // e.g. "audio + video + data", for comparisons

  const ref = useRef({ pcA: null, pcB: null, stream: null });
  // Bumped on every connect/close: events from an old connection are ignored.
  const genRef = useRef(0);
  const prevStatsRef = useRef(null);

  const close = useCallback(() => {
    genRef.current++;
    const { pcA, pcB, stream } = ref.current;
    if (pcA || pcB) log('Closing both peer connections');
    pcA?.close(); // close() does NOT fire connectionstatechange, so we reset state ourselves
    pcB?.close();
    stream?.getTracks().forEach((t) => t.stop());
    ref.current = { pcA: null, pcB: null, stream: null };
    prevStatsRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setRunning(false);
    setStates((s) => ({
      A: closedState(s.A),
      B: closedState(s.B),
    }));
  }, [log]);

  const connect = useCallback(
    async ({ audio, video, data, useStun, trickle = true }) => {
      close();
      const gen = ++genRef.current;
      const stale = () => gen !== genRef.current;
      const name = [audio && 'audio', video && 'video', data && 'data'].filter(Boolean).join(' + ');
      setLabel(`${name}${useStun ? '' : ', no STUN'}${trickle ? '' : ', non-trickle'}`);
      setSdp(EMPTY_SDP);
      setCandidates([]);
      setStates(EMPTY_STATES);
      setError(null);
      setRunning(true);
      log(`--- Loopback: ${name}, ${useStun ? 'with STUN' : 'host candidates only'}, ${trickle ? 'trickle' : 'non-trickle'} ICE ---`);

      try {
        let stream = null;
        if (audio || video) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio,
            video: video ? { width: { ideal: 640 }, height: { ideal: 360 } } : false,
          });
          if (stale()) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          setLocalStream(stream);
        }

        const config = useStun ? ICE_CONFIG : NO_STUN_CONFIG;
        const pcA = new RTCPeerConnection(config);
        const pcB = new RTCPeerConnection(config);
        ref.current = { pcA, pcB, stream };

        const wire = (pc, side, other) => {
          const update = () => {
            if (stale()) return;
            setStates((s) => ({
              ...s,
              [side]: {
                signaling: pc.signalingState,
                iceGathering: pc.iceGatheringState,
                iceConnection: pc.iceConnectionState,
                connection: pc.connectionState,
              },
            }));
          };
          update();

          pc.onicecandidate = (e) => {
            if (stale()) return;
            if (!e.candidate) {
              log(`${side}: ICE gathering finished (null candidate)`);
              return;
            }
            // An empty candidate string is the per-m-section "end-of-candidates" marker.
            if (e.candidate.candidate) {
              const { candidate, sdpMid, sdpMLineIndex } = e.candidate;
              setCandidates((prev) => [...prev, { id: nextCandidateId++, side, candidate, sdpMid, sdpMLineIndex }]);
            }
            // The "signaling channel": hand it straight to the other peer.
            // (Non-trickle: don't. The candidates travel inside the final SDP instead.)
            if (trickle) {
              other.addIceCandidate(e.candidate).catch((err) => log(`${side}→ addIceCandidate failed: ${err.message}`, 'error'));
            }
          };
          pc.onicecandidateerror = (e) => {
            // Typically: STUN server unreachable (offline, firewall). Not fatal, host candidates still work.
            if (!stale()) log(`${side}: ICE candidate error ${e.errorCode} ${e.errorText} (${e.url})`, 'warn');
          };
          pc.onsignalingstatechange = () => {
            log(`${side}: signalingState → ${pc.signalingState}`);
            update();
          };
          pc.onicegatheringstatechange = () => {
            log(`${side}: iceGatheringState → ${pc.iceGatheringState}`);
            update();
            if (pc.iceGatheringState === 'complete' && !stale()) {
              // localDescription now also contains every gathered a=candidate line.
              const key = side === 'A' ? 'offerFinal' : 'answerFinal';
              setSdp((s) => ({ ...s, [key]: pc.localDescription?.sdp ?? null }));
            }
          };
          pc.oniceconnectionstatechange = () => {
            log(`${side}: iceConnectionState → ${pc.iceConnectionState}`);
            update();
          };
          pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            log(`${side}: connectionState → ${st}`, st === 'connected' ? 'success' : st === 'failed' ? 'error' : 'info');
            update();
          };
        };
        wire(pcA, 'A', pcB);
        wire(pcB, 'B', pcA);

        // B receives A's media.
        pcB.ontrack = (e) => {
          if (stale()) return;
          log(`B: ontrack ${e.track.kind} (mid ${e.transceiver.mid})`, 'success');
          setRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
        };

        if (stream) stream.getTracks().forEach((t) => pcA.addTrack(t, stream));

        if (data) {
          const dc = pcA.createDataChannel('inspector');
          dc.onopen = () => {
            log('A: data channel open → sending "hello from A"', 'success');
            dc.send('hello from A');
          };
          pcB.ondatachannel = (e) => {
            log(`B: ondatachannel "${e.channel.label}"`);
            e.channel.onmessage = (msg) => log(`B: received "${msg.data}"`, 'success');
          };
        }

        // ---- offer / answer ----
        const offer = await pcA.createOffer();
        if (stale()) return;
        setSdp((s) => ({ ...s, offer: offer.sdp }));
        log(`A: createOffer → ${offer.sdp.split('\r\n').length} SDP lines`);
        await pcA.setLocalDescription(offer); // starts ICE gathering on A
        if (!trickle) {
          log('A: non-trickle, waiting for ICE gathering to complete before "sending" the offer');
          await waitForIceGathering(pcA);
          if (stale()) return;
        }
        // Trickle: the offer as created (no candidates). Non-trickle: localDescription, with all candidates.
        await pcB.setRemoteDescription(trickle ? offer : pcA.localDescription);

        const answer = await pcB.createAnswer();
        if (stale()) return;
        setSdp((s) => ({ ...s, answer: answer.sdp }));
        log(`B: createAnswer → ${answer.sdp.split('\r\n').length} SDP lines`);
        await pcB.setLocalDescription(answer);
        if (!trickle) {
          await waitForIceGathering(pcB);
          if (stale()) return;
        }
        await pcA.setRemoteDescription(trickle ? answer : pcB.localDescription);
        log('Offer/answer exchange complete; ICE is checking candidate pairs');
      } catch (err) {
        if (stale()) return;
        setError(`${err.name}: ${err.message}`);
        log(`Loopback failed: ${err.name}: ${err.message}`, 'error');
        close();
      }
    },
    [close, log],
  );

  const getStats = useCallback(async () => {
    const { pcA, pcB } = ref.current;
    if (!pcA || !pcB) return null;
    const summary = await collectStats(pcA, pcB, prevStatsRef.current);
    prevStatsRef.current = summary;
    return summary;
  }, []);

  // Leaving the page closes everything (also covers StrictMode's dev double-mount).
  useEffect(
    () => () => {
      genRef.current++;
      const { pcA, pcB, stream } = ref.current;
      pcA?.close();
      pcB?.close();
      stream?.getTracks().forEach((t) => t.stop());
      ref.current = { pcA: null, pcB: null, stream: null };
    },
    [],
  );

  return { states, sdp, candidates, localStream, remoteStream, running, error, label, connect, close, getStats };
}
