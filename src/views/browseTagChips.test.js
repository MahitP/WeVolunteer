import { describe, it, expect } from 'vitest';
import { tagChipsToShow } from './BrowseEvents.jsx';

/**
 * A tag you have ticked never disappears from the filter bar.
 *
 * ── The trap ──
 *
 * The server sends the fifteen most-USED tags, recomputed on every request. So
 * the set can change under a reader who has already selected one: usage shifts,
 * an organizer retags an event, a filter change returns a different slice.
 *
 * When that happens the list is still filtered by the tag while its chip has
 * gone. The reader sees a shortened list of events, nothing explaining why, and
 * no control to switch it back off — the filter is stuck until they reload.
 *
 * ── Why this is unit-tested rather than clicked ──
 *
 * Reaching it through the UI means engineering a vocabulary change between two
 * fetches. The rule is a pure function of three inputs, and testing it directly
 * is both honest and reachable; the rest of the bar was verified in a browser.
 */

const opt = (tag, label = tag) => ({ tag, label });
const top15 = Array.from({ length: 15 }, (_, i) => opt(`t${i}`));

describe('tagChipsToShow', () => {
  it('shows exactly the server list when nothing is selected', () => {
    expect(tagChipsToShow(top15, [], [])).toEqual(top15);
  });

  it('does not duplicate a selected tag that is already in the list', () => {
    const shown = tagChipsToShow(top15, ['t3'], []);
    expect(shown).toHaveLength(15);
    expect(shown.filter(t => t.tag === 't3')).toHaveLength(1);
  });

  it('adds a selected tag the server did not send', () => {
    /* The whole point: `rare` is filtering the list, so it must be visible and
       therefore un-tickable. */
    const shown = tagChipsToShow(top15, ['rare'], []);
    expect(shown).toHaveLength(16);
    expect(shown.some(t => t.tag === 'rare')).toBe(true);
  });

  it("labels that tag with the organizer's real spelling when the events know it", () => {
    /**
     * `tag` is the normalised key (`animalshelter`); `label` is what somebody
     * typed (`AnimalShelter`). Showing the key would put a flattened spelling
     * on screen that nobody chose.
     */
    const events = [{ tags: [opt('animalshelter', 'AnimalShelter')] }];
    const shown = tagChipsToShow(top15, ['animalshelter'], events);
    expect(shown.find(t => t.tag === 'animalshelter').label).toBe('AnimalShelter');
  });

  it('falls back to the key when no event on screen carries that tag', () => {
    /* Ugly but true, and better than a chip with no words on it — which is what
       `label: undefined` renders as. */
    const shown = tagChipsToShow(top15, ['ghost'], [{ tags: [] }]);
    expect(shown.find(t => t.tag === 'ghost').label).toBe('ghost');
  });

  it('keeps the server order, appending the extras', () => {
    /* The bar must not reshuffle just because something was ticked. */
    const shown = tagChipsToShow(top15, ['rare'], []);
    expect(shown.slice(0, 15).map(t => t.tag)).toEqual(top15.map(t => t.tag));
    expect(shown[15].tag).toBe('rare');
  });

  it('handles several selected tags outside the list at once', () => {
    const shown = tagChipsToShow(top15, ['a', 'b', 'c'], []);
    expect(shown).toHaveLength(18);
    expect(new Set(shown.map(t => t.tag)).size).toBe(18);
  });

  it('survives missing and malformed inputs rather than throwing', () => {
    /**
     * This runs during render on the browse screen. A first paint with no
     * response yet, or an event whose `tags` field is absent, must not take the
     * page down.
     */
    expect(() => tagChipsToShow(undefined, undefined, undefined)).not.toThrow();
    expect(tagChipsToShow(undefined, undefined, undefined)).toEqual([]);
    expect(tagChipsToShow([], ['x'], [{ /* no tags key */ }, null])).toEqual([opt('x')]);
  });
});
