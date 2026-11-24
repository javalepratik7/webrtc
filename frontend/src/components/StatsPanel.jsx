// Renders the summary produced by collectStats() (services/webrtc.js).
const fmt = (n, digits = 0) => (n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(digits));
const bytes = (n) => (n == null ? '-' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
// Chrome hides the address of peer-reflexive remote candidates (privacy), so it can be empty.
const endpoint = (c) => (c ? `${c.type} ${c.protocol} ${c.address || '(hidden)'}:${c.port}` : '-');

export default function StatsPanel({ stats }) {
  if (!stats) return <p className="muted">Press “Stats” while connected.</p>;
  const { pair, outbound, inbound, dataChannels } = stats;

  return (
    <div className="stats">
      <h3>Selected candidate pair (A’s view)</h3>
      {pair ? (
        <dl className="settings-list">
          <div>
            <dt>local</dt>
            <dd>{endpoint(pair.local)}</dd>
          </div>
          <div>
            <dt>remote</dt>
            <dd>{endpoint(pair.remote)}</dd>
          </div>
          <div>
            <dt>state</dt>
            <dd>{pair.state}</dd>
          </div>
          <div>
            <dt>RTT</dt>
            <dd>{pair.rttMs == null ? '-' : `${fmt(pair.rttMs, 1)} ms`}</dd>
          </div>
          <div>
            <dt>available out</dt>
            <dd>{pair.availableOutgoingKbps == null ? '-' : `${fmt(pair.availableOutgoingKbps)} kbps`}</dd>
          </div>
          <div>
            <dt>bytes sent / recv</dt>
            <dd>
              {bytes(pair.bytesSent)} / {bytes(pair.bytesReceived)}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted small">No selected pair yet.</p>
      )}

      {outbound.length > 0 && (
        <>
          <h3>Outbound RTP (A sends)</h3>
          <table className="track-table">
            <thead>
              <tr>
                <th>kind</th>
                <th>codec</th>
                <th>sent</th>
                <th>kbps</th>
                <th>fps</th>
                <th>resolution</th>
                <th>encoder</th>
              </tr>
            </thead>
            <tbody>
              {outbound.map((r) => (
                <tr key={r.key}>
                  <td>{r.kind}</td>
                  <td className="addr">{r.codec ?? '-'}</td>
                  <td>{bytes(r.bytesSent)}</td>
                  <td>{fmt(r.kbps)}</td>
                  <td>{fmt(r.fps)}</td>
                  <td>{r.resolution ?? '-'}</td>
                  <td>
                    {r.encoder ?? '-'}
                    {r.limitation && r.limitation !== 'none' && <span className="muted"> (limited: {r.limitation})</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {inbound.length > 0 && (
        <>
          <h3>Inbound RTP (B receives)</h3>
          <table className="track-table">
            <thead>
              <tr>
                <th>kind</th>
                <th>codec</th>
                <th>received</th>
                <th>kbps</th>
                <th>fps</th>
                <th>lost</th>
                <th>jitter</th>
              </tr>
            </thead>
            <tbody>
              {inbound.map((r) => (
                <tr key={r.key}>
                  <td>{r.kind}</td>
                  <td className="addr">{r.codec ?? '-'}</td>
                  <td>{bytes(r.bytesReceived)}</td>
                  <td>{fmt(r.kbps)}</td>
                  <td>{fmt(r.fps)}</td>
                  <td>{r.packetsLost ?? '-'}</td>
                  <td>{r.jitterMs == null ? '-' : `${fmt(r.jitterMs, 1)} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {dataChannels.length > 0 && (
        <>
          <h3>Data channels</h3>
          <table className="track-table">
            <thead>
              <tr>
                <th>peer</th>
                <th>label</th>
                <th>state</th>
                <th>msgs sent / recv</th>
                <th>bytes sent / recv</th>
              </tr>
            </thead>
            <tbody>
              {dataChannels.map((d) => (
                <tr key={`${d.side}-${d.label}`}>
                  <td>{d.side}</td>
                  <td>{d.label}</td>
                  <td>{d.state}</td>
                  <td>
                    {d.messagesSent} / {d.messagesReceived}
                  </td>
                  <td>
                    {bytes(d.bytesSent)} / {bytes(d.bytesReceived)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted small">
        {stats.reportCount} reports in A’s getStats(). kbps is computed from the difference to the previous sample.
      </p>
    </div>
  );
}
