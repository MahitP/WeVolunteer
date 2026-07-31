import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { Seats } from './Seats';

/**
 * Regression cover for the capacity text running together.
 *
 * Reported as "0 signed up15 of 15 left". Two causes, both here:
 *
 *   1. `Seats` renders two sibling <span>s inside `.meter-label`, separated only
 *      by `justify-content: space-between` — which distributes the space that
 *      exists and nothing more.
 *   2. The wrapper's `style={{ minWidth: 108, flex: 1 }}` had been replaced by a
 *      generated class name with no CSS rule behind it, so in a flex parent the
 *      wrapper collapsed to 0px wide. Measured live before the fix:
 *      containerWidth 0, gap between the spans 0. With no space to distribute,
 *      the two labels rendered touching.
 *
 * Only the >12 branch shows both labels, which is why small events looked fine
 * and a 15-spot shift did not.
 *
 * jsdom does not lay out or apply the stylesheet, so the CSS half is asserted
 * against index.css directly — the component half is asserted on the DOM.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src', 'index.css'), 'utf8');

describe('Seats capacity text', () => {
  /** Visible label parts only — the sr-only separator is excluded. */
  const visibleParts = (label) =>
    [...label.children].filter(c => !c.classList.contains('sr-only')).map(c => c.textContent);

  it('keeps the two labels as separate elements', () => {
    const { container } = render(<Seats filled={0} total={15} />);
    const label = container.querySelector('.meter-label');
    expect(label).toBeTruthy();
    expect(visibleParts(label)).toEqual(['0 signed up', '15 of 15 spots left']);
  });

  // The reported symptom, asserted on the text layer rather than on layout:
  // jsdom applies no CSS, so a passing gap-based fix alone would still read
  // "0 signed up15 of 15 spots left" to a screen reader.
  it('never reads as one run-together string', () => {
    const { container } = render(<Seats filled={0} total={15} />);
    const label = container.querySelector('.meter-label');
    expect(label.textContent).not.toContain('signed up15');
    expect(label.textContent).toContain('0 signed up · 15 of 15 spots left');
  });

  it('names the unit, so the number is not bare', () => {
    const { container } = render(<Seats filled={3} total={20} />);
    expect(visibleParts(container.querySelector('.meter-label'))[1])
      .toBe('17 of 20 spots left');
  });

  it('says Full rather than "0 of N spots left" when there is no room', () => {
    const { container } = render(<Seats filled={15} total={15} />);
    expect(visibleParts(container.querySelector('.meter-label')))
      .toEqual(['15 signed up', 'Full']);
  });

  it('uses the discrete-seat row at 12 spots or fewer', () => {
    const { container } = render(<Seats filled={2} total={5} />);
    expect(container.querySelector('.meter-label')).toBeNull();
    expect(container.querySelectorAll('.seat')).toHaveLength(5);
    expect(container.querySelector('.seats-label').textContent).toBe('3 of 5 spots left');
  });

  it('gives the meter wrapper a class that actually exists in the stylesheet', () => {
    const { container } = render(<Seats filled={0} total={15} />);
    const wrapper = container.querySelector('.seats-meter');
    expect(wrapper, 'wrapper must carry .seats-meter').toBeTruthy();
    // The regression was a class name with no rule behind it.
    expect(CSS).toMatch(/\.seats-meter\s*\{/);
  });

  it('gives the seat row a class that exists in the stylesheet', () => {
    const { container } = render(<Seats filled={1} total={4} />);
    expect(container.querySelector('.seats-row')).toBeTruthy();
    expect(CSS).toMatch(/\.seats-row\s*\{/);
  });

  it('restores the width that stopped the labels colliding', () => {
    const rule = CSS.match(/\.seats-meter\s*\{([^}]*)\}/)?.[1] || '';
    expect(rule).toMatch(/min-width:\s*108px/);
    expect(rule).toMatch(/flex:\s*1/);
  });

  it('gives .meter-label a gap so the labels cannot touch at any width', () => {
    const rule = CSS.match(/\.meter-label\s*\{([^}]*)\}/)?.[1] || '';
    expect(rule).toMatch(/gap:/);
  });

  it('references no generated class that has no stylesheet rule', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'Seats.jsx'), 'utf8');
    const generated = [...new Set([...src.matchAll(/s-[0-9a-f]{6}/g)].map(m => m[0]))];
    const dangling = generated.filter(c => !new RegExp(`\\.${c}\\b`).test(CSS));
    expect(dangling).toEqual([]);
  });

  it('still labels capacity for screen readers', () => {
    const { container } = render(<Seats filled={2} total={5} />);
    expect(container.querySelector('.seats').getAttribute('aria-label'))
      .toBe('2 of 5 spots taken');
  });

  it('handles a zero-capacity shift without producing nonsense', () => {
    const { container } = render(<Seats filled={0} total={0} />);
    expect(container.textContent).toContain('No spots');
  });
});
