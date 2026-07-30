import { Server } from 'socket.io';
import { ALLOWED_ORIGINS, JWT_SECRET } from '../config.js';
import { setRealtimeServer } from './events.js';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';

const SESSION_CHECK_INTERVAL = Number(process.env.SOCKET_SESSION_CHECK_INTERVAL_MS) || 5 * 60 * 1000;

export function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: ALLOWED_ORIGINS,
      credentials: true
    }
  });

  setRealtimeServer(io);

  io.use((socket, next) => {
    try {
      const cookies = cookie.parse(socket.request.headers.cookie || '');
      const token = cookies.wev_session;
      if (!token) {
        return next(new Error('Authentication error: Missing session'));
      }
      
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT id, role, token_version FROM users WHERE id = ?').get(payload.userId);
      
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }
      
      if (user.token_version !== payload.tokenVersion) {
        return next(new Error('Authentication error: Session stale'));
      }
      
      socket.data.user = { id: user.id, role: user.role };
      socket.data.tokenVersion = payload.tokenVersion;
      next();
    } catch (err) {
      return next(new Error('Authentication error: Invalid session'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    console.log(`[realtime] connected socket=${socket.id} user=${user.id}`);
    
    socket.join(`user:${user.id}`);
    
    const interval = setInterval(() => {
      try {
        const current = db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id);
        if (!current || current.token_version !== socket.data.tokenVersion) {
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

    socket.on('typing.start', ({ conversationId }) => {
      handleTypingEvent(socket, conversationId, 'typing.start', checkTypingRateLimit);
    });
    
    socket.on('typing.stop', ({ conversationId }) => {
      handleTypingEvent(socket, conversationId, 'typing.stop', checkTypingRateLimit);
    });
  });
  
  return io;
}

function handleTypingEvent(socket, conversationId, eventType, checkLimit) {
  if (!conversationId) return;
  if (!checkLimit()) return;
  
  try {
    const participant = db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(conversationId, socket.data.user.id);
    if (!participant) return;
    
    const otherParticipants = db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?').all(conversationId, socket.data.user.id);
    
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
