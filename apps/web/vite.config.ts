import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The SPA talks to the API on the same origin in production, because IAP fronts
    // one service. Proxying in dev keeps that true locally, so there is no
    // cross-origin path that only exists on a laptop.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      // /auth is a browser navigation, not a fetch, so it has to proxy too — the
      // GitHub link starts from the SPA on 5173 but must be handled by the API.
      '/auth': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
