// Live call stats drawn over the remote video, refreshed every 2 s.
//   <StatsOverlay getStats={peer.getStats} />   (getStats → collectStats summary)
// Bitrates are computed from the difference between two samples, so the first
// sample shows "-" for kbps.
import { useEffect, useState } from 'react';

const INTERVAL_MS = 2000;
const n = (v, d = 0) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(d));
const codecShort = (c) => (c ? c.split(' ')[0].replace(/^(audio|video)\//, '') : '-');

export default function StatsOverlay({ getStats }) {
  const [s, setS] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const summary = await getStats();
        if (!cancelled && summary) setS(summary);
      } catch {
        // connection closed between ticks
      }
    };
    tick();
    const id = setInterval(tick, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [getStats]);

  if (!s) return <div className="stats-overlay">Collecting stats…</div>;
  const outV = s.outbound.find((r) => r.kind === 'video');
  const outA = s.outbound.find((r) => r.kind === 'audio');
  const inV = s.inbound.find((r) => r.kind === 'video');
  const inA = s.inbound.find((r) => r.kind === 'audio');
  const local = s.pair?.local;
  const remote = s.pair?.remote;

  return (
    <div className="stats-overlay" aria-label="Call statistics">
      <div>
        <b>path</b> {local ? `${local.type} ${local.protocol}` : '-'} ↔ {remote ? remote.type : '-'}
        {local?.type === 'relay' && ' (TURN)'} · <b>RTT</b> {s.pair?.rttMs != null ? `${n(s.pair.rttMs, 1)} ms` : '-'}
      </div>
      <div>
        <b>↓ in</b> video {n(inV?.kbps)} kbps · {inV?.resolution ?? '-'} @ {n(inV?.fps)} fps · {codecShort(inV?.codec)}
      </div>
      <div>
        <b>↓ in</b> audio {n(inA?.kbps)} kbps · {codecShort(inA?.codec)} · lost {inV?.packetsLost ?? '-'}/{inA?.packetsLost ?? '-'}
      </div>
      <div>
        <b>↑ out</b> video {n(outV?.kbps)} kbps · {outV?.resolution ?? '-'} @ {n(outV?.fps)} fps · {codecShort(outV?.codec)}
        {outV?.limitation && outV.limitation !== 'none' && ` · limited by ${outV.limitation}`}
      </div>
      <div>
        <b>↑ out</b> audio {n(outA?.kbps)} kbps · {codecShort(outA?.codec)}
      </div>
    </div>
  );
}
