import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Middleware ordering in production (Task 11).
 *
 * The bug: `/health` was registered AFTER the production `app.get('*')` SPA
 * catch-all, so in production a health check fell through to the SPA and
 * returned `text/html` — a load balancer would see 200 OK against a dead API.
 * The error handler was also registered before the static/SPA block, so errors
 * thrown there bypassed it.
 *
 * `app.js` fixes its route order at import time from NODE_ENV, so this must run
 * the app in a real production-mode subprocess (mirrors email.production.test.js).
 * SMTP_* are set because importing app.js transitively imports email.js, which
 * exits in production without SMTP.
 */
function bootProdAndProbe() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wev-ordering-'));
  const dbFile = path.join(dir, 'test.db');
  const root = process.cwd().replace(/\\/g, '/');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { initDatabase, completeDatabaseInit } = await import('${root}/server/db.js');
      initDatabase();
      await completeDatabaseInit();
      const { app } = await import('${root}/server/app.js');
      const server = app.listen(0);
      await new Promise(r => server.once('listening', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const health = await fetch(base + '/health');
      const api404 = await fetch(base + '/api/does-not-exist-xyz');
      const spa = await fetch(base + '/some/spa/route');
      // A browser sends Origin when fetching <script type="module">, even
      // same-origin. CORS_ORIGINS is left at its localhost default here, so
      // this origin is deliberately NOT on the allowlist.
      const spaWithOrigin = await fetch(base + '/some/spa/route', {
        headers: { Origin: base }
      });
      const apiForeignOrigin = await fetch(base + '/api/events', {
        headers: { Origin: 'https://evil.example' }
      });
      const apiAllowedOrigin = await fetch(base + '/api/events', {
        headers: { Origin: 'http://localhost:5173' }
      });
      // Browsers attach Origin to same-origin POSTs. 'base' is not on the
      // allowlist, so this only passes via the same-origin comparison.
      const apiSameOriginPost = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.org', password: 'wrong-password' })
      });
      const apiForeignPost = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.org', password: 'wrong-password' })
      });
      console.log('RESULT' + JSON.stringify({
        healthStatus: health.status,
        healthCT: health.headers.get('content-type') || '',
        healthBody: await health.text(),
        api404Status: api404.status,
        api404CT: api404.headers.get('content-type') || '',
        spaCT: spa.headers.get('content-type') || '',
        spaWithOriginStatus: spaWithOrigin.status,
        spaWithOriginCT: spaWithOrigin.headers.get('content-type') || '',
        spaBody: await spa.text(),
        apiForeignOriginStatus: apiForeignOrigin.status,
        apiAllowedOriginStatus: apiAllowedOrigin.status,
        apiSameOriginPostStatus: apiSameOriginPost.status,
        apiForeignPostStatus: apiForeignPost.status,
        spaWithOriginBody: await spaWithOrigin.text(),
      }));
      server.close();
    `], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        REQUIRE_ADMIN_2FA: 'true',
        WEV_DB_PATH: dbFile,
        DEMO_MODE: '',
        JWT_SECRET: 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm',
        SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASS: 'p',
        // Required in production since email.js started enforcing it.
        APP_URL: 'https://volunteers.example.org',
        // Required in production since two-factor authentication started
        // encrypting stored TOTP secrets. Same class of guard as JWT_SECRET.
        TFA_ENCRYPTION_KEY: 'c3VwZXJzZWNyZXRrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=',
        /* Production refuses to boot without it — every per-IP limiter would
           otherwise share one bucket behind a proxy. Set here so this case
           fails for its own reason rather than on an unrelated guard. */
        TRUST_PROXY: '1',
      },
      stdio: 'pipe',
      encoding: 'utf8'
    });
    console.log("Subprocess output:\n", out);
    const line = out.split('\n').find(l => l.startsWith('RESULT'));
    return JSON.parse(line.slice('RESULT'.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('production middleware ordering (Task 11)', () => {
  const probe = bootProdAndProbe();

  it('/health returns JSON, never the SPA HTML, in production', () => {
    expect(probe.healthStatus).toBe(200);
    expect(probe.healthCT).toMatch(/application\/json/);
    expect(probe.healthCT).not.toMatch(/text\/html/);
    expect(JSON.parse(probe.healthBody)).toMatchObject({ status: 'ok' });
  });

  it('an unknown /api path still returns a JSON 404 in production', () => {
    expect(probe.api404Status).toBe(404);
    expect(probe.api404CT).toMatch(/application\/json/);
  });

  it('the SPA catch-all is present and serving HTML for non-API routes (so the health check is a meaningful test)', () => {
    // Proves /health returning JSON is not merely because the catch-all is
    // absent — a real SPA route still gets index.html.
    expect(probe.spaCT).toMatch(/text\/html/);
  });
});

/**
 * CORS must guard the API without being able to take the whole app offline.
 *
 * The bug: `cors()` was mounted globally, so it also guarded `dist/`. Browsers
 * attach an `Origin` header when fetching `<script type="module">` — including
 * same-origin — so any deployment whose CORS_ORIGINS did not exactly match its
 * public origin answered its own JavaScript bundle with 403 and rendered a
 * blank white page. Observed directly: assets 403, `#root` empty, no console
 * error a user could act on.
 *
 * These probes use an origin that is NOT on the allowlist (the default is the
 * two localhost dev ports), which is exactly the misconfigured-production case.
 */
describe('CORS scope', () => {
  const probe = bootProdAndProbe();

  it('serves the SPA even when the request carries an unlisted Origin', () => {
    expect(probe.spaWithOriginStatus).toBe(200);
    expect(probe.spaWithOriginCT).toMatch(/text\/html/);
  });

  it('still refuses an API call from an origin that is not allowed', () => {
    expect(probe.apiForeignOriginStatus).toBe(403);
  });

  it('lets an allowed origin through to normal auth handling', () => {
    // 401 (needs a token), not 403 (origin refused) — proves the allowlist is
    // doing its job rather than being bypassed by the scoping change.
    expect(probe.apiAllowedOriginStatus).toBe(401);
  });

  it('accepts a same-origin POST even when that origin is not on the allowlist', () => {
    // The production topology serves the SPA and the API from one origin, and
    // browsers attach Origin to POSTs. Without the same-origin comparison this
    // was 403 — every login failed on any deployment whose CORS_ORIGINS did not
    // exactly match its public URL, while GETs kept working.
    // 401 = credentials rejected, i.e. the request reached the login handler.
    expect(probe.apiSameOriginPostStatus).toBe(401);
  });

  it('still refuses a cross-origin POST', () => {
    expect(probe.apiForeignPostStatus).toBe(403);
  });
});
