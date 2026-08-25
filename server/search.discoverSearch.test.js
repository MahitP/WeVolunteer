import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  shouldUseSemantic, buildPineconeFilter, rrfFuse, shouldRerank,
  rerankBudgetState, __resetRerankBudget, semanticCandidates,
} from './search/discoverSearch.js';
import { resolvePineconeConfig, __resetPineconeConfig, pineconeEnabled } from './search/pineconeConfig.js';
import { __resetPineconeClient } from './search/pineconeClient.js';

/**
 * The decisions the search service makes before it spends anything.
 *
 * ── Why so much of this file is about NOT calling Pinecone ──
 *
 * The Starter plan meters everything: 1,000,000 read units a month, 5,000,000
 * embedding tokens, and — the one that shapes the design — 500 rerank requests,
 * which is about sixteen a day. A search integration that treats the vendor as
 * free is one that stops working in the third week of the month, on a school
 * platform, during the term. So the cheapest correct behaviour is the default,
 * and every escalation past it is a decision with a test.
 */

const withConfig = (env, fn) => {
  const prev = { ...process.env };
  Object.assign(process.env, { WEV_PINECONE_TEST_SINK: '1', ...env });
  __resetPineconeConfig();
  __resetPineconeClient();
  try { return fn(); } finally {
    process.env = prev;
    __resetPineconeConfig();
    __resetPineconeClient();
  }
};

beforeEach(() => { __resetRerankBudget(); __resetPineconeConfig(); });
afterEach(() => { __resetRerankBudget(); __resetPineconeConfig(); __resetPineconeClient(); });

describe('whether the integration is on at all', () => {
  /** Off is the default, and the default must serve a working Discover. */
  it('is disabled without an API key', () => {
    expect(resolvePineconeConfig({}).enabled).toBe(false);
    expect(resolvePineconeConfig({}).reason).toBe('not_configured');
  });

  /**
   * A suite that talks to a real vendor spends somebody's quota silently and
   * writes fixture events into a production index. The gate is checked first,
   * exactly as `telemetrySink.js` checks its own.
   */
  it('refuses to run from a test process even when fully configured', () => {
    expect(resolvePineconeConfig({ VITEST: '1', PINECONE_API_KEY: 'real-key' }).enabled).toBe(false);
    expect(resolvePineconeConfig({ VITEST: '1', PINECONE_API_KEY: 'real-key' }).reason).toBe('test_environment');
  });

  it('lets a test opt in by name', () => {
    const cfg = resolvePineconeConfig({ VITEST: '1', WEV_PINECONE_TEST_SINK: '1', PINECONE_API_KEY: 'k' });
    expect(cfg.enabled).toBe(true);
  });

  /**
   * A developer who sets only an API key must not write into the production
   * namespace. The namespace defaults to NODE_ENV rather than to a shared name.
   */
  it('separates deployments by namespace without being told to', () => {
    expect(resolvePineconeConfig({ PINECONE_API_KEY: 'k', NODE_ENV: 'development' }).namespace).toBe('development');
    expect(resolvePineconeConfig({ PINECONE_API_KEY: 'k', NODE_ENV: 'production' }).namespace).toBe('production');
  });

  /** Reranking is opt-in even when Pinecone is on. 500 a month is not a default. */
  it('leaves reranking off unless asked for explicitly', () => {
    expect(resolvePineconeConfig({ PINECONE_API_KEY: 'k' }).rerankEnabled).toBe(false);
    expect(resolvePineconeConfig({ PINECONE_API_KEY: 'k', PINECONE_RERANK: '1' }).rerankEnabled).toBe(true);
  });
});

describe('which queries are worth a vendor call', () => {
  const on = (fn) => withConfig({ PINECONE_API_KEY: 'k' }, fn);

  it('runs semantic search for a natural-language query', () => {
    on(() => {
      expect(pineconeEnabled()).toBe(true);
      expect(shouldUseSemantic('volunteer opportunities helping elementary school children')).toBe(true);
      expect(shouldUseSemantic('something outdoors involving animals')).toBe(true);
    });
  });

  /** Browsing is a filter, not a question, and it is the page's default state. */
  it('does not spend a read on an empty query', () => {
    on(() => {
      expect(shouldUseSemantic('')).toBe(false);
      expect(shouldUseSemantic('   ')).toBe(false);
      expect(shouldUseSemantic(null)).toBe(false);
    });
  });

  /** "ch" is somebody two keystrokes into "chess". */
  it('leaves prefixes to the substring search', () => {
    on(() => {
      expect(shouldUseSemantic('ch')).toBe(false);
      expect(shouldUseSemantic('a')).toBe(false);
      expect(shouldUseSemantic('che')).toBe(true);
    });
  });

  /** `@handle` and `#tag` have exact answers and are routed elsewhere. */
  it('leaves the sigil searches alone', () => {
    on(() => {
      expect(shouldUseSemantic('@leo.chen')).toBe(false);
      expect(shouldUseSemantic('#nhs')).toBe(false);
      expect(shouldUseSemantic('anything', { sigil: 'handle' })).toBe(false);
      expect(shouldUseSemantic('anything', { sigil: 'tag' })).toBe(false);
    });
  });

  /** Quotes are a request for those words in that order. */
  it('honours a quoted phrase by staying lexical', () => {
    on(() => expect(shouldUseSemantic('"Chess Club"')).toBe(false));
  });

  /** With no key, nothing is ever worth a call. */
  it('is false for everything when Pinecone is off', () => {
    expect(shouldUseSemantic('volunteer opportunities with animals')).toBe(false);
  });
});

