// One row per peer connection, refreshed every 2 s, + my totals across all of them.
// Mesh (step 13): one row per peer. SFU (step 15): one row per TRANSPORT, so just
// "send" and "recv", whatever the room size. onSetMaxBitrate is optional.
//
//   <PeerStatsTable peers={mesh.peers} getPeerStats={mesh.getPeerStats} onSetMaxBitrate={mesh.setMaxBitrate} />
//
// The totals are the point of step 13: in a mesh, my upload ≈ (N−1) × one stream,
// and my encoder CPU ≈ (N−1) × one encode, because every connection encodes separately.
import { useEffect, useRef, useState } from 'react';

const REFRESH_MS = 2000;
export const BITRATE_OPTIONS = [null, 2500, 1500, 1000, 600, 300, 150, 50];

const num = (v, digits = 0) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(digits));
const kbps = (v) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} Mbps` : `${v.toFixed(0)} kbps`);
const videoText = (list) => (list.length ? list.map((v) => `${v.w}×${v.h}@${num(v.fps)}`).join(' + ') : '–');

function BitrateSelect({ value, onChange, label }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} aria-label={label}>
      {BITRATE_OPTIONS.map((b) => (
        <option key={b ?? 'none'} value={b ?? ''}>
          {b ? `${b} kbps` : 'unlimited'}
        </option>
      ))}
    </select>
  );
}

export default function PeerStatsTable({ peers, getPeerStats, onSetMaxBitrate }) {
  const [stats, setStats] = useState({});
  const getRef = useRef(getPeerStats);
  getRef.current = getPeerStats;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await getRef.current();
      if (!cancelled) setStats(s);
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const rows = peers.map((p) => ({ peer: p, s: stats[p.id] }));
  const sum = (key) => rows.reduce((acc, { s }) => acc + (s?.[key] ?? 0), 0);
  const encoders = rows.reduce((acc, { s }) => acc + (s?.outVideo.length ?? 0), 0);
  const totals = { up: sum('upKbps'), down: sum('downKbps'), encode: sum('encodePct'), decode: sum('decodePct') };
  const allSame = peers.length && peers.every((p) => p.maxKbps === peers[0].maxKbps) ? peers[0].maxKbps : undefined;

  return (
    <div className="card peer-stats">
      <h2>
        Per-peer stats <span className="muted small">(getStats every 2 s, one row per RTCPeerConnection)</span>
      </h2>
      <div className="stat-tiles">
        <div>
          <span className="muted small">My total upload</span>
          <strong>{kbps(totals.up)}</strong>
          <span className="muted small">over {peers.length} connection(s)</span>
        </div>
        <div>
          <span className="muted small">My total download</span>
          <strong>{kbps(totals.down)}</strong>
        </div>
        <div>
          <span className="muted small">Video encoders running</span>
          <strong>{encoders}</strong>
          <span className="muted small">mesh: one per peer · SFU: one per simulcast layer</span>
        </div>
        <div>
          <span className="muted small">Encode / decode CPU</span>
          <strong>
            {num(totals.encode)}% / {num(totals.decode)}%
          </strong>
          <span className="muted small">of one core</span>
        </div>
        {onSetMaxBitrate && (
          <div>
            <span className="muted small">Max video bitrate, every peer</span>
            <BitrateSelect value={allSame} onChange={(v) => onSetMaxBitrate('all', v)} label="Max video bitrate for all peers" />
            <span className="muted small">sender.setParameters</span>
          </div>
        )}
      </div>
      <div className="table-scroll">
        <table className="track-table stats-table">
          <thead>
            <tr>
              <th>Peer</th>
              <th>Path</th>
              <th>RTT</th>
              <th>↑ up</th>
              <th>↓ down</th>
              <th>↑ I send (video)</th>
              <th>↓ I receive (video)</th>
              <th>Loss ↓ / ↑</th>
              <th>Limited by</th>
              <th>Encode CPU</th>
              {onSetMaxBitrate && <th>Max ↑ video</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={onSetMaxBitrate ? 11 : 10} className="muted">
                  No peers yet.
                </td>
              </tr>
            )}
            {rows.map(({ peer: p, s }) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong>
                  {p.connection !== 'connected' && <span className="muted small"> ({p.connection})</span>}
                </td>
                <td>
                  <code>{s?.path ?? '–'}</code>
                </td>
                <td>{s?.rttMs != null ? `${num(s.rttMs, 1)} ms` : '–'}</td>
                <td>{kbps(s?.upKbps)}</td>
                <td>{kbps(s?.downKbps)}</td>
                <td>{s ? videoText(s.outVideo) : '–'}</td>
                <td>{s ? videoText(s.inVideo) : '–'}</td>
                <td>
                  {num(s?.lossInPct, 1)}% / {num(s?.lossOutPct, 1)}%
                </td>
                <td className={s?.limitation && s.limitation !== 'none' ? 'stats-warn' : undefined}>{s?.limitation ?? '–'}</td>
                <td>{s?.encodePct != null ? `${num(s.encodePct)}%` : '–'}</td>
                {onSetMaxBitrate && (
                  <td>
                    <BitrateSelect value={p.maxKbps} onChange={(v) => onSetMaxBitrate(p.id, v)} label={`Max video bitrate to ${p.name}`} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td />
                <td />
                <td>
                  <strong>{kbps(totals.up)}</strong>
                </td>
                <td>
                  <strong>{kbps(totals.down)}</strong>
                </td>
                <td colSpan={4} className="muted small">
                  ≈ {peers.length} × one stream each way
                </td>
                <td>
                  <strong>{num(totals.encode)}%</strong>
                </td>
                {onSetMaxBitrate && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        <strong>Limited by</strong> = <code>qualityLimitationReason</code>: <code>bandwidth</code> (congestion control says the link is full),{' '}
        <code>cpu</code> (the encoder can&apos;t keep up, so resolution/fps drop), <code>none</code>. <strong>Encode CPU</strong> = Δ
        totalEncodeTime / Δt.
      </p>
    </div>
  );
}
