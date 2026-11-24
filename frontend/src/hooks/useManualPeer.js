// One RTCPeerConnection whose signaling is done BY HAND: everything that would
// normally go through a server is turned into JSON text for you to copy/paste.
//
// Caller:  createOffer(mode)  → copy `localText` → (later) acceptAnswer(text)
// Callee:  acceptOffer(text, mode) → copy `localText`
// Trickle mode only: copy each of `localCandidates`, paste the peer's into addRemoteCandidates(text)
//
// mode: 'vanilla' = wait for ICE gathering to finish, so the SDP contains every candidate (ONE message each way)
//       'trickle' = send the SDP immediately, candidates follow one by one (MANY messages each way)
import { useCallback, useEffect, useRef, useState } from 'react';
import useLog from './useLog.js';
import { ICE_CONFIG, waitForIceGathering } from '../services/webrtc.js';

const EMPTY_STATE = { signaling: '-', iceGathering: '-', iceConnection: '-', connection: '-' };

// Accepts what the other tab copied: {"type":"offer","sdp":"v=0..."}.
// Also tolerates raw SDP text, and gives a clear message for common mix-ups.
function parseDescription(text, expectedType) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Paste the ${expectedType} first.`);
  if (trimmed.startsWith('v=0')) {
    // Raw SDP: make sure the lines end with CRLF, as SDP requires.
    return { type: expectedType, sdp: `${trimmed.split(/\r?\n/).join('\r\n')}\r\n` };
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    throw new Error('That isn’t valid JSON. Copy the whole box (the Copy button does that).');
  }
  if (Array.isArray(obj) || obj?.candidate !== undefined) {
    throw new Error('That’s an ICE candidate, not a session description. Paste it in the candidates box.');
  }
  if (!obj?.type || typeof obj.sdp !== 'string') throw new Error('Expected an object with "type" and "sdp".');
  if (obj.type !== expectedType) {
    throw new Error(`That’s an ${obj.type}, but this side expects an ${expectedType}. Did you paste into the wrong tab?`);
  }
  return obj;
}

// Accepts one candidate object, an array of them, or one JSON object per line.
function parseCandidates(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Paste one or more candidates first.');
  let items;
  try {
    const parsed = JSON.parse(trimmed);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      items = trimmed
        .split(/\n+/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch {
      throw new Error('That isn’t valid JSON.');
    }
  }
  for (const c of items) {
    if (c?.sdp) throw new Error('That’s a session description (offer/answer), not a candidate. Paste it in the other box.');
    if (typeof c?.candidate !== 'string') throw new Error('Each candidate needs a "candidate" field.');
  }
  return items;
}

export default function useManualPeer() {
  const { log } = useLog();
  const [pcState, setPcState] = useState(EMPTY_STATE);
  const [channel, setChannel] = useState(null);
  const [localText, setLocalText] = useState(''); // offer/answer JSON to copy
  const [gathering, setGathering] = useState(false); // waiting for vanilla gathering
  const [localCandidates, setLocalCandidates] = useState([]); // JSON strings, trickle mode
  const [gatheringDone, setGatheringDone] = useState(false);
  const [remoteCandidates, setRemoteCandidates] = useState(0);
  const [remoteApplied, setRemoteApplied] = useState(false);
  const [error, setError] = useState(null);

  const pcRef = useRef(null);
  const channelRef = useRef(null); // current data channel, for the 'failed' handler
  const modeRef = useRef('vanilla');
  const setChannelBoth = useCallback((dc) => {
    channelRef.current = dc;
    setChannel(dc);
  }, []);

  const reset = useCallback(() => {
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.close();
      log('Peer connection closed');
    }
    setPcState(EMPTY_STATE);
    setChannelBoth(null);
    setLocalText('');
    setGathering(false);
    setLocalCandidates([]);
    setGatheringDone(false);
    setRemoteCandidates(0);
    setRemoteApplied(false);
    setError(null);
  }, [log, setChannelBoth]);

  const createPc = useCallback(
    (mode) => {
      reset();
      modeRef.current = mode;
      const pc = new RTCPeerConnection(ICE_CONFIG);
      pcRef.current = pc;
      const mine = () => pcRef.current === pc; // ignore events from a peer we already reset

      const update = () => {
        if (!mine()) return;
        setPcState({
          signaling: pc.signalingState,
          iceGathering: pc.iceGatheringState,
          iceConnection: pc.iceConnectionState,
          connection: pc.connectionState,
        });
      };
      update();
      pc.onsignalingstatechange = () => {
        log(`signalingState → ${pc.signalingState}`);
        update();
      };
      pc.onicegatheringstatechange = () => {
        log(`iceGatheringState → ${pc.iceGatheringState}`);
        update();
      };
      pc.oniceconnectionstatechange = () => {
        log(`iceConnectionState → ${pc.iceConnectionState}`);
        update();
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        log(`connectionState → ${s}`, s === 'connected' ? 'success' : s === 'failed' ? 'error' : 'info');
        update();
        // Observed in Chrome: when the peer vanishes (tab closed), the connection goes
        // disconnected (~5 s) → failed (~15 s), but the data channel still says "open".
        // Close it ourselves so the chat stops offering a dead channel.
        if (s === 'failed' && channelRef.current?.readyState === 'open') {
          log('Connection failed: closing the data channel', 'warn');
          channelRef.current.close();
        }
      };
      pc.onicecandidate = (e) => {
        if (!mine()) return;
        if (!e.candidate) {
          setGatheringDone(true);
          return;
        }
        if (!e.candidate.candidate) return; // per-m-section end-of-candidates marker
        // toJSON() → { candidate, sdpMid, sdpMLineIndex, usernameFragment }: exactly what addIceCandidate wants.
        setLocalCandidates((prev) => [...prev, JSON.stringify(e.candidate)]);
      };
      // Callee: the caller's data channel arrives through the connection.
      pc.ondatachannel = (e) => {
        if (!mine()) return;
        log(`ondatachannel "${e.channel.label}"`, 'success');
        setChannelBoth(e.channel);
      };
      return pc;
    },
    [log, reset, setChannelBoth],
  );

  // After setLocalDescription: produce the text the user has to carry to the other tab.
  const publishLocal = useCallback(
    async (pc) => {
      if (modeRef.current === 'vanilla') {
        setGathering(true);
        log('Non-trickle: waiting for ICE gathering to complete (max 3 s)…');
        const completed = await waitForIceGathering(pc, 3000);
        if (pcRef.current !== pc) return;
        setGathering(false);
        if (!completed) {
          log('Gathering not complete after 3 s (a STUN request is still timing out); sending the candidates we have', 'warn');
        }
      }
      // Vanilla: localDescription now includes all a=candidate lines.
      // Trickle: it has none yet (they'll come through onicecandidate).
      const json = JSON.stringify(pc.localDescription);
      setLocalText(json);
      const n = (pc.localDescription.sdp.match(/^a=candidate:/gm) || []).length;
      log(`${pc.localDescription.type} ready to copy: ${json.length} chars, ${n} candidate(s) inside`, 'success');
    },
    [log],
  );

  const run = useCallback(async (fn) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      const hint =
        err.name === 'InvalidStateError' && /candidate/i.test(err.message)
          ? ' Candidates can only be added AFTER the remote description (offer/answer) is applied. A real signaling app queues them until then.'
          : '';
      setError(`${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}${hint}`);
    }
  }, []);

  const createOffer = useCallback(
    (mode) =>
      run(async () => {
        const pc = createPc(mode);
        // Must exist BEFORE createOffer, so the offer contains an m=application section.
        const dc = pc.createDataChannel('chat');
        setChannelBoth(dc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await publishLocal(pc);
      }),
    [run, createPc, publishLocal, setChannelBoth],
  );

  const acceptOffer = useCallback(
    (text, mode) =>
      run(async () => {
        const offer = parseDescription(text, 'offer'); // validate BEFORE creating anything
        const pc = createPc(mode);
        await pc.setRemoteDescription(offer);
        setRemoteApplied(true);
        log('Offer applied (setRemoteDescription)', 'success');
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await publishLocal(pc);
      }),
    [run, createPc, publishLocal, log],
  );

  const acceptAnswer = useCallback(
    (text) =>
      run(async () => {
        const pc = pcRef.current;
        if (!pc) throw new Error('Create the offer first.');
        const answer = parseDescription(text, 'answer');
        if (pc.signalingState !== 'have-local-offer') {
          throw new Error(`Can't apply an answer in signalingState "${pc.signalingState}" (already applied?).`);
        }
        await pc.setRemoteDescription(answer);
        setRemoteApplied(true);
        log('Answer applied (setRemoteDescription). ICE checks can start', 'success');
      }),
    [run, log],
  );

  const addRemoteCandidates = useCallback(
    (text) =>
      run(async () => {
        const pc = pcRef.current;
        if (!pc) throw new Error('Start first.');
        const items = parseCandidates(text);
        for (const c of items) {
          await pc.addIceCandidate(c);
          setRemoteCandidates((n) => n + 1);
          log(`addIceCandidate: ${c.candidate.split(' ').slice(4, 8).join(' ')}`, 'success');
        }
      }),
    [run, log],
  );

  // Leaving the page closes the connection.
  useEffect(
    () => () => {
      pcRef.current?.close();
      pcRef.current = null;
    },
    [],
  );

  return {
    pcState,
    channel,
    localText,
    gathering,
    localCandidates,
    gatheringDone,
    remoteCandidates,
    remoteApplied,
    error,
    started: Boolean(localText) || gathering || pcState.signaling !== '-',
    createOffer,
    acceptOffer,
    acceptAnswer,
    addRemoteCandidates,
    reset,
  };
}
