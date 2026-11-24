// Entry point: builds the Express app and starts the HTTP server.
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import config from './config/index.js';
import logger from './utils/logger.js';
import healthRoutes from './routes/healthRoutes.js';

const app = express();

// In dev the Vite proxy makes requests same-origin, so CORS isn't strictly needed.
// It matters when the frontend calls the backend directly (e.g. phone on LAN, Step 2).
app.use(cors({ origin: config.clientOrigin }));
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

// Anything else under /api is an unknown endpoint.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// We create the http.Server ourselves (instead of app.listen) because in Step 8
// Socket.IO needs to attach to this same server object.
const server = http.createServer(app);

server.listen(config.port, () => {
  logger.info(`Backend listening on http://localhost:${config.port} (${config.env})`);
  logger.info(`Allowed client origin: ${config.clientOrigin}`);
});
