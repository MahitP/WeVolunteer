import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';

/**
 * Realtime channel regression guard.
 *
 * The audit found the socket layer COMPLETELY non-functional in both development
 * and production, from two independent defects:
 *
 *   1. The handshake read `payload.userId`; the session token is signed with
 *      `id`. `node:sqlite` throws on an undefined bind parameter, so every
 *      handshake fell into the catch-all and was rejected as "Invalid session".
 *   2. Vite proxied only `/api`, so in development `/socket.io` fell through to
 *      the SPA fallback and returned index.html. The client parsed HTML as a
 *      handshake and retried forever.
 *
 * Both shipped past a fully green suite because NOTHING IN THE SUITE OPENED A
 * SOCKET. That is the actual gap this file closes: it boots the real socket
 * server and completes a real authenticated connection, so a claim rename or a
 * regressed auth path fails here instead of in front of a district.
 *
 * (2) is a client build-config defect and is guarded by vite.config.test.js —
 * it cannot be observed from a server-side socket test.
 */

let httpServer, base, dir, db, call;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-socket-'));
  process.env.WEV_DB_PATH = path.join(dir, 'socket.db');
  process.env.DEMO_MODE = 'true';
  process.env.JWT_SECRET = 'socket-test-secret';

  const { initDatabase, db: liveDb } = await import('./db.js');
  const { app } = await import('./app.js');
  const { initSocketServer } = await import('./realtime/socketServer.js');
  db = liveDb;
  initDatabase();

  httpServer = createServer(app);
  initSocketServer(httpServer);
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
  await new Promise(r => httpServer?.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const signIn = async (identifier) => {
  const r = await call('POST', '/api/auth/login', null, { email: identifier, password: 'password123' });
  if (!r.cookie) throw new Error(`login failed for ${identifier}: ${r.status}`);
  return r.cookie;
};

/** Opens a socket, resolving on connect and REJECTING on connect_error. */
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

/** Resolves with the next occurrence of `event` — never a previously buffered one. */
const nextEvent = (socket, event, ms = 8000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

describe('realtime handshake authentication', () => {
  it('accepts a valid session cookie', async () => {
    const cookie = await signIn('leochen');
    const s = await openSocket(cookie);
    expect(s.connected).toBe(true);
    s.close();
  });

  /**
   * The regression itself. Before the fix this threw REJECTED for a perfectly
   * valid session, so asserting a successful connection is what pins it.
   */
  it('resolves the user from the token\'s `id` claim, not `userId`', async () => {
    const cookie = await signIn('leochen');
    const jwt = (await import('jsonwebtoken')).default;
    const claims = jwt.decode(cookie);

    expect(claims.id).toBeTruthy();
    expect(claims.userId).toBeUndefined();   // the claim the old code read

    const s = await openSocket(cookie);
    expect(s.connected).toBe(true);
    s.close();
  });

  it('refuses a connection with no cookie', async () => {
    await expect(openSocket(null)).rejects.toThrow(/REJECTED/);
  });

  it('refuses a malformed token', async () => {
    await expect(openSocket('not-a-jwt')).rejects.toThrow(/REJECTED/);
  });

  it('refuses a token whose token_version is stale', async () => {
    const cookie = await signIn('priyapatel');
    // sign-out-others bumps token_version, invalidating every other session.
    await call('POST', '/api/auth/sign-out-others', cookie);
    await expect(openSocket(cookie)).rejects.toThrow(/REJECTED/);
  });

  it('refuses a token for a non-active account', async () => {
    const cookie = await signIn('leochen');
    const jwt = (await import('jsonwebtoken')).default;
    const { id } = jwt.decode(cookie);
    db.prepare("UPDATE users SET account_status = 'suspended' WHERE id = ?").run(id);
    try {
      await expect(openSocket(cookie)).rejects.toThrow(/REJECTED/);
    } finally {
      db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(id);
    }
  });
});

describe('realtime delivery', () => {
  it('delivers a notification to its recipient live', async () => {
    const student = await signIn('leochen');
    const organizer = await signIn('jkatzenback');
    const socket = await openSocket(student);

    const events = (await call('GET', '/api/events', student)).data;
    const ev = events.find(e => e.id === 'event-softball');
    const slot = ev.slots[1];
    await call('POST', '/api/events/event-softball/apply', student, { slotId: slot.id });

    const apps = (await call('GET', '/api/applications', organizer)).data;
    const pending = apps.find(a => a.userId === 'user-student-1' && a.status === 'pending');

    const waiting = nextEvent(socket, 'notification.created');
    await call('PATCH', `/api/applications/${pending.id}`, organizer, { status: 'accepted' });
    const received = await waiting;

    expect(received).toBeTruthy();
    expect(received.type).toBe('notification.created');
    expect(received.payload.notification.title).toBeTruthy();
    socket.close();
  });

  it('delivers a message to the other participant live', async () => {
    const student = await signIn('leochen');
    const organizer = await signIn('jkatzenback');
    const socket = await openSocket(student);

    const resolved = await call('POST', '/api/messages/conversations/resolve', organizer, {
      eventId: 'event-softball', studentId: 'user-student-1'
    });
    const cid = resolved.data.conversation.id;

    const marker = `live-delivery-${Date.now()}`;
    const waiting = nextEvent(socket, 'message.created');
    await call('POST', `/api/messages/conversations/${cid}/messages`, organizer, { body: marker });
    const received = await waiting;

    expect(received).toBeTruthy();
    expect(JSON.stringify(received)).toContain(marker);
    socket.close();
  });

  it('relays typing indicators between participants', async () => {
    const student = await signIn('leochen');
    const organizer = await signIn('jkatzenback');
    const studentSocket = await openSocket(student);
    const organizerSocket = await openSocket(organizer);

    const resolved = await call('POST', '/api/messages/conversations/resolve', organizer, {
      eventId: 'event-softball', studentId: 'user-student-1'
    });
    const cid = resolved.data.conversation.id;

    const waiting = nextEvent(organizerSocket, 'typing.start');
    studentSocket.emit('typing.start', { conversationId: cid });
    const received = await waiting;

    expect(received).toBeTruthy();
    expect(received.conversationId).toBe(cid);
    expect(received.userId).toBe('user-student-1');

    studentSocket.close();
    organizerSocket.close();
  });

  it('does not relay typing for a conversation the sender is not in', async () => {
    const outsider = await signIn('ethanmiller');
    const organizer = await signIn('jkatzenback');
    const outsiderSocket = await openSocket(outsider);
    const organizerSocket = await openSocket(organizer);

    const resolved = await call('POST', '/api/messages/conversations/resolve', organizer, {
      eventId: 'event-softball', studentId: 'user-student-1'
    });
    const cid = resolved.data.conversation.id;

    const waiting = nextEvent(organizerSocket, 'typing.start', 2000);
    outsiderSocket.emit('typing.start', { conversationId: cid });
    expect(await waiting).toBeNull();

    outsiderSocket.close();
    organizerSocket.close();
  });

  it('synchronises read receipts live', async () => {
    const student = await signIn('leochen');
    const organizer = await signIn('jkatzenback');
    const organizerSocket = await openSocket(organizer);

    const resolved = await call('POST', '/api/messages/conversations/resolve', organizer, {
      eventId: 'event-softball', studentId: 'user-student-1'
    });
    const cid = resolved.data.conversation.id;
    await call('POST', `/api/messages/conversations/${cid}/messages`, organizer, { body: 'read-receipt probe' });

    const waiting = nextEvent(organizerSocket, 'conversation.read');
    await call('POST', `/api/messages/conversations/${cid}/read`, student, { lastReadMessageId: null });
    const received = await waiting;

    expect(received).toBeTruthy();
    expect(received.type).toBe('conversation.read');
    organizerSocket.close();
  });

  it('does not leak another user\'s notification onto this socket', async () => {
    const student = await signIn('leochen');
    const organizer = await signIn('jkatzenback');
    // Listening as the ORGANIZER; the notification below is addressed to a student.
    const organizerSocket = await openSocket(organizer);

    const events = (await call('GET', '/api/events', student)).data;
    const ev = events.find(e => e.id === 'event-softball');
    await call('POST', '/api/events/event-softball/apply', student, { slotId: ev.slots[3].id });
    const apps = (await call('GET', '/api/applications', organizer)).data;
    const pending = apps.find(a => a.userId === 'user-student-1' && a.status === 'pending');

    if (pending) {
      const leaked = nextEvent(organizerSocket, 'notification.created', 2500);
      await call('PATCH', `/api/applications/${pending.id}`, organizer, { status: 'accepted' });
      const received = await leaked;
      // The organizer may legitimately get their own notifications, but never one
      // whose recipient is the student.
      if (received) {
        expect(received.payload?.notification?.user_id).not.toBe('user-student-1');
      }
    }
    organizerSocket.close();
  });
});
