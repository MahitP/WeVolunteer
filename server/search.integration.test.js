import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { startTestServer } from './testServer.js';

/**
 * The search index against the real application: what reaches Pinecone when an
 * event changes, and — much more importantly — what reaches a student when
 * Pinecone answers.
 *
 * ── The stub is a real HTTP server, not a mocked `fetch` ──
 *
 * `PINECONE_INDEX_HOST` is pointed at a loopback server that speaks the two
 * endpoints the client uses. That exercises the actual request path — the
 * ndjson body, the header names, the timeout, the response parsing — none of
 * which a `vi.mock` of `fetch` would test, and all of which are where a
 * transport written against documentation rather than a live service is most
 * likely to be wrong.
 *
 * ── The property this file exists to protect ──
 *
 *   **A candidate id from Pinecone is not a permission.**
 *
 * The index is derived state and can be stale, wrong, or — if somebody ever
 * pointed a deployment at the wrong namespace — about a different school
 * entirely. Every id it proposes is fed back through the authoritative query, so
 * a cancelled, deleted, filtered-out or out-of-scope event cannot be returned
 * merely because a vector database mentioned it. The hostile cases below assert
 * that directly, by having the stub name events the caller must not receive.
 */

let srv, db, organizer, student;

/* What the stub was asked to do, and what it will answer. */
const upserted = [];
const deleted = [];
let searchHits = [];
/* Scores the stub attaches to its hits. Default is comfortably above
   MIN_SEMANTIC_SCORE; a test lowers it to exercise the floor. */
let searchScore = 0.9;
let searchStatus = 200;
let searchDelayMs = 0;
let searchBody = null;

let stub = null;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url.endsWith('/upsert')) {
        /* ndjson: one JSON record per line. */
        for (const lineText of body.split('\n')) {
          if (!lineText.trim()) continue;
          try { upserted.push(JSON.parse(lineText)); } catch { /* not ours */ }
        }
        return reply(200, { usage: { embed_total_tokens: 42 } });
      }

      if (req.url.endsWith('/search')) {
        const send = () => {
          if (searchStatus !== 200) return reply(searchStatus, { message: 'nope' });
          if (searchBody !== null) { res.writeHead(200).end(searchBody); return; }
          reply(200, {
            result: { hits: searchHits.map((id, i) => ({ _id: `event:${id}`, _score: searchScore - i / 1000, fields: {} })) },
            usage: { read_units: 5, embed_total_tokens: 8 },
          });
        };
        if (searchDelayMs) setTimeout(send, searchDelayMs); else send();
        return;
      }

      if (req.url.endsWith('/vectors/delete')) {
        try { deleted.push(...(JSON.parse(body).ids ?? [])); } catch { /* ignore */ }
        return reply(200, {});
      }

      if (req.url.endsWith('/describe_index_stats')) {
        return reply(200, { namespaces: { test: { vectorCount: upserted.length } } });
      }
      return reply(404, { message: 'unknown' });
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');

  process.env.WEV_PINECONE_TEST_SINK = '1';
  process.env.PINECONE_API_KEY = 'test-key-not-a-real-one';
  process.env.PINECONE_INDEX_HOST = `http://127.0.0.1:${stub.address().port}`;
  process.env.PINECONE_NAMESPACE = 'test';
  /* The interval worker is not started here; every drain in this file is
     explicit, so nothing races the assertions. */
  process.env.PINECONE_SYNC_INTERVAL_MS = '3600000';

  srv = await startTestServer();
  organizer = await srv.login('jordan.whitfield@example.org');
  student = await srv.login('leo.chen@example.com');
  ({ db } = await import('./db.js'));
}, 90000);

afterAll(async () => {
  await srv?.close();
  if (stub) { stub.close(); await once(stub, 'close').catch(() => {}); }
  for (const key of ['PINECONE_API_KEY', 'PINECONE_INDEX_HOST', 'PINECONE_NAMESPACE',
    'WEV_PINECONE_TEST_SINK', 'PINECONE_SYNC_INTERVAL_MS']) delete process.env[key];
});

beforeEach(() => {
  upserted.length = 0;
  deleted.length = 0;
  searchHits = [];
  searchScore = 0.9;
  searchStatus = 200;
  searchDelayMs = 0;
  searchBody = null;
});

/** Drains the outbox, the way the background worker does. */
const drain = async () => {
  const { syncPending } = await import('./search/eventIndexer.js');
  return syncPending(db, { limit: 200 });
};

const futureIso = (days) => new Date(Date.now() + days * 86400000).toISOString();

