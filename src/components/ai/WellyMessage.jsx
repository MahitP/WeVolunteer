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

/* Ordered so the longest delimiter is tried first: `**` before `*`, or every
   bold marker is read as two italics wrapped around nothing. */
const INLINE = [
  { name: 'code', re: /`([^`\n]+)`/ },
  { name: 'strong', re: /\*\*([^*\n]+)\*\*/ },
  { name: 'strong', re: /__([^_\n]+)__/ },
  { name: 'em', re: /\*([^*\n]+)\*/ },
  /* `_` only between word boundaries: snake_case_names are not emphasis, and a
     model writing `event_id` should not lose the underscores. */
  { name: 'em', re: /(?<![\w\\])_([^_\n]+)_(?!\w)/ },
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

const BULLET = /^\s*([-*•])\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/;
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

  const flushList = () => {
    if (!list) return;
    const key = `${keyPrefix}-list${blocks.length}`;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={key} className="welly-md-list">
        {list.items.map((item, i) => (
          <li key={`${key}-${i}`}>{parseInline(item, `${key}-${i}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushList();
      flushParagraph();
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
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet || numbered)[2]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

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
