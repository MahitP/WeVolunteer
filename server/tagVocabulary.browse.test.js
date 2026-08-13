import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { BROWSE_TAG_LIMIT } from './eventTags.js';

/**
 * The filter bar offers the fifteen tags organizers actually use.
 *
 * ── Why a cap, and why by usage ──
 *
 * The bar is a row of chips above a list of events. It was served the default
 * vocabulary of fifty, which wrapped into a wall a reader had to scroll past to
 * reach what they came for.
 *
 * "Popular" is `COUNT(*)` over `event_tags` — the number of events carrying the
 * tag — which is the only usage signal this schema holds. Ties break on the key,
 * so the same fifteen come back for the same data rather than a different
 * fifteen per request; a filter bar that reshuffles between keystrokes is worse
 * than a long one.
 */

describe('the browse filter vocabulary', () => {
  let srv;
  let db;
  let session;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    session = await srv.login('leo.chen@example.com');

    /* Twenty-two tags with deliberately different usage counts, so "most used"
       is a real ordering rather than an accident of insertion order. */
    /**
     * The suite seeds only two events, which is not enough for usage counts to
     * differ — every tag would tie at 1 or 2 and "most used" would test nothing.
     * So the fixture clones events of its own rather than asserting the seed
     * happens to be large enough.
     */
    const template = db.prepare('SELECT * FROM events LIMIT 1').get();
    expect(template, 'no event to clone').toBeTruthy();
    const events = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `vocab-ev-${i}`;
      const row = { ...template, id, title: `Vocabulary fixture ${i}`, status: 'open' };
      const cols = Object.keys(row);
      db.prepare(`INSERT OR REPLACE INTO events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map(c => row[c]));
      events.push(id);
    }

    const names = Array.from({ length: 22 }, (_, i) => `vocab${String(i).padStart(2, '0')}`);
    db.prepare(`DELETE FROM event_tags WHERE tag LIKE 'vocab%'`).run();
    names.forEach((name, i) => {
      const uses = Math.max(1, events.length - Math.floor((i * events.length) / names.length));
      events.slice(0, uses).forEach(ev =>
        db.prepare('INSERT OR REPLACE INTO event_tags (event_id, tag, label) VALUES (?,?,?)')
          .run(ev, name, name));
    });
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const browseTags = async () => {
    const res = await srv.call('GET', '/api/events?scope=listable&limit=60&offset=0', undefined, session);
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    return res.body.tags;
  };

  it('has more tags in the database than the bar will show', () => {
    /* The vacuity guard. With fewer than fifteen distinct tags every assertion
       below passes without the cap doing anything. */
    const distinct = db.prepare('SELECT COUNT(DISTINCT tag) n FROM event_tags').get().n;
    expect(distinct).toBeGreaterThan(BROWSE_TAG_LIMIT);
  });

  it('sends at most fifteen', async () => {
    expect((await browseTags()).length).toBeLessThanOrEqual(BROWSE_TAG_LIMIT);
  });

  it('sends the MOST USED ones, not an arbitrary fifteen', async () => {
    /**
     * The requirement that separates this from `LIMIT 15` on an unordered
     * query. Every tag the bar offers must be at least as used as every tag it
     * omits.
     */
    const shown = (await browseTags()).map(t => t.tag);
    const counts = Object.fromEntries(
      db.prepare('SELECT tag, COUNT(*) n FROM event_tags GROUP BY tag').all().map(r => [r.tag, r.n]),
    );
    const omitted = Object.keys(counts).filter(t => !shown.includes(t));

    const lowestShown = Math.min(...shown.map(t => counts[t]));
    const highestOmitted = Math.max(...omitted.map(t => counts[t]));
    expect(lowestShown, 'a less-used tag was shown over a more-used one')
      .toBeGreaterThanOrEqual(highestOmitted);
  });

  it('returns the same fifteen every time, so the bar does not reshuffle', async () => {
    const a = (await browseTags()).map(t => t.tag);
    const b = (await browseTags()).map(t => t.tag);
    expect(a).toEqual(b);
  });

  it('breaks ties deterministically rather than by chance', async () => {
    /* Many tags here share a usage count. Without the `tag ASC` tie-break,
       SQLite may return equal rows in any order and the bar would shuffle. */
    const shown = await browseTags();
    const counts = Object.fromEntries(
      db.prepare('SELECT tag, COUNT(*) n FROM event_tags GROUP BY tag').all().map(r => [r.tag, r.n]),
    );
    for (let i = 1; i < shown.length; i += 1) {
      const prev = shown[i - 1]; const cur = shown[i];
      /* Indexed by .tag, not by the row object. Keying a lookup with an object
         yields undefined on both sides, the equality holds, and every iteration
         hits the `continue` — the loop would run and assert nothing. */
      if (counts[prev.tag] !== counts[cur.tag]) continue;
      expect(prev.tag.localeCompare(cur.tag), `tie between ${prev.tag} and ${cur.tag} is unordered`)
        .toBeLessThan(0);
    }
  });

  it('never repeats a tag', async () => {
    const shown = (await browseTags()).map(t => t.tag);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('still serves the wider vocabulary from its own endpoint', async () => {
    /**
     * The cap is a DISPLAY decision for one bar, not a shrinking of the
     * vocabulary. Anything built later that needs more — a tag search, an
     * organizer's suggestion list — still has it.
     */
    const res = await srv.call('GET', '/api/events/tags?limit=50', undefined, session);
    expect(res.status).toBe(200);
    expect(res.body.tags.length).toBeGreaterThan(BROWSE_TAG_LIMIT);
  });
});
