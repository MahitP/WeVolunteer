import React, { useRef } from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useWindowedRows } from './useWindowedRows';

/**
 * Windowing maths for the opportunity grid.
 *
 * Verified here rather than in a browser because the available browser harness
 * reports `window.innerHeight === 0`, which makes viewport-dependent behaviour
 * unobservable there. jsdom lets the viewport, the grid's rect and the card
 * height all be controlled exactly, which is what these assertions need.
 *
 * The properties that matter:
 *   • below the threshold, nothing is windowed (the common case must not change)
 *   • the mounted window follows the scroll position
 *   • spacer heights always add up to the rows that are NOT mounted, so the
 *     scrollbar stays honest
 *   • a zero/unknown viewport renders MORE, never a blank list
 */

const CARD_HEIGHT = 200;
const ROW_GAP = 16;
const ROW_HEIGHT = CARD_HEIGHT + ROW_GAP;

/** Test harness: a grid whose geometry is fully controlled. */
function Grid({ count, columns = 3, gridTop = 0 }) {
  const gridRef = useRef(null);
  const { start, end, padTop, padBottom, active } = useWindowedRows({ count, gridRef });

  // Stand in for the real cards; each carries the marker the hook measures.
  const items = [];
  for (let i = start; i < end; i++) {
    items.push(<div key={i} data-windowed-item data-index={i}>item-{i}</div>);
  }

  return (
    <div>
      <div data-testid="meta">{JSON.stringify({ start, end, padTop, padBottom, active })}</div>
      <div ref={gridRef} data-testid="grid">{items}</div>
    </div>
  );
}

let rectTop = 0;

function mockGeometry({ columns = 3, viewport = 800 }) {
  window.innerWidth = 1280;
  window.innerHeight = viewport;
  Object.defineProperty(document.documentElement, 'clientHeight', { value: viewport, configurable: true });

  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    if (el?.dataset?.testid === 'grid') {
      return {
        gridTemplateColumns: Array(columns).fill('320px').join(' '),
        rowGap: `${ROW_GAP}px`
      };
    }
    return { gridTemplateColumns: '', rowGap: '0px' };
  });

  // Every element reports a rect; the grid's top tracks the simulated scroll.
  Element.prototype.getBoundingClientRect = function () {
    if (this.dataset?.testid === 'grid') {
      return { top: rectTop, bottom: rectTop + 10000, height: 10000, left: 0, right: 1280, width: 1280 };
    }
    if (this.hasAttribute?.('data-windowed-item')) {
      return { top: 0, bottom: CARD_HEIGHT, height: CARD_HEIGHT, left: 0, right: 320, width: 320 };
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  };
}

const meta = () => JSON.parse(screen.getByTestId('meta').textContent);
const scrollTo = async (px) => {
  rectTop = -px;
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
    // The hook coalesces to one recompute per animation frame.
    await new Promise(r => setTimeout(r, 30));
  });
};

beforeEach(() => { rectTop = 0; });
afterEach(() => { vi.restoreAllMocks(); });

describe('useWindowedRows — the common case is untouched', () => {
  it('does not window a small list', () => {
    mockGeometry({});
    render(<Grid count={12} />);
    const m = meta();
    expect(m.active).toBe(false);
    expect(m.start).toBe(0);
    expect(m.end).toBe(12);
    expect(m.padTop).toBe(0);
    expect(m.padBottom).toBe(0);
    // Every item mounted, exactly as before the change.
    expect(document.querySelectorAll('[data-windowed-item]').length).toBe(12);
  });

  it('activates only above the threshold', () => {
    mockGeometry({});
    const { rerender } = render(<Grid count={60} />);
    expect(meta().active).toBe(false);
    rerender(<Grid count={61} />);
    expect(meta().active).toBe(true);
  });
});

