import React, { useMemo } from 'react';

/**
 * What a reply looks like once it stops being a string.
 *
 * ── Why this exists ──
 *
 * Every assistant turn was rendered as `<p>{text}</p>`. A single paragraph node
 * holds one run of text, and CSS collapses the newlines inside it, so a reply
 * Welly deliberately wrote as
 *
 *     No worries at all! Here are a few things you can ask me:
 *     • Find open volunteer opportunities near you
 *     • Check your verified volunteer hours
 *
 * arrived on screen as one unbroken line with three bullet characters loose in
 * the middle of it. That is not a small cosmetic problem: it is the difference
 * between a reply that reads as considered and one that reads as a dump, and
 * every fixed answer in `assistant.js` and `informational.js` is written with
 * line breaks and bullets in it.
 *
 * ── Why a small parser rather than a markdown library ──
 *
 * The set of things that actually appear here is short and known: paragraphs,
 * bullets, numbered steps, a bold label, a backticked code, a link, and — from
 * the model rather than from us — the occasional fenced block. A dependency for
 * that is a dependency shipped to every student on the critical path of a page
 * that already carries an inference runtime.
 *
 * ── Why it builds React elements and never HTML ──
 *
 * The text passing through here is, in the on-device case, a language model's
 * output, and in every case is untrusted by construction. `dangerouslySetInnerHTML`
 * over model output is an injection with extra steps. Everything below returns
 * elements, so a `<script>` the model writes is a string that says `<script>`.
 *
 * ── What it is careful NOT to do ──
 *
 * It does not rewrite, normalise, or repair the text. Unmatched `**`, a stray
 * backtick, an emoji, a URL with parentheses in it and a Windows file path all
 * come out as themselves. Where a pattern does not match cleanly the source
 * characters are emitted verbatim, which is the behaviour that keeps this from
 * becoming the corrupting layer that `formatResponseText` used to be.
 */

