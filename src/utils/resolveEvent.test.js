import { describe, it, expect, vi } from 'vitest';
import { findEventLocally, resolveEventById } from './resolveEvent';

/**
 * Turning an event id into an event object.
 *
 * ── The defect ──
 *
 * 23 notification kinds emit `event:<id>`, and every notification email turns
 * that into `${APP_URL}/?event=<id>`. Both were resolved ONLY against caches
 * the client already held: the SessionProvider index — fetched with
 * `{mine: 'true'}` for anybody without `event.moderate`, so "only events this
 * user is involved in" — plus `seenEvents`, whatever a browse surface rendered
 * this session and therefore empty on a cold load.
 *
 * Two of those kinds are about an event the recipient is deliberately NOT part
 * of: FRIEND_SIGNED_UP ("There may still be places") and
 * ORGANIZATION_EVENT_POSTED ("is open for applications"). Both answered "That
 * event is no longer available" for a live, open event, and the emailed link
 * rendered nothing at all — no modal, no error, no explanation.
 *
 * ── What these cases pin ──
 *
 * The caches are still consulted FIRST, because they are free and because the
 * browse projection carries `slots` and `viewerBan` that the narrow index does
 * not. The network is the fallback, not the path. And a lookup that fails for
 * any reason resolves to null rather than rejecting, because both call sites
 * are event handlers where an unhandled rejection is a blank screen.
 */

const EVENT = { id: 'e-1', title: 'Riverbank Litter Sweep' };

describe('finding one locally', () => {
  it('prefers the session index', () => {
    expect(findEventLocally('e-1', [EVENT], {})).toEqual(EVENT);
  });

  it('falls back to what a browse surface rendered', () => {
    expect(findEventLocally('e-1', [], { 'e-1': EVENT })).toEqual(EVENT);
  });

  it('answers null rather than undefined when it has neither', () => {
    expect(findEventLocally('e-1', [], {})).toBeNull();
  });

  it('answers null for a missing id without touching the caches', () => {
    expect(findEventLocally('', [EVENT], {})).toBeNull();
    expect(findEventLocally(null, [EVENT], {})).toBeNull();
  });

  it('tolerates absent caches, which is the cold-load shape', () => {
    expect(findEventLocally('e-1', undefined, undefined)).toBeNull();
  });
});

describe('resolving one', () => {
  it('does not go to the network for an event it already holds', async () => {
    const fetchById = vi.fn();
    const found = await resolveEventById('e-1', { events: [EVENT], seenEvents: {}, fetchById });

    expect(found).toEqual(EVENT);
    expect(fetchById, 'a cached event cost a round trip').not.toHaveBeenCalled();
  });

  it('does not go to the network for one a browse surface just rendered', async () => {
    const fetchById = vi.fn();
    const found = await resolveEventById('e-1', { events: [], seenEvents: { 'e-1': EVENT }, fetchById });

    expect(found).toEqual(EVENT);
    expect(fetchById).not.toHaveBeenCalled();
  });

  it('asks the server when neither cache has it — the notification case', async () => {
    const fetchById = vi.fn().mockResolvedValue(EVENT);
    const found = await resolveEventById('e-1', { events: [], seenEvents: {}, fetchById });

    expect(fetchById).toHaveBeenCalledWith('e-1');
    expect(found).toEqual(EVENT);
  });

  it('answers null when the server has nothing, so the caller can still say so', async () => {
    /* The event really was deleted. The existing "no longer available" message
       is correct here and must survive — this change narrows when it is shown,
       it does not remove it. */
    const fetchById = vi.fn().mockResolvedValue(null);
    expect(await resolveEventById('gone', { events: [], seenEvents: {}, fetchById })).toBeNull();
  });

  it('answers null when the lookup fails, rather than rejecting', async () => {
    /**
     * Both call sites are event handlers. A rejection there is an unhandled
     * promise, and this codebase treats those as fatal — `shutdown.js` does,
     * which is how an empty `typing.start` payload once stopped the server.
     */
    const fetchById = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(resolveEventById('e-1', { events: [], seenEvents: {}, fetchById }))
      .resolves.toBeNull();
  });

  it('answers null for a missing id without asking anything', async () => {
    const fetchById = vi.fn();
    expect(await resolveEventById(null, { events: [], seenEvents: {}, fetchById })).toBeNull();
    expect(fetchById).not.toHaveBeenCalled();
  });

  it('answers null when it has no way to ask', async () => {
    expect(await resolveEventById('e-1', { events: [], seenEvents: {} })).toBeNull();
  });
});
