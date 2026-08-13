import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import EmptyState from './EmptyState';

/**
 * An empty state does not skip a heading level.
 *
 * ── The bug ──
 *
 * `EmptyState` hard-coded `h3`, which is right when it sits inside a section
 * that already has an `h2`. But when a list is empty there is often no section
 * heading at all, so the empty state is the FIRST thing under the page's `h1` —
 * and `h1 → h3` skips a level.
 *
 * That is invisible to a sighted reader and load-bearing for somebody skimming
 * by heading, which is how a screen reader user navigates a page: they are told
 * a level exists that does not, and the outline reads as though a section went
 * missing. Found on `/organizations` and again on `/messages`.
 *
 * ── Why the default did not change ──
 *
 * Twenty-eight files render this component, most of them inside a titled
 * section where `h3` is correct. Moving the default would have shifted all of
 * them to fix two pages. The level is a prop instead, and the two callers that
 * need `h2` pass it.
 */
describe('EmptyState heading level', () => {
  it('is an h3 by default, because that is right inside a titled section', () => {
    const { container } = render(<EmptyState title="Nothing yet" />);
    expect(container.querySelector('h3')).toBeTruthy();
    expect(container.querySelector('h2')).toBeNull();
  });

  it('renders the level asked for, so a page under an h1 does not skip one', () => {
    const { container } = render(<EmptyState title="Nothing yet" headingLevel={2} />);
    expect(container.querySelector('h2')?.textContent).toBe('Nothing yet');
    expect(container.querySelector('h3')).toBeNull();
  });

  it('renders every level it claims to support', () => {
    for (const lvl of [1, 2, 3, 4, 5, 6]) {
      const { container } = render(<EmptyState title="Nothing yet" headingLevel={lvl} />);
      expect(container.querySelector(`h${lvl}`)?.textContent).toBe('Nothing yet');
    }
  });

  it('falls back to the default for anything it cannot render', () => {
    /**
     * `<h7>` is not an element. React renders it as an unknown tag, which is
     * not a heading at all — so the title would vanish from the document
     * outline entirely while still looking fine on screen.
     *
     * One rule, not a clamp: `0` and `-3` and `7` are all equally nonsense, and
     * an earlier clamp answered 3, 1 and 6 respectively, which no caller could
     * have predicted.
     */
    for (const [given, expected] of [[7, 'H3'], [0, 'H3'], [-3, 'H3'], [2.5, 'H3'], ['nonsense', 'H3'], [null, 'H3'], [undefined, 'H3']]) {
      const { container } = render(<EmptyState title="Nothing yet" headingLevel={given} />);
      const h = container.querySelector('h1,h2,h3,h4,h5,h6');
      expect(h, `level ${given} rendered no heading at all`).toBeTruthy();
      expect(h.tagName, `level ${given}`).toBe(expected);
    }
  });

  it('still renders nothing when there is no title to render', () => {
    const { container } = render(<EmptyState message="Just a message" />);
    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
  });
});
