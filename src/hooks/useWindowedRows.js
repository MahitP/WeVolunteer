import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Row windowing for a responsive CSS grid.
 *
 * The opportunity list rendered every matching event: measured with 502 events
 * it produced 23,815 DOM nodes and 285,547px of scroll height. Lighthouse warns
 * above 1,500 nodes and calls 6,000 excessive, and this is a mobile-first
 * product — so at a district's full event history the browse screen was the
 * heaviest thing in the app by a wide margin.
 *
 * Why this rather than a virtualisation library:
 *
 *   • The grid is `repeat(auto-fill, minmax(320px, 1fr))`, so the column count
 *     is decided by CSS at the current width, not by JavaScript. It is read back
 *     from the computed style rather than guessed, so the maths follows the
 *     breakpoint automatically — including the single-column mobile rule.
 *   • Card heights vary with content, but CSS Grid stretches every card in a row
 *     to the tallest, so ROWS are the uniform unit. Windowing by row avoids the
 *     per-item height estimation that makes variable-size virtualisers janky.
 *   • Offsets are computed from the grid's viewport-relative rect, so it does
 *     not matter which ancestor is the scroll container — the app shell scrolls
 *     the document, but a modal or a future inner-scroll layout would work
 *     unchanged.
 *
 * Below `threshold` items nothing is windowed at all: the common case (a school
 * with a dozen open events) renders exactly as it did before, so this cannot
 * regress the screen it is most often looked at on.
 *
 * @returns {{start:number,end:number,padTop:number,padBottom:number,active:boolean,measure:()=>void}}
 */
export function useWindowedRows({
  count,
  gridRef,
  threshold = 60,
  overscanRows = 3
}) {
  // Only meaningful once measured; the first paint renders the initial window.
  const [range, setRange] = useState({ start: 0, end: Math.min(count, threshold) });
  const metrics = useRef({ rowHeight: 0, columns: 1 });

  const active = count > threshold;

  /**
   * Reads the live geometry: how many columns CSS has chosen, and how tall one
   * row is including the gap. Both come from the DOM rather than from
   * assumptions, because either can change on resize, orientation change, or a
   * font-size preference.
   */
  const readMetrics = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return null;

    const style = window.getComputedStyle(grid);
    // `grid-template-columns` resolves to a space-separated list of used pixel
    // values, so its length is the real column count at this width.
    const columns = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
    const rowGap = parseFloat(style.rowGap) || 0;

    // Measure a real child rather than assuming a card height.
    const firstChild = grid.querySelector('[data-windowed-item]');
    const childHeight = firstChild ? firstChild.getBoundingClientRect().height : 0;
    const rowHeight = childHeight > 0 ? childHeight + rowGap : 0;

    metrics.current = { rowHeight, columns };
    return metrics.current;
  }, [gridRef]);

  const recompute = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || !active) return;

    const { rowHeight, columns } = metrics.current.rowHeight ? metrics.current : (readMetrics() || {});
    if (!rowHeight || !columns) return;

    const totalRows = Math.ceil(count / columns);
    const rect = grid.getBoundingClientRect();

    /**
     * Fail towards rendering MORE, never fewer.
     *
     * Some environments report a zero viewport — embedded webviews, headless
     * screenshot renderers, and the browser harness this was verified in all do.
     * With a zero height the window collapses to a single row and the user sees a
     * blank list while the scrollbar says there are hundreds of events, which is
     * far worse than simply rendering too much. `FALLBACK_VIEWPORT` is a tall
     * desktop; if the real height is unknowable, mount a generous window.
     */
    const FALLBACK_VIEWPORT = 1200;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || FALLBACK_VIEWPORT;

    // How far the grid's top sits above the viewport top.
    const scrolledPast = Math.max(0, -rect.top);
    const firstVisibleRow = Math.floor(scrolledPast / rowHeight);
    const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;

    const startRow = Math.max(0, firstVisibleRow - overscanRows);
    // MIN_ROWS is a second floor on the same failure: even if every measurement
    // is wrong, enough rows are mounted for the screen to look populated.
    const MIN_ROWS = 8;
    const endRow = Math.min(totalRows, Math.max(startRow + MIN_ROWS, firstVisibleRow + visibleRows + overscanRows));

    const start = startRow * columns;
    const end = Math.min(count, endRow * columns);

    setRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [active, count, gridRef, overscanRows, readMetrics]);

  // Measure after the first paint, once real cards exist to measure.
  useLayoutEffect(() => {
    if (!active) { setRange({ start: 0, end: count }); return; }
    readMetrics();
    recompute();
  }, [active, count, readMetrics, recompute]);

  useEffect(() => {
    if (!active) return;

    let frame = 0;
    const onScroll = () => {
      // Coalesce to one recompute per frame: a scroll handler that does layout
      // work on every event is its own performance problem.
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; recompute(); });
    };
    const onResize = () => { readMetrics(); recompute(); };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    // A card can change height after images or fonts load, and the column count
    // changes at breakpoints — both invalidate the measurement.
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(onResize)
      : null;
    if (observer && gridRef.current) observer.observe(gridRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll, { passive: true });
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [active, gridRef, readMetrics, recompute]);

  if (!active) {
    return { start: 0, end: count, padTop: 0, padBottom: 0, active: false, measure: readMetrics };
  }

  const { rowHeight, columns } = metrics.current;
  const totalRows = columns ? Math.ceil(count / columns) : 0;
  const startRow = columns ? Math.floor(range.start / columns) : 0;
  const endRow = columns ? Math.ceil(range.end / columns) : 0;

  return {
    start: range.start,
    end: range.end,
    // Spacers preserve the true scroll height so the scrollbar and any
    // scroll-position restore stay honest.
    padTop: startRow * rowHeight,
    padBottom: Math.max(0, (totalRows - endRow) * rowHeight),
    active: true,
    measure: readMetrics
  };
}
