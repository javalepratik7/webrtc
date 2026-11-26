// Step 15: group call through the mediasoup SFU (backend: step 14).
//
//   Join → getUserMedia ONCE → sfu:join → load Device → send + recv transports
//   → produce mic + camera (3 simulcast layers) → consume everyone else (useSfuRoom)
//
// Same UI pieces as the mesh (VideoGrid, ParticipantTile, CallControls, PeerStatsTable),
// different engine:
//   - mute / camera off = producer.pause() + sfu:pauseProducer; the SERVER tells everyone
//   - switch camera     = producer.replaceTrack()
//   - each remote tile reports its size → the page picks a simulcast layer → sfu:setPreferredLayers
//   - click a tile to pin it (spotlight): pinned = high layer, the small strip = low
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSfuRoom, { LAYER_NAMES } from '../hooks/useSfuRoom.js';
import useLocalMedia from '../hooks/useLocalMedia.js';
import useDevices from '../hooks/useDevices.js';
import useActiveSpeaker from '../hooks/useActiveSpeaker.js';
import useLog from '../hooks/useLog.js';
import VideoGrid from '../components/VideoGrid.jsx';
import CallControls from '../components/CallControls.jsx';
import PeerStatsTable from '../components/PeerStatsTable.jsx';
import { getNetwork } from '../services/api.js';

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

// Tile width (CSS px × devicePixelRatio = real pixels on screen) → simulcast layer.
// Layers of a 1280×720 camera: L0 320×180, L1 640×360, L2 1280×720. Pick the
// smallest layer that is at least as wide as the tile: never upscale (blurry),
// never send more pixels than the tile can show (wasted bandwidth + decoding).
export function layerForWidth(cssWidth, dpr = window.devicePixelRatio || 1) {
  const px = cssWidth * dpr;
  return px <= 320 ? 0 : px <= 640 ? 1 : 2;
}

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

