import { describe, it, expect } from 'vitest';
import {
  normaliseTag, validateTags, MAX_TAGS_PER_EVENT, MAX_TAG_LENGTH,
} from './eventTags.js';

/**
 * Tag normalisation and validation, as pure functions.
 *
 * The requirement that shapes this file: `#NHS`, `#nhs` and `# NHS` must not
 * become three separate concepts. Everything else here is the bounding that keeps
 * a free-text field from becoming an unbounded one — the write path is reachable
 * by any approved organizer, so the limits are the only thing between a form and
 * a megabyte of tags.
 */

describe('normaliseTag', () => {
  /** The named requirement, stated as a table so a regression names the input. */
  it.each([
    ['NHS', 'nhs'],
    ['#NHS', 'nhs'],
    ['#nhs', 'nhs'],
    ['# NHS', 'nhs'],
    ['  #NHS  ', 'nhs'],
    ['###NHS', 'nhs'],
    ['nHs', 'nhs'],
  ])('reduces %o to the one concept %o', (input, key) => {
    expect(normaliseTag(input)?.tag).toBe(key);
  });

  it('collapses internal whitespace rather than treating it as significant', () => {
    /* `Food   Drive` and `Food Drive` are the same tag typed carelessly, and a
       tab or a newline arrives from a paste. */
    expect(normaliseTag('Food   Drive')?.tag).toBe('food drive');
    expect(normaliseTag('Food\tDrive')?.tag).toBe('food drive');
    expect(normaliseTag('Food\nDrive')?.tag).toBe('food drive');
  });

  /**
   * The label keeps the organizer's spelling.
   *
   * `AnimalShelter` must not come back as `animalshelter`. The normalised key is
   * for finding; the label is for reading.
   */
  it('preserves the typed capitalisation as the display label', () => {
    expect(normaliseTag('AnimalShelter')).toEqual({ tag: 'animalshelter', label: 'AnimalShelter' });
    expect(normaliseTag('#SATPrep')).toEqual({ tag: 'satprep', label: 'SATPrep' });
  });

  it('accepts the arbitrary tags an organizer might invent', () => {
    for (const tag of ['CommunityGarden', 'CancerAwareness', 'MiddleSchool', 'Coding', 'Library', 'Food Drive', 'K-9']) {
      expect(normaliseTag(tag), tag).toBeTruthy();
    }
  });

  /** Not `a-z`: a district that tags in another language is not told it is wrong. */
  it('accepts non-Latin letters', () => {
    expect(normaliseTag('Español')?.tag).toBe('español');
    expect(normaliseTag('한국어')?.tag).toBe('한국어');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['#', 'a bare hash'],
    ['###', 'hashes only'],
    ['-leading', 'a leading hyphen'],
    ['<script>', 'markup'],
    ['a&b', 'an ampersand'],
    ['tag"quote', 'a quote'],
    ['=cmd', 'a spreadsheet formula lead-in'],
    ['emoji🎉', 'emoji'],
    ['new\0line', 'a NUL byte'],
  ])('refuses %o (%s)', (input) => {
    expect(normaliseTag(input)).toBeNull();
  });

  it('refuses a tag longer than the limit, measured on the normalised form', () => {
    expect(normaliseTag('a'.repeat(MAX_TAG_LENGTH))).toBeTruthy();
    expect(normaliseTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
  });

  it('refuses a non-string without throwing', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(normaliseTag(value)).toBeNull();
    }
  });
});

describe('validateTags', () => {
  const keys = (result) => result.value.map(t => t.tag);

  it('treats absent and empty as "no tags", because tags are optional', () => {
    expect(validateTags(undefined)).toEqual({ ok: true, value: [] });
    expect(validateTags(null)).toEqual({ ok: true, value: [] });
    expect(validateTags([])).toEqual({ ok: true, value: [] });
  });

  /**
   * Duplicates are de-duplicated SILENTLY, unlike every other refusal here.
   *
   * Typing `NHS` twice means the same thing as typing it once; there is nothing
   * for the organizer to correct, so an error would be pedantry. A tag that is
   * unusable is different — that one they need to know about.
   */
  it('collapses spellings of one concept, keeping the first label', () => {
    const result = validateTags(['NHS', '#nhs', '# NHS', 'nHs']);
    expect(result.ok).toBe(true);
    expect(keys(result)).toEqual(['nhs']);
    expect(result.value[0].label).toBe('NHS');
  });

  it('keeps distinct tags distinct and in submission order', () => {
    const result = validateTags(['NHS', 'Pets', 'School']);
    expect(keys(result)).toEqual(['nhs', 'pets', 'school']);
  });

  it('refuses more tags than an event may carry', () => {
    const many = Array.from({ length: MAX_TAGS_PER_EVENT + 1 }, (_, i) => `tag${i}`);
    const result = validateTags(many);
    expect(result.ok).toBe(false);
    expect(result.field).toBe('tags');
    expect(result.error).toMatch(new RegExp(`at most ${MAX_TAGS_PER_EVENT} tags`));
  });

  it('accepts exactly the maximum', () => {
    const exact = Array.from({ length: MAX_TAGS_PER_EVENT }, (_, i) => `tag${i}`);
    expect(validateTags(exact).ok).toBe(true);
  });

  /**
   * The count is checked on the RAW list, before normalising.
   *
   * Ten thousand tags that all collapse to one concept must still be refused on
   * the shape of the request: normalising them first is work done on behalf of a
   * caller acting in bad faith.
   */
  it('refuses an oversized list even when it would de-duplicate to one tag', () => {
    const flood = Array.from({ length: 10_000 }, () => 'nhs');
    const result = validateTags(flood);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most/);
  });

  it('refuses an enormous single tag without processing it', () => {
    const result = validateTags(['a'.repeat(500_000)]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(new RegExp(`${MAX_TAG_LENGTH} characters or fewer`));
  });

  it('refuses a non-array', () => {
    for (const value of ['nhs', 42, {}, true]) {
      const result = validateTags(value);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must be a list/);
    }
  });

  it('refuses a non-string element', () => {
    const result = validateTags(['ok', 42]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be text/);
  });

  /** The error names the offending value, so the form can teach rather than just refuse. */
  it('names the tag it rejected', () => {
    const result = validateTags(['fine', '<script>alert(1)</script>']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('<script>');
    expect(result.error).toMatch(/letters, numbers, spaces or hyphens/);
  });

  it('reports "(empty)" rather than an empty pair of quotes', () => {
    const result = validateTags(['   ']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('(empty)');
  });
});