describe('useWindowedRows — windowing a large list', () => {
  it('mounts far fewer items than the list holds', () => {
    mockGeometry({ columns: 3, viewport: 800 });
    render(<Grid count={1500} />);
    const mounted = document.querySelectorAll('[data-windowed-item]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);   // vs 1500 rendered before
  });

  it('advances the mounted window as the user scrolls', async () => {
    mockGeometry({ columns: 3, viewport: 800 });
    render(<Grid count={1500} />);
    const atTop = meta();

    await scrollTo(ROW_HEIGHT * 50);       // 50 rows down
    const scrolled = meta();

    expect(scrolled.start).toBeGreaterThan(atTop.start);
    // The window tracks the viewport rather than growing without bound.
    expect(scrolled.end - scrolled.start).toBeLessThan(100);
    // And the first mounted item is near the scroll position, not at the top.
    expect(scrolled.start).toBeGreaterThanOrEqual((50 - 4) * 3);
  });

  it('keeps total height honest — spacers cover every unmounted row', async () => {
    mockGeometry({ columns: 3, viewport: 800 });
    const count = 1500;
    render(<Grid count={count} />);

    for (const rows of [0, 20, 200, 400]) {
      await scrollTo(ROW_HEIGHT * rows);
      const m = meta();
      const totalRows = Math.ceil(count / 3);
      const mountedRows = Math.ceil(m.end / 3) - Math.floor(m.start / 3);
      const accountedHeight = m.padTop + m.padBottom + mountedRows * ROW_HEIGHT;
      // Within one row of the true height: the scrollbar cannot drift.
      expect(Math.abs(accountedHeight - totalRows * ROW_HEIGHT)).toBeLessThanOrEqual(ROW_HEIGHT);
    }
  });

  it('reaches the true end of the list at maximum scroll', async () => {
    mockGeometry({ columns: 3, viewport: 800 });
    const count = 1500;
    render(<Grid count={count} />);
    await scrollTo(ROW_HEIGHT * Math.ceil(count / 3));
    const m = meta();
    expect(m.end).toBe(count);       // the last item is reachable
    expect(m.padBottom).toBe(0);     // nothing left below
  });

  it('respects the column count CSS actually chose', async () => {
    mockGeometry({ columns: 1, viewport: 800 });   // the mobile rule
    render(<Grid count={1500} />);
    await scrollTo(ROW_HEIGHT * 30);
    const m = meta();
    // One column means row index == item index.
    expect(m.start).toBeGreaterThanOrEqual(30 - 4);
    expect(m.start).toBeLessThanOrEqual(30);
  });
});

describe('useWindowedRows — degrades safely', () => {
  /**
   * The failure that matters. A zero viewport is reported by embedded webviews,
   * headless renderers, and the browser harness used to verify this sprint. If
   * the window collapsed to one row, the user would see a blank page while the
   * scrollbar claimed hundreds of events.
   */
  it('renders a populated window when the viewport reports zero', () => {
    mockGeometry({ columns: 3, viewport: 0 });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 0, configurable: true });
    render(<Grid count={1500} />);
    const mounted = document.querySelectorAll('[data-windowed-item]').length;
    expect(mounted).toBeGreaterThanOrEqual(8 * 3);   // MIN_ROWS floor
  });

  it('never mounts a zero-item window at any scroll position', async () => {
    mockGeometry({ columns: 3, viewport: 800 });
    render(<Grid count={1500} />);
    for (const rows of [0, 1, 37, 249, 499, 500]) {
      await scrollTo(ROW_HEIGHT * rows);
      expect(meta().end - meta().start).toBeGreaterThan(0);
    }
  });

  it('handles an empty list without dividing by zero', () => {
    mockGeometry({});
    render(<Grid count={0} />);
    const m = meta();
    expect(m.start).toBe(0);
    expect(m.end).toBe(0);
    expect(Number.isFinite(m.padTop)).toBe(true);
    expect(Number.isFinite(m.padBottom)).toBe(true);
  });
});