// What the server is doing for this room (GET /api/sfu every 2 s).
function ServerCard({ roomId }) {
  const [s, setS] = useState(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/sfu');
        const data = await res.json();
        if (!stop) setS(data);
      } catch {
        // backend restarting
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  const room = s?.rooms.find((r) => r.roomId === roomId);
  const cpu = s?.workers.reduce((a, w) => a + (w.cpuPct ?? 0), 0);
  return (
    <div className="card sfu-server">
      <h2>
        Server (SFU) <span className="muted small">GET /api/sfu</span>
      </h2>
      {room ? (
        <dl>
          <dt>In this room</dt>
          <dd>
            {room.peers} peers · {room.producers} producers · {room.consumers} consumers
          </dd>
          <dt>Server ↓ in</dt>
          <dd>{room.serverInKbps} kbps (≈ N uploads)</dd>
          <dt>Server ↑ out</dt>
          <dd>{room.serverOutKbps} kbps (≈ N × (N−1) forwards)</dd>
          <dt>Workers CPU</dt>
          <dd>
            {cpu ?? '–'}% of one core ({s.workers.length} workers)
          </dd>
          <dt>Announced IP</dt>
          <dd>
            <code>{s.announcedIp}</code> · ports {s.ports}
          </dd>
        </dl>
      ) : (
        <p className="muted small">{s ? 'Room not found on the server.' : 'Loading…'}</p>
      )}
    </div>
  );
}

export default function GroupSfu() {
  const { log } = useLog();
  const [params, setParams] = useSearchParams();
  const [roomInput, setRoomInput] = useState(() => params.get('room') || load('sfu-room', 'sfu-room'));
  const [name, setName] = useState(() => (isMobile ? 'Phone' : ''));
  const [joining, setJoining] = useState(false);
  const [statsOn, setStatsOn] = useState(true);
  const [pinnedId, setPinnedId] = useState(null);
  const [lanHosts, setLanHosts] = useState([]);

  const media = useLocalMedia();
  const devices = useDevices(media.stream);
  const sfu = useSfuRoom();
  const inRoom = Boolean(sfu.room);
  const speaker = useActiveSpeaker(sfu.getAudioLevels, inRoom);

  const camSnap = media.tracks.find((t) => t.kind === 'video' && t.readyState === 'live');
  const micSnap = media.tracks.find((t) => t.kind === 'audio' && t.readyState === 'live');
  // In the SFU, "on/off" is the PRODUCER's paused state (not track.enabled).
  const micOn = Boolean(micSnap) && !sfu.paused.audio;
  const camOn = Boolean(camSnap) && !sfu.paused.video;
  const cameras = devices.cameras.filter((c) => c.deviceId);

  useEffect(() => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
    getNetwork()
      .then(({ addresses }) => setLanHosts(addresses.map((a) => `${a.address}:${window.location.port}`)))
      .catch(() => {});
  }, []);

  const join = async (e) => {
    e.preventDefault();
    setJoining(true);
    // Camera at 720p so the 3 simulcast layers are 320×180 / 640×360 / 1280×720.
    const stream = await media.start({ video: true, audio: true });
    if (!stream) log('No camera/mic: joining anyway, I will only receive', 'warn');
    const res = await sfu.join(roomInput, name, stream);
    setJoining(false);
    if (res.ok) {
      setParams({ room: roomInput.trim() }, { replace: true });
      save('sfu-room', roomInput.trim());
    } else {
      media.stop();
    }
  };

  // Full cleanup: producers + transports (both RTCPeerConnections) + sfu:leave, then camera/mic off.
  const leave = async () => {
    await sfu.leave();
    media.stop();
    setPinnedId(null);
    setParams({}, { replace: true });
  };

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const idx = cameras.findIndex((c) => c.deviceId === camSnap?.settings.deviceId);
    const next = cameras[(idx + 1) % cameras.length];
    const track = await media.switchDevice('video', next.deviceId); // new track in the local stream (preview)
    if (track) await sfu.replaceTrack('video', track); // ONE sender to update (mesh: N−1)
  };

  // Tile sizes → simulcast layers. Stable callback so the ResizeObserver isn't rebuilt.
  const { setPreferredLayer } = sfu;
  const lastLayer = useRef({});
  const onTileResize = useCallback(
    (id, width) => {
      if (id === 'me' || !width) return;
      const layer = layerForWidth(width);
      if (lastLayer.current[id] === layer) return;
      lastLayer.current[id] = layer;
      setPreferredLayer(id, layer);
    },
    [setPreferredLayer],
  );
  const onSelect = useCallback((id) => setPinnedId((cur) => (cur === id ? null : id)), []);

  // ======================= lobby =======================
  if (!inRoom) {
    return (
      <div>
        <h1>Group call (SFU)</h1>
        <p className="muted">
          Step 15: everyone sends ONE stream (3 simulcast layers) to the mediasoup server, which forwards it to the others. Compare with the{' '}
          <a href="/group">mesh</a>.
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
            <button className="primary" type="submit" disabled={joining || sfu.status !== 'connected'}>
              {joining ? 'Joining…' : 'Join SFU call'}
            </button>
          </form>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Joining turns on your camera and microphone. Signaling:{' '}
            <span className={`badge badge-${sfu.status === 'connected' ? 'online' : 'offline'}`}>{sfu.status}</span>
          </p>
          {(media.error || sfu.error) && (
            <div className="alert" role="alert" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              {media.error ? `${media.error.name}: ${media.error.hint}` : sfu.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ======================= in the room =======================
  const levels = { ...speaker.levels, me: micOn ? speaker.levels.me : 0 };
  const badgeFor = (p) => {
    if (!p.hasVideo) return null;
    if (!p.camOn) return 'video paused · nothing forwarded';
    const res = p.recv ? `${p.recv.w}×${p.recv.h}@${p.recv.fps}` : '…';
    if (!p.simulcast) return `single stream · ${res}`;
    const now = p.layer == null ? 'no layer' : `L${p.layer} ${LAYER_NAMES[p.layer]}`;
    const want = p.preferredLayer != null && p.preferredLayer !== p.layer ? ` → wants L${p.preferredLayer}` : '';
    return `${now}${want} · ${res}`;
  };
  const tiles = [
    { id: 'me', name: sfu.room.you.name, stream: media.stream, isLocal: true, micOn, camOn, mirrored: camSnap?.settings.facingMode !== 'environment' },
    ...[...sfu.peers]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, stream: p.stream, micOn: p.micOn, camOn: p.camOn && p.hasVideo, badge: badgeFor(p) })),
  ];
  const transportRows = [
    { id: 'send', name: '↑ send transport', connection: sfu.transports.send, maxKbps: null },
    { id: 'recv', name: '↓ recv transport', connection: sfu.transports.recv, maxKbps: null },
  ];
  const shareUrls = (lanHosts.length ? lanHosts : [window.location.host]).map((h) => `https://${h}/sfu?room=${encodeURIComponent(sfu.room.id)}`);

  return (
    <div>
      <div className="group-header">
        <h1>
          SFU room “{sfu.room.id}” <span className="muted small">as {sfu.room.you.name}</span>
        </h1>
        <span className={`badge badge-${sfu.transports.send === 'connected' ? 'online' : 'checking'}`}>send {sfu.transports.send}</span>
        <span className={`badge badge-${sfu.transports.recv === 'connected' ? 'online' : 'checking'}`}>recv {sfu.transports.recv}</span>
        <span className={`badge badge-${sfu.status === 'connected' ? 'online' : 'offline'}`}>signaling {sfu.status}</span>
      </div>
      <div className="call-layout">
        <div className="call-main">
          <VideoGrid tiles={tiles} activeId={speaker.activeId} levels={levels} pinnedId={pinnedId} onSelect={onSelect} onTileResize={onTileResize} />
          <CallControls
            micOn={micOn}
            camOn={camOn}
            hasMic={Boolean(micSnap)}
            hasCam={Boolean(camSnap)}
            canSwitchCamera={cameras.length > 1}
            onToggleMic={() => sfu.setPaused('audio', micOn)}
            onToggleCam={() => sfu.setPaused('video', camOn)}
            onSwitchCamera={switchCamera}
            onHangUp={leave}
            hangUpLabel="Leave"
            statsOn={statsOn}
            onToggleStats={() => setStatsOn((v) => !v)}
          />
          <p className="muted small call-share">
            Click a tile to pin it (big = high layer, the strip = low). Invite others:{' '}
            {shareUrls.map((u) => (
              <code key={u} className="addr">
                {u}
              </code>
            ))}
          </p>
          {statsOn && <PeerStatsTable peers={transportRows} getPeerStats={sfu.getTransportStats} />}
        </div>
        <aside className="call-side">
          <div className="card">
            <h2>
              Participants <span className="muted small">({1 + sfu.peers.length})</span>
            </h2>
            <ul className="participant-list">
              <li>
                <span className="dot dot-on" />
                <strong>{sfu.room.you.name}</strong> <span className="muted small">(you) · {micOn ? '🎤' : '🔇'} {camOn ? '📷' : '🚫📷'}</span>
              </li>
              {sfu.peers.map((p) => (
                <li key={p.id}>
                  <span className={`dot ${p.hasVideo || p.micOn ? 'dot-on' : ''}`} />
                  <strong>{p.name}</strong>{' '}
                  <span className="muted small">
                    {p.micOn ? '🎤' : '🔇'} {p.camOn ? '📷' : '🚫📷'}
                    {p.simulcast && ` · receiving ${p.layer == null ? '–' : LAYER_NAMES[p.layer]}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted small" style={{ marginBottom: 0 }}>
              2 RTCPeerConnections in this tab (send + recv), whatever the room size.
            </p>
          </div>
          <ServerCard roomId={sfu.room.id} />
        </aside>
      </div>
    </div>
  );
}
