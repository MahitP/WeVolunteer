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

  socketInstance.on('connect', () => {
    console.log('[socket] Connected', socketInstance.id);
    window.dispatchEvent(new CustomEvent('wev:socket_connect'));
  });

  socketInstance.on('disconnect', (reason) => {
    console.log('[socket] Disconnected:', reason);
    window.dispatchEvent(new CustomEvent('wev:socket_disconnect'));
    if (reason === 'io server disconnect') {
      // the disconnection was initiated by the server, you need to reconnect manually
      // but in our case, if it was 'session.invalidated', we want it to stay dead
    }
  });

  socketInstance.on('session.invalidated', () => {
    console.warn('[socket] Session invalidated by server');
    socketInstance.disconnect();
    // Dispatch a global event or something so App.jsx knows to re-auth?
    // In our architecture, the next REST call will 401 anyway, but we can trigger a reload.
    window.dispatchEvent(new CustomEvent('wev:session_invalidated'));
  });

  // Reattach all global listeners to the new socket
  for (const [event, callbacks] of listeners.entries()) {
    callbacks.forEach(cb => socketInstance.on(event, cb));
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
 * Add a listener for a socket event.
 */
export function subscribeSocket(event, callback) {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event).add(callback);
  
  if (socketInstance) {
    socketInstance.on(event, callback);
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
  
  if (socketInstance) {
    socketInstance.off(event, callback);
  }
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
