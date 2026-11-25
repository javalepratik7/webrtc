// GET /api/sfu → mediasoup workers (pid, CPU time, memory) and SFU rooms (peers, producers, consumers).
// Dev/observability helper: watch it while clients join to see the server side of the SFU.
import config from '../config/index.js';
import { workerStats, workersReady } from '../mediasoup/workers.js';
import { sfuStats } from '../mediasoup/sfuRoom.js';

export async function getSfuStatus(req, res) {
  const ms = config.mediasoup;
  res.json({
    ready: workersReady(),
    announcedIp: ms.announcedIp,
    ports: `${ms.rtcMinPort}-${ms.rtcMaxPort}`,
    workers: workersReady() ? await workerStats() : [],
    rooms: sfuStats(),
  });
}
