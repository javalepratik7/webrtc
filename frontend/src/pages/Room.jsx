// Step 8: signaling only. Join a room, see who's there, relay a test "ping".
// (Steps 9–10 will run the RTCPeerConnection over this same channel.)
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSignaling from '../hooks/useSignaling.js';
import useLog from '../hooks/useLog.js';
import { getNetwork } from '../services/api.js';

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

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
  const [roomInput, setRoomInput] = useState(params.get('room') || 'test-room');
  const [name, setName] = useState(loadName);
  const [busy, setBusy] = useState(false);
  const [lastPing, setLastPing] = useState(null);
  const [lanHosts, setLanHosts] = useState([]); // e.g. ['192.168.0.115:5173']

  // On https://localhost the share link would be useless on a phone: ask the backend for the LAN IP.
  useEffect(() => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
    getNetwork()
      .then(({ addresses }) => setLanHosts(addresses.map((a) => `${a.address}:${window.location.port}`)))
      .catch(() => {});
  }, []);

  const sig = useSignaling({
    // Every relayed message arrives here as { from, type, payload }.
    onSignal: ({ from, type, payload }) => {
      if (type === 'ping') {
        log(`signal "ping" from ${payload?.from ?? from.slice(0, 6)}: "${payload?.text}" → replying with pong`, 'success');
        setLastPing({ from: payload?.from, at: new Date() });
        sig.send('pong', { sentAt: payload?.sentAt, from: name });
      } else if (type === 'pong') {
        // Round trip: me → server → peer → server → me. Uses only MY clock, so no clock-sync issues.
        log(`signal "pong" from ${payload?.from}: round trip via server ${Date.now() - payload?.sentAt} ms`, 'success');
      } else {
        log(`signal "${type}" from ${from.slice(0, 6)} (not handled yet)`);
      }
    },
  });

  useEffect(() => {
    try {
      localStorage.setItem('webrtc-lab:name', name);
    } catch {
      // storage unavailable (private mode): fine
    }
  }, [name]);

  const join = async (e) => {
    e.preventDefault();
    setBusy(true);
    const res = await sig.join(roomInput, name);
    setBusy(false);
    if (res.ok) setParams({ room: res.roomId }, { replace: true }); // shareable URL
  };

  const leave = async () => {
    await sig.leave();
    setParams({}, { replace: true });
  };

  const ping = () => sig.send('ping', { sentAt: Date.now(), from: name, text: `hello from ${name}` });

  const peer = sig.room?.peers[0];
  const shareUrls = sig.room
    ? (lanHosts.length ? lanHosts : [window.location.host]).map((h) => `https://${h}/room?room=${encodeURIComponent(sig.room.id)}`)
    : [];
  const statusBadge = sig.status === 'connected' ? 'online' : sig.status === 'connecting' ? 'checking' : 'offline';

  return (
    <div>
      <h1>Room</h1>
      <p className="muted">Step 8: Socket.IO signaling. Open this page on two devices and join the same room.</p>

      <div className="room-grid">
        <div className="card">
          <h2>Signaling server</h2>
          <dl className="settings-list">
            <div>
              <dt>socket</dt>
              <dd>
                <span className={`badge badge-${statusBadge}`}>{sig.status}</span>
              </dd>
            </div>
            <div>
              <dt>transport</dt>
              <dd>{sig.status === 'connected' ? sig.transport : '-'}</dd>
            </div>
            <div>
              <dt>socket id</dt>
              <dd>
                <code>{sig.status === 'connected' ? sig.socketId : '-'}</code>
              </dd>
            </div>
            <div>
              <dt>via</dt>
              <dd>
                <code>{window.location.host}/socket.io</code> → Vite proxy → :4000
              </dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h2>Join a room</h2>
          {sig.room ? (
            <>
              <p>
                In room <strong>{sig.room.id}</strong> as <strong>{sig.room.you.name}</strong>
              </p>
              <button onClick={leave}>Leave room</button>
            </>
          ) : (
            <form className="join-form" onSubmit={join}>
              <label>
                <span className="muted small">Room</span>
                <input value={roomInput} onChange={(e) => setRoomInput(e.target.value)} maxLength={40} required />
              </label>
              <label>
                <span className="muted small">Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} />
              </label>
              <button className="primary" type="submit" disabled={busy || sig.status !== 'connected'}>
                Join
              </button>
            </form>
          )}
          {sig.error && (
            <div className="alert" role="alert" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              {sig.error}
            </div>
          )}
        </div>
      </div>

      {sig.room && (
        <div className="card">
          <h2>
            People in “{sig.room.id}” ({1 + sig.room.peers.length}/2)
          </h2>
          <ul className="member-list">
            <li>
              <span className="dot dot-on" /> {sig.room.you.name} <span className="muted small">(you · {sig.room.you.id.slice(0, 6)})</span>
            </li>
            {peer ? (
              <li>
                <span className="dot dot-on" /> {peer.name} <span className="muted small">({peer.id.slice(0, 6)})</span>
              </li>
            ) : (
              <li className="muted">
                <span className="dot" /> Waiting for someone to join… Open this link on the other device:
                {shareUrls.map((u) => (
                  <div key={u}>
                    <code className="addr">{u}</code>
                  </div>
                ))}
              </li>
            )}
          </ul>
          <div className="toolbar" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            <button className="primary" onClick={ping} disabled={!peer}>
              Send “ping” signal
            </button>
            {lastPing && (
              <span className="muted small">
                Last ping received from {lastPing.from} at {lastPing.at.toTimeString().slice(0, 8)} (details in the event log)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
