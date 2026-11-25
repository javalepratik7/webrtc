// The room as a graph: participants on a circle, one line per peer connection.
// Lines from "you" are coloured by MY connectionState. Lines between two OTHER
// people are dashed: they exist (it's a full mesh) but I can't see them; the
// signaling server only relays, and those connections are browser ↔ browser.
//   <MeshDiagram you={room.you} peers={mesh.peers} />

const SIZE = 220;
const R = 80;
const C = SIZE / 2;
const STATE_COLOR = { connected: 'var(--ok)', failed: 'var(--err)', closed: 'var(--err)', disconnected: 'var(--warn)' };

export default function MeshDiagram({ you, peers }) {
  // Everyone in join order, so the picture is stable as people come and go.
  const people = [{ id: you.socketId, name: you.name, joinedAt: you.joinedAt, me: true }, ...peers].sort((a, b) => a.joinedAt - b.joinedAt);
  const n = people.length;
  const pos = new Map(
    people.map((p, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [p.id, { x: C + R * Math.cos(a), y: C + R * Math.sin(a) }];
    }),
  );
  const byId = new Map(peers.map((p) => [p.id, p]));

  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = people[i];
      const b = people[j];
      const mine = a.me || b.me;
      const other = byId.get(a.me ? b.id : a.id);
      edges.push({ key: `${a.id}-${b.id}`, a: pos.get(a.id), b: pos.get(b.id), mine, color: mine ? (STATE_COLOR[other?.connection] ?? 'var(--muted)') : 'var(--border)' });
    }
  }

  return (
    <div className="card mesh-card">
      <h2>The mesh</h2>
      <div className="mesh-body">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mesh-svg" role="img" aria-label={`${n} participants, ${edges.length} connections`}>
          {edges.map((e) => (
            <line key={e.key} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={e.color} strokeWidth={e.mine ? 2.5 : 1.5} strokeDasharray={e.mine ? undefined : '4 4'} />
          ))}
          {people.map((p) => {
            const { x, y } = pos.get(p.id);
            return (
              <g key={p.id}>
                <circle cx={x} cy={y} r={14} fill={p.me ? 'var(--accent)' : '#232835'} stroke="var(--text)" strokeWidth={1} />
                <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fill="var(--text)">
                  {p.name.slice(0, 2)}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="mesh-math small">
          <p>
            <strong>N = {n}</strong> people → <strong>N×(N−1)/2 = {(n * (n - 1)) / 2}</strong> connections in the room
          </p>
          <p className="muted">
            You hold <strong>N−1 = {n - 1}</strong> of them. Every chat message is sent {n - 1} time(s). With video, you would upload{' '}
            {n - 1} copies of your camera.
          </p>
          <table className="track-table mesh-table">
            <thead>
              <tr>
                <th>N</th>
                <th>room total</th>
                <th>per person</th>
              </tr>
            </thead>
            <tbody>
              {[2, 3, 4, 5, 6, 10].map((k) => (
                <tr key={k} className={k === n ? 'mesh-current' : undefined}>
                  <td>{k}</td>
                  <td>{(k * (k - 1)) / 2}</td>
                  <td>{k - 1}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Solid = my connections (coloured by state). Dashed = theirs, invisible to me.</p>
        </div>
      </div>
    </div>
  );
}
