import { useRef } from 'react';

/**
 * A number that changes in place — hours credited, places left — with a
 * 150ms colour tint on the frame it changes, and nothing else.
 *
 * No count-up, no odometer, no bounce. A total that counts up presents a
 * record as a score, and a place count that rolls like an odometer makes an
 * ordinary change look like an event. The new value is there at once; the tint
 * only says "this just changed" to somebody who was looking at it.
 *
 * Nothing plays on first render: arriving at a page is not a change. The
 * element is re-keyed on each change so the animation starts again.
 */
export default function TintOnChange({ value, className = '', children }) {
  const previous = useRef(value);
  const changes = useRef(0);
  if (previous.current !== value) {
    previous.current = value;
    changes.current += 1;
  }
  const tinted = changes.current > 0;
  return (
    <span key={changes.current} className={`${className}${tinted ? ' value-tint' : ''}`.trim() || undefined}>
      {children}
    </span>
  );
}
