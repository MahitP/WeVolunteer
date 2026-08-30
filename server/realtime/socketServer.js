import { Server } from 'socket.io';
import { ALLOWED_ORIGINS, IS_PRODUCTION, COOKIE_NAME, JWT_SECRET } from '../config.js';
import { setRealtimeServer } from './events.js';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { isSessionRevoked } from '../utils.js';

const SESSION_CHECK_INTERVAL = Number(process.env.SOCKET_SESSION_CHECK_INTERVAL_MS) || 5 * 60 * 1000;

/**
 * Origin policy for the realtime channel.
 *
 * Mirrors the reasoning in app.js rather than pinning ALLOWED_ORIGINS directly.
 * A WebSocket upgrade ALWAYS carries an `Origin` header — unlike a same-origin
 * GET, which may omit it — so in development the header is the Vite origin, and
 * Vite picks a fresh port whenever 5173 is taken. Pinning the allowlist meant a
 * dev server on any other port had its upgrade rejected by CORS even once the
 * proxy existed, which would have masked the real fix.
 *
 * Loopback and private ranges are allowed in development only, exactly as
 * app.js does; a production build never reaches that branch.
 */
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (!IS_PRODUCTION) {
    try {
      const { hostname } = new URL(origin);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
        || hostname.startsWith('192.168.') || hostname.startsWith('10.')
        || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);
    } catch { return false; }
  }
  return false;
}

/**
 * The session-invalidation sweep, run once for every connected socket together.
 *
 * ── What this replaces ──
 *
 * Each socket used to own a `setInterval` that asked two questions of its own:
 * `SELECT token_version FROM users WHERE id = ?` and `isSessionRevoked(jti)`,
 * which is a second SELECT. So the cost of keeping sessions honest was **two
 * statements per connected socket per five minutes** — three hundred students
 * with a tab open is 600 queries every five minutes, entirely to discover that
 * almost nobody signed out. It also scaled with sockets rather than with users,
 * so a student with a phone and a laptop paid twice.
 *
 * One sweep asks both questions for every socket at once: two statements
 * total, regardless of how many are connected.
 *
 * ── What deliberately did NOT change ──
 *
 * The rule itself. A socket is disconnected when its user row is gone, when
 * `token_version` has moved past the one the socket handshook with, or when its
 * `jti` has been revoked — the same three conditions, in the same order, with
 * the same `session.invalidated` emitted before the disconnect. The handshake
 * check runs once, so this sweep is what stops an already-open socket streaming
 * notifications to a session the user has ended.
 *
 * Never throws. A database error means this tick learns nothing and the next one
 * tries again, which is what the per-socket version did by swallowing it too — a
 * failed check must not tear down live connections.
 */
export async function sweepInvalidatedSockets(io) {
  const sockets = await io.fetchSockets();
  if (!sockets.length) return 0;

  const userIds = [...new Set(sockets.map(s => s.data?.user?.id).filter(Boolean))];
  const jtis = [...new Set(sockets.map(s => s.data?.jti).filter(Boolean))];
  const marks = (n) => Array.from({ length: n }, () => '?').join(',');

  /* Every socket carries a user by the time it is connected — the handshake
     middleware sets `socket.data.user` or refuses — so an empty list here should
     be unreachable. Guarded anyway, because the alternative is `IN ()`, which is
     a SQL syntax error rather than an empty result, and a sweep that throws is a
     sweep that stops enforcing sign-outs. */
  if (!userIds.length) return 0;

  const versionByUser = new Map();
  for (const row of await db.prepare(
    `SELECT id, token_version FROM users WHERE id IN (${marks(userIds.length)})`
  ).all(...userIds)) {
    versionByUser.set(row.id, row.token_version);
  }

  /* One lookup for every jti on the server, rather than `isSessionRevoked` per
     socket. A token with no jti predates the mechanism and is allowed through,
     exactly as `isSessionRevoked` allows it — see the note there. */
  const revoked = new Set();
  if (jtis.length) {
    for (const row of await db.prepare(
      `SELECT jti FROM revoked_sessions WHERE jti IN (${marks(jtis.length)})`
    ).all(...jtis)) {
      revoked.add(row.jti);
    }
  }

  let cut = 0;
  for (const socket of sockets) {
    const userId = socket.data?.user?.id;
    if (!userId) continue;
    const current = versionByUser.get(userId);
    const invalidated = current === undefined
      || current !== socket.data.tokenVersion
      || (socket.data.jti && revoked.has(socket.data.jti));
    if (!invalidated) continue;

    console.log(`[realtime] disconnected socket=${socket.id} user=${userId} reason=session_invalidated`);
    socket.emit('session.invalidated');
    socket.disconnect(true);
    cut++;
  }
  return cut;
}

