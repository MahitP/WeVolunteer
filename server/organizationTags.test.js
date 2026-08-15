import { describe, it, expect } from 'vitest';
import { normaliseTag } from './eventTags.js';
import {
  cleanOrgTag,
  normaliseOrgTag,
  normaliseOrgTags,
  MAX_ORG_TAGS,
  MAX_ORG_TAG_LENGTH,
} from './organizationTags.js';

/**
 * The rules an organization's tags are held to.
 *
 * Two bugs are pinned here, and they are opposite failures of the same missing
 * idea — that the thing which stores a tag and the thing which searches for one
 * have to agree about what a tag is.
 */

describe('what a stored tag looks like', () => {
  it('strips the hash people type in front of tags', () => {
    expect(cleanOrgTag('#NHS')).toBe('NHS');
    expect(cleanOrgTag('  ## Food Drive ')).toBe('Food Drive');
  });

  it('collapses internal whitespace, not just the ends', () => {
    expect(cleanOrgTag('Food  Drive')).toBe('Food Drive');
    expect(cleanOrgTag('Food\tDrive')).toBe('Food Drive');
  });

  it('takes the space a removed hash leaves behind', () => {
    expect(cleanOrgTag('  # NHS ')).toBe('NHS');
  });
});

/**
 * ── The unreachable-tag bug ──
 *
 * `#` search compares what it finds against `normaliseTag(query).tag`, which
 * collapses whitespace and strips a leading hash. Organization tags were stored
 * exactly as typed, so `"#NHS"` and `"Food  Drive"` — both accepted by the
 * route — could never be matched by any search by anyone. The tag saved, the
 * chip rendered, and the organization was simply unfindable by it.
 *
 * The property that fixes it is agreement, so that is what is asserted: for any
 * tag the organization rules accept, searching for it finds it.
 */
describe('a stored tag is reachable by the search that looks for it', () => {
  const typed = ['#NHS', 'Food  Drive', '  Beach Cleanup  ', '##Robotics'];

  it.each(typed)('%s stores in the form the # search compares against', (raw) => {
    const stored = normaliseOrgTags([raw]);
    expect(stored.ok).toBe(true);

    /* What the `#` branch of directory search reduces a query to. */
    const query = normaliseTag(raw);
    expect(query, 'fixture: the event normaliser should accept these').not.toBeNull();

    expect(stored.value[0].toLocaleLowerCase()).toBe(query.tag);
  });
});

describe('what organizations may be called that events may not', () => {
  /**
   * Real bodies are punctuated. Every one of these was accepted by the route
   * and refused by the form, which was using the event charset.
   */
  const realNames = ['Food & Water', 'St. Judes', '501(c)(3)', 'Kids/Teens'];

  it.each(realNames)('accepts %s', (name) => {
    const res = normaliseOrgTags([name]);
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([name]);
  });

  it.each(realNames)('%s is exactly what the event rules refuse', (name) => {
    /* Pins the asymmetry as deliberate. If event tags ever loosen to accept
       these, this file should be revisited rather than silently diverging. */
    expect(normaliseTag(name)).toBeNull();
  });
});

describe('limits', () => {
  it(`accepts a tag of exactly ${MAX_ORG_TAG_LENGTH} characters`, () => {
    const res = normaliseOrgTags(['a'.repeat(MAX_ORG_TAG_LENGTH)]);
    expect(res.ok).toBe(true);
  });

  it('refuses one character more, and names it', () => {
    const tooLong = 'a'.repeat(MAX_ORG_TAG_LENGTH + 1);
    const res = normaliseOrgTags([tooLong]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain(tooLong);
  });

  it('measures length after cleaning, so padding cannot buy room', () => {
    /* 40 characters plus surrounding space is a 40-character tag, not a 42. */
    const res = normaliseOrgTags([`  ${'a'.repeat(MAX_ORG_TAG_LENGTH)}  `]);
    expect(res.ok).toBe(true);
  });

  it('applies the count limit after de-duplication', () => {
    const eight = Array.from({ length: MAX_ORG_TAGS }, (_, i) => `Tag ${i}`);
    const res = normaliseOrgTags([...eight, 'TAG 0', 'tag 1']);
    expect(res.ok).toBe(true);
    expect(res.value).toHaveLength(MAX_ORG_TAGS);
  });

  it('refuses more than the limit once duplicates are gone', () => {
    const nine = Array.from({ length: MAX_ORG_TAGS + 1 }, (_, i) => `Tag ${i}`);
    expect(normaliseOrgTags(nine).ok).toBe(false);
  });

  it('keeps the first spelling of a duplicate', () => {
    const res = normaliseOrgTags(['NHS', 'nhs']);
    expect(res.value).toEqual(['NHS']);
  });
});

describe('the shapes a shared editor can send', () => {
  it('accepts the {tag, label} objects TagInput emits', () => {
    const res = normaliseOrgTags([{ tag: 'nhs', label: 'NHS' }]);
    expect(res.ok).toBe(true);
    expect(res.value).toEqual(['NHS']);
  });

  it('refuses a shape nobody meant to send', () => {
    expect(normaliseOrgTags([{ nope: 1 }]).ok).toBe(false);
    expect(normaliseOrgTags('NHS').ok).toBe(false);
  });

  it('refuses a blank tag rather than storing an empty chip', () => {
    expect(normaliseOrgTags(['   ']).ok).toBe(false);
    expect(normaliseOrgTags(['#']).ok).toBe(false);
  });
});

/**
 * ── The silent-deletion bug ──
 *
 * The form loaded stored tags, normalised them with the EVENT rules, dropped
 * whatever failed, and submitted the survivors — and the route replaces the
 * whole column. Editing a description therefore deleted tags nobody touched and
 * the editor never displayed.
 *
 * The unit-level property is that loading and saving is lossless.
 */
describe('a load-then-save round trip loses nothing', () => {
  const stored = ['Food & Water', 'St. Judes', '501(c)(3)', 'NHS', 'Kids/Teens'];

  it('keeps every stored tag through the chip form and back', () => {
    const chips = stored.map(normaliseOrgTag);
    expect(chips.every(Boolean), 'a stored tag failed to become a chip').toBe(true);

    const submitted = chips.map(c => c.label);
    const res = normaliseOrgTags(submitted);

    expect(res.ok).toBe(true);
    expect(res.value).toEqual(stored);
  });
});
