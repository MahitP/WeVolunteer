/**
 * What the discovery live region says.
 *
 * `role="status"` on a visually hidden paragraph is the only announcement a
 * screen-reader user gets that a directory search returned anything, and it
 * read `${people + orgs} people and organizations found` — so the single result
 * that typing somebody's name usually produces was announced as "1 people and
 * organizations found", and no results as "0 people and organizations found"
 * where the natural phrasing is a negative.
 *
 * A pure function with its own test because it is a sentence, and a sentence
 * assembled from two independently pluralised counts is the kind of thing that
 * is only ever wrong for the least common case somebody thought to look at.
 */
import { describe, it, expect } from 'vitest';
import { discoveryAnnouncement } from './BrowseEvents.jsx';

describe('the discovery search announcement', () => {
  it('says nothing was found, rather than counting to zero', () => {
    expect(discoveryAnnouncement({ users: [], organizations: [] }))
      .toBe('No people or organizations found');
    expect(discoveryAnnouncement(null)).toBe('No people or organizations found');
    expect(discoveryAnnouncement({})).toBe('No people or organizations found');
  });

  it('uses the singular for one person — the commonest result of a name search', () => {
    expect(discoveryAnnouncement({ users: [{}], organizations: [] }))
      .toBe('1 person found');
  });

  it('pluralises each kind on its own count', () => {
    expect(discoveryAnnouncement({ users: [{}, {}], organizations: [] }))
      .toBe('2 people found');
    expect(discoveryAnnouncement({ users: [], organizations: [{}] }))
      .toBe('1 organization found');
    expect(discoveryAnnouncement({ users: [], organizations: [{}, {}] }))
      .toBe('2 organizations found');
  });

  /* One sentence with two different plurals in it — the case a single shared
     count could never get right. */
  it('joins the two kinds, each pluralised separately', () => {
    expect(discoveryAnnouncement({ users: [{}], organizations: [{}, {}] }))
      .toBe('1 person and 2 organizations found');
    expect(discoveryAnnouncement({ users: [{}, {}], organizations: [{}] }))
      .toBe('2 people and 1 organization found');
  });

  /* A kind with no results is omitted entirely rather than announced as zero. */
  it('never mentions a kind that returned nothing', () => {
    expect(discoveryAnnouncement({ users: [{}], organizations: [] }))
      .not.toContain('organization');
    expect(discoveryAnnouncement({ users: [], organizations: [{}] }))
      .not.toContain('person');
  });
});
