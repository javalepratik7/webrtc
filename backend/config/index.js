// Central place for configuration.
// Every other file imports from here instead of reading process.env directly,
// so defaults and type conversion live in ONE spot.
import os from 'node:os';
import dotenv from 'dotenv';
import { getLanAddresses } from '../utils/network.js';

dotenv.config({ quiet: true }); // loads backend/.env into process.env

const config = {
  port: Number(process.env.PORT) || 4000,
  // Origin(s) the React app is served from, comma-separated, e.g.
  //   CLIENT_ORIGIN=https://localhost:5173,https://192.168.0.115:5173
  // Used for Express CORS and Socket.IO CORS. In dev every request comes
  // through the Vite proxy (same origin), so this only matters for clients
  // that call the backend directly.
  clientOrigins: (process.env.CLIENT_ORIGIN || 'https://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  env: process.env.NODE_ENV || 'development',

  // Step 14: mediasoup SFU (details and explanations in mediasoup/config.js).
  mediasoup: {
    // How many C++ worker processes. Default: one per CPU core.
    numWorkers: Number(process.env.MEDIASOUP_WORKERS) || os.availableParallelism(),
    // Bind on every interface…
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    // …but TELL browsers this address. Default: the first LAN IPv4 (dev on Wi-Fi).
    // On EC2: the instance's PUBLIC / Elastic IP.
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || getLanAddresses()[0]?.address || '127.0.0.1',
    announcedIpFromEnv: Boolean(process.env.MEDIASOUP_ANNOUNCED_IP),
    rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT) || 40000,
    rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT) || 40100,
  },
};

export default config;
