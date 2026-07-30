import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Vite does not read PORT on its own — without this it always tries 5173
    // and collides with anything already there. Honouring PORT lets the dev
    // harness assign a free port instead.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true
      },
      /**
       * Socket.IO. This entry did not exist.
       *
       * src/services/socket.js already documented that "in development, the Vite
       * proxy forwards /socket.io to the backend" — but only /api was proxied, so
       * `/socket.io/?EIO=4&transport=polling` fell through to Vite's SPA fallback
       * and answered 200 with `content-type: text/html`. The client parsed the
       * index.html shell as a handshake, failed, and — with
       * `reconnectionAttempts: Infinity` — retried forever without ever
       * surfacing an error.
       *
       * `ws: true` is required, not optional: socket.io opens over HTTP polling
       * and then upgrades to a WebSocket. Without it the polling transport would
       * work and the upgrade would silently fail, leaving the connection stuck on
       * long-polling.
       */
      '/socket.io': {
        target: 'http://localhost:5050',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
