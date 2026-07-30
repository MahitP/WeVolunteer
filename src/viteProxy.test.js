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
  const proxy = viteConfig.server?.proxy || {};

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
