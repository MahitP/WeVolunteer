/**
 * Parses the Markdown subset the published policies actually use.
 *
 * ── Why this exists instead of `react-markdown` ──
 *
 * Two reasons, and the second is the real one.
 *
 * The first is proportion: this renders ten documents whose syntax is known and
 * measured — headings, lists, tables, blockquotes, rules, and inline bold, links
 * and code spans. A general Markdown pipeline plus a sanitiser is a large
 * dependency tree to add to a bundle that currently has eight runtime packages,
 * in order to support a syntax surface this file covers in a couple of hundred
 * lines.
 *
 * The second is the shape of the output. Every general renderer's fast path
 * produces an HTML string, and consuming an HTML string means
 * `dangerouslySetInnerHTML`. The legal pages are public and the moderator views
 * coming later display user-submitted text, so "we render Markdown by injecting
 * HTML" is a pattern this codebase should not establish anywhere — once it is in
 * the tree, the next person renders a report description through it.
 *
 * So this produces a block AST of plain objects. The renderer turns those into
 * React elements, and React escapes text nodes. There is no code path from a
 * document's bytes to markup, which means the escaping cannot be forgotten
 * rather than merely being present today.
 *
 * ── Deliberately not a Markdown implementation ──
 *
 * Unsupported syntax degrades to visible text rather than being dropped: an
 * unrecognised construct shows up in the document looking wrong, which is a bug
 * report. Silently swallowing it hides a clause, and a clause missing from a
 * policy nobody noticed is the failure mode worth designing against.
 *
 * `src/utils/policyMarkdown.test.js` pins that behaviour, and a test asserts
 * this parser handles every construct present in the published set — so a future
 * document using something new fails the build instead of rendering oddly.
 */

/** Heading text -> a stable anchor id, for deep links and the contents list. */
export function slugifyHeading(text) {
  return String(text)
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'section';
}

/**
 * Splits one line of inline Markdown into spans.
 *
 * Order matters: code spans are matched before bold, so `**` inside backticks
 * stays literal. A policy that documents a placeholder like `[[TODO: ...]]`
 * inside backticks must render it verbatim rather than as emphasis.
 */
export function parseInline(line) {
  const spans = [];
  let rest = String(line);

  // Code first, then link, then bold. Each alternative captures its own payload.
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)/;

  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) {
      spans.push({ type: 'text', text: rest });
      break;
    }

    if (match.index > 0) spans.push({ type: 'text', text: rest.slice(0, match.index) });

    const [token] = match;
    if (token.startsWith('`')) {
      spans.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      spans.push({
        type: 'link',
        text: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    } else {
      spans.push({ type: 'bold', text: token.slice(2, -2) });
    }

    rest = rest.slice(match.index + token.length);
  }

  return spans.filter(s => s.type !== 'text' || s.text.length > 0);
}

/** `| a | b |` -> ['a', 'b']. Leading/trailing pipes are optional. */
function tableCells(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(c => c.trim());
}

/** A `|---|:--:|` alignment row, which carries no content. */
function isTableDivider(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

/**
 * Parses a whole document into blocks.
 *
 * Line-oriented and single-pass. Blank lines end paragraphs, lists and quotes;
 * everything else is decided by the line's own prefix, which is why the
 * unsupported-syntax-becomes-text guarantee holds — an unmatched line is a
 * paragraph line.
 */
export function parsePolicyMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let paragraph = [];
  let quote = [];
  let list = null;
  let table = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      blocks.push({ type: 'quote', spans: parseInline(quote.join(' ')) });
      quote = [];
    }
  };
  const flushList = () => {
    if (list) { blocks.push(list); list = null; }
  };
  const flushTable = () => {
    if (table) { blocks.push(table); table = null; }
  };
  const flushAll = () => { flushParagraph(); flushQuote(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (line.trim() === '') { flushAll(); continue; }

    // Thematic break. Checked before headings because `---` is neither.
    if (/^-{3,}$/.test(line.trim())) { flushAll(); blocks.push({ type: 'hr' }); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const text = heading[2].trim();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        spans: parseInline(text),
        // The id is derived from the raw text, so it survives inline formatting
        // inside a heading — several policy headings contain bold or code.
        id: slugifyHeading(text),
        text,
      });
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph(); flushList(); flushTable();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    // A table row. The divider is consumed as structure, not content.
    if (/^\s*\|/.test(line)) {
      flushParagraph(); flushQuote(); flushList();
      if (isTableDivider(line)) continue;
      const cells = tableCells(line);
      if (!table) {
        table = { type: 'table', header: cells.map(parseInline), rows: [] };
      } else {
        table.rows.push(cells.map(parseInline));
      }
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph(); flushQuote(); flushTable();
      const ordered = Boolean(numbered);
      const text = (bullet ? bullet[1] : numbered[2]).trim();
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(parseInline(text));
      continue;
    }

    // A continuation line of a list item, indented under it.
    if (list && /^\s{2,}\S/.test(raw)) {
      const item = list.items[list.items.length - 1];
      item.push({ type: 'text', text: ` ${line.trim()}` });
      continue;
    }

    flushQuote(); flushList(); flushTable();
    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

/**
 * The contents list: every `##` and `###`, in document order.
 *
 * Derived from the parsed blocks rather than a second scan of the source, so the
 * ids in the contents list are necessarily the ids the rendered headings carry.
 * A separately-computed list is how a table of contents ends up with links that
 * scroll nowhere.
 */
export function tableOfContents(blocks) {
  return blocks
    .filter(b => b.type === 'heading' && (b.level === 2 || b.level === 3))
    .map(b => ({ id: b.id, text: b.text, level: b.level }));
}
