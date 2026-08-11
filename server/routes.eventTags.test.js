import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Event tags through the API: writing, reading, filtering and who may change them.
 *
 * `eventTags.test.js` covers normalisation as pure functions. This file covers the
 * parts only the real stack can answer — that tags survive a round trip, that the
 * filter runs in SQL rather than in a client, that its multi-select semantics are
 * what was decided, and that one organizer cannot retag another's event.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
/* The only other seeded organizer. Approval-pending, which does not matter
   here: `verified` gates event CREATION, and what this exercises is the
   ownership refusal on edit. */
const OTHER_ORGANIZER = 'robin.ellery@example.org';
const STUDENT = 'leo.chen@example.com';

describe('event tags', () => {
  let srv;
  let organizer;

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /** A minimal valid event payload; `tags` is layered on per test. */
  const payload = (over = {}) => ({
    title: `Tagged event ${Math.random().toString(36).slice(2, 8)}`,
    description: 'A description long enough to pass validation for this event.',
    category: 'School',
    location: 'Example Valley High School',
    applicationDeadline: '2027-01-01',
    slots: [{
      name: 'Morning', description: 'The morning shift',
      startDatetime: '2027-02-01T09:00:00.000Z',
      endDatetime: '2027-02-01T12:00:00.000Z',
      maxSpots: 5,
    }],
    ...over,
  });

  const create = async (body, session = organizer) =>
    srv.call('POST', '/api/events', payload(body), session);

  /** The created event, read back through the detail endpoint. */
  const readBack = async (eventId, session = organizer) => {
    const res = await srv.call('GET', `/api/events/${eventId}`, undefined, session);
    return res.body.event;
  };

  it('saves arbitrary organizer-invented tags and reads them back', async () => {
    /* Deliberately none of the examples in the brief: the requirement is that the
       vocabulary is not predefined, so the test uses tags no code has heard of. */
    const res = await create({ tags: ['CommunityGarden', 'SATPrep', 'K-9'] });
    expect(res.status).toBe(201);

    const event = await readBack(res.body.eventId ?? res.body.id ?? res.body.event?.id);
    expect(event.tags.map(t => t.tag).sort()).toEqual(['communitygarden', 'k-9', 'satprep']);
  });

  it('keeps the organizer\'s capitalisation for display', async () => {
    const res = await create({ tags: ['AnimalShelter'] });
    const event = await readBack(res.body.eventId ?? res.body.id);
    expect(event.tags[0]).toEqual({ tag: 'animalshelter', label: 'AnimalShelter' });
  });

  it('collapses three spellings of one tag into one', async () => {
    const res = await create({ tags: ['NHS', '#nhs', '# NHS'] });
    const event = await readBack(res.body.eventId ?? res.body.id);
    expect(event.tags).toHaveLength(1);
    expect(event.tags[0].tag).toBe('nhs');
  });

  it('accepts an event with no tags at all, because tags are optional', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    const event = await readBack(res.body.eventId ?? res.body.id);
    /* Always an array, never absent — the client should not have to distinguish
       "no tags" from "field missing". */
    expect(event.tags).toEqual([]);
  });

  it('refuses an oversized tag list rather than truncating it', async () => {
    const res = await create({ tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('tags');
  });

  it('refuses a tag containing markup, and names it', async () => {
    const res = await create({ tags: ['<script>alert(1)</script>'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('<script>');
  });

  /**
   * 413 is as good an answer as 400 here, and is the one that actually happens.
   *
   * Express's JSON body limit refuses the request before any handler sees it, so
   * the oversized payload never reaches `validateTags` — which is the correct
   * order: the cheapest possible refusal for a request that is abusive by size.
   * The unit test in eventTags.test.js covers the validator's own length rule.
   */
  it('refuses a megabyte-long tag before it reaches a handler', async () => {
    const res = await create({ tags: ['a'.repeat(1_000_000)] });
    expect([400, 413]).toContain(res.status);
  });

  /**
   * The write is atomic with the event.
   *
   * A refused tag must leave NO event behind. `replaceEventTags` runs inside the
   * same transaction as the insert, but the validation happens before it — so this
   * asserts the ordering rather than the transaction.
   */
  it('creates no event when its tags are refused', async () => {
    const title = `Atomic ${Math.random().toString(36).slice(2, 8)}`;
    const res = await create({ title, tags: ['<bad>'] });
    expect(res.status).toBe(400);

    /* `limit` is what asks for the paginated envelope; without a pagination
       param this endpoint answers with a bare array (see the two-shapes note in
       eventRoutes.js). */
    const list = await srv.call('GET', `/api/events?limit=50&q=${encodeURIComponent(title)}`, undefined, organizer);
    expect(list.body.events).toHaveLength(0);
  });

  /* ── Editing ─────────────────────────────────────────────────────────── */

  it('replaces tags on edit', async () => {
    const created = await create({ tags: ['Before'] });
    const id = created.body.eventId ?? created.body.id;
    const existing = await readBack(id);

    const res = await srv.call('PUT', `/api/events/${id}`, {
      ...payload({ title: existing.title }),
      slots: existing.slots.map(s => ({
        id: s.id, name: s.name, description: s.description,
        startDatetime: s.startDatetime, endDatetime: s.endDatetime, maxSpots: s.maxSpots,
      })),
      tags: ['After', 'Second'],
    }, organizer);
    expect(res.status).toBe(200);

    const after = await readBack(id);
    expect(after.tags.map(t => t.tag).sort()).toEqual(['after', 'second']);
  });

  it('clears tags when the edit sends an empty list', async () => {
    const created = await create({ tags: ['Doomed'] });
    const id = created.body.eventId ?? created.body.id;
    const existing = await readBack(id);

    await srv.call('PUT', `/api/events/${id}`, {
      ...payload({ title: existing.title }),
      slots: existing.slots.map(s => ({
        id: s.id, name: s.name, description: s.description,
        startDatetime: s.startDatetime, endDatetime: s.endDatetime, maxSpots: s.maxSpots,
      })),
      tags: [],
    }, organizer);

    expect((await readBack(id)).tags).toEqual([]);
  });

  /**
   * Omitting `tags` LEAVES THEM ALONE — it does not mean "remove them".
   *
   * This endpoint is also called by clients written before tags existed. Treating
   * an absent field as empty would silently strip every tag off an event the
   * moment such a client saved anything else about it.
   */
  it('leaves tags untouched when the edit does not mention them', async () => {
    const created = await create({ tags: ['Survivor'] });
    const id = created.body.eventId ?? created.body.id;
    const existing = await readBack(id);

    await srv.call('PUT', `/api/events/${id}`, {
      ...payload({ title: 'Renamed but same tags' }),
      slots: existing.slots.map(s => ({
        id: s.id, name: s.name, description: s.description,
        startDatetime: s.startDatetime, endDatetime: s.endDatetime, maxSpots: s.maxSpots,
      })),
      // no `tags` key at all
    }, organizer);

    expect((await readBack(id)).tags.map(t => t.tag)).toEqual(['survivor']);
  });

  /* ── Authorization ───────────────────────────────────────────────────── */

  /**
   * Tags are part of the event, so they inherit the event's ownership rule.
   *
   * Asserted rather than assumed: the whole point of putting tags on the existing
   * edit endpoint instead of a new `/tags` route is that there is one ownership
   * check to get right, and this is the test that says so.
   */
  it('refuses another organizer\'s attempt to retag an event', async () => {
    const created = await create({ tags: ['Mine'] });
    const id = created.body.eventId ?? created.body.id;
    const existing = await readBack(id);
    const intruder = await srv.login(OTHER_ORGANIZER);

    const res = await srv.call('PUT', `/api/events/${id}`, {
      ...payload({ title: existing.title }),
      slots: existing.slots.map(s => ({
        id: s.id, name: s.name, description: s.description,
        startDatetime: s.startDatetime, endDatetime: s.endDatetime, maxSpots: s.maxSpots,
      })),
      tags: ['Theirs'],
    }, intruder);

    expect(res.status).toBe(403);
    expect((await readBack(id)).tags.map(t => t.tag)).toEqual(['mine']);
  });

  it('refuses a student creating a tagged event at all', async () => {
    const student = await srv.login(STUDENT);
    const res = await create({ tags: ['Nope'] }, student);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated write', async () => {
    const res = await srv.call('POST', '/api/events', payload({ tags: ['Nope'] }));
    expect(res.status).toBe(401);
  });

  /* ── Filtering ───────────────────────────────────────────────────────── */

  describe('filtering, which happens in SQL', () => {
    let alphaId;
    let betaId;

    beforeAll(async () => {
      const a = await create({ title: 'Filter alpha', tags: ['FilterOne', 'Shared'] });
      const b = await create({ title: 'Filter beta', tags: ['FilterTwo', 'Shared'] });
      alphaId = a.body.eventId ?? a.body.id;
      betaId = b.body.eventId ?? b.body.id;
    });

    /* Always asks for the envelope, so `pagination` is available to the tests
       that need it and the shape is the same for all of them. */
    const idsFor = async (qs) => {
      const res = await srv.call('GET', `/api/events?limit=100&${qs}`, undefined, organizer);
      expect(res.status).toBe(200);
      return res.body.events.map(e => e.id);
    };

    it('returns only events carrying the selected tag', async () => {
      const ids = await idsFor('tags=FilterOne');
      expect(ids).toContain(alphaId);
      expect(ids).not.toContain(betaId);
    });

    it('matches regardless of how the tag is spelled in the URL', async () => {
      for (const spelling of ['FilterOne', 'filterone', '%23FilterOne', 'FILTERONE']) {
        expect(await idsFor(`tags=${spelling}`), spelling).toContain(alphaId);
      }
    });

    /**
     * OR *within* the tag facet — the decided semantics.
     *
     * Every other control in the browse toolbar is a different dimension, so they
     * AND together. Multiple values of ONE dimension is the faceted-search case,
     * where ticking a second tag widens within the facet. AND-within-facet was
     * rejected on behaviour: with free-text tags it returns nothing almost every
     * time, and a filter that usually answers "no results" reads as broken.
     */
    it('OR-s multiple selected tags', async () => {
      const ids = await idsFor('tags=FilterOne,FilterTwo');
      expect(ids).toContain(alphaId);
      expect(ids).toContain(betaId);
    });

    it('accepts a repeated query parameter as well as a comma list', async () => {
      const ids = await idsFor('tags=FilterOne&tags=FilterTwo');
      expect(ids).toContain(alphaId);
      expect(ids).toContain(betaId);
    });

    /** AND with every OTHER filter — the tag facet narrows, it does not widen. */
    it('combines with the free-text search rather than overriding it', async () => {
      const ids = await idsFor('tags=Shared&q=alpha');
      expect(ids).toContain(alphaId);
      expect(ids).not.toContain(betaId);
    });

    it('returns nothing for a tag nobody used, rather than everything', async () => {
      expect(await idsFor('tags=NoSuchTagAnywhere')).toEqual([]);
    });

    /**
     * A tag the normaliser cannot use is DROPPED from a filter, not a 400.
     *
     * A filter is a view: a stale or hand-edited URL should show what it can. The
     * write path errors instead, because there an organizer needs to know their
     * tag did not save.
     */
    it('ignores an unusable tag in the query instead of failing the request', async () => {
      const res = await srv.call('GET', '/api/events?limit=100&tags=<script>', undefined, organizer);
      expect(res.status).toBe(200);
    });

    it('reports the tags it actually filtered on', async () => {
      const res = await srv.call('GET', '/api/events?limit=100&tags=%23FilterOne', undefined, organizer);
      expect(res.body.filters.tags).toEqual(['filterone']);
    });

    /**
     * Pagination counts the FILTERED set.
     *
     * The tag clause is an `EXISTS` semi-join rather than a join precisely so the
     * `COUNT(*)` behind `pagination.total` stays one row per event. A join would
     * multiply the count by the number of matching tags and the page count would
     * silently inflate.
     */
    it('paginates the filtered set without double-counting', async () => {
      const res = await srv.call('GET', '/api/events?tags=Shared&limit=1', undefined, organizer);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.pagination.total).toBe(2);
    });

    /* ── The vocabulary ────────────────────────────────────────────────── */

    it('offers the tags in use so an organizer can reuse rather than reinvent', async () => {
      const res = await srv.call('GET', '/api/events?limit=100', undefined, organizer);
      const shared = res.body.tags.find(t => t.tag === 'shared');
      expect(shared).toBeTruthy();
      expect(shared.uses).toBeGreaterThanOrEqual(2);
      /* A real spelling, not the normalised key — it is shown to a person. */
      expect(shared.label).toBe('Shared');
    });

    /**
     * The vocabulary is NOT narrowed by the current selection.
     *
     * A facet whose options are filtered by what is already selected removes every
     * other option the moment one is ticked, and the reader can neither add a
     * second tag nor see what they excluded.
     */
    it('offers the whole vocabulary even while a tag filter is applied', async () => {
      const res = await srv.call('GET', '/api/events?limit=100&tags=FilterOne', undefined, organizer);
      expect(res.body.tags.map(t => t.tag)).toContain('filtertwo');
    });
  });
});
