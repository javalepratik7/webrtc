// Central place for configuration.
// Every other file imports from here instead of reading process.env directly,
// so defaults and type conversion live in ONE spot.
import dotenv from 'dotenv';

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
};

export default config;
