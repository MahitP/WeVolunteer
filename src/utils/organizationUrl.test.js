import { describe, it, expect } from 'vitest';
import { organizationPath, organizationSubPath } from './organizationUrl';

/**
 * Where an organization lives, built in one place.
 *
 * ── Why this is worth a test file of its own ──
 *
 * The `@` is punctuation the URL adds, and a link written without it still
 * RESOLVES — the signed-in route accepts the bare handle so that every link made
 * before handles existed keeps working. That is exactly what makes the omission
 * invisible: it is not a broken page, it is a page at a non-canonical address
 * that a signed-out reader is refused. Eight call sites each adding the sigil by
 * hand was eight chances for one of them not to; these assertions are what keep
 * it to one place.
 */

describe('the canonical path', () => {
  it('takes an organization', () => {
    expect(organizationPath({ slug: 'robotics' })).toBe('/organizations/@robotics');
  });

  it('takes a bare handle too, because half the callers only have one', () => {
    expect(organizationPath('robotics')).toBe('/organizations/@robotics');
  });

  it('does not double the sigil for a value that already carries it', () => {
    expect(organizationPath('@robotics')).toBe('/organizations/@robotics');
    expect(organizationPath({ slug: '@robotics' })).toBe('/organizations/@robotics');
  });

  /**
   * The directory rather than a broken URL.
   *
   * Several callers build this from a value that can legitimately be absent —
   * `event.organizationSlug` on an event with no club, a notification payload
   * written before the column existed. `/organizations/@undefined` would be a
   * link to nothing that looks like a link to something.
   */
  it('falls back to the directory when there is no handle', () => {
    for (const nothing of [undefined, null, '', {}, { slug: null }, { slug: '' }]) {
      expect(organizationPath(nothing), JSON.stringify(nothing)).toBe('/organizations');
    }
  });

  it('encodes anything that would change the shape of the URL', () => {
    /* The server refuses these handles, so they should never occur — but this
       builds a URL from a value the server sent, and a client-side validator
       would be a second copy of `validateHandle` that could only disagree with
       it. Encoding is the answer that cannot disagree. */
    expect(organizationPath('a/b')).toBe('/organizations/@a%2Fb');
    expect(organizationPath('a?b=1')).toBe('/organizations/@a%3Fb%3D1');
    expect(organizationPath('a#b')).toBe('/organizations/@a%23b');
  });
});

describe('sub-pages', () => {
  it('hangs a segment off the canonical path', () => {
    expect(organizationSubPath({ slug: 'robotics' }, 'edit')).toBe('/organizations/@robotics/edit');
  });
});
