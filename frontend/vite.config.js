import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Step 2: serve the dev server over HTTPS so the page is a "secure context"
// (required for getUserMedia) even when opened from a phone via the LAN IP.
// The certs are generated locally with mkcert and are gitignored (see notes/step02.md).
const certDir = fileURLToPath(new URL('./certs/', import.meta.url));
const certFile = `${certDir}dev-cert.pem`;
const keyFile = `${certDir}dev-key.pem`;

if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
  throw new Error(
    `HTTPS certs not found in ${certDir}\n` +
      'Generate them with mkcert (from the frontend/ folder):\n' +
      '  mkdir -p certs && mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem \\\n' +
      '    localhost 127.0.0.1 ::1 <your-LAN-IP>\n',
  );
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // fail instead of silently moving to 5174 (the cert/URLs assume 5173)
    host: true, // listen on all interfaces (0.0.0.0) so the phone can reach it via the LAN IP
    https: {
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
    },
    // The browser (laptop or phone) ONLY talks to this HTTPS origin.
    // Vite forwards these paths to the plain-HTTP Express backend on the same machine.
    proxy: {
      '/api': 'http://localhost:4000',
      // Step 8: Socket.IO uses HTTP long-polling first, then upgrades to a WebSocket.
      // ws: true makes Vite proxy the upgrade too (wss:// from browser -> ws:// to backend).
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
      },
    },
  },
});
