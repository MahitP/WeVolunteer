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
  const dir = mkdtempSync(path.join(tmpdir(), 'sbv-ordering-'));
  const dbFile = path.join(dir, 'test.db');
  const root = process.cwd().replace(/\\/g, '/');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { initDatabase } = await import('${root}/server/db.js');
      initDatabase();
      const { app } = await import('${root}/server/app.js');
      const server = app.listen(0);
      await new Promise(r => server.once('listening', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const health = await fetch(base + '/health');
      const api404 = await fetch(base + '/api/does-not-exist-xyz');
      const spa = await fetch(base + '/some/spa/route');
      console.log('RESULT' + JSON.stringify({
        healthStatus: health.status,
        healthCT: health.headers.get('content-type') || '',
        healthBody: await health.text(),
        api404Status: api404.status,
        api404CT: api404.headers.get('content-type') || '',
        spaCT: spa.headers.get('content-type') || ''
      }));
      server.close();
    `], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SBV_DB_PATH: dbFile,
        DEMO_MODE: '',
        JWT_SECRET: 'test-secret-not-for-production',
        SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASS: 'p'
      },
      stdio: 'pipe',
      encoding: 'utf8'
    });
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
