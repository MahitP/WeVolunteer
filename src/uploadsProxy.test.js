import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Uploaded pictures reach the browser in development.
 *
 * ── The bug this exists to stop coming back ──
 *
 * Organization logos "did not appear". The serializer was right, the component
 * was right, and the API was right — `server/app.js` serves `/uploads` from
 * `UPLOADS_ROOT` and answers a miss with a real 404, with a comment describing
 * this very symptom ("I can edit my avatar but it never appears").
 *
 * But that only closed the API side, and in development the browser never talks
 * to the API. It talks to Vite, and Vite proxied `/api` and `/socket.io` and
 * nothing else. A request for `/uploads/logo.png` therefore fell through to the
 * SPA fallback and came back as `index.html` — HTTP 200, `content-type:
 * text/html`, which an `<img>` cannot decode and renders as nothing.
 *
 * That is the worst shape this bug can take: nothing goes red. The network panel
 * shows 200, the console shows no error, and the picture is simply absent — so
 * the search goes to the serializer and the component, which are both fine.
 *
 * ── Why a config test rather than a request test ──
 *
 * The proxy table only exists inside `vite dev`. Booting a dev server inside the
 * suite to make one request would be slow and flaky for a guarantee that is
 * fully expressed by one line of configuration. The live behaviour was verified
 * by hand through Vite: `/uploads/org-test-logo.png` → 200 `image/png`, a
 * missing file → 404 `application/json` (not the shell), and an organization
 * logo rendering in search results with `naturalWidth: 64`.
 */

const CONFIG = fs.readFileSync(path.join(process.cwd(), 'vite.config.js'), 'utf8')
  // Comments stripped first: this file explains the fix using the fix's own
  // words, so an un-stripped search would match the prose and pass regardless.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The proxy keys Vite is configured to forward. */
const proxyKeys = [...CONFIG.matchAll(/'(\/[a-zA-Z0-9._-]+)':\s*\{/g)].map(m => m[1]);

describe('the dev server forwards what the API owns', () => {
  it('proxies /uploads, so pictures are not answered with the SPA shell', () => {
    expect(
      proxyKeys,
      'without this every uploaded avatar and organization logo is served as index.html '
      + 'with HTTP 200, which an <img> silently fails to decode',
    ).toContain('/uploads');
  });

  it('still proxies the routes it already did', () => {
    /* Guarding against a fix that adds one entry by replacing another — both of
       these have their own recorded incident in this file's comments. */
    expect(proxyKeys).toContain('/api');
    expect(proxyKeys).toContain('/socket.io');
  });

  it('sends uploads to the same place as the API', () => {
    /**
     * A literal host here would be the next bug: `API_TARGET` honours the port
     * the dev harness assigns, and a hardcoded `localhost:5000` would work on
     * one machine and 404 on every other.
     */
    const block = CONFIG.slice(CONFIG.indexOf("'/uploads'"));
    const target = block.slice(0, block.indexOf('}')).match(/target:\s*([A-Za-z_$][\w$]*)/);
    expect(target?.[1], '/uploads must use the shared API_TARGET, not a literal').toBe('API_TARGET');
  });
});
