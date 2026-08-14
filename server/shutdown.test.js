/**
 * Graceful-shutdown cover.
 *
 * The process had no signal handlers, so SIGTERM took Node's default action —
 * immediate exit. Every `systemctl restart` therefore dropped in-flight requests,
 * abandoned the notification job already marked `processing`, abandoned any
 * in-flight data export (permanently 409-ing that student out of the feature,
 * since privacyRoutes refuses a new export while one is `pending`/`processing`),
 * and never checkpointed the WAL.
 *
 * These are spawned as real child processes and sent real signals. A unit test
 * that called an exported function would prove the sequence runs, but not the
 * thing that actually mattered: that the process EXITS, promptly and with status
 * 0. The original bug's most likely regression is an interval left armed, which
 * hangs the process instead of throwing — invisible to any in-process assertion.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = process.cwd();

/**
 * Boots server.js as a child, waits until it is listening, then runs `act`.
 *
 * Port 0 is not usable here because the app reads API_PORT and logs the port it
 * chose; a fixed high port per test keeps the boot log parseable and avoids
 * collisions with a developer's running dev server.
 */
function withServer(port, act, { extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-shutdown-'));
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(ROOT, 'server'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        API_PORT: String(port),
        BIND_ADDRESS: '127.0.0.1',
        WEV_DB_PATH: path.join(dir, 'shutdown.db'),
        JWT_SECRET: 'x'.repeat(48),
        APP_URL: `http://127.0.0.1:${port}`,
        // Keeps the drain short so a hung test fails fast rather than at the
        // suite timeout.
        SHUTDOWN_TIMEOUT_MS: '3000',
        ...extraEnv
      }
    });

    let out = '';
    let settled = false;
    const collect = (buf) => { out += String(buf); };
    child.stdout.on('data', (buf) => {
      collect(buf);
      if (!settled && /listening on/i.test(out)) {
        settled = true;
        // Hand control to the caller now that the port is bound.
        Promise.resolve(act(child)).catch(reject);
      }
    });
    child.stderr.on('data', collect);

    child.on('exit', (code, signal) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, signal, out });
    });
    child.on('error', reject);

    // Backstop: if the child never reports listening, fail with its output rather
    // than hanging until vitest's own timeout, which reports nothing useful.
    setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        reject(new Error(`server never started:\n${out}`));
      }
    }, 15_000);
  });
}

