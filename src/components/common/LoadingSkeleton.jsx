import React from 'react';
import { LOADING_THRESHOLD_MS, useDelayedFlag } from '../../utils/motion';

/**
 * Content-shaped placeholders for a list or page that is loading.
 *
 * The blocks are laid out from the first frame, so the page does not jump when
 * they appear, but they stay invisible for the first 300ms: most fetches resolve
 * inside that, and a skeleton that flashes for 100ms reads as a flicker rather
 * than as a wait. The shimmer pauses while the tab is hidden (see
 * `installPageVisibilityFlag`).
 */
export default function LoadingSkeleton({
  heights = [120, 200],
  className = "stack-lg page",
  style = {
    padding: 'var(--s6)'
  }
}) {
  const shown = useDelayedFlag(true, LOADING_THRESHOLD_MS);
  return <div className={className} style={style}>
      {heights.map((h, i) => <div key={i} className={shown ? 'skeleton' : 'skeleton skeleton-waiting'} style={{
      height: h
    }} />)}
    </div>;
}
