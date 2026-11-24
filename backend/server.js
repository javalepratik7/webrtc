// Entry point: builds the Express app and starts the HTTP server.
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import config from './config/index.js';
import logger from './utils/logger.js';
import healthRoutes from './routes/healthRoutes.js';

const app = express();

// The browser never calls :4000 directly: every request goes to the HTTPS Vite
// origin and is proxied here, so it's same-origin and CORS never kicks in.
// This only matters if something calls the backend cross-origin on purpose.
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
