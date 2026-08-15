import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Where `/api` and `/socket.io` are forwarded in development.
 *
 * `API_PORT` for the same reason `PORT` is honoured below: the server reads
 * `API_PORT` (never `PORT` — see the gotchas in docs/ENGINEERING_GUIDE.md), so a second stack
 * pointed at a throwaway database needs both halves to agree, and hardcoding 5050
 * here meant the client could only ever talk to the FIRST server on the machine.
 *
 * That is not hypothetical on this repository. The dev stack runs against
 * `pilot.db`, so verifying a change in a browser without touching real data means
 * a second API on another port — and with the target fixed, the only way to reach
 * it was to edit this file and remember to put it back.
 */
const API_TARGET = process.env.VITE_API_TARGET
  || `http://localhost:${process.env.API_PORT || 5050}`

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
        target: API_TARGET,
        changeOrigin: true
      },
      /**
       * Uploaded pictures — profile photographs and organization logos.
       *
       * `server/app.js` already serves these from `UPLOADS_ROOT` and already
       * answers a miss with a real 404 rather than the SPA shell, and its
       * comment describes fixing exactly this symptom ("I can edit my avatar but
       * it never appears"). But that only closed the API side. In development
       * the browser does not talk to the API — it talks to Vite, and Vite
       * proxied `/api` and `/socket.io` and nothing else. So a request for
       * `/uploads/whatever.png` fell through to the SPA fallback and came back
       * as `index.html`: HTTP 200, `content-type: text/html`, which an `<img>`
       * cannot decode and renders as nothing at all.
       *
       * That is the whole reason organization logos "did not appear" — not the
       * serializer, not the component. A 200 that is silently the wrong content
       * type is the worst shape of this bug, because nothing in the network
       * panel looks red.
       */
      '/uploads': {
        target: API_TARGET,
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
        target: API_TARGET,
        ws: true,
        changeOrigin: true
      }
    }
  }
})
