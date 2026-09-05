import { io } from 'socket.io-client';

let socketInstance = null;
const listeners = new Map();

/**
 * Connects the Socket.IO client.
 * Disconnects the old socket if it exists.
 */
export function connectSocket() {
  if (socketInstance) {
    socketInstance.disconnect();
  }

  // Socket.IO server is served from the same host, so we don't need a full URL in production.
  // In development, the Vite proxy forwards `/socket.io` to the backend.
  socketInstance = io({
    path: '/socket.io',
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
  });

  /* Behind import.meta.env.DEV, matching App.jsx. Vite inlines the constant and
     drops the branch from the production bundle, so these do not print the
     socket id into every user's console — which they did, on every connect and
     every reconnect. Useful while developing, noise in production. */
  socketInstance.on('connect', () => {
    if (import.meta.env.DEV) console.log('[socket] Connected', socketInstance.id);
    window.dispatchEvent(new CustomEvent('wev:socket_connect'));
  });

  /* No branch on `io server disconnect` here, deliberately.
     socket.io reconnects on its own for every reason EXCEPT that one, where the
     server hung up and the client is expected to reconnect manually. We do not:
     the case that produces it is `session.invalidated`, and a socket whose
     session was invalidated should stay down. Doing nothing is the behaviour —
     this used to be an empty `if` holding the same reasoning, which reads as
     unfinished work rather than as a decision. */
  socketInstance.on('disconnect', (reason) => {
    if (import.meta.env.DEV) console.log('[socket] Disconnected:', reason);
    window.dispatchEvent(new CustomEvent('wev:socket_disconnect'));
  });

  socketInstance.on('session.invalidated', () => {
    console.warn('[socket] Session invalidated by server');
    socketInstance.disconnect();
    // Dispatch a global event or something so App.jsx knows to re-auth?
    // In our architecture, the next REST call will 401 anyway, but we can trigger a reload.
    window.dispatchEvent(new CustomEvent('wev:session_invalidated'));
  });

  // Reattach all global listeners to the new socket. The same wrappers are
  // reused, so unwrapping survives a reconnect and unsubscribing still works.
  for (const [event, callbacks] of listeners.entries()) {
    callbacks.forEach(cb => socketInstance.on(event, wrapperFor(event, cb)));
  }

  return socketInstance;
}

export function getSocket() {
  return socketInstance;
}

export function disconnectSocket() {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}

/**
 * Unwraps the server's realtime envelope.
 *
 * `emitToUser` (server/realtime/events.js) wraps every payload:
 *
 *   emitToUser(userId, 'notification.created', id, { notification })
 *     → { eventId, type, resourceId, emittedAt, payload: { notification } }
 *
 * Every handler in this app, though, reads its fields straight off the argument
 * it is given — `payload.notification.id`, `payload.conversationId`,
 * `payload.all`. Against the envelope those are all `undefined`, and
 * NotificationsBell did `payload.notification.id`, so it threw
 *
 *   TypeError: Cannot read properties of undefined (reading 'id')
 *
 * which the top-level ErrorBoundary caught and replaced the entire application
 * with "WeVolunteer couldn't start". Any live notification arriving while the
 * page was open did this; applying over a schedule conflict was simply the most
 * reliable way to send yourself one, because the server dispatches
 * SCHEDULE_CONFLICT_WARNING to the applicant on the override path. The
 * application really was saved, which is what made it look like a bug in the
 * apply flow rather than in here.
 *
 * The same mismatch quietly disabled `notification.read`, `conversation.read`
 * and `message.created`: those handlers read undefined fields, matched nothing,
 * and returned without doing anything, so read state and live messages never
 * arrived. No error, just a feature that did not work.
 *
 * Unwrapping here rather than in each handler keeps it to one place, leaves the
 * server contract alone, and means a new subscriber cannot reintroduce the bug.
 *
 * Typing indicators do NOT come through emitToUser — socketServer.js emits
 * `{ conversationId, userId }` directly — so a non-envelope argument has to pass
 * through untouched. The three envelope fields are checked together so a domain
 * object that merely happens to have a `payload` key is not unwrapped by
 * accident.
 */
function unwrapEnvelope(arg) {
  if (
    arg && typeof arg === 'object' && !Array.isArray(arg)
    && typeof arg.type === 'string'
    && typeof arg.emittedAt === 'string'
    && 'payload' in arg
  ) {
    return arg.payload;
  }
  return arg;
}

/**
 * Wrapper registry.
 *
 * socket.io removes a listener by identity, so the function actually handed to
 * `socket.on` has to be the same one later handed to `socket.off`. Since we
 * register a wrapper rather than the caller's callback, the mapping from
 * callback → wrapper is kept here so unsubscribeSocket can still find it.
 */
const wrappers = new Map();

function wrapperFor(event, callback) {
  let perEvent = wrappers.get(event);
  if (!perEvent) {
    perEvent = new Map();
    wrappers.set(event, perEvent);
  }
  let wrapped = perEvent.get(callback);
  if (!wrapped) {
    wrapped = (arg) => callback(unwrapEnvelope(arg));
    perEvent.set(callback, wrapped);
  }
  return wrapped;
}

/**
 * Add a listener for a socket event.
 */
export function subscribeSocket(event, callback) {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event).add(callback);

  if (socketInstance) {
    socketInstance.on(event, wrapperFor(event, callback));
  }

  return () => unsubscribeSocket(event, callback);
}

/**
 * Remove a listener for a socket event.
 */
export function unsubscribeSocket(event, callback) {
  if (listeners.has(event)) {
    listeners.get(event).delete(callback);
  }

  // Remove the wrapper that was actually registered, not the raw callback —
  // socket.io matches listeners by identity, so passing the callback here would
  // leave the real listener attached and the handler would keep firing.
  const wrapped = wrappers.get(event)?.get(callback);
  if (socketInstance) {
    socketInstance.off(event, wrapped || callback);
  }
  wrappers.get(event)?.delete(callback);
}

/**
 * Send typing start to the server.
 */
export function emitTypingStart(conversationId) {
  if (socketInstance && socketInstance.connected) {
    socketInstance.emit('typing.start', { conversationId });
  }
}

/**
 * Send typing stop to the server.
 */
export function emitTypingStop(conversationId) {
  if (socketInstance && socketInstance.connected) {
    socketInstance.emit('typing.stop', { conversationId });
  }
}
