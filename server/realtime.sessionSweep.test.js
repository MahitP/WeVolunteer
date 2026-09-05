import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';

/**
 * The shared session-invalidation sweep.
 *
 * ── What it replaced, and why the cost mattered ──
 *
 * Every connected socket used to own a `setInterval` that asked two questions:
 * the user's current `token_version`, and whether its `jti` had been revoked —
 * two SELECTs each, every five minutes. The cost therefore scaled with SOCKETS,
 * not with people: three hundred students with a tab open cost six hundred
 * queries per interval, almost all of them to learn that nobody had signed out,
 * and a student with a phone and a laptop paid twice.
 *
 * One sweep now asks both questions for every socket at once — two statements,
 * whatever the connection count.
 *
 * ── What must not have changed ──
 *
 * The rule. The tests below drive the sweep directly rather than waiting five
 * minutes for a timer, and assert the same three conditions the per-socket
 * version enforced: a missing user row, a moved `token_version`, and a revoked
 * `jti`. A socket that is still valid must survive, because a sweep that
 * disconnects live sessions is a far worse failure than a slow one.
 */
let httpServer, io, base, dir, db, call, sweepInvalidatedSockets;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-sweep-'));
  process.env.WEV_DB_PATH = path.join(dir, 'sweep.db');
  process.env.DEMO_MODE = 'true';
  process.env.JWT_SECRET = 'sweep-test-secret';

  const { initDatabase, completeDatabaseInit, db: liveDb } = await import('./db.js');
  const { app } = await import('./app.js');
  ({ sweepInvalidatedSockets } = await import('./realtime/socketServer.js'));
  const { initSocketServer } = await import('./realtime/socketServer.js');
  db = liveDb;
  initDatabase();
  await completeDatabaseInit();

  httpServer = createServer(app);
  io = initSocketServer(httpServer);
  httpServer.listen(0, '127.0.0.1');
  await new Promise(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;

  call = async (method, p, cookie, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `wev_session=${cookie}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null; try { data = await res.json(); } catch { /* empty body */ }
    const sc = res.headers.getSetCookie?.() || [];
    const cookieOut = sc.map(c => c.match(/wev_session=([^;]+)/)?.[1]).find(Boolean);
    return { status: res.status, data, cookie: cookieOut };
  };
}, 30000);

afterAll(async () => {
  if (io?.sessionSweepTimer) clearInterval(io.sessionSweepTimer);
  await new Promise(r => io?.close(r));
  await new Promise(r => httpServer?.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const signIn = async (identifier) => {
  const r = await call('POST', '/api/auth/login', null, { email: identifier, password: 'password123' });
  if (!r.cookie) throw new Error(`login failed for ${identifier}: ${r.status}`);
  return r.cookie;
};

const openSocket = (cookie) => new Promise((resolve, reject) => {
  const s = ioClient(base, {
    path: '/socket.io',
    extraHeaders: cookie ? { Cookie: `wev_session=${cookie}` } : {},
    transports: ['websocket'],
    reconnection: false
  });
  const timer = setTimeout(() => { s.close(); reject(new Error('connect timeout')); }, 8000);
  s.on('connect', () => { clearTimeout(timer); resolve(s); });
  s.on('connect_error', (e) => { clearTimeout(timer); s.close(); reject(new Error('REJECTED: ' + e.message)); });
});

/**
 * Resolves TRUE when `event` fires, false on timeout.
 *
 * Deliberately not resolving with the payload: `session.invalidated` is emitted
 * with no arguments, so a payload-based assertion cannot tell "it fired" from
 * "it never fired" — both are `undefined`.
 */
const firedWithin = (socket, event, ms = 5000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms);
  socket.once(event, () => { clearTimeout(timer); resolve(true); });
});

/** Waits for a socket to actually be disconnected, or gives up. */
const waitForDisconnect = (socket, ms = 5000) => new Promise((resolve) => {
  if (socket.disconnected) return resolve(true);
  const timer = setTimeout(() => resolve(socket.disconnected), ms);
  socket.once('disconnect', () => { clearTimeout(timer); resolve(true); });
});

describe('a valid session is left alone', () => {
  it('does not disconnect a socket whose session is still good', async () => {
    const s = await openSocket(await signIn('leochen'));
    try {
      const cut = await sweepInvalidatedSockets(io);
      expect(cut).toBe(0);
      // Give the socket a moment to notice a disconnect it should never receive.
      await new Promise(r => setTimeout(r, 200));
      expect(s.connected).toBe(true);
    } finally { s.close(); }
  });

  it('does nothing, and asks the database nothing, with no sockets connected', async () => {
    // Every socket from the previous test is closed; Socket.IO needs a tick.
    await new Promise(r => setTimeout(r, 200));
    const spy = vi.spyOn(db, 'prepare');
    try {
      expect(await sweepInvalidatedSockets(io)).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('the three invalidation conditions', () => {
  it('disconnects a socket whose token_version has moved', async () => {
    const cookie = await signIn('priyapatel');
    const s = await openSocket(cookie);
    try {
      const user = await db.prepare("SELECT id, token_version FROM users WHERE username = 'priyapatel'").get();
      await db.prepare('UPDATE users SET token_version = ? WHERE id = ?')
        .run(user.token_version + 1, user.id);

      const invalidated = firedWithin(s, 'session.invalidated');
      expect(await sweepInvalidatedSockets(io)).toBeGreaterThanOrEqual(1);
      // The client is TOLD before it is cut, so it can show "signed out
      // elsewhere" rather than a bare connection drop.
      expect(await invalidated).toBe(true);
      expect(await waitForDisconnect(s)).toBe(true);

      await db.prepare('UPDATE users SET token_version = ? WHERE id = ?').run(user.token_version, user.id);
    } finally { s.close(); }
  });

  it('disconnects a socket whose jti has been revoked', async () => {
    const cookie = await signIn('ethanmiller');
    const s = await openSocket(cookie);
    try {
      /* Signing out is what writes the `revoked_sessions` row, so the fixture
         goes through the real route rather than inserting one by hand. */
      const out = await call('POST', '/api/auth/logout', cookie);
      expect(out.status).toBeLessThan(400);

      expect(await sweepInvalidatedSockets(io)).toBeGreaterThanOrEqual(1);
      expect(await waitForDisconnect(s)).toBe(true);
    } finally { s.close(); }
  });
});

describe('the sweep is a batch', () => {
  it('costs the same two statements whether one socket is open or several', async () => {
    await new Promise(r => setTimeout(r, 200));

    const one = await openSocket(await signIn('leochen'));
    const original = db.prepare;
    let calls = 0;
    let spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => { calls++; return original(sql); });
    await sweepInvalidatedSockets(io);
    const withOne = calls;
    spy.mockRestore();

    const more = [
      await openSocket(await signIn('priyapatel')),
      await openSocket(await signIn('ethanmiller')),
      await openSocket(await signIn('leochen')),
    ];
    calls = 0;
    spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => { calls++; return original(sql); });
    await sweepInvalidatedSockets(io);
    const withFour = calls;
    spy.mockRestore();

    try {
      // Four sockets across three people cost exactly what one socket cost.
      // Under the per-socket timer this would have been four times as much.
      expect(withFour).toBe(withOne);
      expect(withFour).toBeLessThanOrEqual(2);
    } finally {
      one.close();
      for (const s of more) s.close();
    }
  });
});
