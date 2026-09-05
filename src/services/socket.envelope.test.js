import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression cover for the realtime envelope mismatch.
 *
 * The server wraps every payload sent through `emitToUser`:
 *
 *   emitToUser(userId, 'notification.created', id, { notification })
 *     → { eventId, type, resourceId, emittedAt, payload: { notification } }
 *
 * Every client handler, however, read its fields off the FIRST argument as if
 * it were the raw payload — `payload.notification.id`, `payload.conversationId`,
 * `payload.all`. So `payload.notification` was `undefined` and
 * `NotificationsBell` threw
 *
 *   TypeError: Cannot read properties of undefined (reading 'id')
 *
 * which the top-level ErrorBoundary caught, replacing the whole application
 * with "WeVolunteer couldn't start". Reproduced in a browser: a student applying
 * over a schedule conflict presses "Apply Anyway", the server accepts the
 * application AND dispatches SCHEDULE_CONFLICT_WARNING to that same student, the
 * socket delivers it, and the page dies. The application is really there after a
 * reload, which is why it looked like an apply-flow bug — it was not. ANY live
 * notification arriving while the page was open did this.
 *
 * The quieter half of the same bug: `notification.read` and `conversation.read`
 * handlers read `payload.all` / `payload.conversationId`, got `undefined`, and
 * silently did nothing — so read state and live messages never synced.
 *
 * Fixed once, at the subscription boundary, so no handler needed changing.
 *
 * Typing indicators are emitted RAW (`socket.to(room).emit('typing.start',
 * { conversationId, userId })`) rather than through emitToUser, so the unwrap has
 * to pass a non-envelope through untouched. Both shapes are pinned below.
 */

// A controllable fake socket.io client.
const handlers = new Map();
const fakeSocket = {
  id: 'sock-1',
  connected: true,
  on: vi.fn((event, cb) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(cb);
  }),
  off: vi.fn((event, cb) => handlers.get(event)?.delete(cb)),
  emit: vi.fn(),
  disconnect: vi.fn()
};

vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));

/** Delivers an event to every registered handler, as socket.io would. */
function deliver(event, arg) {
  for (const cb of handlers.get(event) || []) cb(arg);
}

const envelope = (type, payload, resourceId = 'res-1') => ({
  eventId: `rt-123-abc`,
  type,
  resourceId,
  emittedAt: '2026-07-31T00:00:00.000Z',
  payload
});

let socketMod;
beforeEach(async () => {
  handlers.clear();
  vi.resetModules();
  socketMod = await import('./socket.js');
  /* Awaited because `connectSocket` is async now: `socket.io-client` is loaded
     on demand so it stays out of the eager bundle a signed-out visitor pays
     for. The mock above is still what the dynamic import resolves to. */
  await socketMod.connectSocket();
});

describe('subscribeSocket unwraps the realtime envelope', () => {
  it('hands notification.created the inner payload, not the envelope', () => {
    const seen = [];
    socketMod.subscribeSocket('notification.created', p => seen.push(p));

    const notification = { id: 'notif-1', title: 'You were accepted!', read: 0 };
    deliver('notification.created', envelope('notification.created', { notification }));

    expect(seen).toHaveLength(1);
    // The exact expression that used to throw.
    expect(() => seen[0].notification.id).not.toThrow();
    expect(seen[0].notification).toEqual(notification);
  });

  it('does not leave envelope metadata where the payload should be', () => {
    const seen = [];
    socketMod.subscribeSocket('notification.created', p => seen.push(p));
    deliver('notification.created', envelope('notification.created', { notification: { id: 'n1' } }));

    expect(seen[0]).not.toHaveProperty('emittedAt');
    expect(seen[0]).not.toHaveProperty('resourceId');
    expect(seen[0]).not.toHaveProperty('payload');
  });

  it('unwraps notification.read so mark-as-read actually syncs', () => {
    const seen = [];
    socketMod.subscribeSocket('notification.read', p => seen.push(p));
    deliver('notification.read', envelope('notification.read', { all: true }, null));
    expect(seen[0].all).toBe(true);
  });

  it('unwraps notification.read with an ids list', () => {
    const seen = [];
    socketMod.subscribeSocket('notification.read', p => seen.push(p));
    deliver('notification.read', envelope('notification.read', { ids: ['a', 'b'] }, null));
    expect(seen[0].ids).toEqual(['a', 'b']);
  });

  it('unwraps message.created so live messages reach the conversation', () => {
    const seen = [];
    socketMod.subscribeSocket('message.created', p => seen.push(p));
    const payload = { message: { id: 'm1', body: 'hi' }, conversation: { id: 'c1' } };
    deliver('message.created', envelope('message.created', payload, 'm1'));
    expect(seen[0].message.id).toBe('m1');
    expect(seen[0].conversation.id).toBe('c1');
  });

  it('unwraps conversation.read', () => {
    const seen = [];
    socketMod.subscribeSocket('conversation.read', p => seen.push(p));
    deliver('conversation.read', envelope('conversation.read', { conversationId: 'c1', userId: 'u2', lastReadAt: 'now' }));
    expect(seen[0].conversationId).toBe('c1');
  });

  // Typing events bypass emitToUser and arrive raw. They must not be mangled.
  it('passes a RAW (non-envelope) typing event through untouched', () => {
    const seen = [];
    socketMod.subscribeSocket('typing.start', p => seen.push(p));
    deliver('typing.start', { conversationId: 'c1', userId: 'u2' });
    expect(seen[0]).toEqual({ conversationId: 'c1', userId: 'u2' });
  });

  it('tolerates an event with no argument at all', () => {
    const seen = [];
    socketMod.subscribeSocket('session.invalidated', p => seen.push(p));
    expect(() => deliver('session.invalidated', undefined)).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('does not mistake a raw payload that happens to carry a payload field', () => {
    // A real envelope is identified by type + emittedAt + payload together, so a
    // domain object with its own `payload` key is not unwrapped by accident.
    const seen = [];
    socketMod.subscribeSocket('custom.thing', p => seen.push(p));
    deliver('custom.thing', { conversationId: 'c1', payload: 'a string' });
    expect(seen[0].conversationId).toBe('c1');
    expect(seen[0].payload).toBe('a string');
  });

  it('still unsubscribes correctly after unwrapping', () => {
    const seen = [];
    const unsub = socketMod.subscribeSocket('notification.created', p => seen.push(p));
    deliver('notification.created', envelope('notification.created', { notification: { id: 'n1' } }));
    unsub();
    deliver('notification.created', envelope('notification.created', { notification: { id: 'n2' } }));
    expect(seen).toHaveLength(1);
  });

  it('re-attaches unwrapping listeners across a reconnect', () => {
    const seen = [];
    socketMod.subscribeSocket('notification.created', p => seen.push(p));
    // connectSocket() rebuilds the socket and reattaches stored listeners.
    socketMod.connectSocket();
    deliver('notification.created', envelope('notification.created', { notification: { id: 'n3' } }));
    expect(seen.at(-1)?.notification?.id).toBe('n3');
  });
});
