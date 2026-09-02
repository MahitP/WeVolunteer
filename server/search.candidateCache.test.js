/**
 * The candidate cache, on its own.
 *
 * `search.integration.test.js` asserts what the cache does to a REQUEST — how
 * many times the vendor is called and which rows come back. This asserts the
 * properties of the structure itself, which that file cannot reach: expiry,
 * eviction, what happens to a failure, and whether a caller can corrupt an
 * entry by holding on to what it was given.
 *
 * The limits are read from the environment when the module loads, so they are
 * set here BEFORE the dynamic import rather than by an ordinary top-level
 * import, which would be hoisted above them.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let candidateKey, withCandidateCache, candidateCacheStats, __resetCandidateCache;

beforeAll(async () => {
  process.env.PINECONE_CANDIDATE_TTL_MS = '120';
  process.env.PINECONE_CANDIDATE_MAX = '3';
  ({ candidateKey, withCandidateCache, candidateCacheStats, __resetCandidateCache } =
    await import('./search/candidateCache.js'));
});

beforeEach(() => __resetCandidateCache());

const ok = (ids) => ({ ok: true, ids });

describe('the key', () => {
  it('is a hash, so the query text is not readable in the process', () => {
    const key = candidateKey({ op: 'discover', text: 'food pantry saturday' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('pantry');
  });

  it('separates two questions that differ anywhere', () => {
    const base = { op: 'discover', index: 'i', namespace: 'n', text: 'chess', filter: {}, topK: 60 };
    const keys = new Set([
      candidateKey(base),
      candidateKey({ ...base, text: 'chess club' }),
      candidateKey({ ...base, topK: 30 }),
      candidateKey({ ...base, namespace: 'other' }),
      candidateKey({ ...base, filter: { status: { $eq: 'open' } } }),
      candidateKey({ ...base, op: 'similar' }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('gives the same question the same key', () => {
    const parts = { op: 'discover', text: 'beach cleanup', filter: { status: { $ne: 'cancelled' } } };
    expect(candidateKey(parts)).toBe(candidateKey({ ...parts }));
  });
});

describe('hits and misses', () => {
  it('calls the loader once for a repeated question', async () => {
    const key = candidateKey({ text: 'once' });
    let calls = 0;
    const load = async () => { calls += 1; return ok(['e-1', 'e-2']); };

    const first = await withCandidateCache(key, load);
    const second = await withCandidateCache(key, load);

    expect(calls).toBe(1);
    expect(first.ids).toEqual(['e-1', 'e-2']);
    expect(second.ids).toEqual(['e-1', 'e-2']);
    expect(second.cached).toBe(true);
    expect(candidateCacheStats().hits).toBe(1);
  });

  it('stores a successful EMPTY answer, because that is an answer', async () => {
    const key = candidateKey({ text: 'nothing like this' });
    let calls = 0;
    const load = async () => { calls += 1; return ok([]); };

    await withCandidateCache(key, load);
    const again = await withCandidateCache(key, load);

    expect(calls).toBe(1);
    expect(again.ids).toEqual([]);
    expect(again.cached).toBe(true);
  });

  it('does not store a failure', async () => {
    const key = candidateKey({ text: 'vendor down' });
    let calls = 0;
    const load = async () => { calls += 1; return { ok: false, ids: [], reason: 'timeout' }; };

    await withCandidateCache(key, load);
    await withCandidateCache(key, load);

    expect(calls).toBe(2);
    expect(candidateCacheStats().stored).toBe(0);
  });

  it('forgets an entry once its TTL has passed', async () => {
    const key = candidateKey({ text: 'briefly' });
    let calls = 0;
    const load = async () => { calls += 1; return ok(['e-1']); };

    await withCandidateCache(key, load);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await withCandidateCache(key, load);

    expect(calls).toBe(2);
  });
});

describe('the bound on memory', () => {
  it('evicts the oldest entry rather than growing', async () => {
    for (const text of ['a', 'b', 'c', 'd']) {
      await withCandidateCache(candidateKey({ text }), async () => ok([text]));
    }
    expect(candidateCacheStats().size).toBe(3);
    expect(candidateCacheStats().evicted).toBe(1);

    /* 'a' was first in and is the one that went. */
    let reloaded = false;
    await withCandidateCache(candidateKey({ text: 'a' }), async () => { reloaded = true; return ok(['a']); });
    expect(reloaded).toBe(true);
  });
});

describe('what a caller is given', () => {
  /**
   * The list reaches a sort builder and a parameter binder by way of
   * `filters.semanticIds`. If it were the cache's own array, one caller sorting
   * it in place would silently reorder every later answer to the same question.
   */
  it('hands out a copy, so a caller cannot rewrite the entry', async () => {
    const key = candidateKey({ text: 'mutation' });
    const first = await withCandidateCache(key, async () => ok(['e-1', 'e-2', 'e-3']));
    first.ids.reverse();
    first.ids.push('e-999');

    const second = await withCandidateCache(key, async () => ok(['unused']));
    expect(second.ids).toEqual(['e-1', 'e-2', 'e-3']);
  });

  it('is not corrupted by the loader keeping its own reference', async () => {
    const key = candidateKey({ text: 'loader keeps it' });
    const mine = ['e-1'];
    await withCandidateCache(key, async () => ok(mine));
    mine.push('e-2');

    const second = await withCandidateCache(key, async () => ok(['unused']));
    expect(second.ids).toEqual(['e-1']);
  });
});

describe('single flight', () => {
  it('runs one loader for callers that arrive together', async () => {
    const key = candidateKey({ text: 'together' });
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ok(['e-1']);
    };

    const results = await Promise.all([
      withCandidateCache(key, load),
      withCandidateCache(key, load),
      withCandidateCache(key, load),
    ]);

    expect(calls).toBe(1);
    for (const r of results) expect(r.ids).toEqual(['e-1']);
    expect(candidateCacheStats().coalesced).toBe(2);
  });

  it('does not wedge a key when the loader rejects', async () => {
    const key = candidateKey({ text: 'rejects' });
    await expect(withCandidateCache(key, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(candidateCacheStats().inFlight).toBe(0);

    const after = await withCandidateCache(key, async () => ok(['e-1']));
    expect(after.ids).toEqual(['e-1']);
  });
});
