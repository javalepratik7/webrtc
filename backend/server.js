// Entry point: builds the Express app and starts the HTTP server.
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import config from './config/index.js';
import logger from './utils/logger.js';
import healthRoutes from './routes/healthRoutes.js';
import networkRoutes from './routes/networkRoutes.js';
import { attachSocketServer } from './socket/index.js';
import sfuRoutes from './routes/sfuRoutes.js';
import { startWorkers } from './mediasoup/workers.js';

const app = express();

// The browser never calls :4000 directly: every request goes to the HTTPS Vite
// origin and is proxied here, so it's same-origin and CORS never kicks in.
// This only matters if something calls the backend cross-origin on purpose.
app.use(cors({ origin: config.clientOrigins }));
app.use(express.json());

// Log every request: method, path, status, duration.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use('/api/health', healthRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/sfu', sfuRoutes);

// Anything else under /api is an unknown endpoint.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// We create the http.Server ourselves (instead of app.listen) so Socket.IO can
// attach to this same server object: one port for REST and signaling.
const server = http.createServer(app);
attachSocketServer(server);

// Step 14: mediasoup workers (C++ processes). Not fatal if they fail: the 1:1 and
// mesh pages don't need them; sfu:join answers "SFU not available" instead.
const ms = config.mediasoup;
startWorkers()
  .then(() => {
    logger.info(`mediasoup: RTC ports ${ms.rtcMinPort}–${ms.rtcMaxPort} UDP+TCP on ${ms.listenIp}, announced as ${ms.announcedIp}${ms.announcedIpFromEnv ? '' : ' (auto-detected LAN IP: set MEDIASOUP_ANNOUNCED_IP to override)'}`);
  })
  .catch((err) => logger.error(`mediasoup workers failed to start: ${err.message}`));

server.listen(config.port, () => {
  logger.info(`Backend listening on http://localhost:${config.port} (${config.env})`);
  logger.info(`Allowed client origin(s): ${config.clientOrigins.join(', ')}`);
});
