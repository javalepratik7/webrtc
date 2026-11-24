// The ONE Socket.IO client instance for the whole app.
//
// No URL: io() connects to the page's own origin (https://<host>:5173), path
// /socket.io. Vite proxies that to the backend on localhost:4000, including the
// WebSocket upgrade (wss:// from the browser, ws:// behind the proxy). So the
// phone only ever talks to the Vite origin, exactly like /api.
//
// Module-level = created once, even with StrictMode / hot reload re-running effects.
// autoConnect: false: we connect when a page actually needs signaling.
import { io } from 'socket.io-client';

export const socket = io({
  autoConnect: false,
  // Defaults: start with HTTP long-polling, upgrade to WebSocket; reconnect
  // automatically with exponential backoff if the server goes away.
});