describe('SIGTERM shuts the server down cleanly', () => {
  it('exits 0 without needing SIGKILL', async () => {
    const { code, signal, out } = await withServer(5231, (child) => {
      child.kill('SIGTERM');
    });

    // The regression this guards: an interval left armed keeps the event loop
    // alive, the process never exits, and systemd escalates to SIGKILL. A
    // SIGKILLed process reports signal 'SIGKILL' and a null code.
    expect(signal, `expected a self-directed exit, got signal ${signal}\n${out}`).toBeNull();
    expect(code, `expected exit 0\n${out}`).toBe(0);
  }, 30_000);

  it('runs the drain sequence in order', async () => {
    const { out } = await withServer(5232, (child) => {
      child.kill('SIGTERM');
    });

    expect(out).toMatch(/SIGTERM received — draining/);
    expect(out).toMatch(/Notification outbox processor stopped/);
    expect(out).toMatch(/Database closed/);
    expect(out).toMatch(/Shutdown\] Complete/);

    // Ordering matters: the database must close AFTER the workers stop, because
    // they touch it while draining.
    expect(out.indexOf('processor stopped')).toBeLessThan(out.indexOf('Database closed'));
  }, 30_000);

  it('treats SIGINT the same way, so Ctrl-C in dev exercises the real path', async () => {
    const { code, signal, out } = await withServer(5233, (child) => {
      child.kill('SIGINT');
    });

    expect(signal, out).toBeNull();
    expect(code, out).toBe(0);
    expect(out).toMatch(/SIGINT received/);
  }, 30_000);

  it('ignores a second signal rather than running the sequence twice', async () => {
    const { code, out } = await withServer(5234, (child) => {
      child.kill('SIGTERM');
      // An impatient operator, or systemd escalating. Must not re-enter — a second
      // db.close() would throw and a second drain would race the first.
      setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, 50);
    });

    expect(code, out).toBe(0);
    // Exactly one completion line, however many signals arrived.
    expect(out.match(/Shutdown\] Complete/g) || []).toHaveLength(1);
  }, 30_000);

  it('drains an open keep-alive connection and still exits promptly', async () => {
    const port = 5235;
    let firstStatus = null;

    /**
     * The realistic drain case, and the one that hangs without
     * `closeAllConnections()`.
     *
     * An earlier version of this test started a `fetch` and signalled in the same
     * tick, which raced the TCP handshake — the listener closed first, so the
     * request was refused before it ever reached the server and the assertion was
     * measuring a connection error rather than a drain. A keep-alive agent is the
     * honest version: the socket is genuinely open and idle when SIGTERM lands,
     * exactly as a browser's would be, and `httpServer.close()` will not complete
     * until it is dealt with.
     */
    const { code, signal, out } = await withServer(port, async (child) => {
      const agent = new (await import('http')).Agent({ keepAlive: true, maxSockets: 1 });
      const http = await import('http');

      firstStatus = await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/health', agent },
          (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
        );
        req.on('error', () => resolve('failed'));
        req.end();
      });

      // Socket is now open and idle in the agent's pool.
      child.kill('SIGTERM');
    });

    // The request itself must have succeeded before the signal.
    expect(firstStatus, `request failed before shutdown\n${out}`).toBe(200);
    // And the idle keep-alive socket must not have prevented a self-directed exit.
    expect(signal, `expected a clean exit, got ${signal}\n${out}`).toBeNull();
    expect(code, out).toBe(0);
  }, 30_000);
});

describe('the bind address is configurable', () => {
  it('honours BIND_ADDRESS and reports it', async () => {
    const { out } = await withServer(5236, (child) => {
      child.kill('SIGTERM');
    });

    // The runbook claimed 127.0.0.1 was hardcoded while the code bound 0.0.0.0.
    // Now the address is explicit in the boot log so an operator can verify it.
    expect(out).toMatch(/listening on 127\.0\.0\.1:5236/);
  }, 30_000);

  it('warns when bound to all interfaces in production', async () => {
    /**
     * A production boot has to satisfy every startup guard, and the first attempt
     * at this test did not — it reused `'x'.repeat(48)` as JWT_SECRET, which is 48
     * characters of ONE character. config.js rejects a secret with fewer than 8
     * distinct characters as having no real entropy, and that rejection is fatal in
     * production, so the child exited before it ever bound a port.
     *
     * Worth recording rather than just fixing: the guard did exactly its job, on a
     * value that passes a naive length check. The secret below is deliberately
     * high-entropy so this test exercises the bind warning and not the secret check.
     */
    const { out } = await withServer(5237, (child) => {
      child.kill('SIGTERM');
    }, {
      extraEnv: {
        NODE_ENV: 'production',
        BIND_ADDRESS: '0.0.0.0',
        JWT_SECRET: 'Kf9-Zq2mR7tX1wJ4bN8sV3hL6pC0dY5gA2eU7iO9kQ1xM4zT',
        SMTP_HOST: 'smtp.invalid',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        APP_URL: 'https://volunteers.example.org',
        // Fatal boot guard in production, same class as JWT_SECRET above.
        TFA_ENCRYPTION_KEY: 'c3VwZXJzZWNyZXRrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=',
        /* Production refuses to boot without it — every per-IP limiter would
           otherwise share one bucket behind a proxy. Set here so this case
           fails for its own reason rather than on an unrelated guard. */
        TRUST_PROXY: '1',
        REQUIRE_ADMIN_2FA: 'true'
      }
    });

    expect(out).toMatch(/\[Security\] Listening on 0\.0\.0\.0 in production/);
    expect(out).toMatch(/BIND_ADDRESS=127\.0\.0\.1/);
  }, 30_000);
});
