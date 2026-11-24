// Step 10: a complete 1:1 peer-to-peer video call.
//
//   Join → getUserMedia (camera + mic) → join-room over Socket.IO
//   2nd person joins → the 1st becomes the caller → offer/answer/candidates via signaling
//   → ICE + DTLS → remote tracks (ontrack) in the big tile, chat over the data channel
//
// Reuses: useLocalMedia (camera/mic), useSignaling (rooms + relay),
// usePeerConnection (RTCPeerConnection), useChat/ChatBox, VideoTile.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSignaling from '../hooks/useSignaling.js';
import usePeerConnection from '../hooks/usePeerConnection.js';
import useLocalMedia from '../hooks/useLocalMedia.js';
import useDevices from '../hooks/useDevices.js';
import useChat from '../hooks/useChat.js';
import useLog from '../hooks/useLog.js';
import VideoTile from '../components/VideoTile.jsx';
import ChatBox from '../components/ChatBox.jsx';
import CallControls from '../components/CallControls.jsx';
import StatsOverlay from '../components/StatsOverlay.jsx';
import { getNetwork } from '../services/api.js';

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const PEER_SIGNALS = new Set(['offer', 'answer', 'candidate']);

// Last used room / name are remembered, so coming back via the navbar (no ?room=) rejoins the same room.
function load(key, fallback) {
  try {
    return localStorage.getItem(`webrtc-lab:${key}`) || fallback;
  } catch {
    return fallback;
  }
}

function loadName() {
  try {
    return localStorage.getItem('webrtc-lab:name') || (isMobile ? 'Phone' : 'Laptop');
  } catch {
    return isMobile ? 'Phone' : 'Laptop';
  }
}

