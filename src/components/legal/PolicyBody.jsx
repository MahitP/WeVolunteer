import React from 'react';
import { parsePolicyMarkdown, isSafeHref } from '../../utils/policyMarkdown';

/**
 * Renders a parsed policy document as React elements.
 *
 * ── No HTML strings, anywhere in this path ──
 *
 * The parser produces plain objects and this file turns them into elements, so
 * every piece of document text lands in a React text node and is escaped by
 * React. There is no `dangerouslySetInnerHTML` and no way to add one without
 * changing the shape of both files, which matters more than it looks: the
 * moderator views coming later display user-submitted report text, and if
 * "render Markdown" existed here as an HTML-injection helper, that is the helper
 * somebody would reach for.
 *
 * ── Headings carry ids ──
 *
 * `##` and `###` get the ids the contents list links to, and the ids come from
 * the same parsed blocks the list is built from — not a second slugify pass over
 * the source. Two independent derivations is how a contents list ends up with
 * links that scroll nowhere.
 *
 * External links get `rel="noopener noreferrer"`. Policy text is repo-controlled
 * so this is not defending against a hostile document; it is defending against
 * the next document, and against `window.opener` reaching a page that renders
 * the terms.
 */

function Spans({ spans }) {
  return spans.map((span, i) => {
    if (span.type === 'bold') {
      /* A bold run may contain a link or a code span — see parseInline. `spans`
         is present only for that case, so plain bold stays a single text node. */
      return <strong key={i}>{span.spans ? <Spans spans={span.spans} /> : span.text}</strong>;
    }
    if (span.type === 'italic') return <em key={i}>{span.spans ? <Spans spans={span.spans} /> : span.text}</em>;
    if (span.type === 'code') return <code key={i} className="policy-code">{span.text}</code>;
    if (span.type === 'link') {
      /**
       * An unsafe target renders as its own link text, not as a link.
       *
       * Degrading rather than dropping, for the reason the parser's header
       * gives about unsupported syntax: a clause that silently disappears is
       * the failure mode worth designing against. The reader still sees every
       * word the document said; what they cannot do is click it.
       */
      if (!isSafeHref(span.href)) {
        return <React.Fragment key={i}>{span.text}</React.Fragment>;
      }
      const external = /^https?:\/\//.test(span.href) || span.href.startsWith('mailto:');
      return (
        <a
          key={i}
          className="policy-link"
          href={span.href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {span.text}
        </a>
      );
    }
    return <React.Fragment key={i}>{span.text}</React.Fragment>;
  });
}

function Block({ block }) {
  switch (block.type) {
    case 'heading': {
      /**
       * `h1` in the source becomes `h2` on the page. The page already renders
       * the document title as its own `h1`, and a second one would give the
       * document two top-level headings — which reads to a screen reader as two
       * documents. Levels below that shift by the same one step so the outline
       * stays ordered rather than jumping h1 → h3.
       */
      const Tag = `h${Math.min(block.level + 1, 6)}`;
      /**
       * `tabIndex={-1}` makes the heading a focus target without putting it in
       * the tab order.
       *
       * A fragment link — `/legal/privacy-policy#how-long-we-keep-things`, or
       * an entry in the contents list — has to land a KEYBOARD user on the
       * section, not just scroll a sighted one to it. Scrolling alone leaves
       * the focus ring at the top of the document, so the next Tab walks the
       * page from the beginning and a screen reader keeps reading whatever it
       * was on. `LegalDocument.jsx` focuses this element after the document
       * loads; a heading is not focusable by default, and setting the attribute
       * here rather than mutating the DOM from that effect keeps the property
       * declared where the element is.
       */
      return <Tag id={block.id} tabIndex={-1} className="policy-heading"><Spans spans={block.spans} /></Tag>;
    }
    case 'paragraph':
      return <p className="policy-paragraph"><Spans spans={block.spans} /></p>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag className="policy-list">
          {block.items.map((item, i) => <li key={i}><Spans spans={item} /></li>)}
        </Tag>
      );
    }
    case 'quote':
      return <blockquote className="policy-quote"><Spans spans={block.spans} /></blockquote>;
    case 'hr':
      return <hr className="policy-rule" />;
    case 'table':
      return (
        // Its own scroll container: a wide table must not make the page scroll
        // sideways on a phone, which is where most of these will be read.
        <div className="policy-table-scroll">
          <table className="policy-table">
            <thead>
              <tr>{block.header.map((cell, i) => <th key={i} scope="col"><Spans spans={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j}><Spans spans={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export default function PolicyBody({ markdown }) {
  const blocks = React.useMemo(() => parsePolicyMarkdown(markdown), [markdown]);
  return (
    <div className="policy-body">
      {blocks.map((block, i) => <Block key={i} block={block} />)}
    </div>
  );
}
