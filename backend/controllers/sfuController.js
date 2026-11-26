// GET /api/sfu → mediasoup workers (pid, CPU, memory) and SFU rooms (peers, producers,
// consumers, server in/out bitrate). Dev/observability helper: watch it while clients join.
import config from '../config/index.js';
import { workerStats, workersReady } from '../mediasoup/workers.js';
import { sfuStats } from '../mediasoup/sfuRoom.js';

// CPU % since the previous request, per worker (100 % = one core). Worker CPU time
// only grows, so the delta between two calls / elapsed wall time = current load.
const previous = new Map(); // pid → { cpuMs, at }

export async function getSfuStatus(req, res) {
  const ms = config.mediasoup;
  const now = Date.now();
  const workers = workersReady() ? await workerStats() : [];
  for (const w of workers) {
    const prev = previous.get(w.pid);
    w.cpuPct = prev && now > prev.at ? Math.round((100 * (w.cpuMs - prev.cpuMs)) / (now - prev.at)) : null;
    previous.set(w.pid, { cpuMs: w.cpuMs, at: now });
  }
  res.json({
    ready: workersReady(),
    announcedIp: ms.announcedIp,
    ports: `${ms.rtcMinPort}-${ms.rtcMaxPort}`,
    workers,
    rooms: await sfuStats(),
  });
}
