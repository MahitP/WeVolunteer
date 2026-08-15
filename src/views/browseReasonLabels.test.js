import { describe, it, expect } from 'vitest';
import { reasonLabel } from './BrowseEvents.jsx';

/**
 * The words that tell a student why they are being shown an opportunity.
 *
 * The server returns typed reasons — `{kind, value}` — and this turns them into
 * text. Keeping the two apart is what stops the wording claiming more than the
 * ranking used: a reason can only be phrased here if the server said it fired.
 *
 * Tested directly rather than through a page render, because this is the part
 * that has to be right and it should not need a mounted view to check.
 */

describe('reasonLabel', () => {
  it('names the interest that matched', () => {
    expect(reasonLabel({ kind: 'tag', value: 'Environment' })).toBe('Matches Environment');
    expect(reasonLabel({ kind: 'skill', value: 'Tutoring' })).toBe('Matches Tutoring');
  });

  it('says what a category reason actually means', () => {
    /* "School" alone would read as a label on the event rather than as a fact
       about the person being shown it. */
    expect(reasonLabel({ kind: 'category', value: 'Food Pantry' }))
      .toBe('You have volunteered for Food Pantry before');
  });

  it('reports distance with its unit', () => {
    expect(reasonLabel({ kind: 'distance', miles: 2.1 })).toBe('2.1 mi away');
    expect(reasonLabel({ kind: 'distance', miles: 0 })).toBe('0 mi away');
  });

  it('renders nothing rather than something vague', () => {
    /**
     * An unrecognised or incomplete reason produces no chip at all. A vague
     * one would be worse than none: it reads as an explanation while
     * explaining nothing, and it would survive a server change that stopped
     * sending the value.
     */
    expect(reasonLabel({ kind: 'tag' })).toBeNull();
    expect(reasonLabel({ kind: 'skill', value: '' })).toBeNull();
    expect(reasonLabel({ kind: 'category', value: null })).toBeNull();
    expect(reasonLabel({ kind: 'distance' })).toBeNull();
    expect(reasonLabel({ kind: 'distance', miles: 'close' })).toBeNull();
    expect(reasonLabel({ kind: 'invented-later', value: 'x' })).toBeNull();
    expect(reasonLabel(null)).toBeNull();
    expect(reasonLabel(undefined)).toBeNull();
  });
});
