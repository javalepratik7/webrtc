// Everyone in the group room and, for each OTHER participant, the state of MY
// connection to them. In a mesh these are independent: one can be "connected"
// while another is "failed".
//   <ParticipantList you={room.you} peers={mesh.peers} />

const CONNECTION_CLASS = {
  connected: 'online',
  failed: 'offline',
  closed: 'offline',
  disconnected: 'checking',
};

// Who STARTED the connection (step 11 join rule) and who yields on glare (step 13).
const roleText = (p) => `${p.initiator ? 'I started it (I joined later)' : 'they started it'} · I am ${p.polite ? 'polite' : 'impolite'}`;

export default function ParticipantList({ you, peers, onRestartIce }) {
  return (
    <div className="card">
      <h2>
        Participants <span className="muted small">({1 + peers.length}/6)</span>
      </h2>
      <ul className="participant-list">
        <li>
          <span className="dot dot-on" />
          <strong>{you.name}</strong> <span className="muted small">(you · {you.socketId.slice(0, 6)})</span>
        </li>
        {peers.map((p) => {
          const waiting = p.connection === 'none';
          return (
            <li key={p.id}>
              <div className="participant-head">
                <span className={`dot ${p.connection === 'connected' ? 'dot-on' : ''}`} />
                <strong>{p.name}</strong> <span className="muted small">{p.id.slice(0, 6)}</span>
                {!p.media.audio && <span title="mic off">🔇</span>}
                {!p.media.video && <span title="camera off">🚫📷</span>}
                <span className={`badge badge-${CONNECTION_CLASS[p.connection] ?? 'checking'} participant-state`}>
                  {waiting ? 'waiting for offer' : p.connection}
                </span>
              </div>
              <div className="participant-detail muted small">
                {roleText(p)}
                {p.missing && <strong className="stats-warn"> · signaling lost, P2P kept</strong>}
                {!waiting && (
                  <>
                    {' · '}ICE <code>{p.ice}</code> · signaling <code>{p.signaling}</code> · chat <code>{p.channel}</code>
                    {' · '}candidates ↑{p.counts.sent} ↓{p.counts.received}
                    {p.counts.queued > 0 && ` (${p.counts.queued} queued)`}
                    {' · '}offers {p.counts.offers} · glare {p.counts.glare} · ICE restarts {p.counts.restarts}
                    {onRestartIce && (
                      <button className="small-btn" onClick={() => onRestartIce(p.id)} title="pc.restartIce() for this peer only">
                        ↻ ICE
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {peers.length === 0 && <p className="muted small" style={{ marginBottom: 0 }}>Nobody else yet. Open this room in another tab or on your phone.</p>}
    </div>
  );
}
