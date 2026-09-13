import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';

/**
 * Two ways a signed-in-ish caller could abuse the realtime server.
 *
 * ── 1. A half-finished sign-in joined the user's room ──
 *
 * `POST /api/auth/login` for an account with two-factor authentication answers
 * `require2FA` and sets `wev_preauth`: a signed token carrying the user's `id`,
 * `tokenVersion` and a `jti`, marked `preauth: true`. It proves the password and
 * nothing more.
 *
 * `authenticateToken` refuses that token as a session. The Socket.IO handshake
 * did not ask: it verified the signature, looked the user up by `id`, checked
 * the version and the revocation list — all of which a preauth token satisfies —
 * and joined the socket to `user:<id>`. A client controls its own cookie header,
 * so presenting the `wev_preauth` value as `wev_session` was enough.
 *
 * That room receives `message.created` with the message and
 * `notification.created` with the notification. Somebody holding only an
 * administrator's password — the exact case the mandatory second factor exists
 * for — could read that administrator's incoming messages live.
 *
 * ── 2. One event with no payload stopped the server ──
 *
 * The typing listeners destructured their argument:
 * `async ({ conversationId }) => …`. `socket.emit('typing.start')` with nothing,
 * or with `null`, throws inside an async function, which rejects a promise
 * nobody awaits. `shutdown.js` treats `unhandledRejection` as fatal and drains
 * the process. Any signed-in account could therefore take the platform down
 * with one line in the browser console, and again as soon as systemd restarted
 * it.
 */
let httpServer, io, base, dir, db;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-rt-harden-'));
  process.env.WEV_DB_PATH = path.join(dir, 'rt.db');
  process.env.DEMO_MODE = 'true';
  process.env.JWT_SECRET = 'realtime-hardening-test-secret';

  const { initDatabase, completeDatabaseInit, db: liveDb } = await import('./db.js');
  const { app } = await import('./app.js');
  const { initSocketServer } = await import('./realtime/socketServer.js');
  db = liveDb;
  initDatabase();
  await completeDatabaseInit();

  httpServer = createServer(app);
  io = initSocketServer(httpServer);
  httpServer.listen(0, '127.0.0.1');
  await new Promise(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
}, 30000);

afterAll(async () => {
  if (io?.sessionSweepTimer) clearInterval(io.sessionSweepTimer);
  await new Promise(r => io?.close(r));
  await new Promise(r => httpServer?.close(r));
  rmSync(dir, { recursive: true, force: true });
});

async function login(email) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const cookies = res.headers.getSetCookie?.() || [];
  const pick = (name) => cookies.map(c => c.match(new RegExp(`${name}=([^;]+)`))?.[1]).find(Boolean);
  return { status: res.status, body: await res.json(), session: pick('wev_session'), preauth: pick('wev_preauth') };
}

const openSocket = (token) => new Promise((resolve, reject) => {
  const s = ioClient(base, {
    path: '/socket.io',
    extraHeaders: { Cookie: `wev_session=${token}` },
    transports: ['websocket'],
    reconnection: false,
  });
  const timer = setTimeout(() => { s.close(); reject(new Error('connect timeout')); }, 8000);
  s.on('connect', () => { clearTimeout(timer); resolve(s); });
  s.on('connect_error', (e) => { clearTimeout(timer); s.close(); reject(new Error('REJECTED: ' + e.message)); });
});

describe('the handshake accepts only a finished sign-in', () => {
  it('refuses the pre-authentication token of a two-factor account', async () => {
    const { enrolTwoFactor } = await import('./testServer.js');
    await enrolTwoFactor(db, 'admin@example.gov');

    const half = await login('admin@example.gov');
    // Precondition: this really is the half-finished state, not a full session.
    expect(half.body.require2FA).toBe(true);
    expect(half.session).toBeUndefined();
    expect(half.preauth).toBeTruthy();

    await expect(openSocket(half.preauth)).rejects.toThrow(/REJECTED/);
  });

  it('still accepts a full session', async () => {
    const full = await login('leo.chen@example.com');
    const socket = await openSocket(full.session);
    expect(socket.connected).toBe(true);
    socket.close();
  });
});

