// getStats() → one summary per peer connection, for the mesh stats table (step 13).
//
//   const s = summarizePeerStats(await pc.getStats(), previousSummary);
//
// Rates (kbps, fps of CPU time…) need two samples: we keep the cumulative
// counters of the previous call and divide the difference by the elapsed time.
//
// Upload/download come from the `transport` report (everything on the wire for
// this connection: RTP + RTCP + data channel + headers), falling back to the
// sum of outbound/inbound-rtp bytes where there's no transport report (Firefox).
//
// encodePct: Σ Δ outbound-rtp.totalEncodeTime / Δt. Seconds of encoder work per
// second of wall clock = fraction of ONE CPU core spent encoding video for this
// peer. In a mesh you pay it once PER PEER: that's the number that explodes.
import { selectedPair } from './webrtc.js';

const rate = (now, before, dt) => (before == null || !dt ? null : Math.max(0, now - before) / dt);

export function summarizePeerStats(report, prev) {
  const time = performance.now();
  const dt = prev ? (time - prev.time) / 1000 : 0;

  let transportSent = null;
  let transportReceived = null;
  let rtpSent = 0;
  let rtpReceived = 0;
  let encodeTime = 0;
  let decodeTime = 0;
  let lost = 0;
  let received = 0;
  let lossOut = null;
  const outVideo = [];
  const inVideo = [];

  report.forEach((r) => {
    if (r.type === 'transport') {
      transportSent = (transportSent ?? 0) + (r.bytesSent ?? 0);
      transportReceived = (transportReceived ?? 0) + (r.bytesReceived ?? 0);
    } else if (r.type === 'outbound-rtp') {
      rtpSent += r.bytesSent ?? 0;
      if (r.kind === 'video') {
        encodeTime += r.totalEncodeTime ?? 0;
        // Only streams that are actually flowing (an inactive screen-share sender keeps its old report).
        if (r.frameWidth && r.framesPerSecond != null) {
          outVideo.push({ w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond ?? 0, limit: r.qualityLimitationReason, encoder: r.encoderImplementation });
        }
      }
    } else if (r.type === 'inbound-rtp') {
      rtpReceived += r.bytesReceived ?? 0;
      lost += Math.max(0, r.packetsLost ?? 0);
      received += r.packetsReceived ?? 0;
      if (r.kind === 'video') {
        decodeTime += r.totalDecodeTime ?? 0;
        if (r.frameWidth && r.framesPerSecond != null) inVideo.push({ w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond ?? 0 });
      }
    } else if (r.type === 'remote-inbound-rtp' && r.fractionLost != null) {
      // What the PEER reports about our packets (RTCP receiver reports).
      lossOut = Math.max(lossOut ?? 0, r.fractionLost);
    }
  });

  const bytesSent = transportSent ?? rtpSent;
  const bytesReceived = transportReceived ?? rtpReceived;
  const dLost = prev ? lost - prev.lost : 0;
  const dReceived = prev ? received - prev.received : 0;
  const pair = selectedPair(report);
  const limits = outVideo.map((v) => v.limit).filter((l) => l && l !== 'none');

  return {
    // cumulative counters (for the next call)
    time,
    bytesSent,
    bytesReceived,
    encodeTime,
    decodeTime,
    lost,
    received,
    // what the table shows
    path: pair ? `${pair.local?.type ?? '?'} ↔ ${pair.remote?.type ?? '?'} ${pair.local?.protocol ?? ''}` : null,
    relay: pair?.local?.type === 'relay' || pair?.remote?.type === 'relay',
    rttMs: pair?.rttMs ?? null,
    upKbps: prev ? (rate(bytesSent, prev.bytesSent, dt) * 8) / 1000 : null,
    downKbps: prev ? (rate(bytesReceived, prev.bytesReceived, dt) * 8) / 1000 : null,
    outVideo,
    inVideo,
    lossInPct: prev && dLost + dReceived > 0 ? (100 * dLost) / (dLost + dReceived) : prev ? 0 : null,
    lossOutPct: lossOut != null ? lossOut * 100 : null,
    limitation: limits.length ? [...new Set(limits)].join(', ') : outVideo.length ? 'none' : null,
    encodePct: prev ? rate(encodeTime, prev.encodeTime, dt) * 100 : null,
    decodePct: prev ? rate(decodeTime, prev.decodeTime, dt) * 100 : null,
  };
}
