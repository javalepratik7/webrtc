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

const ROLE_TEXT = {
  offerer: 'I sent the offer (I joined later)',
  answerer: 'they offer, I answer (they joined later)',
};

export default function ParticipantList({ you, peers }) {
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
                <span className={`badge badge-${CONNECTION_CLASS[p.connection] ?? 'checking'} participant-state`}>
                  {waiting ? 'waiting for offer' : p.connection}
                </span>
              </div>
              <div className="participant-detail muted small">
                {ROLE_TEXT[p.role]}
                {!waiting && (
                  <>
                    {' · '}ICE <code>{p.ice}</code> · signaling <code>{p.signaling}</code> · chat <code>{p.channel}</code>
                    {' · '}candidates ↑{p.counts.sent} ↓{p.counts.received}
                    {p.counts.queued > 0 && ` (${p.counts.queued} queued)`}
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
