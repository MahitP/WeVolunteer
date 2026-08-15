import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TagChips from './TagChips';

/**
 * A preview shows a few tags; the event shows all of them.
 *
 * ── The two limits, and why they differ ──
 *
 * A card in a scannable list caps at four. Twelve chips wrap to three lines and
 * push the title, the date and the seat count out of a card somebody is
 * skimming twenty of — which is the whole reason a preview limit exists.
 *
 * The details modal caps at nothing. That is where the rest live, and until this
 * change they lived nowhere: the only `limit={Infinity}` in the codebase was in
 * `EventDetailsExperience.jsx`, which has no importers, so a card's `+9`
 * counted toward a page that never rendered.
 *
 * ── Why the card's overflow is not a button ──
 *
 * Expanding in place is the behaviour the cap exists to prevent. The card is
 * itself a link to the event, so the overflow is marked up as a count rather
 * than dressed as a control somebody could press in vain.
 */

const tags = (n) => Array.from({ length: n }, (_, i) => ({ tag: `t${i}`, label: `Tag${i}` }));

/** How `EventCard` renders them. */
const preview = (list) => render(<TagChips tags={list} limit={4} expandable={false} />);

/** How `EventModal` renders them. */
const details = (list) => render(<TagChips tags={list} limit={Infinity} />);

const chipTexts = (container) =>
  [...container.querySelectorAll('.tag-chip')].map(c => c.textContent.trim());

describe('the event card preview', () => {
  it('renders nothing at all for an event with no tags', () => {
    const { container } = preview([]);
    expect(container.querySelector('.tag-chips')).toBeNull();
  });

  it('shows the single tag of a one-tag event, with no counter', () => {
    const { container } = preview(tags(1));
    expect(chipTexts(container)).toEqual(['#Tag0']);
    expect(container.querySelector('.tag-chip-more')).toBeNull();
  });

  it('shows all four of a four-tag event, with no counter', () => {
    /* The boundary. Four is the cap, so a four-tag event is complete and a
       "+0" would be nonsense. */
    const { container } = preview(tags(4));
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(4);
    expect(container.querySelector('.tag-chip-more')).toBeNull();
  });

  it('shows four and counts one for a five-tag event', () => {
    const { container } = preview(tags(5));
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(4);
    expect(container.querySelector('.tag-chip-more').textContent.trim()).toBe('+1');
  });

  it('still shows only four for a twelve-tag event', () => {
    /* The case that motivated the cap: an event carrying every tag it is
       allowed must not turn a card into three lines of chips. */
    const { container } = preview(tags(12));
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(4);
    expect(container.querySelector('.tag-chip-more').textContent.trim()).toBe('+8');
  });

  it('renders the overflow as a count, not as a control', () => {
    /**
     * On a card the chips are not the surface — the card is. A button here
     * would expand the very layout the cap protects, so the count is a `span`
     * and says where the rest are.
     */
    const { container } = preview(tags(12));
    const more = container.querySelector('.tag-chip-more');
    expect(more.tagName).toBe('SPAN');
    expect(container.querySelector('button.tag-chip-more')).toBeNull();
    expect(more.getAttribute('aria-label')).toMatch(/open this event/i);
  });

  it('is deterministic: the same tags give the same four, in the same order', () => {
    const list = tags(12);
    const a = chipTexts(preview(list).container);
    const b = chipTexts(preview(list).container);
    expect(a).toEqual(b);
    expect(a.slice(0, 4)).toEqual(['#Tag0', '#Tag1', '#Tag2', '#Tag3']);
  });

  it('never shows the same tag twice', () => {
    const { container } = preview(tags(12));
    const shown = chipTexts(container).filter(t => t.startsWith('#'));
    expect(new Set(shown).size).toBe(shown.length);
  });
});

describe('the event details list', () => {
  it('shows every tag of a twelve-tag event', () => {
    const { container } = details(tags(12));
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(12);
    expect(container.querySelector('.tag-chip-more')).toBeNull();
  });

  it('shows every tag of a five-tag event', () => {
    const { container } = details(tags(5));
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(5);
  });

  it('still renders nothing when there are no tags', () => {
    const { container } = details([]);
    expect(container.querySelector('.tag-chips')).toBeNull();
  });
});

describe('a malformed limit does not silently show the wrong tags', () => {
  it.each([[-1], [NaN], ['four'], [null]])('falls back to showing all for a limit of %s', (limit) => {
    /**
     * `slice(0, -1)` drops the LAST tag and `slice(0, NaN)` shows none — each
     * looks like a working component with a plausible-but-wrong result, which
     * is the worst kind of bug to inherit from a prop. Falling back to the full
     * list fails visibly instead.
     */
    const { container } = render(<TagChips tags={tags(6)} limit={limit} />);
    const shown = chipTexts(container).filter(t => t.startsWith('#'));
    expect(shown, `limit ${limit} produced ${shown.length} chips`).toHaveLength(6);
    expect(shown[0]).toBe('#Tag0');
  });

  it('honours an explicit limit of 0, which is a coherent request', () => {
    /* Not lumped in with the malformed values above: a caller asking for none
       has said something meaningful, and overriding it would be the component
       second-guessing its caller. */
    const { container } = render(<TagChips tags={tags(6)} limit={0} />);
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(0);
  });
});

describe('the default limit', () => {
  it('is four, so a caller that passes nothing gets the preview rule', () => {
    const { container } = render(<TagChips tags={tags(9)} />);
    expect(chipTexts(container).filter(t => t.startsWith('#'))).toHaveLength(4);
  });

  it('still expands in place by default, for callers that want it', () => {
    /* Unchanged behaviour for everything that is not a card. */
    const { container } = render(<TagChips tags={tags(9)} />);
    expect(container.querySelector('button.tag-chip-more')).toBeTruthy();
    expect(screen.getByLabelText(/Show 5 more tags/i)).toBeTruthy();
  });
});
