import { defineConfig, loadEnv } from 'vite'
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

/**
 * Whether this build carries the on-device assistant. Defaults to ON.
 *
 * ── Why the default lives here rather than in an environment file ──
 *
 * It used to be opt-in: `VITE_LOCAL_AI` unset meant no Welly, and the only way
 * to see the feature was `npm run dev:ai`. That was right while the assistant
 * was being built and wrong the moment it was finished — a feature nobody can
 * reach without knowing the name of an undocumented variable is a feature that
 * is off in every deployment where somebody forgot, including production. The
 * failure mode is silence: nothing errors, the launcher simply is not there.
 *
 * An environment file cannot fix that, because the problem IS the environment
 * file — `.env` is not committed, so "remember to set this" is exactly the step
 * that gets missed. A default in the config travels with the repository.
 *
 * ── Why `define` rather than reading it in `config.js` ──
 *
 * The value must survive as a LITERAL in the transformed source. `src/ai/index.js`
 * guards its dynamic imports with `import.meta.env.VITE_LOCAL_AI === 'true'`, and
 * that comparison folding to a constant is the only thing that keeps the 7.66 MB
 * `wllama.wasm` out of a build with the feature off — an imported constant does
 * not fold across the module boundary and ships the runtime anyway (measured:
 * 10,144 KB vs 2,652 KB; see src/ai/bundleCost.test.js).
 *
 * `define` performs exactly that textual substitution, so the guard keeps working
 * character-for-character, and turning the feature OFF still removes the runtime
 * from the output. What changes is only which way the default points.
 *
 * ── What it does NOT do ──
 *
 * This switches on the OFFER, never a download. No model is fetched until
 * somebody opens Welly and chooses one; a device that cannot run one is never
 * offered one. See `src/ai/capability.js` and the note in `src/config.js`.
 *
 * `VITE_LOCAL_AI=false` (or an empty string, which is what
 * `bin/verify-ai-bundle.mjs` builds with) opts out and drops the assets.
 *
 * ── Precedence ──
 *
 * Shell environment, then `.env` files for the mode, then this default. The
 * `.env` layer is read explicitly with `loadEnv` because `define` bypasses
 * Vite's own env handling entirely: without it, a deployment that had written
 * `VITE_LOCAL_AI=false` into its `.env` would be silently overridden by the
 * default here — the config would be ignoring the one file an operator would
 * expect to be authoritative.
 */
function localAiFlag(mode) {
  const fromFiles = loadEnv(mode, process.cwd(), 'VITE_')
  return process.env.VITE_LOCAL_AI ?? fromFiles.VITE_LOCAL_AI ?? 'true'
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_LOCAL_AI': JSON.stringify(localAiFlag(mode)),
  },
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
}))
