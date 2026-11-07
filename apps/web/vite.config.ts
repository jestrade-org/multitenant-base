import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    // The API is a separate origin in every environment, so the client always speaks to
    // it over HTTP rather than being served from it. Proxying in development keeps that
    // true while avoiding a CORS setup that production would not use.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: true },
    },
  },
  build: {
    // Source maps are uploaded to the error tracker at build time and never served
    // publicly (observability.md).
    sourcemap: true,
  },
});