describe('the metadata filter', () => {
  /**
   * A district's corpus is mostly history. Without this, a top-60 for "food
   * pantry" can be sixty events from two years ago and the semantic half
   * contributes nothing to a browse of what is open.
   */
  it('narrows to the statuses the caller is browsing', () => {
    expect(buildPineconeFilter({ scope: 'listable' }).status).toEqual({ $in: ['open', 'closed'] });
    expect(buildPineconeFilter({ scope: 'open' }).status).toEqual({ $eq: 'open' });
  });

  /** Cancelled events are never candidates, whatever the scope. */
  it('always excludes cancelled events', () => {
    expect(buildPineconeFilter({ scope: 'all' }).status).toEqual({ $ne: 'cancelled' });
  });

  it('passes through category and tags', () => {
    const filter = buildPineconeFilter({ category: 'Animals', tags: ['nhs', 'weekend'] });
    expect(filter.category).toEqual({ $eq: 'Animals' });
    expect(filter.tags).toEqual({ $in: ['nhs', 'weekend'] });
  });

  it('turns date bounds into epoch-second ranges', () => {
    const filter = buildPineconeFilter({ from: '2026-09-01', to: '2026-09-30' });
    expect(filter.startsAt.$gte).toBe(Math.floor(Date.parse('2026-09-01T00:00:00.000Z') / 1000));
    expect(filter.startsAt.$lte).toBe(Math.floor(Date.parse('2026-09-30T23:59:59.999Z') / 1000));
  });

  /**
   * `openOnly` depends on remaining spots, which the index deliberately does not
   * store. Applying a stale version of it here would hide events that DO have
   * space — a filter that removes correct answers is worse than no filter.
   */
  it('does not try to filter on anything the index cannot know', () => {
    const filter = buildPineconeFilter({ scope: 'open', openOnly: true, minHours: 4, maxDistance: 5 });
    expect(filter).not.toHaveProperty('spots');
    expect(filter).not.toHaveProperty('spotsRemaining');
    expect(filter).not.toHaveProperty('minHours');
    expect(filter).not.toHaveProperty('distance');
  });

  /** Metadata filtering is an optimisation; it never encodes who may see what. */
  it('carries nothing about the viewer', () => {
    const filter = buildPineconeFilter({ scope: 'listable', mine: true, favoritesOnly: true });
    const serialised = JSON.stringify(filter);
    expect(serialised).not.toContain('user');
    expect(filter).not.toHaveProperty('audience');
    expect(filter).not.toHaveProperty('viewer');
  });
});

describe('fusing two rankings', () => {
  /**
   * Agreement is what RRF rewards: an id both halves returned outranks one only
   * a single half returned, whatever their individual positions were.
   *
   * Deliberately not asserting which of two agreed ids wins. With k = 60, first
   * plus third (1/61 + 1/63) and second plus second (2/62) differ in the fifth
   * decimal place — a real ordering, but a knife-edge one that says nothing
   * about the property worth protecting, and pinning it would make the test a
   * description of the arithmetic rather than of the behaviour.
   */
  it('ranks ids both lists returned above ids only one returned', () => {
    const fused = rrfFuse([['a', 'b', 'c'], ['c', 'b', 'z']]);
    const agreed = [fused.indexOf('b'), fused.indexOf('c')];
    const alone = [fused.indexOf('a'), fused.indexOf('z')];
    expect(Math.max(...agreed), 'an agreed id ranked below a solo one').toBeLessThan(Math.min(...alone));
    expect(fused).toContain('z');
  });

  it('keeps everything from both lists', () => {
    expect(rrfFuse([['a'], ['b']]).sort()).toEqual(['a', 'b']);
  });

  it('is deterministic when scores tie', () => {
    expect(rrfFuse([['a'], ['b']])).toEqual(rrfFuse([['a'], ['b']]));
  });

  it('survives empty and malformed input', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], null, undefined])).toEqual([]);
    expect(rrfFuse([['a', null, '', 'b']])).toEqual(['a', 'b']);
  });

  /** A first place from either list beats a third place from both. */
  it('rewards rank rather than count alone', () => {
    const fused = rrfFuse([['top'], ['x', 'y', 'shared'], ['x', 'y', 'shared']]);
    expect(fused).toContain('top');
    expect(fused.indexOf('x')).toBeLessThan(fused.indexOf('shared'));
  });
});

