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

/**
 * URL schemes a policy link may use.
 *
 * ── Why this exists now and did not before ──
 *
 * The header above argues that no document text ever becomes markup, and that
 * is still true of text. It was never true of a link TARGET: the renderer puts
 * `span.href` straight into an anchor's `href`, and `[read this](javascript:…)`
 * is a script that runs when a reader clicks it — on `/legal/:slug`, which is
 * unauthenticated and is where the signup form sends people.
 *
 * Until v1.4 the only source of policy text was this repository, so the gap was
 * theoretical and the file said as much. The Legal Center editor makes policy
 * text something an account can write, so it is not theoretical any more.
 *
 * Two layers refuse it. `validateBody` in server/legalStore.js rejects the save,
 * which is where an owner gets a useful error message. This one is the backstop
 * for everything that never passes through a save: the ten documents on disk,
 * any row written before this check existed, and whatever renders policy
 * Markdown next.
 */
export const ALLOWED_LINK_SCHEMES = Object.freeze(['http://', 'https://', 'mailto:']);

/**
 * A host no real link can resolve to, used to ask the URL parser what a
 * slash-leading href ACTUALLY means. `.invalid` is reserved by RFC 2606
 * precisely so it can never be registered.
 */
const RESOLUTION_SENTINEL = 'https://policy.invalid';

/**
 * True for a link a policy is allowed to contain.
 *
 * A bare `#` is refused because it scrolls nowhere and reads as a dead control.
 *
 * ── Why a slash-leading href is RESOLVED rather than prefix-matched ──
 *
 * This used to be `return !value.startsWith('//')` — refuse the
 * protocol-relative form, treat everything else beginning with `/` as an
 * internal path. That is not what a browser does. In the WHATWG URL spec's
 * relative-slash state, `\` and `/` are interchangeable for special schemes, so
 * a SECOND character of `\` opens an authority just as a second `/` does:
 *
 *     new URL('/\\evil.example.com/phish', 'https://wevolunteer.example/')
 *       -> https://evil.example.com/phish
 *
 * Every layer read it as internal. `validateBody` stored it, this function
 * passed it, and `PolicyBody`'s `external` test (`/^https?:\/\//`) was false —
 * so the anchor rendered with no `target="_blank"` and, worse, no
 * `rel="noopener noreferrer"`: same tab, full `Referer`. On `/legal/:slug`,
 * which is served unauthenticated and is where signup sends children.
 *
 * Asking the parser removes the whole class rather than the one spelling of it.
 * `//host`, `/\host`, `/\/host` and anything else that forms an authority all
 * resolve to an origin that is not the sentinel, and are refused by the same
 * line. A denylist of prefixes could only ever cover the tricks somebody had
 * already thought of.
 */
export function isSafeHref(href) {
  if (typeof href !== 'string') return false;
  const value = href.trim();
  if (value === '') return false;

  if (value.startsWith('#')) return value.length > 1;
  if (value.startsWith('/')) {
    try {
      return new URL(value, `${RESOLUTION_SENTINEL}/`).origin === RESOLUTION_SENTINEL;
    } catch {
      return false;
    }
  }

  const lower = value.toLowerCase();
  return ALLOWED_LINK_SCHEMES.some(scheme => lower.startsWith(scheme));
}

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

  // Code first, then link, then bold, then italic. Each alternative captures its
  // own payload. Italic is a single asterisk with no space just inside it and no
  // word character just outside it, so `5*3 and 2*4` and `a * b` stay literal.
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|((?<![\w*])\*(?![\s*])[^*]+?(?<![\s*])\*(?![\w*]))/;

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
    } else if (!token.startsWith('**')) {
      /* Italic, re-parsed for a nested link or code span exactly as bold is
         below; `text` is kept so every caller reading `s.text` still works. */
      const inner = token.slice(1, -1);
      const nested = parseInline(inner);
      const flat = nested.length <= 1 && nested.every(sp => sp.type === 'text');
      spans.push(flat ? { type: 'italic', text: inner } : { type: 'italic', text: inner, spans: nested });
    } else {
      /**
       * Bold can contain a link or a code span, so its payload is re-parsed.
       *
       * The alternation above picks the LEFTMOST construct, so
       * `**Please read the [Data Deletion Policy](/legal/...) first**` matched
       * as bold and the link inside it became literal text. That is not a
       * hypothetical: it is the Privacy Policy's "Your choices" table, on the
       * row a reader lands on while deciding to delete their account — the one
       * row where the pointer to the Data Deletion Policy has to work.
       *
       * `text` is kept and `spans` added only when the payload really is
       * nested, so ordinary bold keeps the flat shape every caller already
       * handles and only the nested case costs a renderer branch.
       */
      const inner = token.slice(2, -2);
      const nested = parseInline(inner);
      const flat = nested.length <= 1 && nested.every(s => s.type === 'text');
      spans.push(flat ? { type: 'bold', text: inner } : { type: 'bold', text: inner, spans: nested });
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
      /* `- [ ] …` is a printed confirm list in the three agreements. On screen
         the real checkboxes follow it, so the box is dropped and the sentence
         kept; a literal "[ ]" above them read as a broken control. */
      const text = (bullet ? bullet[1] : numbered[2]).trim().replace(/^\[[ xX]\]\s+/, '');
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(parseInline(text));
      continue;
    }

    /**
     * A continuation line of a list item, indented under it.
     *
     * Parsed inline, exactly like the item's first line. It used to be appended
     * as a raw text span, which made a wrapped list item the one place in the
     * document where Markdown did not work: five cross-document links in the
     * published set — three in the Terms, one in the Privacy Policy, one in the
     * Youth Safety Guidelines — happened to fall past the wrap point and were
     * printed to readers as `[Youth Safety Guidelines](/legal/...)`.
     *
     * That is worse than it looks for these documents specifically. The link
     * that failed to render is the one telling a reader where the safety rules
     * are, so the failure lands on the sentence that was trying to send them
     * somewhere. It also inverts this parser's stated bargain: unsupported
     * syntax is meant to stay visible so somebody files a bug, not supported
     * syntax silently degrading because of where a line happened to wrap.
     *
     * `server/legalContent.test.js` now fails the build on any link-shaped
     * construct the renderer does not turn into a link, so this cannot come
     * back quietly.
     */
    if (list && /^\s{2,}\S/.test(raw)) {
      const item = list.items[list.items.length - 1];
      item.push(...parseInline(` ${line.trim()}`));
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
