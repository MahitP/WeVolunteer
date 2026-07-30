let ioInstance = null;

export function setRealtimeServer(io) {
  ioInstance = io;
}

export function realtimeAvailable() {
  return !!ioInstance;
}

export function realtimeEnvelope(type, resourceId, payload = {}) {
  return {
    eventId: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    resourceId,
    emittedAt: new Date().toISOString(),
    payload
  };
}

export function emitToUser(userId, type, resourceId, payload = {}) {
  if (!ioInstance) return false;
  ioInstance.to(`user:${userId}`).emit(type, realtimeEnvelope(type, resourceId, payload));
  return true;
}