export default function Room() {
  const { log } = useLog();
  const [params, setParams] = useSearchParams();
  const [roomInput, setRoomInput] = useState(() => params.get('room') || load('room', 'test-room'));
  const [name, setName] = useState(loadName);
  const [joining, setJoining] = useState(false);
  const [slowCallee, setSlowCallee] = useState(false);
  const [statsOn, setStatsOn] = useState(false);
  const [endReason, setEndReason] = useState(null); // 'peer left' | 'peer hung up' | null
  const [remoteMedia, setRemoteMedia] = useState({ audio: true, video: true });
  const [lanHosts, setLanHosts] = useState([]);

  const media = useLocalMedia();
  const devices = useDevices(media.stream);
  // The stream the peer connection should send. A ref, because offers/answers are
  // created inside socket callbacks that must see the CURRENT stream.
  const localStreamRef = useRef(null);

  const sig = useSignaling({
    onSignal: (msg) => {
      const { from, type, payload } = msg;
      if (PEER_SIGNALS.has(type)) {
        if (type === 'offer') setEndReason(null);
        peer.handleSignal(msg);
      } else if (type === 'bye') {
        log('← bye: the peer hung up', 'warn');
        peer.close('peer hung up');
        setEndReason('peer hung up');
      } else if (type === 'ping') {
        sig.send('pong', { sentAt: payload?.sentAt, from: name });
      } else {
        log(`signal "${type}" from ${from.slice(0, 6)} (not handled)`);
      }
    },
    // The second person arrived → the one already here (me) calls.
    onPeerJoined: (p) => {
      if (peer.isActive() && peer.currentPeerKey() === p.clientId) {
        log(`${p.name} re-joined after a signaling reconnect: keeping the existing call`, 'success');
        return;
      }
      setEndReason(null);
      peer.startAsCaller(p.clientId);
    },
    onPeerLeft: () => {
      peer.close('peer left');
      // A hang-up sends 'bye' and then leaves: keep the more precise "peer hung up".
      setEndReason((r) => (r === 'peer hung up' ? r : 'peer left'));
      setRemoteMedia({ audio: true, video: true });
    },
  });

  const peer = usePeerConnection({
    send: sig.send,
    getLocalStream: () => localStreamRef.current,
    slowRemoteMs: slowCallee ? 1000 : 0,
  });
  const connection = peer.state?.connection ?? null;

  const chat = useChat(peer.channel, connection ?? 'closed', {
    // App messages over the data channel: the peer tells us when they mute / turn the camera off.
    onData: (msg) => {
      if (msg.type === 'media-state') setRemoteMedia({ audio: msg.audio, video: msg.video });
    },
  });

  // ---- local track state ----
  const liveTrack = (kind) => media.tracks.find((t) => t.kind === kind && t.readyState === 'live');
  const micSnap = liveTrack('audio');
  const camSnap = liveTrack('video');
  const micOn = micSnap?.enabled ?? false;
  const camOn = camSnap?.enabled ?? false;
  const cameras = devices.cameras.filter((c) => c.deviceId);

  // Tell the peer our mic/camera state whenever it changes or the channel opens.
  const { sendJson } = chat;
  useEffect(() => {
    if (chat.state === 'open') sendJson({ type: 'media-state', audio: micOn, video: camOn });
  }, [chat.state, micOn, camOn, sendJson]);

  useEffect(() => {
    try {
      localStorage.setItem('webrtc-lab:name', name);
    } catch {
      // storage unavailable: fine
    }
  }, [name]);

  useEffect(() => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
    getNetwork()
      .then(({ addresses }) => setLanHosts(addresses.map((a) => `${a.address}:${window.location.port}`)))
      .catch(() => {});
  }, []);

  // ---- actions ----
  const join = async (e) => {
    e.preventDefault();
    setJoining(true);
    setEndReason(null);
    chat.clear();
    // 1. Camera + mic FIRST, so the tracks exist before any offer/answer is created.
    const stream = await media.start({ video: true, audio: true });
    localStreamRef.current = stream;
    if (!stream) log('No camera/mic: joining anyway, I will only receive', 'warn');
    // 2. Then the room.
    const res = await sig.join(roomInput, name);
    setJoining(false);
    if (res.ok) {
      setParams({ room: res.roomId }, { replace: true });
      try {
        localStorage.setItem('webrtc-lab:room', res.roomId);
      } catch {
        // storage unavailable: fine
      }
      if (res.peers.length) log('Peer already in the room → I am the callee: waiting for their offer');
    } else {
      media.stop();
      localStreamRef.current = null;
    }
  };

  // Full cleanup: tell the peer, close the connection, release camera/mic, leave the room.
  const hangUp = useCallback(async () => {
    if (peer.isActive()) sig.send('bye');
    peer.close('hung up');
    media.stop();
    localStreamRef.current = null;
    setEndReason(null);
    setStatsOn(false);
    setRemoteMedia({ audio: true, video: true });
    await sig.leave();
    setParams({}, { replace: true });
  }, [peer, media, sig, setParams]);

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const idx = cameras.findIndex((c) => c.deviceId === camSnap?.settings.deviceId);
    const next = cameras[(idx + 1) % cameras.length];
    // 1. New camera track in the local stream (preview updates)…
    const track = await media.switchDevice('video', next.deviceId);
    // 2. …and the SAME sender starts sending it. No new offer/answer.
    if (track) await peer.replaceTrack(track);
  };

  // Tab close / reload: best-effort goodbye. (The socket dropping makes the server
  // send peer-left anyway; 'bye' just makes it instant and explicit.)
  const pageHideRef = useRef(null);
  pageHideRef.current = () => {
    if (peer.isActive()) sig.send('bye');
    peer.close('page closed');
    media.stop();
  };
  useEffect(() => {
    const onPageHide = () => pageHideRef.current();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);
  // Route change (unmount) is covered by the hooks' own cleanups: usePeerConnection
  // closes the pc, useLocalMedia stops the tracks, useSignaling emits leave-room.

  // ---- call status ----
  const roomPeer = sig.room?.peers[0];
  let status;
  if (connection === 'connected') status = ['connected', 'ok'];
  else if (connection === 'disconnected') status = ['reconnecting… (network hiccup)', 'warn'];
  else if (connection === 'new' || connection === 'connecting') status = ['connecting…', 'info'];
  else if (peer.closeReason === 'connection failed') status = ['connection failed', 'err'];
  else if (endReason) status = [endReason, 'warn'];
  else if (!roomPeer) status = ['waiting for peer…', 'info'];
  else status = ['connecting…', 'info'];

  const canRetry = roomPeer && !peer.state && sig.status === 'connected';
  const shareUrls = sig.room
    ? (lanHosts.length ? lanHosts : [window.location.host]).map((h) => `https://${h}/room?room=${encodeURIComponent(sig.room.id)}`)
    : [];
  const mirrored = camSnap?.settings.facingMode !== 'environment'; // don't mirror a back camera

  // ======================= lobby =======================
  if (!sig.room) {
    return (
      <div>
        <h1>Video call</h1>
        <p className="muted">Step 10: 1:1 peer-to-peer video call. Join the same room on two devices.</p>
        <div className="card lobby">
          <form className="join-form" onSubmit={join}>
            <label>
              <span className="muted small">Room</span>
              <input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} maxLength={40} required />
            </label>
            <label>
              <span className="muted small">Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} />
            </label>
            <button className="primary" type="submit" disabled={joining || sig.status !== 'connected'}>
              {joining ? 'Starting camera…' : 'Join call'}
            </button>
          </form>
          <p className="muted small">
            Joining turns on your camera and microphone. Signaling server:{' '}
            <span className={`badge badge-${sig.status === 'connected' ? 'online' : 'offline'}`}>{sig.status}</span>
          </p>
          <label className="checkbox small" title="Delays setRemoteDescription by 1 s on this device, so early candidates must be queued">
            <input type="checkbox" checked={slowCallee} onChange={(e) => setSlowCallee(e.target.checked)} /> Simulate slow
            setRemoteDescription (1 s) to watch the candidate queue
          </label>
          {(media.error || sig.error) && (
            <div className="alert" role="alert" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              {media.error ? `${media.error.name}: ${media.error.hint}` : sig.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ======================= call =======================
  const remotePlaceholder = !peer.remoteStream
    ? status[0]
    : !remoteMedia.video
      ? `📷 ${roomPeer?.name ?? 'Peer'} turned the camera off`
      : null;

  return (
    <div className="call-layout">
      <div className="call-main">
        <div className="call-stage">
          <VideoTile stream={peer.remoteStream} className="remote" placeholder={remotePlaceholder} label={roomPeer?.name}>
            <span className={`call-status call-status-${status[1]}`}>{status[0]}</span>
            {peer.remoteStream && !remoteMedia.audio && <span className="remote-muted">🔇 muted</span>}
            {statsOn && peer.state && <StatsOverlay getStats={peer.getStats} />}
          </VideoTile>
          <VideoTile
            stream={media.stream}
            className="local-pip"
            muted
            mirrored={mirrored}
            label={`You${micOn ? '' : ' 🔇'}`}
            placeholder={!media.stream ? 'No camera' : !camOn ? 'Camera off' : null}
          />
        </div>

        <CallControls
          micOn={micOn}
          camOn={camOn}
          hasMic={Boolean(micSnap)}
          hasCam={Boolean(camSnap)}
          canSwitchCamera={cameras.length > 1}
          statsOn={statsOn}
          onToggleMic={() => media.toggleEnabled('audio')}
          onToggleCam={() => media.toggleEnabled('video')}
          onSwitchCamera={switchCamera}
          onToggleStats={() => setStatsOn((v) => !v)}
          onHangUp={hangUp}
        />

        {canRetry && (
          <div className="toolbar" style={{ justifyContent: 'center', marginTop: '0.75rem' }}>
            <button className="primary" onClick={() => peer.startAsCaller(roomPeer.clientId)}>
              Call {roomPeer.name} again
            </button>
          </div>
        )}
        {!roomPeer && (
          <p className="muted small call-share">
            Waiting for someone. Open this on the other device:{' '}
            {shareUrls.map((u) => (
              <code key={u} className="addr">
                {u}
              </code>
            ))}
          </p>
        )}
      </div>

      <aside className="call-side">
        <div className="card">
          <h2>
            Room “{sig.room.id}” <span className="muted small">({1 + sig.room.peers.length}/2)</span>
          </h2>
          <ul className="member-list">
            <li>
              <span className="dot dot-on" /> {sig.room.you.name} <span className="muted small">(you)</span>
            </li>
            {roomPeer && (
              <li>
                <span className={`dot ${connection === 'connected' ? 'dot-on' : ''}`} /> {roomPeer.name}
                {peer.role && <span className="muted small"> · I am the {peer.role}</span>}
              </li>
            )}
          </ul>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Signaling: <span className={`badge badge-${sig.status === 'connected' ? 'online' : 'offline'}`}>{sig.status}</span>
            {sig.status !== 'connected' && connection === 'connected' && ' (the call is peer-to-peer and keeps going)'}
          </p>
        </div>
        <ChatBox
          messages={chat.messages}
          state={chat.state}
          onSend={chat.send}
          onTyping={chat.notifyTyping}
          peerTyping={chat.peerTyping}
          peerName={roomPeer?.name ?? 'Peer'}
        />
      </aside>
    </div>
  );
}
