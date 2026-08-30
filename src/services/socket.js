/**
 * The realtime client, loaded only when a session actually needs one.
 *
 * ── Why `socket.io-client` is not a static import ──
 *
 * It was, and it therefore sat in the eager bundle that every visitor downloads
 * before anything renders — including a signed-out visitor browsing
 * opportunities, who never opens a socket at all. Measured on a production
 * build, the eager first-paint payload was 175 kB gzipped with `engine.io`
 * inside it.
 *
 * `connectSocket` is called from `SessionProvider` only once there is a session,
 * so moving the import there costs a signed-in user one extra request after
 * first paint — at which point the page is already interactive — and costs a
 * signed-out visitor nothing at all.
 *
 * The rest of this module was already shaped for it: `listeners` is a registry
 * that fills up whether or not a socket exists, `subscribeSocket` tolerates
 * `socketInstance === null`, and `connectSocket` reattaches everything after it
 * builds the socket. Nothing about subscription order had to change.
 */
let socketInstance = null;
const listeners = new Map();

/**
 * Bumped by every connect and every disconnect.
 *
 * The import is asynchronous now, so two things can happen while it is in
 * flight: another `connectSocket` (a session change), or a `disconnectSocket`
 * (a sign-out). Either must win over the connect that is still loading, or a
 * signed-out user ends up with a live socket nobody holds a reference to.
 * A connect that finds the generation moved on discards its own result.
 */
let generation = 0;

/**
 * Connects the Socket.IO client.
 * Disconnects the old socket if it exists.
 *
 * Returns a promise for the socket, or for `null` when a later connect or
 * disconnect superseded this one. Callers that do not care may ignore it —
 * `SessionProvider` does.
 */
export async function connectSocket() {
  const mine = ++generation;

  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }

  const { io } = await import('socket.io-client');
  if (mine !== generation) return null; // superseded while the client was loading

  // Socket.IO server is served from the same host, so we don't need a full URL in production.
  // In development, the Vite proxy forwards `/socket.io` to the backend.
  const socket = io({
    path: '/socket.io',
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
  });
  socketInstance = socket;

  socket.on('connect', () => {
    console.log('[socket] Connected', socket.id);
    window.dispatchEvent(new CustomEvent('wev:socket_connect'));
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] Disconnected:', reason);
    window.dispatchEvent(new CustomEvent('wev:socket_disconnect'));
    if (reason === 'io server disconnect') {
      // the disconnection was initiated by the server, you need to reconnect manually
      // but in our case, if it was 'session.invalidated', we want it to stay dead
    }
  });

  socket.on('session.invalidated', () => {
    console.warn('[socket] Session invalidated by server');
    socket.disconnect();
    // Dispatch a global event or something so App.jsx knows to re-auth?
    // In our architecture, the next REST call will 401 anyway, but we can trigger a reload.
    window.dispatchEvent(new CustomEvent('wev:session_invalidated'));
  });

  // Reattach all global listeners to the new socket. The same wrappers are
  // reused, so unwrapping survives a reconnect and unsubscribing still works.
  for (const [event, callbacks] of listeners.entries()) {
    callbacks.forEach(cb => socket.on(event, wrapperFor(event, cb)));
  }

  return socket;
}

export function getSocket() {
  return socketInstance;
}

export function disconnectSocket() {
  /* Bumped so a connect still waiting on the dynamic import discards its socket
     instead of installing it after the user has signed out. */
  generation++;
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
