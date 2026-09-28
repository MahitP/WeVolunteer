import BrandMark from './BrandMark';
import { LONG_WAIT_MS, useDelayedFlag } from '../../utils/motion';

/**
 * A wait that owns the whole page or the whole route: app start, session
 * restore, a route chunk still arriving.
 *
 * Nothing is drawn for the first second. Most of these waits end well inside
 * it, and a loader that flashes for 200ms reads as a glitch. Past that the
 * brand loader appears — `BrandMark motion="loader"`, the same one the OAuth
 * callback uses — with the wait said in words beside it. `size="lg"` is
 * required rather than chosen: below a 32px mark the loader refuses to
 * animate (see `BrandMark`).
 *
 * The status region is on screen from the first frame, so a screen reader is
 * told about the wait at the same moment a sighted reader is shown it.
 */
export default function FullPageWait({ label = 'Loading…' }) {
  const shown = useDelayedFlag(true, LONG_WAIT_MS);
  return (
    <div className="full-page-wait" role="status" aria-live="polite">
      {shown && (
        <>
          <BrandMark size="lg" motion="loader" />
          <p className="dim">{label}</p>
        </>
      )}
    </div>
  );
}
