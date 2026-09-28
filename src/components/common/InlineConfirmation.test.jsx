/**
 * The success beat plays once per confirmation, and never for history.
 *
 * The beat is the brand's one moment of celebration and the product's rule is
 * that hours are a record, not a score. Both failure modes are invisible in a
 * screenshot: a beat that replays on every visit to the hours page, and a
 * first visit that fires a beat on every row a volunteer has ever earned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import InlineConfirmation from './InlineConfirmation';
import BrandMark from './BrandMark';
import { __resetConfirmationBaselines } from '../../utils/confirmationBeat';
import { MARK_PATH_LENGTH, TICK_PATH_LENGTH } from './brandMotion';
import { MARK_STROKE } from './logoGeometry';

const beats = (container) => container.querySelectorAll('.wv-ok-tick').length;

const show = (itemKey, { userId = 'u1', kind = 'hours' } = {}) =>
  render(
    <InlineConfirmation userId={userId} kind={kind} itemKey={itemKey}>
      <span>+3 hrs</span>
    </InlineConfirmation>
  );

/** A new page load: the module forgets which baselines it created. */
const reload = () => __resetConfirmationBaselines();

beforeEach(() => {
  window.localStorage.clear();
  reload();
});

describe('InlineConfirmation', () => {
  it('always renders the confirmation text, beat or not', () => {
    const { container } = show('e1:2026-09-01');
    expect(container).toHaveTextContent('+3 hrs');
  });

  it('plays nothing on the first visit: everything already there is history', () => {
    const { container } = show('e1:2026-09-01');
    expect(beats(container)).toBe(0);
  });

  it('plays once for an item first seen on a later visit, then never again', () => {
    show('old').unmount();
    reload();

    const first = show('new');
    expect(beats(first.container), 'a new confirmation should beat').toBe(1);
    first.unmount();

    expect(beats(show('new').container), 'same view, remounted').toBe(0);
    reload();
    expect(beats(show('new').container), 'next visit').toBe(0);
  });

  it('does not replay history on the second visit either', () => {
    show('old').unmount();
    reload();
    expect(beats(show('old').container)).toBe(0);
  });

  it('keeps each kind and each person separate', () => {
    show('a', { kind: 'hours' }).unmount();
    reload();
    /* First look at certificates: its own baseline, so nothing plays. */
    expect(beats(show('c1', { kind: 'certificate' }).container)).toBe(0);
    /* A different person on the same browser has no history yet. */
    expect(beats(show('b', { userId: 'u2' }).container)).toBe(0);
  });

  it('plays when an item becomes confirmed while it is on screen', () => {
    show('seed').unmount();
    reload();
    const { container, rerender } = show(null);
    expect(beats(container)).toBe(0);
    rerender(
      <InlineConfirmation userId="u1" kind="hours" itemKey="just-now">
        <span>+3 hrs</span>
      </InlineConfirmation>
    );
    expect(beats(container)).toBe(1);
  });

  it('renders static, and records nothing, when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
    try {
      expect(beats(show('x').container)).toBe(0);
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('keeps the mark out of the accessibility tree', () => {
    show('old').unmount();
    reload();
    const { container } = show('new');
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('BrandMark variant="inline"', () => {
  it('draws no tile, at the full-weight stroke the dash values were solved for', () => {
    const { container } = render(<BrandMark variant="inline" />);
    expect(container.querySelector('.brand-mark')).toBeNull();
    const svg = container.querySelector('svg.brand-mark-inline');
    expect(svg).not.toBeNull();
    expect(svg.querySelector('path').getAttribute('stroke-width')).toBe(String(MARK_STROKE));
    expect(svg.querySelector('path').getAttribute('stroke')).toBe('currentColor');
  });

  it('may perform the success beat, with its frozen body/tick split', () => {
    const { container } = render(<BrandMark variant="inline" motion="success" />);
    const [body, tick] = container.querySelectorAll('path');
    expect(body.getAttribute('class')).toBe('wv-ok-body');
    expect(body.getAttribute('pathLength')).toBe(MARK_PATH_LENGTH);
    expect(tick.getAttribute('class')).toBe('wv-ok-tick');
    expect(tick.getAttribute('pathLength')).toBe(TICK_PATH_LENGTH);
  });
});
