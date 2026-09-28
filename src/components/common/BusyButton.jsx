import { Loader2 } from 'lucide-react';
import { LOADING_THRESHOLD_MS, useDelayedFlag } from '../../utils/motion';

/**
 * A button whose action waits on the server.
 *
 *   idle → busy → (busy + spinner after 300ms) → idle
 *
 * - The pressed state is the ordinary `.btn` one, which answers within
 *   `--t-fast`: feedback has to start inside a tenth of a second to read as a
 *   result of the tap.
 * - While busy the label says what is happening, in the present progressive
 *   ("Signing up…"), and the button is disabled, which is what stops a second
 *   press sending the request twice. `aria-busy` tells assistive technology the
 *   control is working rather than broken.
 * - The spinner appears only once the wait passes 300ms. A quick reply never
 *   flashes a loading state; the 300ms timer is cleared on resolve.
 * - Under reduced motion the spinner is not drawn at all — both reduced-motion
 *   blocks hide `.btn-busy-spinner` — and the label carries the wait alone.
 *
 * Everything else a caller passes goes to the `<button>` unchanged.
 */
export default function BusyButton({
  busy = false,
  busyLabel,
  disabled = false,
  children,
  type = 'button',
  ...rest
}) {
  const showSpinner = useDelayedFlag(busy, LOADING_THRESHOLD_MS);
  return (
    <button
      type={type}
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {showSpinner && <Loader2 size={14} className="spin btn-busy-spinner" aria-hidden="true" />}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}
