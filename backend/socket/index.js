// Attaches Socket.IO to the existing HTTP server (same port as Express: 4000).
//
// Socket.IO starts every connection with HTTP long-polling, then upgrades it to
// a WebSocket when possible. Both arrive at /socket.io/… on this server. In dev
// the browser reaches them through the Vite proxy (ws: true in vite.config.js).
import { Server } from 'socket.io';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import registerRoomHandlers from './roomHandlers.js';

// Who is this? Behind the Vite proxy the TCP peer is always localhost, so use
// X-Forwarded-For (the proxy is configured with xfwd: true) for the real address.
function describeClient(socket) {
  const headers = socket.handshake.headers;
  const ip = (headers['x-forwarded-for'] || socket.handshake.address || '?').split(',')[0].trim();
  const ua = headers['user-agent'] || '';
  const device = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mobile/i.test(ua) ? 'mobile' : 'desktop';
  return `${ip} ${device}`;
}

export function attachSocketServer(httpServer) {
  const io = new Server(httpServer, {
    // CORS only matters for pages on ANOTHER origin connecting directly.
    // It is NOT access control: WebSocket upgrades aren't subject to CORS at all.
    cors: { origin: config.clientOrigins },
    maxHttpBufferSize: 100_000, // 100 KB per message is plenty for SDP (~5 KB); default is 1 MB
  });

  io.on('connection', (socket) => {
    logger.info(`socket ${socket.id.slice(0, 6)} connected via ${socket.conn.transport.name} from ${describeClient(socket)}`);
    socket.conn.once('upgrade', () => {
      logger.info(`socket ${socket.id.slice(0, 6)} upgraded to ${socket.conn.transport.name}`);
    });
    socket.on('disconnect', (reason) => {
      logger.info(`socket ${socket.id.slice(0, 6)} disconnected (${reason})`);
    });

    registerRoomHandlers(io, socket);
  });

  return io;
}
