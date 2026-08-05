import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { parsePolicyMarkdown, parseInline, slugifyHeading, tableOfContents } from './policyMarkdown';

/**
 * Tests for the policy Markdown parser.
 *
 * The last block of tests is the one that matters most: it parses every
 * published document and asserts nothing was silently dropped. A parser that
 * handles the constructs it was written against is easy; the failure worth
 * guarding is a future policy using syntax this does not know, and a clause
 * disappearing from a legal document because the renderer skipped it.
 */

const POLICY_DIR = path.join(process.cwd(), 'docs', 'legal', 'policies');

describe('parseInline', () => {
  it('returns a single text span for plain prose', () => {
    expect(parseInline('We do not sell your data.')).toEqual([
      { type: 'text', text: 'We do not sell your data.' },
    ]);
  });

  it('extracts bold, links and code', () => {
    expect(parseInline('**Note:** see [the policy](https://example.com) and `--flag`')).toEqual([
      { type: 'bold', text: 'Note:' },
      { type: 'text', text: ' see ' },
      { type: 'link', text: 'the policy', href: 'https://example.com' },
      { type: 'text', text: ' and ' },
      { type: 'code', text: '--flag' },
    ]);
  });

  it('leaves ** inside a code span literal', () => {
    // Order-dependent: if bold were matched first, a documented literal like
    // `**` would render as emphasis and the document would misdescribe itself.
    expect(parseInline('use `**bold**` for emphasis')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: '**bold**' },
      { type: 'text', text: ' for emphasis' },
    ]);
  });

  it('keeps an unresolved placeholder visible rather than swallowing it', () => {
    // An unfilled [[TODO: …]] must reach the page. A parser that dropped it
    // would make an unpublishable document look finished.
    const spans = parseInline('Contact [[TODO: postal address]] for requests.');
    expect(spans.map(s => s.text).join('')).toContain('[[TODO: postal address]]');
  });
});

describe('slugifyHeading', () => {
  it('produces a stable anchor id', () => {
    expect(slugifyHeading('What we collect')).toBe('what-we-collect');
    expect(slugifyHeading('3. Your rights & choices')).toBe('3-your-rights-choices');
  });

  it('strips inline formatting so the id matches the visible text', () => {
    expect(slugifyHeading('**Retention** periods')).toBe('retention-periods');
    expect(slugifyHeading('The `users` table')).toBe('the-users-table');
  });

  it('never returns an empty id', () => {
    // An empty id makes two headings collide on `#`, which sends every contents
    // link to the top of the page.
    expect(slugifyHeading('***')).toBe('section');
    expect(slugifyHeading('')).toBe('section');
  });
});

describe('parsePolicyMarkdown', () => {
  it('parses headings with ids', () => {
    const blocks = parsePolicyMarkdown('## Your rights\n\nText.');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2, id: 'your-rights' });
  });

  it('joins wrapped paragraph lines into one block', () => {
    const blocks = parsePolicyMarkdown('One line\nand its continuation.\n\nSecond.');
    expect(blocks.filter(b => b.type === 'paragraph')).toHaveLength(2);
    expect(blocks[0].spans[0].text).toBe('One line and its continuation.');
  });

  it('separates ordered from unordered lists', () => {
    const blocks = parsePolicyMarkdown('- a\n- b\n\n1. one\n2. two');
    const lists = blocks.filter(b => b.type === 'list');
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ ordered: false });
    expect(lists[0].items).toHaveLength(2);
    expect(lists[1]).toMatchObject({ ordered: true });
  });

  it('does not merge a numbered list into the bulleted one above it', () => {
    const blocks = parsePolicyMarkdown('- a\n1. one');
    expect(blocks.filter(b => b.type === 'list')).toHaveLength(2);
  });

  it('parses a table and drops the alignment divider', () => {
    const blocks = parsePolicyMarkdown('| Field | Kept |\n|---|---|\n| Name | Yes |\n| IP | No |');
    const table = blocks.find(b => b.type === 'table');
    expect(table.header.map(c => c[0].text)).toEqual(['Field', 'Kept']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1].map(c => c[0].text)).toEqual(['IP', 'No']);
  });

  it('parses blockquotes and thematic breaks', () => {
    const blocks = parsePolicyMarkdown('> Important.\n\n---\n\nAfter.');
    expect(blocks.map(b => b.type)).toEqual(['quote', 'hr', 'paragraph']);
  });

  it('treats --- as a rule and not a heading', () => {
    expect(parsePolicyMarkdown('---')[0]).toEqual({ type: 'hr' });
  });

  it('renders unsupported syntax as visible text rather than dropping it', () => {
    // The load-bearing guarantee. A construct this parser does not know must
    // show up looking wrong — which gets reported — rather than vanishing.
    const blocks = parsePolicyMarkdown('~~struck~~ and ![img](x.png)');
    const text = blocks[0].spans.map(s => s.text).join('');
    expect(text).toContain('~~struck~~');
    expect(text).toContain('img');
  });

  it('returns no blocks for empty or missing input', () => {
    expect(parsePolicyMarkdown('')).toEqual([]);
    expect(parsePolicyMarkdown(null)).toEqual([]);
    expect(parsePolicyMarkdown(undefined)).toEqual([]);
  });
});

