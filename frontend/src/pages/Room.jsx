// Steps 8–9: join a room over Socket.IO, then connect peer-to-peer.
// The user already in the room becomes the caller when the second one joins;
// offer/answer/candidates travel over signaling, chat goes over the data channel.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSignaling from '../hooks/useSignaling.js';
import usePeerConnection from '../hooks/usePeerConnection.js';
import useChat from '../hooks/useChat.js';
import useLog from '../hooks/useLog.js';
import ChatBox from '../components/ChatBox.jsx';
import { getNetwork } from '../services/api.js';

const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const PEER_SIGNALS = new Set(['offer', 'answer', 'candidate']);

function loadName() {
  try {
    return localStorage.getItem('webrtc-lab:name') || (isMobile ? 'Phone' : 'Laptop');
  } catch {
    return isMobile ? 'Phone' : 'Laptop';
  }
}

const GOOD = new Set(['stable', 'complete', 'connected', 'completed']);
const BAD = new Set(['failed', 'disconnected', 'closed']);
const stateClass = (v) => (GOOD.has(v) ? 'ok' : BAD.has(v) ? 'err' : '');
// Type is shown as a tag next to it. mDNS (.local) host addresses are hidden by Chrome's stats.
const endpoint = (c) => (c ? `${c.protocol} ${c.address || '(hidden: mDNS)'}:${c.port}` : '-');

