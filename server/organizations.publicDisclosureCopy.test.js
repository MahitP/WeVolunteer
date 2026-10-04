import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { publicOrganization } from './organizations.js';

/**
 * The sentence a manager reads before publishing a page about children, checked
 * against what the page actually publishes.
 *
 * ── Why this is a test and not a comment ──
 *
 * `VISIBILITY_COPY.public.note` lists what a public page shows and then says
 * "never who is in it, and never where an event is". The "never … never"
 * construction makes it an INVENTORY, and that is how a safety statement is
 * read: a manager who ticks "Anyone can see this page" is entitled to treat
 * that sentence as complete.
 *
 * It was not. `publicOrganization` also shipped `tags` and `eventCount`, and
 * the copy named neither — so the disclosure was already two fields behind the
 * projection on the day it was written, with nothing to notice.
 *
 * This is the thing that notices. It fails when a field is added to the
 * allowlist and not to the sentence, which is the direction the drift actually
 * goes.
 *
 * ── Why the copy is read as TEXT ──
 *
 * `src/organizationPolicy.js` imports `src/config.js`, which reads
 * `import.meta.env` — undefined under the server project's Node environment.
 * Reading the source is what lets the assertion live next to
 * `publicOrganization`, which is the half that changes.
 */

const COPY = readFileSync(new URL('../src/organizationPolicy.js', import.meta.url), 'utf8');

/** The `note` on the `public` visibility option, as written. */
function disclosureNote() {
  const block = COPY.slice(COPY.indexOf('export const VISIBILITY_COPY'));
  const note = block.slice(block.indexOf('note:'), block.indexOf('unlisted:'));
  /* The string literal's contents, with the concatenation seams removed. */
  return note.replace(/'\s*\+\s*'/g, '').replace(/[^']*'/, '').replace(/',[\s\S]*$/, '');
}

/**
 * What the projection actually carries, from a row shaped like a real one.
 *
 * Derived rather than listed, so a new field in `publicOrganization` turns up
 * here without anybody remembering this file.
 */
const projected = () => Object.keys(publicOrganization(
  {
    id: 'org-1', slug: 'robotics', name: 'Robotics', description: 'We build robots.',
    tags: JSON.stringify(['Engineering']), avatar: '🤖', image_url: null,
    avatar_color: 'sage', memberCount: 6, eventCount: 3,
    join_policy: 'open', status: 'active', visibility: 'public',
  },
  { upcoming: [] },
));

/**
 * Every field, and the words in the sentence that account for it.
 *
 * A field is either NAMED in the disclosure, or it is structural and discloses
 * nothing about the club (`kind`, `slug`, `handle` — the address the reader is
 * already at). Anything else has to be added to both sides deliberately, which
 * is the point.
 */
const ACCOUNTED_FOR = {
  name: ['name'],
  description: ['description'],
  avatar: ['logo'],
  imageUrl: ['logo'],
  avatarColor: ['logo'],
  tags: ['tags'],
  memberCount: ['how many members'],
  eventCount: ['how many events'],
  upcoming: ['what is coming up'],
  joinPolicy: ['can join', 'coming up'],

  /* Structural: the reader is already at this address, and `kind` is a type
     tag the client branches on. Neither is a fact about the club. */
  kind: [],
  slug: [],
  handle: [],
};

describe('the public-visibility disclosure', () => {
  it('accounts for every field the projection publishes', () => {
    const note = disclosureNote();
    const unaccounted = projected().filter((field) => {
      const words = ACCOUNTED_FOR[field];
      /* A field nobody has classified is unaccounted for by definition — that
         is what makes this fail on a NEW field rather than only on a renamed
         one. */
      if (!words) return true;
      return words.length > 0 && !words.some(word => note.includes(word));
    });

    expect(
      unaccounted,
      'these fields reach an unauthenticated reader and the visibility setting\'s '
      + 'disclosure sentence does not mention them. Add them to the sentence in '
      + 'src/organizationPolicy.js and to ACCOUNTED_FOR here — a manager ticking '
      + '"Anyone can see this page" reads that sentence as complete.',
    ).toEqual([]);
  });

  /** The two promises, which are the reason the sentence is load-bearing. */
  it('still promises no member and no location', () => {
    const note = disclosureNote();
    expect(note).toMatch(/never who is in it/);
    expect(note).toMatch(/never where an event is/);
  });

  it('is telling the truth about members and locations', () => {
    const fields = projected();
    /* No per-member anything, and no location field of any kind. If either
       appears, the sentence above becomes false and this fails before anybody
       reads it. */
    expect(fields).not.toContain('members');
    expect(fields).not.toContain('memberList');
    expect(fields).not.toContain('roster');
    expect(fields).not.toContain('createdByName');
    for (const field of fields) {
      expect(field.toLowerCase(), `${field} looks like a location`).not.toMatch(/location|address|latitude|longitude/);
    }
  });

  /**
   * And the upcoming events carry a title, a date and a category — never a
   * place or a time of day.
   *
   * This is the one nested shape in the projection, so a field added inside it
   * would not show up in the top-level key list above.
   */
  it('publishes no location or time inside an upcoming opportunity', () => {
    const [event] = publicOrganization(
      {
        id: 'org-1', slug: 'robotics', name: 'Robotics', description: '', tags: '[]',
        avatar: null, image_url: null, avatar_color: null, memberCount: 0, eventCount: 1,
        join_policy: 'open', status: 'active', visibility: 'public',
      },
      {
        upcoming: [{
          title: 'Build night', startsAt: '2026-10-01T18:00:00.000Z', category: 'Engineering',
          location: '14 Mill Lane', address: '14 Mill Lane', latitude: 1, longitude: 2,
          instructions: 'Come to the back door', id: 'event-1',
        }],
      },
    ).upcoming;

    expect(Object.keys(event).sort()).toEqual(['category', 'startsAt', 'title']);
  });
});