describe('tableOfContents', () => {
  it('lists h2 and h3 in document order, with the ids the headings carry', () => {
    const blocks = parsePolicyMarkdown('# Title\n\n## One\n\n### One a\n\n## Two\n\n#### Deep');
    const toc = tableOfContents(blocks);
    expect(toc).toEqual([
      { id: 'one', text: 'One', level: 2 },
      { id: 'one-a', text: 'One a', level: 3 },
      { id: 'two', text: 'Two', level: 2 },
    ]);

    // Every id in the contents list is an id a rendered heading will have,
    // because both come from the same parsed blocks.
    const headingIds = blocks.filter(b => b.type === 'heading').map(b => b.id);
    for (const entry of toc) expect(headingIds).toContain(entry.id);
  });
});

describe('every published policy document', () => {
  const files = readdirSync(POLICY_DIR).filter(f => /^\d+-.*\.md$/.test(f));

  it('finds the published documents, so the sweep cannot pass over nothing', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)('%s parses into blocks with no content lost', (file) => {
    const source = readFileSync(path.join(POLICY_DIR, file), 'utf8');
    const blocks = parsePolicyMarkdown(source);

    expect(blocks.length).toBeGreaterThan(0);

    /**
     * Content conservation: every non-blank source line that is not pure
     * structure (a `---` rule or a `|---|` table divider) must contribute text
     * to some block.
     *
     * This is the check that catches a future document using syntax the parser
     * skips. Comparing word counts rather than exact strings, because the parser
     * legitimately rewraps paragraphs and strips markup characters.
     */
    const rendered = blocks.map(function text(b) {
      if (b.type === 'hr') return '';
      if (b.type === 'table') {
        return [...b.header, ...b.rows.flat()].flat().map(s => s.text).join(' ');
      }
      if (b.type === 'list') return b.items.flat().map(s => s.text).join(' ');
      return (b.spans || []).map(s => s.text).join(' ');
    }).join(' ');

    /**
     * Reduces prose to a bag of comparable words.
     *
     * Normalising away punctuation on both sides is what keeps this measuring
     * the thing it is for. Two legitimate differences would otherwise dominate
     * the result and the test would get deleted for crying wolf: the parser
     * strips markup characters, and it splits `[Organizer Agreement](09-x.md),`
     * into a link span plus a separate `,` — so the source's `Agreement,` has no
     * single rendered token to match.
     *
     * A link's TARGET is markup, not content: `[the policy](06-foo.md)` renders
     * as "the policy", and the filename is correctly absent from the page.
     */
    const words = (text) => new Set(
      text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
    );

    const sourceProse = source
      .split('\n')
      .filter(l => l.trim() !== '')
      .filter(l => !/^-{3,}$/.test(l.trim()))
      .filter(l => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l))
      .join(' ');

    const renderedWords = words(rendered);
    const missing = [...words(sourceProse)].filter(w => !renderedWords.has(w));
    expect(
      missing.slice(0, 20),
      `${file}: these words are in the source but not in any parsed block — `
      + 'the parser is dropping content, which in a legal document means a clause '
      + 'silently disappearing from the page'
    ).toEqual([]);
  });
});