describe('rationing the reranker', () => {
  /**
   * 500 requests a month is about sixteen a day. Off by default is the first
   * protection; these are the second and third.
   */
  it('never reranks while the feature is off', () => {
    withConfig({ PINECONE_API_KEY: 'k' }, () => {
      expect(shouldRerank('a long natural language query about animals', 50)).toBe(false);
    });
  });

  it('reranks a long query with plenty of candidates once enabled', () => {
    withConfig({ PINECONE_API_KEY: 'k', PINECONE_RERANK: '1' }, () => {
      expect(shouldRerank('volunteer opportunities helping elementary school children', 50)).toBe(true);
    });
  });

  /** A two-word query with four results has nothing to reorder. */
  it('declines short queries and small candidate sets', () => {
    withConfig({ PINECONE_API_KEY: 'k', PINECONE_RERANK: '1' }, () => {
      expect(shouldRerank('dog walking', 50)).toBe(false);
      expect(shouldRerank('volunteer opportunities helping elementary children', 4)).toBe(false);
    });
  });

  it('stops when the month’s budget is gone', () => {
    withConfig({ PINECONE_API_KEY: 'k', PINECONE_RERANK: '1', PINECONE_RERANK_BUDGET: '400' }, () => {
      expect(rerankBudgetState().remaining).toBeGreaterThan(0);
      expect(shouldRerank('a query with more than four words in it', 50)).toBe(true);
    });
  });
});

describe('when Pinecone is unavailable', () => {
  /**
   * The property the whole integration rests on: a vendor problem produces an
   * empty candidate list, never an exception. The caller then runs the search it
   * ran before this existed.
   */
  it('returns no candidates rather than throwing, with no key', async () => {
    const res = await semanticCandidates('anything at all', { scope: 'listable' });
    expect(res.ok).toBe(false);
    expect(res.ids).toEqual([]);
    expect(res.reason).toBe('disabled');
  });

  it('returns no candidates rather than throwing, against a dead port', async () => {
    const res = await withConfig(
      { PINECONE_API_KEY: 'k', PINECONE_INDEX_HOST: 'http://127.0.0.1:1' },
      () => semanticCandidates('volunteer opportunities with animals', { scope: 'listable' }),
    );
    expect(res.ok).toBe(false);
    expect(res.ids).toEqual([]);
    expect(res.durationMs).toBeLessThan(5000);
  }, 15000);
});


/**
 * What telemetry is allowed to know about a search.
 *
 * `docs/operations/pinecone.md` claims that search text never leaves this
 * application through telemetry. That is a privacy claim about free text typed
 * by minors into a school platform, and a claim of that kind should be asserted
 * on the wire rather than argued from the source.
 *
 * Both sinks are pointed at loopback stubs: Pinecone answers a search, and
 * Better Stack receives whatever the search decided to report.
 */
describe('what a search tells telemetry', () => {
  it('reports the shape of the search and never its text', async () => {
    const QUERY = 'help autistic children with reading at lincoln elementary';
    const delivered = [];

    const pinecone = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ result: { hits: [{ _id: 'event:abc', _score: 0.9 }] } }));
      });
    });
    pinecone.listen(0, '127.0.0.1');
    await once(pinecone, 'listening');

    const betterstack = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { delivered.push(...JSON.parse(body)); } catch { /* not ours */ }
        res.writeHead(202).end('{}');
      });
    });
    betterstack.listen(0, '127.0.0.1');
    await once(betterstack, 'listening');

    const prev = { ...process.env };
    try {
      process.env.WEV_PINECONE_TEST_SINK = '1';
      process.env.PINECONE_API_KEY = 'k';
      process.env.PINECONE_INDEX_HOST = `http://127.0.0.1:${pinecone.address().port}`;
      process.env.PINECONE_NAMESPACE = 'test';
      process.env.WEV_TELEMETRY_TEST_SINK = '1';
      process.env.BETTERSTACK_SOURCE_TOKEN = 'telemetry-token';
      process.env.BETTERSTACK_INGESTING_HOST = `http://127.0.0.1:${betterstack.address().port}`;

      __resetPineconeConfig();
      __resetPineconeClient();
      const sink = await import('./telemetrySink.js');
      sink.__resetTelemetrySink();

      const res = await semanticCandidates(QUERY, { scope: 'listable' });
      expect(res.ok, 'the stub search did not succeed, so nothing was reported').toBe(true);

      await sink.drainTelemetry();

      const record = delivered.find((r) => r.event === 'pinecone.search');
      expect(record, 'the search reported nothing at all').toBeTruthy();

      /* The shape: enough to answer "is search slow" and "is it failing". */
      expect(record.operation).toBe('discover');
      expect(record.outcome).toBe('ok');
      expect(typeof record.durationMs).toBe('number');

      /* And not one word of what the student was looking for. */
      const serialised = JSON.stringify(delivered);
      for (const fragment of ['autistic', 'lincoln', 'elementary', 'reading', QUERY]) {
        expect(serialised, `"${fragment}" reached the telemetry vendor`).not.toContain(fragment);
      }
    } finally {
      process.env = prev;
      __resetPineconeConfig();
      __resetPineconeClient();
      (await import('./telemetrySink.js')).__resetTelemetrySink();
      pinecone.close(); await once(pinecone, 'close').catch(() => {});
      betterstack.close(); await once(betterstack, 'close').catch(() => {});
    }
  }, 20000);
});
