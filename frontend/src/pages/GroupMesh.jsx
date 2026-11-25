// Group room as a FULL MESH.
// Step 11: chat. Step 12: + video for up to 6 people. Step 13: perfect negotiation,
// per-peer ICE recovery, survives a backend restart, screen share, per-peer stats,
// bitrate caps (see useMeshRoom + PeerStatsTable).
//
//   Join → getUserMedia ONCE (camera + mic) → group:join
//   → I offer to everyone already here (new joiner rule); they only answer
//   → every connection gets the SAME local tracks + its own "chat" data channel
//   → each peer's remote MediaStream (ontrack) → its tile in the grid
//   → mute / camera off = track.enabled + a media-state message to everyone
//   → switch camera = one new track, replaceTrack on EVERY connection
//
// The 1:1 Room page (steps 8–10) is untouched; this page uses its own events (group:*).
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useMeshRoom from '../hooks/useMeshRoom.js';
import useLocalMedia from '../hooks/useLocalMedia.js';
import useDevices from '../hooks/useDevices.js';
import useActiveSpeaker from '../hooks/useActiveSpeaker.js';
import useLog from '../hooks/useLog.js';
import ParticipantList from '../components/ParticipantList.jsx';
import MeshDiagram from '../components/MeshDiagram.jsx';
import GroupChat from '../components/GroupChat.jsx';
import VideoGrid from '../components/VideoGrid.jsx';
import CallControls from '../components/CallControls.jsx';
import PeerStatsTable from '../components/PeerStatsTable.jsx';
import { getNetwork } from '../services/api.js';

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const CAN_SHARE_SCREEN = !isMobile && Boolean(navigator.mediaDevices?.getDisplayMedia);

function load(key, fallback) {
  try {
    return localStorage.getItem(`webrtc-lab:${key}`) || fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`webrtc-lab:${key}`, value);
  } catch {
    // storage unavailable: fine
  }
}

