import { describe, it, expect } from 'vitest';
import { buildExcerpt, addedSentences, sentences, publishedPortion } from './legalExcerpt.js';

/**
 * The excerpt shown when a legal document changes.
 *
 * The property under test throughout is *honesty*: the quote must be something
 * the document actually now says, must not be something it already said, and
 * must never be manufactured when nothing quotable was added.
 */

const DOC = (body) => `## Specification\ninternal drafting notes\n\n## Draft\n${body}`;

describe('publishedPortion', () => {
  it('drops the internal specification block', () => {
    /* Quoting the drafting brief would put internal reasoning in front of a
       user, and it is not the text whose hash the acceptance record pins. */
    const text = publishedPortion(DOC('We keep your data for one year.'));
    expect(text).toContain('We keep your data');
    expect(text).not.toContain('internal drafting notes');
  });

  it('returns the whole thing when there is no marker', () => {
    expect(publishedPortion('Just a body.')).toBe('Just a body.');
  });

  it('survives a non-string', () => {
    expect(publishedPortion(null)).toBe('');
  });
});

describe('sentences', () => {
  it('splits on sentence boundaries', () => {
    expect(sentences('We store data. We delete it after a year.')).toEqual([
      'We store data.',
      'We delete it after a year.',
    ]);
  });

  it('does not split on an abbreviation', () => {
    /* Over-splitting produces fragments that read as broken text; the cost of
       under-splitting is only a slightly longer quote. */
    expect(sentences('Contact the U.S. office for help.')).toHaveLength(1);
  });

  it('drops heading lines rather than folding them into the next sentence', () => {
    /**
     * Found in a browser. Stripping only the `#` leaves the heading text as a
     * fragment that joins the sentence after it, so this was quoted as
     * "What we collect We only collect what a school needs." — a sentence the
     * document does not contain. A heading labels prose; it is not prose.
     */
    const out = sentences('## What we collect\n\nWe only collect what a school needs.');
    expect(out).toEqual(['We only collect what a school needs.']);
  });

  it('strips markdown decoration', () => {
    const out = sentences('## Heading\n\nWe **never** sell your [data](https://x.test).');
    expect(out.join(' ')).not.toMatch(/[#*[\]()]|https/);
    expect(out.join(' ')).toContain('We never sell your data.');
  });
});

describe('addedSentences', () => {
  it('finds what is new', () => {
    const before = DOC('We store data.');
    const after = DOC('We store data. We now also store your school.');
    expect(addedSentences(before, after)).toEqual(['We now also store your school.']);
  });

  it('reports nothing when a paragraph merely MOVED', () => {
    /**
     * The property a positional diff gets wrong. Reordering two sections
     * changes every line's position and no word of the document — a diff would
     * call that a rewrite and quote a sentence that has not changed.
     */
    const before = DOC('First point.\n\nSecond point.');
    const after = DOC('Second point.\n\nFirst point.');
    expect(addedSentences(before, after)).toEqual([]);
  });

  it('ignores case and punctuation drift', () => {
    const before = DOC('We store your data.');
    const after = DOC('We store your data!');
    expect(addedSentences(before, after)).toEqual([]);
  });

  it('ignores rewrapping', () => {
    /* A file reflowed to a different column width is not a legal change. */
    const before = DOC('We store your data for exactly one year and then remove it.');
    const after = DOC('We store your data for exactly\none year and then remove it.');
    expect(addedSentences(before, after)).toEqual([]);
  });

  it('treats a first publication as entirely new', () => {
    expect(addedSentences(null, DOC('A brand new policy.'))).toEqual(['A brand new policy.']);
  });
});

describe('buildExcerpt', () => {
  const LONG = 'We now retain volunteer attendance records for three school years rather than one.';

  it('quotes a sentence the document actually now contains', () => {
    const out = buildExcerpt(DOC('Old text here.'), DOC(`Old text here. ${LONG}`));
    expect(out.text).toBe(LONG);
  });

  it('prefers a sentence long enough to mean something', () => {
    /* A four-word heading fragment is technically new and tells a reader
       nothing. */
    const out = buildExcerpt(DOC('Old.'), DOC(`Old. Scope. ${LONG}`));
    expect(out.text).toBe(LONG);
  });

  it('reports how many changes there were', () => {
    const out = buildExcerpt(DOC('Old.'), DOC(`Old. ${LONG} And another sentence entirely here.`));
    expect(out.changeCount).toBe(2);
    expect(out.isSample).toBe(true);
  });

  it('is not a sample when it is the only change', () => {
    const out = buildExcerpt(DOC('Old.'), DOC(`Old. ${LONG}`));
    expect(out.changeCount).toBe(1);
    expect(out.isSample).toBe(false);
  });

  it('returns no text when nothing was added', () => {
    /**
     * A deletion-only change is real and must still notify — but inventing a
     * quote for it would put words in the document's mouth. The modal says the
     * wording was revised instead.
     */
    const out = buildExcerpt(DOC('We keep data. We share it with partners.'), DOC('We keep data.'));
    expect(out.text).toBeNull();
    expect(out.changeCount).toBe(0);
  });

  it('clips a very long sentence at a word boundary and marks it', () => {
    const huge = `We ${'very '.repeat(90)}long sentence.`;
    const out = buildExcerpt(DOC('Old.'), DOC(`Old. ${huge}`));

    expect(out.text.length).toBeLessThanOrEqual(281);
    expect(out.text.endsWith('…')).toBe(true);

    /**
     * Cut between words, never mid-word — a half word reads as corruption
     * rather than as an abbreviation.
     *
     * Asserted as "what remains is a whole-word prefix of the original",
     * because that is the actual property. A first draft asserted that the
     * character before the ellipsis was whitespace, which is the opposite of
     * correct: `very…` is a clean cut and `ver…` is the broken one.
     */
    const kept = out.text.slice(0, -1);
    expect(huge.startsWith(kept)).toBe(true);
    expect(huge[kept.length]).toBe(' ');
  });

  it('never quotes the internal specification block', () => {
    const before = '## Specification\nold notes\n\n## Draft\nBody.';
    const after = '## Specification\nWE SHOULD PROBABLY DELETE ALL THE DATA\n\n## Draft\nBody.';
    expect(buildExcerpt(before, after).text).toBeNull();
  });
});
