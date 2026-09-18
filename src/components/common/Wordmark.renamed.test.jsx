import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';

/**
 * A renamed deployment gets text, and `motion` must be a no-op against it.
 *
 * `Wordmark` renders the outlined lettering only when `APP_NAME` is the name
 * that lettering spells; `VITE_APP_NAME` can set another, and then it renders a
 * `<span>`. There is no path to draw and no wordmark to reveal there, so asking
 * for the lockup must return the same text it always did rather than an SVG
 * animation attached to nothing.
 *
 * Mocked at module scope because `config.js` reads `import.meta.env` once.
 */
vi.mock('../../config', () => ({ APP_NAME: 'Springfield Service' }));

const { default: Wordmark } = await import('./Wordmark');

describe('the rename branch ignores motion', () => {
  it.each(['lockup', 'micro', 'signature', 'none'])('motion="%s" still renders the name as text', (motion) => {
    const { container } = render(<Wordmark motion={motion} />);
    const span = container.querySelector('span.brand-name');
    expect(span).toBeTruthy();
    expect(span.textContent).toBe('Springfield Service');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.innerHTML).not.toMatch(/wv-/);
  });

  it('keeps any className the caller passed', () => {
    const { container } = render(<Wordmark className="err-mark-word" motion="lockup" />);
    expect(container.querySelector('span').getAttribute('class')).toBe('brand-name err-mark-word');
  });
});
