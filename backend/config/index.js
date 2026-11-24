// Central place for configuration.
// Every other file imports from here instead of reading process.env directly,
// so defaults and type conversion live in ONE spot.
import dotenv from 'dotenv';

dotenv.config({ quiet: true }); // loads backend/.env into process.env

const config = {
  port: Number(process.env.PORT) || 4000,
  // The URL the React app is served from. Used for CORS now and for
  // Socket.IO's CORS settings in Step 8.
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  env: process.env.NODE_ENV || 'development',
};

export default config;
