// Step 11: group room as a FULL MESH, chat only (no media yet).
//
//   Join (name + room) → group:join → ack lists who is already here
//   → I send one offer to EACH of them (I'm the new joiner); they only answer
//   → one RTCPeerConnection + one "chat" data channel per other participant
//   → a chat message is sent separately over every open channel
//
// The 1:1 Room page (steps 8–10) is untouched; this page uses its own events (group:*).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useMeshRoom from '../hooks/useMeshRoom.js';
import ParticipantList from '../components/ParticipantList.jsx';
import MeshDiagram from '../components/MeshDiagram.jsx';
import GroupChat from '../components/GroupChat.jsx';
import { getNetwork } from '../services/api.js';

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

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
  const [params, setParams] = useSearchParams();
  const [roomInput, setRoomInput] = useState(() => params.get('room') || load('group-room', 'mesh-room'));
  // Not shared with the Room page's saved name: several tabs on one laptop each need their own.
  const [name, setName] = useState(() => (isMobile ? 'Phone' : ''));
  const [joining, setJoining] = useState(false);
  const [lanHosts, setLanHosts] = useState([]);
  const mesh = useMeshRoom();

  useEffect(() => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
    getNetwork()
      .then(({ addresses }) => setLanHosts(addresses.map((a) => `${a.address}:${window.location.port}`)))
      .catch(() => {});
  }, []);

  const join = async (e) => {
    e.preventDefault();
    setJoining(true);
    const res = await mesh.join(roomInput, name);
    setJoining(false);
    if (res.ok) {
      setParams({ room: res.roomId }, { replace: true });
      save('group-room', res.roomId);
    }
  };

  const leave = async () => {
    await mesh.leave();
    setParams({}, { replace: true });
  };

  // ======================= lobby =======================
  if (!mesh.room) {
    return (
      <div>
        <h1>Group mesh</h1>
        <p className="muted">
          Step 11: up to 6 people, every one connected directly to every other. Chat only, no video yet. Open the same room in 3–4 tabs and on
          your phone.
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
              {joining ? 'Joining…' : 'Join group'}
            </button>
          </form>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Signaling server: <span className={`badge badge-${mesh.status === 'connected' ? 'online' : 'offline'}`}>{mesh.status}</span>
          </p>
          {mesh.error && (
            <div className="alert" role="alert" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              {mesh.error}
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

  return (
    <div>
      <div className="group-header">
        <h1>
          Room “{mesh.room.id}” <span className="muted small">as {mesh.room.you.name}</span>
        </h1>
        <span className={`badge badge-${mesh.status === 'connected' ? 'online' : 'offline'}`}>signaling {mesh.status}</span>
        <button onClick={leave}>Leave</button>
      </div>
      <div className="call-layout">
        <div className="call-side">
          <ParticipantList you={mesh.room.you} peers={mesh.peers} />
          <MeshDiagram you={mesh.room.you} peers={mesh.peers} />
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
          <GroupChat messages={mesh.messages} openCount={openCount} peerCount={mesh.peers.length} onSend={mesh.sendChat} />
        </aside>
      </div>
    </div>
  );
}
