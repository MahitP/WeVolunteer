import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Moderation leads the Moderation Center.
 *
 * ── The finding ──
 *
 * `Reports` and `Organizer requests` used to sit fifth and fourth on this page,
 * below `Programme health`, `Participation` and `Most active organizers`. On a
 * 720px viewport that put the safety queue **1,082px down** — a moderator opening
 * the page they are told to work from had to scroll past a page and a half of
 * charts to reach the only thing on it that is time-sensitive. The "N waiting"
 * count that exists to raise the alarm was below the fold with it.
 *
 * Nothing was wrong with the sections. The order was wrong, and an order is
 * exactly the kind of thing that drifts back when somebody adds a section and
 * puts it where the diff is smallest.
 *
 * ── Why this reads the source ──
 *
 * Rendering the dashboard needs the session provider, the router, six API calls
 * and a `totals` payload, and every one of those is a way for this assertion to
 * fail for a reason that has nothing to do with ordering — which is how a test
 * ends up deleted rather than fixed. The claim here is a claim about the file:
 * these headings appear in this sequence. Reading it directly says that and
 * nothing else.
 */
const SRC = readFileSync(
  path.join(process.cwd(), 'src/views/AdminDashboard.jsx'),
  'utf8'
);

const positionOf = (heading) => {
  const at = SRC.indexOf(`<h2>${heading}</h2>`);
  expect(at, `"${heading}" is no longer a section heading on this page`).toBeGreaterThan(-1);
  return at;
};

describe('the Moderation Center leads with moderation', () => {
  it('puts Reports above every analytics section', () => {
    const reports = positionOf('Reports');
    for (const analytics of ['Programme health', 'Participation', 'Most active organizers']) {
      expect(
        reports,
        `"${analytics}" is above the safety queue — a moderator should not scroll `
        + 'past charts to reach the reports, and the "N waiting" badge should not '
        + 'be below the fold'
      ).toBeLessThan(positionOf(analytics));
    }
  });

  /**
   * Reports before the approval queue: both are moderation, and only one of them
   * is about somebody's safety. An organizer waiting on approval is waiting; a
   * report may be a student describing something happening to them now.
   */
  it('puts Reports above the approval queue', () => {
    expect(positionOf('Reports')).toBeLessThan(positionOf('Organizer requests'));
  });

  it('keeps the approval queue above the analytics too', () => {
    expect(positionOf('Organizer requests')).toBeLessThan(positionOf('Programme health'));
  });
});
