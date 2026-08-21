import { describe, it, expect } from 'vitest';
import viteConfig from '../vite.config.js';

/**
 * Guards the development proxy table.
 *
 * `/socket.io` was missing from it, so in development every realtime request
 * fell through to Vite's SPA fallback and was answered with index.html
 * (`content-type: text/html`). socket.io-client parsed the HTML shell as a
 * handshake, failed, and — configured with `reconnectionAttempts: Infinity` —
 * retried forever without ever surfacing an error to the user or the console.
 *
 * `src/services/socket.js` documented the proxy as though it existed, which is
 * why nobody looked. A config-shape assertion is the only place this can be
 * caught cheaply: it is invisible to the server test suite (production serves
 * both from one origin and needs no proxy) and invisible to a production build.
 */
describe('vite dev proxy', () => {
  /**
   * The config is a FUNCTION of `{ mode }`, not a plain object.
   *
   * It became one when the on-device AI flag gained a committed default: that
   * default has to consult `loadEnv(mode, …)` so a deployment's own `.env` still
   * wins, and `mode` is only available inside the function form. Reading
   * `viteConfig.server` off the function silently yielded `undefined`, so every
   * assertion here passed against an empty object — the proxy guard would have
   * stopped guarding without failing.
   */
  const resolved = typeof viteConfig === 'function'
    ? viteConfig({ mode: 'development', command: 'serve' })
    : viteConfig;
  const proxy = resolved.server?.proxy || {};

  it('exposes a proxy table at all', () => {
    /* The assertion the four below quietly depended on. */
    expect(Object.keys(proxy).length).toBeGreaterThan(0);
  });

  it('proxies /api to the API server', () => {
    expect(proxy['/api']).toBeDefined();
    expect(proxy['/api'].target).toMatch(/localhost:5050/);
  });

  it('proxies /socket.io to the API server', () => {
    expect(proxy['/socket.io']).toBeDefined();
    expect(proxy['/socket.io'].target).toMatch(/localhost:5050/);
  });

  /**
   * Not optional. socket.io opens over HTTP long-polling and then upgrades to a
   * WebSocket; without `ws: true` the polling transport works and the upgrade
   * silently fails, leaving every client stuck on polling — degraded in a way
   * that looks like it works.
   */
  it('enables WebSocket upgrades on the socket.io proxy', () => {
    expect(proxy['/socket.io'].ws).toBe(true);
  });

  it('points both proxies at the same origin', () => {
    expect(proxy['/socket.io'].target).toBe(proxy['/api'].target);
  });
});
