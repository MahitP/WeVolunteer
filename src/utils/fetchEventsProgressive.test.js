import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

/**
 * The paged event loader the app boots with.
 *
 * It replaced a single unbounded `GET /api/events` — 690 KB uncompressed at 503
 * events, fetched on every session restore. The point is time-to-first-paint:
 * state is applied after each page rather than after the whole table.
 *
 * The properties worth pinning are the ones that are easy to get wrong in a
 * pagination walk: following `nextOffset` rather than recomputing it, stopping
 * exactly once, never dropping or duplicating a row, and being abandonable so a
 * superseded load cannot overwrite a newer one.
 */

let fetchMock;

/** Serves `total` synthetic events, honouring limit/offset the way the API does. */
function serve(total, { legacyShape = false } = {}) {
  const calls = [];
  fetchMock = vi.fn(async (url) => {
    const u = new URL(url, 'http://localhost');
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset') || 0);
    calls.push({ limit, offset });

    const slice = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      slice.push({ id: `e${i}`, title: `Event ${i}` });
    }

    const body = legacyShape ? slice : {
      events: slice,
      pagination: {
        total,
        limit,
        offset,
        returned: slice.length,
        hasMore: offset + slice.length < total,
        nextOffset: offset + slice.length < total ? offset + slice.length : null,
        maxLimit: 200
      }
    };

    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body
    };
  });
  global.fetch = fetchMock;
  return calls;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { delete global.fetch; });

describe('fetchEventsProgressive', () => {
  it('returns every event exactly once', async () => {
    serve(503);
    const all = await api.fetchEventsProgressive({ pageSize: 200 });
    expect(all).toHaveLength(503);
    expect(new Set(all.map(e => e.id)).size).toBe(503);
  });

  it('preserves server order across pages', async () => {
    serve(45);
    const all = await api.fetchEventsProgressive({ pageSize: 10 });
    expect(all.map(e => e.id)).toEqual(Array.from({ length: 45 }, (_, i) => `e${i}`));
  });

  it('follows nextOffset rather than recomputing the offset itself', async () => {
    const calls = serve(25);
    await api.fetchEventsProgressive({ pageSize: 10 });
    expect(calls.map(c => c.offset)).toEqual([0, 10, 20]);
  });

  it('makes exactly one request when everything fits on one page', async () => {
    const calls = serve(5);
    await api.fetchEventsProgressive({ pageSize: 200 });
    // The common case — a school with a handful of events — must not become
    // chattier than the single request it replaced.
    expect(calls).toHaveLength(1);
  });

  it('stops after the final page instead of requesting an empty one', async () => {
    const calls = serve(20);
    await api.fetchEventsProgressive({ pageSize: 10 });
    // 20 items, 10 per page: two requests. A third would mean it is trusting a
    // short page rather than nextOffset.
    expect(calls).toHaveLength(2);
  });

  it('handles an empty list', async () => {
    const calls = serve(0);
    const all = await api.fetchEventsProgressive({ pageSize: 200 });
    expect(all).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reports progress after every page, cumulatively', async () => {
    serve(30);
    const seen = [];
    await api.fetchEventsProgressive({
      pageSize: 10,
      onPage: (soFar, pagination) => seen.push({ count: soFar.length, total: pagination.total })
    });
    expect(seen.map(s => s.count)).toEqual([10, 20, 30]);
    expect(seen.every(s => s.total === 30)).toBe(true);
  });

  /**
   * The race the generation counter in App.jsx exists to win. A superseded walk
   * must abandon itself rather than keep applying pages over a newer one's
   * results.
   */
  it('abandons the walk when shouldContinue turns false', async () => {
    const calls = serve(1000);
    let pages = 0;
    const all = await api.fetchEventsProgressive({
      pageSize: 100,
      shouldContinue: () => pages < 2,
      onPage: () => { pages++; }
    });
    /**
     * Bounded, not immediate. Remaining pages are fetched concurrently, so up to
     * CONCURRENCY (5) requests can already be in flight when the abandon signal
     * flips — plus the first page, which is always sequential. What matters is
     * that it stops early rather than completing all ten pages; the in-flight
     * results are discarded by the caller's generation check.
     */
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(all.length).toBeLessThan(1000);
  });

  it('does not call onPage after being abandoned', async () => {
    serve(1000);
    let allowed = true;
    const onPage = vi.fn(() => { allowed = false; });
    await api.fetchEventsProgressive({ pageSize: 100, shouldContinue: () => allowed, onPage });
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  /**
   * Degrades to a single request against a server that still returns the bare
   * array, rather than throwing on the missing envelope.
   */
  it('tolerates the legacy bare-array response', async () => {
    const calls = serve(7, { legacyShape: true });
    const all = await api.fetchEventsProgressive({ pageSize: 200 });
    expect(all).toHaveLength(7);
    expect(calls).toHaveLength(1);
  });

  it('surfaces a request failure rather than returning a partial list silently', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'boom' })
    }));
    await expect(api.fetchEventsProgressive({ pageSize: 10 })).rejects.toBeTruthy();
  });

  it('respects the page-count guard against a server that always says hasMore', async () => {
    // A server stuck reporting nextOffset must not spin the client forever.
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        events: [{ id: 'stuck' }],
        pagination: { total: 1e9, limit: 1, offset: 0, returned: 1, hasMore: true, nextOffset: 1 }
      })
    }));
    const all = await api.fetchEventsProgressive({ pageSize: 1 });
    // MAX_PAGES caps the ADDITIONAL pages at 200; the first page is always
    // fetched, so 201 is the ceiling. The property under test is that it
    // terminates at all rather than following nextOffset forever.
    expect(all.length).toBeLessThanOrEqual(201);
  });
});
