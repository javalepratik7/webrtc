import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser calls /api/... on the Vite server (same origin, no CORS),
    // and Vite forwards it to the Express backend.
    // Step 8 will add a '/socket.io' entry here with ws: true.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