export function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      credentials: true
    }
  });

  setRealtimeServer(io);

  /**
   * One timer for the whole server, cleared when the server closes.
   *
   * Attached to `io` rather than held in module scope so a second server in the
   * same process — which is what every socket test creates — gets its own, and
   * closing one does not silence the other. `unref` because a periodic check is
   * never a reason for the process to stay alive.
   */
  const sessionSweep = setInterval(() => {
    sweepInvalidatedSockets(io).catch((err) => {
      // A failed sweep costs one missed check. Taking the process down over it,
      // or tearing down live sockets, would both be worse.
      console.error('[realtime] session sweep failed:', err.message);
    });
  }, SESSION_CHECK_INTERVAL);
  sessionSweep.unref?.();
  io.on('close', () => clearInterval(sessionSweep));
  /* `io.close()` does not emit 'close' on every version, so shutdown.js is given
     a handle it can clear directly as well. Clearing twice is harmless. */
  io.sessionSweepTimer = sessionSweep;

  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.request.headers.cookie || '');
      const token = cookies[COOKIE_NAME];
      if (!token) {
        return next(new Error('Authentication error: Missing session'));
      }

      const payload = jwt.verify(token, JWT_SECRET);

      /**
       * `payload.id`, not `payload.userId`.
       *
       * The session token is signed with `{ id, role, email, name, tokenVersion }`
       * (authRoutes.js issueSession), and the REST middleware reads
       * `decodedUser.id`. This read `payload.userId`, which is always undefined —
       * and `node:sqlite` throws when a bind parameter is undefined rather than
       * treating it as NULL, so every handshake fell into the catch below and was
       * rejected as "Invalid session".
       *
       * The effect was that EVERY socket connection was refused, in development
       * and in production: no live notifications, no live messages, no typing
       * indicators, no read receipts. Nothing surfaced it because no test opened
       * a socket, and the client retried forever in silence.
       */
      const user = await db.prepare(
        'SELECT id, role, token_version, account_status FROM users WHERE id = ?'
      ).get(payload.id);

      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      // A deleted or suspended account must not hold a live channel, the same
      // way authenticateToken refuses one a REST request.
      if (user.account_status !== 'active') {
        return next(new Error('Authentication error: Account not active'));
      }

      // `?? 0` to match authenticateToken: a token minted before the column
      // existed carries no tokenVersion, and must not be read as a mismatch.
      if (user.token_version !== (payload.tokenVersion ?? 0)) {
        return next(new Error('Authentication error: Session stale'));
      }

      /**
       * A signed-out session must not hold a live channel either.
       *
       * Without this, logging out would stop REST requests but leave the socket
       * connected, so the account kept receiving notifications and messages in
       * real time after signing out — the same gap authenticateToken closes.
       */
      if (await isSessionRevoked(payload.jti)) {
        return next(new Error('Authentication error: Session signed out'));
      }

      socket.data.user = { id: user.id, role: user.role };
      socket.data.jti = payload.jti ?? null;
      socket.data.tokenVersion = payload.tokenVersion ?? 0;
      next();
    } catch (err) {
      return next(new Error('Authentication error: Invalid session'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    console.log(`[realtime] connected socket=${socket.id} user=${user.id}`);
    
    socket.join(`user:${user.id}`);
    
    socket.on('disconnect', (reason) => {
      console.log(`[realtime] disconnected socket=${socket.id} user=${user.id} reason=${reason}`);
    });

    // Typing indicators
    const typingBuckets = new Map();
    
    function checkTypingRateLimit() {
      const now = Date.now();
      const windowMs = 10_000;
      const limit = 5;
      const bucket = (typingBuckets.get(user.id) || []).filter(ts => now - ts < windowMs);
      if (bucket.length >= limit) {
        typingBuckets.set(user.id, bucket);
        return false;
      }
      bucket.push(now);
      typingBuckets.set(user.id, bucket);
      return true;
    }

    socket.on('typing.start', async ({ conversationId }) => {
      await handleTypingEvent(socket, conversationId, 'typing.start', checkTypingRateLimit);
    });
    
    socket.on('typing.stop', async ({ conversationId }) => {
      await handleTypingEvent(socket, conversationId, 'typing.stop', checkTypingRateLimit);
    });
  });
  
  return io;
}

async function handleTypingEvent(socket, conversationId, eventType, checkLimit) {
  if (!conversationId) return;
  if (!checkLimit()) return;
  
  try {
    const participant = await db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(conversationId, socket.data.user.id);
    if (!participant) return;
    
    const otherParticipants = await db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?').all(conversationId, socket.data.user.id);
    
    otherParticipants.forEach(p => {
      socket.to(`user:${p.user_id}`).emit(eventType, {
        conversationId,
        userId: socket.data.user.id
      });
    });
  } catch (err) {
    // Database or other error, ignore typing event
  }
}
