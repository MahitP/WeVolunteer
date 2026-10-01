import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One label, one destination.
 *
 * ── The collision ──
 *
 * "Browse organizations" named two different pages:
 *
 *   OrganizationsHome  → /discover?find=organizations   every club on the platform
 *   OrganizationPage   → /organizations                 the clubs you are in
 *
 * And `/organizations` carried two labels: "Browse organizations" there, and
 * "Your organizations" on Discover's action row.
 *
 * ── Why this one is decidable from the repository ──
 *
 * The product already has a name for `/organizations` — "Your organizations",
 * since ruled "Organizations" by the owner —
 * so the collision resolves without anyone choosing new wording: "Browse
 * organizations" keeps the meaning it already has in the other two places, the
 * platform-wide search. That also happens to be the better destination for the
 * screen it sits on: the reader followed a club link that no longer resolves,
 * and what they want is to find a club, not a list of the ones they are already
 * in.
 *
 * The REST of the terminology finding is not decidable this way — four labels
 * for `/events/new` against a page titled "New opportunity", application vs
 * sign-up split along the role line, five names for the service-hours record —
 * because each needs somebody to pick which word wins. Those stay recorded as
 * an owner decision and are deliberately not asserted here.
 *
 * ── A source check, deliberately ──
 *
 * The claim is about two files agreeing, which is not a thing either component
 * can be asked at runtime without mounting both with fixtures that would make
 * the labels incidental to whatever the mock returned.
 */

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Every `<Link to="…">label</Link>` pair in a file, flattened to one line. */
function links(source) {
  const flat = source.replace(/\s+/g, ' ');
  return [...flat.matchAll(/<Link[^>]*to="([^"]+)"[^>]*>(.*?)<\/Link>/g)]
    .map(m => ({ to: m[1], label: m[2].replace(/<[^>]*>/g, '').trim() }));
}

const FILES = [
  'src/views/OrganizationsHome.jsx',
  'src/views/OrganizationPage.jsx',
  'src/views/BrowseEvents.jsx',
];

describe('"Browse organizations"', () => {
  it('finds the labels at all, so this is not scanning an empty set', () => {
    const all = FILES.flatMap(f => links(read(f)));
    expect(all.length).toBeGreaterThan(3);
    expect(all.some(l => /organizations/i.test(l.label))).toBe(true);
  });

  it('names exactly one destination across the app', () => {
    const targets = new Set(
      FILES.flatMap(f => links(read(f)))
        .filter(l => /^browse organizations$/i.test(l.label))
        .map(l => l.to)
    );

    expect(
      [...targets],
      'one label, two pages — a reader cannot tell which one they will get',
    ).toEqual(['/discover?find=organizations']);
  });

  /* "Your organizations" until the owner ruled (2026-09-30, ruling 5) that the
     button is "Organizations". Still one label, one page. */
  it('keeps "Organizations" as the name for the page it already named', () => {
    const yours = FILES.flatMap(f => links(read(f)))
      .filter(l => /^organizations$/i.test(l.label));
    expect(yours.length).toBeGreaterThan(0);
    for (const l of yours) expect(l.to).toBe('/organizations');
  });
});
