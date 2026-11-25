// mediasoup Workers: one C++ process (`mediasoup-worker`) per CPU core.
//
// Node.js runs the API (signaling, rooms, bookkeeping). The worker processes do
// the real work: ICE, DTLS, SRTP decrypt/encrypt, RTP/RTCP, congestion control,
// forwarding packets. Each worker is single-threaded, so one worker ≈ one core.
// More cores → more workers → more rooms in parallel.
//
//   await startWorkers()      at boot
//   getNextWorker()           round-robin: each new ROOM goes to the next worker
//   workersReady()            false until started / if startup failed
//
// A worker can die (crash, OOM-kill, `kill -9`). Every Router on it dies too (and
// with it every transport, producer and consumer of those rooms). We log it, start
// a replacement in the same slot, and the rooms notice via router 'workerclose'
// (see sfuRoom.js). Calls in those rooms must re-join. Other workers are untouched.
import * as mediasoup from 'mediasoup';
import logger from '../utils/logger.js';
import msConfig from './config.js';

const workers = []; // slot index → Worker
let next = 0;
let started = false;

async function createWorker(slot) {
  const worker = await mediasoup.createWorker(msConfig.worker);
  worker.appData.slot = slot;
  workers[slot] = worker;

  worker.on('died', (error) => {
    logger.error(`mediasoup worker #${slot} (pid ${worker.pid}) DIED: ${error?.message ?? error}. Its rooms are gone; restarting it in 2 s`);
    setTimeout(() => {
      createWorker(slot)
        .then((w) => logger.warn(`mediasoup worker #${slot} restarted (pid ${w.pid})`))
        .catch((err) => logger.error(`mediasoup worker #${slot} could not be restarted: ${err.message}`));
    }, 2000);
  });

  return worker;
}

export async function startWorkers() {
  const n = msConfig.numWorkers;
  for (let i = 0; i < n; i++) await createWorker(i);
  started = true;
  logger.info(`mediasoup ${mediasoup.version}: ${n} worker(s) started (pids ${workers.map((w) => w.pid).join(', ')})`);
  return workers;
}

export function workersReady() {
  return started && workers.some((w) => w && !w.closed && !w.died);
}

// Round-robin over live workers. A ROOM is pinned to one worker (its Router lives
// there), so a single room is limited to ~one core. Bigger rooms would spread
// over several routers with router.pipeToRouter(), which is out of scope here.
export function getNextWorker() {
  for (let tries = 0; tries < workers.length; tries++) {
    const w = workers[next];
    next = (next + 1) % workers.length;
    if (w && !w.closed && !w.died) return w;
  }
  throw new Error('No mediasoup worker available');
}

export async function workerStats() {
  return Promise.all(
    workers.filter((w) => w && !w.closed).map(async (w) => {
      const usage = await w.getResourceUsage(); // getrusage() of the C++ process (ms)
      return { slot: w.appData.slot, pid: w.pid, cpuMs: usage.ru_utime + usage.ru_stime, maxRssKb: usage.ru_maxrss };
    }),
  );
}
