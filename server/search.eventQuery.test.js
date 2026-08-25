import { describe, it, expect } from 'vitest';

import {
  parseEventFilters, buildEventWhere, buildEventOrder, semanticIdParams, EVENT_SORTS,
} from './eventQuery.js';

/**
 * Where the semantic half meets the authoritative query.
 *
 * The whole read-path integration is two things: an extra OR on the text
 * predicate, and a sort that can order by a candidate list. Both are here, and
 * both are asserted at the level where the SQL is actually built — because the
 * integration tests exercise the common paths and cannot reach the defensive
 * ones. `restrictToSemanticIds` with an empty list is the clearest example: it
 * cannot happen through the endpoint today, and if it ever starts happening it
 * must fail closed rather than return the entire events table.
 */

describe('accepting a candidate list', () => {
  it('binds each id as a parameter rather than interpolating it', () => {
    const params = {};
    const fragment = semanticIdParams(['a-1', 'b-2'], params);
    expect(fragment).toBe('e.id IN (@sem0, @sem1)');
    expect(params).toEqual({ sem0: 'a-1', sem1: 'b-2' });
  });

  /** A predicate built by concatenation carries its own ceiling. */
  it('caps the list rather than trusting its caller', () => {
    const params = {};
    const fragment = semanticIdParams(Array.from({ length: 500 }, (_, i) => `id-${i}`), params);
    expect(Object.keys(params).length).toBeLessThanOrEqual(100);
    expect(fragment.split(',').length).toBeLessThanOrEqual(100);
  });

  it('produces nothing for an empty or malformed list', () => {
    expect(semanticIdParams([], {})).toBe('');
    expect(semanticIdParams(null, {})).toBe('');
    expect(semanticIdParams([null, '', 0], {})).toBe('');
  });
});

describe('how candidates enter the WHERE clause', () => {
  /**
   * Discover WIDENS: an event matching the typed words is shown whether or not
   * the vector index proposed it. The substring match is not the weaker half —
   * somebody typing "Chess" wants the event called Chess Club.
   */
  it('adds candidates as an OR beside the text match', () => {
    const { where, params } = buildEventWhere(
      { q: 'chess', semanticIds: ['x-1'], scope: 'listable' }, 'me',
    );
    expect(where).toContain('OR e.id IN (@sem0)');
    expect(params.q).toBe('chess');
    expect(params.sem0).toBe('x-1');
  });

  it('leaves the text match alone when there are no candidates', () => {
    const { where } = buildEventWhere({ q: 'chess', semanticIds: null, scope: 'listable' }, 'me');
    expect(where).not.toContain('e.id IN');
    expect(where).toContain('lower(@q)');
  });

  /**
   * Recommendations NARROW: the suggestion is the list. Written as its own
   * clause so it AND-s with the rest — a suggested event still has to survive
   * the status scope, the date bounds and every other filter.
   */
  it('adds candidates as an AND when the caller asked to be restricted', () => {
    const { where } = buildEventWhere(
      { semanticIds: ['x-1', 'x-2'], restrictToSemanticIds: true, scope: 'listable' }, 'me',
    );
    expect(where).toContain('e.id IN (@sem0, @sem1)');
    expect(where).toContain("e.status IN ('open', 'closed')");
    expect(where).toContain(' AND ');
  });

  /**
   * THE fail-closed case. If a restricted query ever arrives with no candidates,
   * it must match nothing — "we have no suggestions for you" must not become
   * "here is every event, presented as personal".
   */
  it('matches nothing when a restricted query has no candidates', () => {
    const { where } = buildEventWhere(
      { semanticIds: [], restrictToSemanticIds: true, scope: 'listable' }, 'me',
    );
    expect(where).toContain('1 = 0');
    expect(where).not.toContain('1 = 1');
  });

  /** Candidates never loosen a filter the caller set. */
  it('keeps every other filter beside the candidates', () => {
    const { where } = buildEventWhere({
      q: 'anything', semanticIds: ['x-1'], scope: 'open', category: 'Animals',
      openOnly: true, favoritesOnly: true,
    }, 'me');
    expect(where).toContain("e.status = 'open'");
    expect(where).toContain('e.category = @category');
    expect(where).toContain('user_favorites');
  });
});

describe('sorting by relevance', () => {
  it('is offered as a sort', () => {
    expect(EVENT_SORTS).toContain('relevance');
    expect(parseEventFilters({ sort: 'relevance' }).ok).toBe(true);
  });

  /** A truthiness check would have rejected it; a prototype key must not pass. */
  it('still refuses a sort that is not one', () => {
    expect(parseEventFilters({ sort: 'nope' }).ok).toBe(false);
    expect(parseEventFilters({ sort: 'toString' }).ok).toBe(false);
    expect(parseEventFilters({ sort: 'constructor' }).ok).toBe(false);
  });

  it('orders by position in the candidate list', () => {
    const order = buildEventOrder('relevance', ['first', 'second']);
    expect(order).toContain('CASE e.id WHEN @sem0 THEN 0 WHEN @sem1 THEN 1');
    /* Events the semantic half never proposed sort after every candidate rather
       than being dropped. */
    expect(order).toContain('ELSE 100');
  });

  /**
   * With no candidates — no query, or Pinecone unavailable — relevance degrades
   * to the default a student sees anyway. A relevance sort never becomes an
   * error, and never becomes an empty page.
   */
  it('degrades to soonest when there is nothing to rank', () => {
    expect(buildEventOrder('relevance', [])).toBe(buildEventOrder('soonest'));
    expect(buildEventOrder('relevance', null)).toBe(buildEventOrder('soonest'));
  });

  it('always ends with a stable tiebreak, so paging is sound', () => {
    for (const sort of EVENT_SORTS) {
      expect(buildEventOrder(sort, ['a']), sort).toContain('e.id ASC');
    }
  });
});

describe('what a client may ask for', () => {
  /**
   * A client cannot supply candidate ids. Being able to would be a way to probe
   * for specific events by guessing at their ids and watching what comes back.
   */
  it('never parses candidate ids from the query string', () => {
    const parsed = parseEventFilters({ semanticIds: ['evt-secret'], 'semanticIds[]': 'evt-secret' });
    expect(parsed.ok).toBe(true);
    expect(parsed.value.semanticIds).toBeNull();
    expect(parsed.value.restrictToSemanticIds).toBe(false);
  });

  it('accepts the recommended mode, which names no rows', () => {
    expect(parseEventFilters({ recommended: 'true' }).value.recommended).toBe(true);
    expect(parseEventFilters({ recommended: '1' }).value.recommended).toBe(true);
    expect(parseEventFilters({}).value.recommended).toBe(false);
    expect(parseEventFilters({ recommended: 'no' }).value.recommended).toBe(false);
  });
});
