/**
 * Liveness and readiness answer different questions, and the difference has to
 * survive contact with a real server.
 *
 * The failure this guards against is subtle and common: a liveness probe that
 * quietly depends on the database. A supervisor then restarts a healthy process
 * every time the database has a bad thirty seconds, and a recoverable blip
 * becomes a restart loop that takes the application down properly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); }, 60000);
afterAll(async () => { await srv?.close(); });

describe('/live — liveness', () => {
  it('answers 200 with no authentication', async () => {
    const res = await srv.call('GET', '/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports a version, so a deploy can be confirmed from the probe', async () => {
    const res = await srv.call('GET', '/live');
    expect(res.body.version).toBeTruthy();
  });

  /**
   * The point of the endpoint. It must not report the database at all — not
   * even as informational detail — because anything present in the payload is
   * something a future change can be tempted to gate on.
   */
  it('says nothing about the database', async () => {
    const res = await srv.call('GET', '/live');
    expect(res.body).not.toHaveProperty('database');
    expect(res.body).not.toHaveProperty('writable');
  });
});

describe('/ready — readiness', () => {
  it('answers 200 when the database is usable', async () => {
    const res = await srv.call('GET', '/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
    expect(res.body.writable).toBe(true);
  });

  it('reports optional dependencies without gating on them', async () => {
    const res = await srv.call('GET', '/ready');
    expect(res.body.dependenciesNonGating).toBeTruthy();
    expect(res.body.dependenciesNonGating).toHaveProperty('redis');
    expect(res.body.dependenciesNonGating).toHaveProperty('pinecone');
  });

  /**
   * The invariant that matters most here.
   *
   * In this environment neither Redis nor Pinecone is configured — which is
   * exactly the degraded state a free-tier outage produces. Readiness must
   * still be 200: a volunteer can apply, be accepted, be marked present and
   * have hours credited with both of them down, so an outage in either must
   * not tell a monitor the application cannot serve traffic.
   */
  it('stays ready while optional dependencies are unconfigured', async () => {
    const res = await srv.call('GET', '/ready');
    expect(res.body.dependenciesNonGating.redis.configured).toBe(false);
    expect(res.body.dependenciesNonGating.pinecone.configured).toBe(false);
    expect(res.status).toBe(200);
  });

  it('does not leak connection detail to an unauthenticated caller', async () => {
    const res = await srv.call('GET', '/ready');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/postgres:\/\/|password|@.*supabase/i);
  });
});

describe('/health — unchanged contract', () => {
  /**
   * A Better Stack monitor already points here and goes red when the database
   * is unreachable. Repurposing it as liveness would have silently converted
   * the one alert that catches a database outage into one that catches nothing,
   * with nothing visible on the dashboard to show it. Pinned so a future tidy-up
   * has to break a test rather than an alert.
   */
  it('still gates on the database', async () => {
    const res = await srv.call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected', writable: true });
  });

  it('is JSON, never the SPA shell', async () => {
    const res = await srv.call('GET', '/health');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