export default function GroupMesh() {
  const { log } = useLog();
  const [params, setParams] = useSearchParams();
  const [roomInput, setRoomInput] = useState(() => params.get('room') || load('group-room', 'mesh-room'));
  // Not shared with the Room page's saved name: several tabs on one laptop each need their own.
  const [name, setName] = useState(() => (isMobile ? 'Phone' : ''));
  const [joining, setJoining] = useState(false);
  const [lanHosts, setLanHosts] = useState([]);
  const [statsOn, setStatsOn] = useState(true);

  const media = useLocalMedia();
  const devices = useDevices(media.stream);

  // ---- local track state (from useLocalMedia's snapshots) ----
  const liveTrack = (kind) => media.tracks.find((t) => t.kind === kind && t.readyState === 'live');
  const micSnap = liveTrack('audio');
  const camSnap = liveTrack('video');
  const micOn = micSnap?.enabled ?? false;
  const camOn = camSnap?.enabled ?? false;
  const cameras = devices.cameras.filter((c) => c.deviceId);

  // Refs, because the mesh hook calls these from socket / pc callbacks long after this render.
  const localStreamRef = useRef(null);
  const mediaStateRef = useRef({ audio: false, video: false });
  mediaStateRef.current = { audio: micOn, video: camOn };

  const mesh = useMeshRoom({
    getLocalStream: () => localStreamRef.current,
    getMediaState: () => mediaStateRef.current,
  });
  const inRoom = Boolean(mesh.room);
  const speaker = useActiveSpeaker(mesh.getAudioLevels, inRoom);

  // track.enabled = false only changes what the encoder is fed (silence / black frames).
  // Nothing in RTP or SDP says "muted", so tell everyone explicitly. (Newcomers get
  // the current state when their data channel opens: see useMeshRoom attachChannel.)
  const { announceMedia } = mesh;
  useEffect(() => {
    if (!inRoom) return;
    const n = announceMedia(); // { audio, video } + screenStreamId, to every open channel
    if (n) log(`→ media-state (mic ${micOn ? 'on' : 'off'}, camera ${camOn ? 'on' : 'off'}) to ${n} peer(s)`);
  }, [inRoom, micOn, camOn, announceMedia, log]);

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
    // 1. Camera + mic ONCE, before any connection exists: every offer/answer will carry these tracks.
    const stream = await media.start({ video: true, audio: true });
    localStreamRef.current = stream;
    if (!stream) log('No camera/mic: joining anyway, I will only receive', 'warn');
    // 2. Then the room (I'll offer to everyone already there).
    const res = await mesh.join(roomInput, name);
    setJoining(false);
    if (res.ok) {
      setParams({ room: res.roomId }, { replace: true });
      save('group-room', res.roomId);
    } else {
      media.stop();
      localStreamRef.current = null;
    }
  };

  // Me leaving: close EVERY connection, release camera + mic, leave the room.
  const leave = async () => {
    await mesh.leave(); // pc.close() × N−1 (does NOT stop local tracks)
    media.stop(); // track.stop(): camera light off
    localStreamRef.current = null;
    setParams({}, { replace: true });
  };

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const idx = cameras.findIndex((c) => c.deviceId === camSnap?.settings.deviceId);
    const next = cameras[(idx + 1) % cameras.length];
    // 1. New track in the local stream (my preview + future connections use it)…
    const track = await media.switchDevice('video', next.deviceId);
    // 2. …and into every EXISTING connection's video sender.
    if (track) await mesh.replaceTrack('video', track);
  };

  // ======================= lobby =======================
  if (!inRoom) {
    return (
      <div>
        <h1>Group mesh</h1>
        <p className="muted">
          Steps 11–12: up to 6 people with video, every one connected directly to every other. Open the same room in 3–4 tabs and on your phone.
        </p>
        <div className="card lobby">
          <form className="join-form" onSubmit={join}>
            <label>
              <span className="muted small">Room</span>
              <input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} maxLength={40} required />
            </label>
            <label>
              <span className="muted small">Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="e.g. Tab A" required />
            </label>
            <button className="primary" type="submit" disabled={joining || mesh.status !== 'connected'}>
              {joining ? 'Starting camera…' : 'Join group'}
            </button>
          </form>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Joining turns on your camera and microphone. Signaling server:{' '}
            <span className={`badge badge-${mesh.status === 'connected' ? 'online' : 'offline'}`}>{mesh.status}</span>
          </p>
          {(media.error || mesh.error) && (
            <div className="alert" role="alert" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              {media.error ? `${media.error.name}: ${media.error.hint}` : mesh.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ======================= in the room =======================
  const openCount = mesh.peers.filter((p) => p.channel === 'open').length;
  const shareUrls = (lanHosts.length ? lanHosts : [window.location.host]).map(
    (h) => `https://${h}/group?room=${encodeURIComponent(mesh.room.id)}`,
  );
  // My own mic's level comes from getStats too; when I'm muted it's 0, whatever the stats say.
  const levels = { ...speaker.levels, me: micOn ? speaker.levels.me : 0 };

  // Me first, then everyone in join order (stable: tiles never jump around).
  const tiles = [
    {
      id: 'me',
      name: mesh.room.you.name,
      stream: media.stream, // ONE MediaStream for the whole session (camera switch swaps the track inside it)
      isLocal: true,
      micOn,
      camOn,
      mirrored: camSnap?.settings.facingMode !== 'environment',
    },
    ...(mesh.screenStream ? [{ id: 'me:screen', name: 'Your screen', stream: mesh.screenStream, isLocal: true, isScreen: true, micOn: true, camOn: true }] : []),
    ...[...mesh.peers]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .flatMap((p) => [
        { id: p.id, name: p.name, stream: p.remoteStream, micOn: p.media.audio, camOn: p.media.video, connection: p.connection },
        // A screen tile only once both the stream (ontrack) and their media-state say so.
        ...(p.screenStream ? [{ id: `${p.id}:screen`, name: `${p.name}'s screen`, stream: p.screenStream, isScreen: true, micOn: true, camOn: true }] : []),
      ]),
  ];

  return (
    <div>
      <div className="group-header">
        <h1>
          Room “{mesh.room.id}” <span className="muted small">as {mesh.room.you.name}</span>
        </h1>
        <span className={`badge badge-${mesh.status === 'connected' ? 'online' : 'offline'}`}>signaling {mesh.status}</span>
      </div>
      <div className="call-layout">
        <div className="call-main">
          <VideoGrid tiles={tiles} activeId={speaker.activeId} levels={levels} />
          <CallControls
            micOn={micOn}
            camOn={camOn}
            hasMic={Boolean(micSnap)}
            hasCam={Boolean(camSnap)}
            canSwitchCamera={cameras.length > 1}
            onToggleMic={() => media.toggleEnabled('audio')}
            onToggleCam={() => media.toggleEnabled('video')}
            onSwitchCamera={switchCamera}
            onHangUp={leave}
            hangUpLabel="Leave"
            statsOn={statsOn}
            onToggleStats={() => setStatsOn((v) => !v)}
            screenOn={Boolean(mesh.screenStream)}
            onToggleScreen={CAN_SHARE_SCREEN ? () => (mesh.screenStream ? mesh.stopScreenShare() : mesh.startScreenShare()) : undefined}
          />
          {statsOn && <PeerStatsTable peers={mesh.peers} getPeerStats={mesh.getPeerStats} onSetMaxBitrate={mesh.setMaxBitrate} />}
          <p className="muted small call-share">
            Invite others:{' '}
            {shareUrls.map((u) => (
              <code key={u} className="addr">
                {u}
              </code>
            ))}
          </p>
        </div>
        <aside className="call-side">
          <ParticipantList you={mesh.room.you} peers={mesh.peers} onRestartIce={mesh.restartIceFor} />
          <GroupChat messages={mesh.messages} openCount={openCount} peerCount={mesh.peers.length} onSend={mesh.sendChat} />
          <MeshDiagram you={mesh.room.you} peers={mesh.peers} />
        </aside>
      </div>
    </div>
  );
}