export default function Room() {
  const { log } = useLog();
  const [params, setParams] = useSearchParams();
  const [roomInput, setRoomInput] = useState(params.get('room') || 'test-room');
  const [name, setName] = useState(loadName);
  const [busy, setBusy] = useState(false);
  const [slowCallee, setSlowCallee] = useState(false);
  const [lanHosts, setLanHosts] = useState([]);

  const sig = useSignaling({
    onSignal: (msg) => {
      const { from, type, payload } = msg;
      if (PEER_SIGNALS.has(type)) {
        peer.handleSignal(msg);
      } else if (type === 'bye') {
        log('← bye: the peer hung up', 'warn');
        peer.close('peer hung up');
      } else if (type === 'ping') {
        log(`signal "ping" from ${payload?.from ?? from.slice(0, 6)} → replying with pong`, 'success');
        sig.send('pong', { sentAt: payload?.sentAt, from: name });
      } else if (type === 'pong') {
        log(`signal "pong" from ${payload?.from}: round trip via server ${Date.now() - payload?.sentAt} ms`, 'success');
      } else {
        log(`signal "${type}" from ${from.slice(0, 6)} (not handled)`);
      }
    },
    // The second user arrived → the one already here (me) becomes the caller.
    onPeerJoined: (p) => {
      if (peer.isActive() && peer.currentPeerKey() === p.clientId) {
        // Same tab, it only lost and regained the signaling connection (e.g. backend
        // restart). The peer-to-peer connection never needed the server: keep it.
        log(`${p.name} re-joined after a signaling reconnect: keeping the existing peer-to-peer connection`, 'success');
        return;
      }
      peer.startAsCaller(p.clientId);
    },
    onPeerLeft: () => peer.close('peer left the room'),
  });

  const peer = usePeerConnection({ send: sig.send, slowRemoteMs: slowCallee ? 1000 : 0 });
  const connection = peer.state?.connection ?? null;
  const chat = useChat(peer.channel, connection ?? 'closed');

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

  const join = async (e) => {
    e.preventDefault();
    setBusy(true);
    chat.clear();
    const res = await sig.join(roomInput, name);
    setBusy(false);
    if (res.ok) {
      setParams({ room: res.roomId }, { replace: true });
      if (res.peers.length) log('Peer already in the room → I am the callee: waiting for their offer');
    }
  };

  const leave = async () => {
    peer.close('left the room');
    await sig.leave();
    setParams({}, { replace: true });
  };

  const hangUp = () => {
    sig.send('bye');
    peer.close('hung up');
  };

  const roomPeer = sig.room?.peers[0];
  const shareUrls = sig.room
    ? (lanHosts.length ? lanHosts : [window.location.host]).map((h) => `https://${h}/room?room=${encodeURIComponent(sig.room.id)}`)
    : [];
  const statusBadge = sig.status === 'connected' ? 'online' : sig.status === 'connecting' ? 'checking' : 'offline';
  const p2pUp = connection === 'connected';

  return (
    <div>
      <h1>Room</h1>
      <p className="muted">Steps 8–9: Socket.IO signaling, then a peer-to-peer data channel. Open this page on two devices.</p>

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
          {sig.status !== 'connected' && p2pUp && (
            <p className="p2p-banner small">
              The signaling server is unreachable, but the chat still works: messages go <strong>directly</strong> between
              the two browsers over the data channel.
            </p>
          )}
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
          <label className="checkbox small" style={{ marginTop: '0.6rem' }} title="Delays setRemoteDescription by 1 s on this device, so early candidates must be queued">
            <input type="checkbox" checked={slowCallee} onChange={(e) => setSlowCallee(e.target.checked)} /> Simulate slow
            setRemoteDescription (1 s) to watch the candidate queue
          </label>
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
            {roomPeer ? (
              <li>
                <span className="dot dot-on" /> {roomPeer.name} <span className="muted small">({roomPeer.id.slice(0, 6)})</span>
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
        </div>
      )}

      {sig.room && (
        <div className="p2p-grid">
          <div className="card">
            <h2>
              Peer connection{' '}
              {peer.role && <span className="muted small">(I am the {peer.role})</span>}
            </h2>
            {peer.state ? (
              <>
                <table className="track-table">
                  <tbody>
                    {[
                      ['connectionState', peer.state.connection],
                      ['iceConnectionState', peer.state.iceConnection],
                      ['signalingState', peer.state.signaling],
                      ['iceGatheringState', peer.state.iceGathering],
                    ].map(([k, v]) => (
                      <tr key={k}>
                        <td>
                          <code>{k}</code>
                        </td>
                        <td className={stateClass(v)}>{v}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>selected pair (local)</td>
                      <td className="addr">
                        {peer.pair?.local && <span className={`tag tag-${peer.pair.local.type}`}>{peer.pair.local.type}</span>}{' '}
                        {endpoint(peer.pair?.local)}
                      </td>
                    </tr>
                    <tr>
                      <td>selected pair (remote)</td>
                      <td className="addr">
                        {peer.pair?.remote && <span className={`tag tag-${peer.pair.remote.type}`}>{peer.pair.remote.type}</span>}{' '}
                        {endpoint(peer.pair?.remote)}
                      </td>
                    </tr>
                    <tr>
                      <td>RTT (peer ↔ peer)</td>
                      <td>{peer.pair?.rttMs != null ? `${peer.pair.rttMs.toFixed(1)} ms` : '-'}</td>
                    </tr>
                    <tr>
                      <td>candidates sent / received / queued</td>
                      <td>
                        {peer.counts.sent} / {peer.counts.received} / {peer.counts.queued}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="toolbar" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                  <button onClick={hangUp}>Hang up</button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">
                  {roomPeer
                    ? 'No connection. (Hung up, or the connection failed.)'
                    : 'Waiting for a second person. When they join, I create the offer.'}
                </p>
                {roomPeer && sig.status === 'connected' && (
                  <button className="primary" onClick={() => peer.startAsCaller(roomPeer.clientId)}>
                    Connect (I’ll be the caller)
                  </button>
                )}
              </>
            )}
          </div>

          <ChatBox
            messages={chat.messages}
            state={chat.state}
            onSend={chat.send}
            onTyping={chat.notifyTyping}
            peerTyping={chat.peerTyping}
            peerName={roomPeer?.name ?? 'Peer'}
          />
        </div>
      )}
    </div>
  );
}