/** Fenced blocks are split off first so nothing inside one is parsed further. */
const FENCE = /```([^\n`]*)\n?([\s\S]*?)```/g;

/**
 * Ordered so the longest delimiter is tried first: `**` before `*`, or every
 * bold marker is read as two italics wrapped around nothing. Ties on position
 * go to the earlier entry, which is what makes that ordering work.
 *
 * ── Why every delimiter requires a non-space on its inner edge ──
 *
 * Without it, `*` and `_` are emphasis wherever they appear in pairs, and the
 * characters between them are consumed. Measured before this rule:
 *
 *     "3 * 4 * 5 = 60"   rendered as   "3  4  5 = 60"
 *     "__init__"          rendered as   "init"
 *
 * Both are the parser deleting characters the model wrote, which is the one
 * thing this file exists not to do. CommonMark's rule is the same and for the
 * same reason: a delimiter followed by whitespace opens nothing, and `_`
 * between word characters is not emphasis at all — otherwise no identifier
 * survives.
 *
 * ── And why `__strong__` is not supported at all ──
 *
 * CommonMark says `__init__` is bold "init", and by the letter of the spec that
 * is correct. It is also the wrong call here: nothing Welly writes uses `__` for
 * emphasis — the fixed answers and the prompts contain none — while `__` around
 * a bare word is, in any technical string, an identifier. Rendering it as bold
 * deletes four characters from what the model said in exchange for a style
 * nobody asked for. `**` remains, and is what a model reaches for anyway.
 *
 * `_italic_` stays, because the word-boundary guard already protects `event_id`
 * and `x_1`. It also refuses a doubled delimiter on either side — without that,
 * removing the `__` rule simply handed `__init__` to the single-underscore one,
 * which ate one pair instead of two.
 */
const INLINE = [
  { name: 'code', re: /`([^`\n]+)`/ },
  { name: 'strong', re: /\*\*(\S(?:[^*\n]*\S)?)\*\*/ },
  { name: 'em', re: /\*(\S(?:[^*\n]*\S)?)\*/ },
  { name: 'em', re: /(?<![\w\\_])_(?!_)(\S(?:[^_\n]*\S)?)_(?!_|\w)/ },
  { name: 'link', re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/ },
  { name: 'url', re: /(?<![("[])\b(https?:\/\/[^\s<>)\]]+)/ },
];

/** A link Welly produced is still a link to somewhere we did not choose. */
function SafeLink({ href, children }) {
  const external = !href.startsWith(window.location.origin);
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
    >
      {children}
    </a>
  );
}

/**
 * One line of text into an array of nodes.
 *
 * Finds the EARLIEST match among all the inline patterns rather than applying
 * them in sequence, so `**bold** and \`code\`` and `\`code\` and **bold**` parse
 * the same way. Applying them one after another instead would let an earlier
 * pattern reach inside a later one's span — the classic failure where a `*` in
 * a code sample turns the rest of the sentence italic.
 */
function parseInline(text, keyPrefix) {
  const out = [];
  let rest = text;
  let n = 0;

  while (rest) {
    let best = null;

    for (const { name, re } of INLINE) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { name, m };
    }

    if (!best) {
      out.push(rest);
      break;
    }

    const { name, m } = best;
    if (m.index > 0) out.push(rest.slice(0, m.index));

    const key = `${keyPrefix}-i${n++}`;
    if (name === 'code') out.push(<code key={key}>{m[1]}</code>);
    else if (name === 'strong') out.push(<strong key={key}>{m[1]}</strong>);
    else if (name === 'em') out.push(<em key={key}>{m[1]}</em>);
    else if (name === 'link') out.push(<SafeLink key={key} href={m[2]}>{m[1]}</SafeLink>);
    else if (name === 'url') out.push(<SafeLink key={key} href={m[1]}>{m[1]}</SafeLink>);

    rest = rest.slice(m.index + m[0].length);
  }

  return out;
}

/** Lines inside one paragraph, with the single newlines kept as breaks. */
function paragraphNodes(lines, keyPrefix) {
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br${i}`} />);
    out.push(...parseInline(line, `${keyPrefix}-l${i}`));
  });
  return out;
}

const BULLET = /^(\s*)([-*•])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,2})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,4})\s+(.*)$/;

/**
 * A block of non-fenced text into paragraphs, lists and headings.
 *
 * Consecutive bullet (or numbered) lines are gathered into one list, which is
 * the whole reason a reply with four bullets reads as four bullets rather than
 * as four paragraphs that happen to start with a dash.
 */
function parseBlocks(text, keyPrefix) {
  const lines = text.split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `${keyPrefix}-p${blocks.length}`;
    blocks.push(<p key={key}>{paragraphNodes(paragraph, key)}</p>);
    paragraph = [];
  };

  /**
   * A gathered list into elements, nesting by the indentation each line carried.
   *
   * Flattening was the previous behaviour, and it is a structural edit: a reply
   * written as
   *
   *     - Shifts
   *       - Morning
   *       - Afternoon
   *     - Hours
   *
   * arrived as four siblings, which says something different from what the
   * model wrote. Depth is taken from the leading whitespace, and a level only
   * opens where one genuinely appears — a list with no indentation produces
   * exactly the flat `<ul>` it did before.
   */
  const renderItems = (items, key) => {
    const nodes = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      /* Everything more deeply indented than this item belongs inside it. */
      const children = [];
      while (i + 1 < items.length && items[i + 1].depth > item.depth) {
        children.push(items[i + 1]);
        i += 1;
      }
      const Tag = children.length && children[0].ordered ? 'ol' : 'ul';
      const childStart = children.length && children[0].ordered ? children[0].number : null;
      nodes.push(
        <li key={`${key}-${i}`}>
          {parseInline(item.text, `${key}-${i}`)}
          {children.length > 0 && (
            <Tag className="welly-md-list" {...(childStart > 1 ? { start: childStart } : {})}>
              {renderItems(children, `${key}-${i}-n`)}
            </Tag>
          )}
        </li>,
      );
    }
    return nodes;
  };

  const flushList = () => {
    if (!list) return;
    const key = `${keyPrefix}-list${blocks.length}`;
    const Tag = list.ordered ? 'ol' : 'ul';
    /**
     * A list that does not begin at 1 says so.
     *
     * `<ol>` always counts from 1, so a reply whose first numbered line is "2."
     * rendered as "1." — the numbers on screen disagreeing with the numbers the
     * model wrote. That happens for real: the model occasionally emits a stray
     * character before the first item, which stops it parsing as one, and the
     * remaining items then formed a list silently renumbered from the top.
     */
    const start = list.ordered ? list.items[0]?.number : null;
    blocks.push(
      <Tag key={key} className="welly-md-list" {...(start > 1 ? { start } : {})}>
        {renderItems(list.items, key)}
      </Tag>,
    );
    list = null;
  };

  /**
   * A blank line inside a list does not end it.
   *
   * It used to. Qwen2.5-0.5B — the model a student actually gets — writes a
   * numbered list with a blank line between the items, and every blank line
   * flushed the list, so three items became three separate `<ol>` elements and
   * the reader saw "1." three times instead of "1. 2. 3.".
   *
   * Markdown calls this a loose list and treats it as one list, which is also
   * the only reading that matches what the model meant. The blank line is
   * remembered rather than acted on, and only ends the list if what follows is
   * not another item of the same kind.
   */
  let blankPending = false;

  for (const line of lines) {
    if (!line.trim()) {
      if (list) { blankPending = true; } else { flushParagraph(); }
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushList();
      flushParagraph();
      const key = `${keyPrefix}-h${blocks.length}`;
      /* Always a `<p>`, never an `<h3>`. The transcript sits inside the page's
         heading outline and a reply is not a section of it — `headingLevels.test.js`
         is what holds that rule for the rest of the application. The visual
         weight is a class. */
      blocks.push(<p key={key} className="welly-md-heading">{parseInline(heading[2], key)}</p>);
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (bullet || numbered) {
      flushParagraph();
      const match = bullet || numbered;
      const ordered = Boolean(numbered);
      const depth = match[1].replace(/\t/g, '  ').length;

      /* A change of list TYPE at the top level starts a new list; the same
         change one level in is just a nested list of the other kind, which
         `renderItems` decides from the children it is given. */
      if (!list || (depth === 0 && list.ordered !== ordered)) {
        flushList();
        list = { ordered, items: [] };
      }
      blankPending = false;
      list.items.push({ depth, ordered, text: match[3], number: ordered ? Number(match[2]) : null });
      continue;
    }

    /* Not a list item, and a blank line came before it — the list is over. */
    if (blankPending) {
      blankPending = false;
      flushList();
    }

    flushList();
    paragraph.push(line);
  }

  blankPending = false;
  flushList();
  flushParagraph();
  return blocks;
}

/**
 * Render one assistant or user message.
 *
 * `streaming` is passed through only so a partially-arrived reply can carry the
 * caret; the parse is the same either way. Parsing mid-stream is deliberate —
 * a half-finished list should already look like a list — and it is safe because
 * an unclosed marker falls through to verbatim text rather than swallowing the
 * rest of the reply.
 */
export default function WellyMessage({ text, streaming = false }) {
  const content = useMemo(() => {
    const source = typeof text === 'string' ? text : '';
    if (!source) return [];

    const out = [];
    let last = 0;
    let n = 0;

    FENCE.lastIndex = 0;
    let match;
    while ((match = FENCE.exec(source)) !== null) {
      const before = source.slice(last, match.index);
      if (before.trim()) out.push(...parseBlocks(before, `b${n}`));
      out.push(
        <pre key={`code${n}`} className="welly-md-pre">
          <code>{match[2].replace(/\n$/, '')}</code>
        </pre>,
      );
      last = match.index + match[0].length;
      n += 1;
    }

    /**
     * A fence that has been opened and not yet closed, which is the normal
     * state of a code block halfway through streaming. Rendering the remainder
     * as a code block keeps it from flashing through as paragraphs of markdown
     * source and then rearranging itself when the closing fence arrives.
     */
    const tail = source.slice(last);
    const openFence = /```([^\n`]*)\n?([\s\S]*)$/.exec(tail);
    if (openFence) {
      const before = tail.slice(0, openFence.index);
      if (before.trim()) out.push(...parseBlocks(before, `b${n}`));
      out.push(
        <pre key={`code-open${n}`} className="welly-md-pre">
          <code>{openFence[2]}</code>
        </pre>,
      );
    } else if (tail.trim()) {
      out.push(...parseBlocks(tail, `b${n}`));
    }

    return out;
  }, [text]);

  return (
    <div className={`welly-md${streaming ? ' is-streaming' : ''}`}>
      {content}
    </div>
  );
}