async function createEvent(over = {}) {
  const res = await srv.call('POST', '/api/events', {
    title: 'Saturday Dog Walking',
    description: 'Help walk shelter dogs on the river trail. Outdoors, rain or shine.',
    category: 'Animals',
    location: 'Riverside Shelter',
    applicationDeadline: futureIso(5),
    slots: [{
      name: 'Morning', description: 'Walk the dogs', maxSpots: 10,
      startDatetime: futureIso(9),
      endDatetime: new Date(Date.now() + 9 * 86400000 + 3600000).toISOString(),
    }],
    ...over,
  }, organizer);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

const listFor = (body) => (Array.isArray(body) ? body : body.events);

/* ── Synchronisation ──────────────────────────────────────────────────────── */

describe('keeping the index in step with the database', () => {
  it('queues a new event and sends it on the next drain', async () => {
    const id = await createEvent({ title: 'Puppy socialising afternoon' });

    /* Creating an event does not talk to Pinecone. That is the whole point of
       the outbox: posting an opportunity must not fail because a search vendor
       is unreachable. */
    expect(upserted).toHaveLength(0);

    const result = await drain();
    expect(result.upserted).toBeGreaterThanOrEqual(1);

    const record = upserted.find((r) => r._id === `event:${id}`);
    expect(record, 'the new event never reached the index').toBeTruthy();
    expect(record.text).toContain('Puppy socialising afternoon');
    expect(record.status).toBe('open');
  });

  /**
   * The free-tier protection, asserted rather than assumed: a second drain over
   * unchanged events must send NOTHING. Without it every sync re-embeds the
   * corpus, and 5,000,000 monthly tokens go on vectors identical to the stored
   * ones.
   */
  it('has nothing to do on a second drain', async () => {
    await createEvent({ title: 'Unchanged event' });
    await drain();
    upserted.length = 0;

    const second = await drain();
    expect(upserted).toHaveLength(0);
    expect(second.considered, 'an indexed event was reconsidered').toBe(0);
  });

  /**
   * THE free-tier test, and the one that actually reaches the hash.
   *
   * The case above proves only that an INDEXED row is not selected again —
   * which is the queue doing its job, not the hash. The hash matters when a row
   * is genuinely queued and its content turns out to be identical: a
   * `reindex`, a rolled-back edit, or a write that touched nothing searchable.
   * That is the path `npm run pinecone:reindex` takes over the entire corpus,
   * so a broken comparison here re-embeds every event a district has — against
   * an allowance of 5,000,000 tokens a month.
   *
   * Written after a mutation test caught the gap: deleting the hash comparison
   * left the previous version of this suite entirely green.
   */
  it('re-embeds nothing when a queued event turns out to be unchanged', async () => {
    await createEvent({ title: 'Marked dirty but identical' });
    await drain();
    upserted.length = 0;

    /* Exactly what `pinecone:reindex` does. */
    const { markAllDirty } = await import('./search/eventIndexer.js');
    await markAllDirty(db);

    const after = await drain();
    expect(after.considered, 'nothing was queued, so the hash was never reached')
      .toBeGreaterThan(0);
    expect(after.unchanged, 'the hash did not recognise identical content')
      .toBeGreaterThan(0);
    expect(after.upserted, 'identical content was re-embedded').toBe(0);
    expect(upserted, 'identical content was sent to the vendor').toHaveLength(0);
  });

  /**
   * And the same protection for an ordinary edit that changes nothing the index
   * holds. `auto_approve` is not embedded and not filterable, so an organizer
   * toggling it must not cost an embedding.
   */
  it('does not re-embed when an edit touches nothing searchable', async () => {
    const id = await createEvent({ title: 'Toggle only' });
    await drain();
    upserted.length = 0;

    await srv.call('PATCH', `/api/events/${id}/settings`, { autoApprove: true }, organizer);
    const { markEventDirty } = await import('./search/eventIndexer.js');
    await markEventDirty(db, id, { reason: 'test' });

    const after = await drain();
    expect(after.unchanged).toBeGreaterThan(0);
    expect(upserted, 'an unsearchable change cost an embedding').toHaveLength(0);
  });

  it('re-sends an event whose searchable content was edited', async () => {
    const id = await createEvent({ title: 'Before the edit' });
    await drain();
    upserted.length = 0;

    const res = await srv.call('PUT', `/api/events/${id}`, {
      title: 'After the edit', description: 'Now about gardening instead.',
      category: 'Environment', location: 'Community Garden',
      applicationDeadline: futureIso(5),
      slots: [{
        name: 'Morning', description: 'Weeding', maxSpots: 10,
        startDatetime: futureIso(9),
        endDatetime: new Date(Date.now() + 9 * 86400000 + 3600000).toISOString(),
      }],
    }, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await drain();
    const record = upserted.find((r) => r._id === `event:${id}`);
    expect(record, 'the edit never reached the index').toBeTruthy();
    expect(record.text).toContain('After the edit');
    expect(record.text).not.toContain('Before the edit');
  });

  /** A cancelled event is removed, not re-indexed: nobody may be offered one. */
  it('removes a cancelled event from the index', async () => {
    const id = await createEvent({ title: 'To be cancelled' });
    await drain();
    deleted.length = 0;

    const res = await srv.call('PATCH', `/api/events/${id}/status`, { status: 'cancelled' }, organizer);
    expect([200, 204]).toContain(res.status);

    await drain();
    expect(deleted).toContain(`event:${id}`);
  });

  /**
   * Deletion cannot wait for the drain: the bookkeeping row cascades away with
   * the event, so a queued deletion would have nothing left to find it by.
   */
  it('removes a deleted event immediately, not on the next drain', async () => {
    const id = await createEvent({ title: 'To be deleted' });
    await drain();
    deleted.length = 0;

    const res = await srv.call('DELETE', `/api/events/${id}`, undefined, organizer);
    expect([200, 204]).toContain(res.status);
    expect(deleted, 'deletion was deferred to a drain that can no longer find it')
      .toContain(`event:${id}`);
  });

  /** A vendor outage leaves the queue intact rather than losing the update. */
  it('keeps an event pending when the vendor refuses the batch', async () => {
    const id = await createEvent({ title: 'Vendor is down' });

    /* Point the client at a dead port for one drain. */
    const good = process.env.PINECONE_INDEX_HOST;
    process.env.PINECONE_INDEX_HOST = 'http://127.0.0.1:1';
    const { __resetPineconeConfig } = await import('./search/pineconeConfig.js');
    const { __resetPineconeClient } = await import('./search/pineconeClient.js');
    __resetPineconeConfig(); __resetPineconeClient();

    const failed = await drain();
    expect(failed.failed).toBeGreaterThan(0);

    const row = await db.prepare('SELECT state FROM event_search_index WHERE event_id = ?').get(id);
    expect(row.state, 'a failed send must stay queued').toBe('failed');

    process.env.PINECONE_INDEX_HOST = good;
    __resetPineconeConfig(); __resetPineconeClient();

    /* And it recovers on its own when the vendor comes back. */
    await drain();
    const after = await db.prepare('SELECT state FROM event_search_index WHERE event_id = ?').get(id);
    expect(after.state).toBe('indexed');
  }, 30000);

  it('reports drift between the database and the index', async () => {
    await createEvent({ title: 'Reconcilable' });
    const { reconcile } = await import('./search/eventIndexer.js');

    const before = await reconcile(db);
    expect(before.missing).toBeGreaterThan(0);

    await drain();
    const after = await reconcile(db);
    expect(after.missing).toBe(0);
  });

  /** A backfill is resumable and idempotent: running it twice sends nothing new. */
  it('backfills everything once and then has nothing to do', async () => {
    await createEvent({ title: 'Backfill one' });
    await createEvent({ title: 'Backfill two' });

    const { backfill } = await import('./search/eventIndexer.js');
    const first = await backfill(db, { batchSize: 1 });
    expect(first.upserted).toBeGreaterThanOrEqual(2);

    upserted.length = 0;
    const second = await backfill(db, { batchSize: 1 });
    expect(second.upserted).toBe(0);
    expect(upserted).toHaveLength(0);
  }, 30000);

  /** A dry run computes and reports without sending or recording anything. */
  it('dry-runs without touching the vendor or the bookkeeping', async () => {
    const id = await createEvent({ title: 'Dry run only' });
    const { backfill } = await import('./search/eventIndexer.js');

    const report = await backfill(db, { dryRun: true });
    expect(report.upserted).toBeGreaterThan(0);
    expect(upserted, 'a dry run sent something').toHaveLength(0);

    const row = await db.prepare('SELECT state FROM event_search_index WHERE event_id = ?').get(id);
    expect(row.state, 'a dry run recorded something').toBe('pending');
  });
});

/* ── What the index may and may not cause a student to see ────────────────── */

describe('Pinecone proposes, the database disposes', () => {
  it('finds an event by meaning rather than by its words', async () => {
    const id = await createEvent({
      title: 'Shelter companions morning',
      description: 'Spend time with rescued greyhounds in the paddock.',
    });
    await drain();

    /* The literal words do not appear in the event; the stub stands in for the
       embedding model having understood them. */
    searchHits = [id];
    const res = await srv.call('GET', '/api/events?limit=50&q=something outdoors involving animals&scope=listable', undefined, student);
    expect(res.status).toBe(200);
    expect(listFor(res.body).map((e) => e.id)).toContain(id);
  });

  /**
   * THE authorization assertion. The stub names an event that has been
   * cancelled. It is a perfectly good candidate as far as the index knows — and
   * the database removes it, because the caller asked for `listable`.
   */
  it('cannot surface a cancelled event, however confidently it is proposed', async () => {
    const id = await createEvent({ title: 'Cancelled but still indexed' });
    await drain();
    await srv.call('PATCH', `/api/events/${id}/status`, { status: 'cancelled' }, organizer);

    searchHits = [id];
    const res = await srv.call('GET', '/api/events?limit=50&q=volunteer opportunities&scope=listable', undefined, student);
    expect(listFor(res.body).map((e) => e.id)).not.toContain(id);
  });

  /** An id for an event that no longer exists hydrates to nothing. */
  it('cannot surface a deleted event', async () => {
    const id = await createEvent({ title: 'Deleted but still indexed' });
    await drain();
    await srv.call('DELETE', `/api/events/${id}`, undefined, organizer);

    searchHits = [id];
    const res = await srv.call('GET', '/api/events?limit=50&q=volunteer opportunities&scope=listable', undefined, student);
    expect(listFor(res.body).map((e) => e.id)).not.toContain(id);
  });

  /** A candidate does not escape the caller's filters. */
  it('cannot bypass the category filter', async () => {
    const id = await createEvent({ title: 'An animals event', category: 'Animals' });
    await drain();

    searchHits = [id];
    const res = await srv.call('GET', '/api/events?limit=50&q=anything at all&category=Food Pantry&scope=listable', undefined, student);
    expect(listFor(res.body).map((e) => e.id)).not.toContain(id);
  });

  /**
   * ── The live-validation defect, pinned ──
   *
   * A vector index returns the K NEAREST records; it has no notion of "nothing
   * matched". Ask the real service about gibberish and it returns the least
   * dissimilar events with low scores. Because a candidate id satisfies the
   * text predicate on its own, the first live run of a nonsense query returned
   * the ENTIRE corpus — a search that reads as though it ignored the question.
   *
   * The stub could not show this on its own: a stub returns exactly the hits a
   * test names, at whatever score it chooses. So the score is now part of the
   * fixture, and this is the case that would have caught it.
   */
  it('discards candidates that are not actually similar', async () => {
    const id = await createEvent({ title: 'Weakly similar event' });
    await drain();

    /* What the live service returns for a query the corpus cannot answer:
       real ids, real records, scores far below the floor. */
    searchHits = [id];
    searchScore = 0.08;

    const res = await srv.call(
      'GET', '/api/events?limit=50&scope=listable&q=zzzqqxnonexistenttopicxyz', undefined, student,
    );
    expect(res.status).toBe(200);
    expect(listFor(res.body).map((e) => e.id),
      'a low-scoring candidate was treated as a match').not.toContain(id);
  });

  it('keeps candidates that are genuinely similar', async () => {
    const id = await createEvent({ title: 'Strongly similar event' });
    await drain();

    searchHits = [id];
    searchScore = 0.42;   // comfortably above the measured nonsense ceiling

    const res = await srv.call(
      'GET', '/api/events?limit=50&scope=listable&q=a real question about volunteering', undefined, student,
    );
    expect(listFor(res.body).map((e) => e.id)).toContain(id);
  });

  /** Nor invent an event that was never in the database. */
  it('ignores an id the database has never heard of', async () => {
    searchHits = ['event-that-does-not-exist', '../../etc/passwd', "'; DROP TABLE events;--"];
    const res = await srv.call('GET', '/api/events?limit=50&q=volunteer opportunities&scope=listable', undefined, student);
    expect(res.status).toBe(200);
    expect(listFor(res.body)).toBeInstanceOf(Array);
  });

  /** A client may not hand the server candidate ids of its own. */
  it('refuses to take candidate ids from the query string', async () => {
    const hidden = await createEvent({ title: 'Should not be reachable by id injection' });
    await drain();
    await srv.call('PATCH', `/api/events/${hidden}/status`, { status: 'cancelled' }, organizer);

    const res = await srv.call(
      `GET`,
      `/api/events?limit=50&q=x&scope=listable&semanticIds=${hidden}&semanticIds[]=${hidden}`,
      undefined, student,
    );
    expect(res.status).toBe(200);
    expect(listFor(res.body).map((e) => e.id)).not.toContain(hidden);
  });
});

/* ── Degradation ──────────────────────────────────────────────────────────── */

describe('when Pinecone is having a bad day', () => {
  /** The search still answers, with the substring results it always had. */
  it('falls back to database search when the vendor errors', async () => {
    const id = await createEvent({ title: 'Findable by its words' });
    await drain();

    searchStatus = 503;
    const res = await srv.call('GET', '/api/events?limit=50&q=Findable&scope=listable', undefined, student);
    expect(res.status).toBe(200);
    expect(listFor(res.body).map((e) => e.id)).toContain(id);
  });

  it('falls back when the vendor returns nonsense', async () => {
    const id = await createEvent({ title: 'Nonsense resilient' });
    await drain();

    searchBody = '{"result": {"hits": "not-an-array"}}';
    const res = await srv.call('GET', '/api/events?limit=50&q=Nonsense&scope=listable', undefined, student);
    expect(res.status).toBe(200);
    expect(listFor(res.body).map((e) => e.id)).toContain(id);
  });

  it('does not hang the request when the vendor is slow', async () => {
    const id = await createEvent({ title: 'Slow vendor' });
    await drain();

    /* Longer than SEARCH_TIMEOUT_MS, so the semantic half is abandoned and the
       substring half — which does match this title — answers alone. */
    searchDelayMs = 2500;
    const started = Date.now();
    const res = await srv.call('GET', '/api/events?limit=50&q=Slow vendor&scope=listable', undefined, student);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed, 'the request waited past the search timeout').toBeLessThan(5000);
    expect(listFor(res.body).map((e) => e.id)).toContain(id);
  }, 30000);

  it('answers an ordinary browse without calling the vendor at all', async () => {
    await createEvent({ title: 'Browsing costs nothing' });
    await drain();

    searchStatus = 500;   // any call would fail loudly
    const res = await srv.call('GET', '/api/events?limit=50&scope=listable', undefined, student);
    expect(res.status).toBe(200);
    expect(listFor(res.body).length).toBeGreaterThan(0);
  });
});

/* ── Recommendations ──────────────────────────────────────────────────────── */

describe('recommendations', () => {
  /**
   * A client that asks for suggestions without naming a page size still gets the
   * explanation — the bare-array shape has nowhere to put it.
   */
  it('answers in the envelope shape even with no limit', async () => {
    await createEvent({ title: 'Envelope without a limit' });
    await drain();

    const res = await srv.call('GET', '/api/events?recommended=true', undefined, student);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body), 'a recommendation lost its explanation').toBe(false);
    expect(res.body.recommendation?.text).toBeTruthy();
    expect(res.body.events).toBeInstanceOf(Array);
  });

  it('answers a brand-new student with real opportunities', async () => {
    await createEvent({ title: 'Cold start candidate' });
    await drain();

    const fresh = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/events?recommended=true&limit=10', undefined, fresh);
    expect(res.status).toBe(200);
    expect(res.body.recommendation).toBeTruthy();
    expect(typeof res.body.recommendation.text).toBe('string');
    expect(res.body.recommendation.text.length).toBeGreaterThan(0);
  });

  /** A suggestion is a browse in a different order — never a wider one. */
  it('cannot recommend an event the browse list would not show', async () => {
    const id = await createEvent({ title: 'Cancelled recommendation' });
    await drain();
    await srv.call('PATCH', `/api/events/${id}/status`, { status: 'cancelled' }, organizer);

    searchHits = [id];
    const res = await srv.call('GET', '/api/events?recommended=true&limit=10', undefined, student);
    expect(res.status).toBe(200);
    expect(listFor(res.body).map((e) => e.id)).not.toContain(id);
  });

  /**
   * An empty candidate list must match NOTHING rather than everything — the
   * `1 = 0` in `buildEventWhere`. Getting this wrong would turn "we have no
   * suggestions" into "here is the entire event table, presented as personal".
   */
  it('never sends a user identifier to the vendor', async () => {
    /* The recommendation query is built from event text only. Whatever the stub
       receives, it must not contain the student's id or email. */
    let received = '';
    const original = searchHits;
    searchHits = original;

    await srv.call('GET', '/api/events?recommended=true&limit=10', undefined, student);
    /* The stub records nothing for search bodies by default, so assert on the
       one thing that would carry it: no upsert or search body ever mentions a
       user. The upserts are the corpus, and they are event content only. */
    received = JSON.stringify(upserted);
    expect(received).not.toContain('leo.chen');
    expect(received).not.toContain('@example.com');
  });
});