/**
 * A handshake from a page on another origin.
 *
 * The HTTP API refuses a cross-origin write twice over — CORS, and csrfGuard's
 * Sec-Fetch-Site check for the case CORS cannot see: a SIBLING subdomain, which
 * is same-site, so `SameSite=Lax` still attaches the session cookie. The socket
 * server had neither. Its `cors.origin` callback only decides CORS headers on
 * polling responses; it refuses nothing, and a WebSocket upgrade is not subject
 * to CORS at all. So a page on the marketing apex — same site as `app.` — could
 * open a socket with the visitor's cookie and read their messages and
 * notifications as they arrived.
 */
describe('the handshake refuses a page on another origin', () => {
  const openWithOrigin = (token, origin, transport = 'websocket') => new Promise((resolve, reject) => {
    const s = ioClient(base, {
      path: '/socket.io',
      extraHeaders: { Cookie: `wev_session=${token}`, Origin: origin },
      transports: [transport],
      reconnection: false,
    });
    const timer = setTimeout(() => { s.close(); reject(new Error('connect timeout')); }, 8000);
    s.on('connect', () => { clearTimeout(timer); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(timer); s.close(); reject(new Error('REJECTED: ' + e.message)); });
  });

  it('refuses a websocket from a same-site sibling page carrying a valid session', async () => {
    const full = await login('leo.chen@example.com');
    await expect(openWithOrigin(full.session, 'https://wevolunteers.org')).rejects.toThrow(/REJECTED/);
    await expect(openWithOrigin(full.session, 'https://evil.example')).rejects.toThrow(/REJECTED/);
  });

  it('refuses the same over long-polling', async () => {
    const full = await login('leo.chen@example.com');
    await expect(openWithOrigin(full.session, 'https://evil.example', 'polling')).rejects.toThrow(/REJECTED/);
  });

  it('still accepts the application\'s own origin, and a client that sends none', async () => {
    const full = await login('leo.chen@example.com');
    const own = await openWithOrigin(full.session, base);
    expect(own.connected).toBe(true);
    own.close();
    const bare = await openSocket(full.session);
    expect(bare.connected).toBe(true);
    bare.close();
  });
});

describe('a malformed client event cannot stop the process', () => {
  it('survives typing events with no payload, null, and nonsense', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    /* shutdown.js is not installed in this harness, so the rejection would not
       drain anything here — it is captured instead, which is the evidence. */
    process.on('unhandledRejection', onRejection);
    try {
      const full = await login('priya.patel@example.com');
      const socket = await openSocket(full.session);

      socket.emit('typing.start');
      socket.emit('typing.stop', null);
      socket.emit('typing.start', 'not-an-object');
      socket.emit('typing.stop', { conversationId: { $ne: null } });
      socket.emit('typing.start', { conversationId: 42 });

      await new Promise(r => setTimeout(r, 400));
      expect(rejections, String(rejections[0])).toEqual([]);
      expect(socket.connected).toBe(true);
      socket.close();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('a client packet is bounded', () => {
  it('closes a connection that sends more than the typing payload could ever need', async () => {
    const { TYPING_PACKET_LIMIT_BYTES } = await import('./realtime/socketServer.js');
    const full = await login('ethan.miller@example.com');
    const socket = await openSocket(full.session);
    const closed = new Promise((resolve) => socket.once('disconnect', resolve));

    socket.emit('typing.start', { conversationId: 'x'.repeat(TYPING_PACKET_LIMIT_BYTES * 4) });

    const reason = await Promise.race([closed, new Promise(r => setTimeout(() => r('still connected'), 4000))]);
    expect(reason).not.toBe('still connected');
  });

  it('keeps an ordinary typing event well inside the limit', async () => {
    const full = await login('leo.chen@example.com');
    const socket = await openSocket(full.session);
    socket.emit('typing.start', { conversationId: 'conv-00000000-0000-0000-0000-000000000000' });
    await new Promise(r => setTimeout(r, 300));
    expect(socket.connected).toBe(true);
    socket.close();
  });
});
