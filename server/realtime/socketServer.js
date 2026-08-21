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

export function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      credentials: true
    }
  });

  setRealtimeServer(io);

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
    
    const interval = setInterval(async () => {
      try {
        const current = await db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id);
        // Signed out mid-connection counts too: the handshake check only runs
        // once, so without this an already-open socket kept streaming
        // notifications to a session the user had ended.
        if (!current || current.token_version !== socket.data.tokenVersion
            || await isSessionRevoked(socket.data.jti)) {
          console.log(`[realtime] disconnected socket=${socket.id} user=${user.id} reason=session_invalidated`);
          socket.emit('session.invalidated');
          socket.disconnect(true);
        }
      } catch (err) {
        // DB error, ignore this check
      }
    }, SESSION_CHECK_INTERVAL);

    socket.on('disconnect', (reason) => {
      clearInterval(interval);
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
