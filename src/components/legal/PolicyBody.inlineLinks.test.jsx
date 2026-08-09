import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PolicyBody from './PolicyBody';

/**
 * Two places where a link in a published policy printed as raw Markdown.
 *
 * Both were live in the published set and both were found the same way: by
 * comparing what the source looks like against what the renderer actually
 * produces, which is now a build-failing guard in
 * `server/legalContent.test.js`. Neither was visible to any test that only
 * asked whether the page rendered.
 *
 *   1. A link on the WRAPPED line of a list item. Continuation lines were
 *      appended as raw text, so whether a link worked depended on where the
 *      author happened to break the line. Three of the Terms' safety bullets
 *      ended up printing `[Youth Safety Guidelines](/legal/...)` at the reader.
 *
 *   2. A link INSIDE a bold run. The inline matcher takes the leftmost
 *      construct, so `**… [Data Deletion Policy](/legal/…) …**` matched as bold
 *      and kept the link as text. That is the Privacy Policy's "Your choices"
 *      table, on the row somebody reads while deciding to delete their account.
 *
 * Asserted against the rendered DOM rather than the parsed blocks, because the
 * question is what a reader sees: an anchor with the right href, and no square
 * bracket anywhere near it.
 */
describe('PolicyBody renders links wherever they appear', () => {
  it('renders a link on the wrapped line of a list item', () => {
    render(<PolicyBody markdown={[
      '- **Follow the safety rules.** At least two adults present at all times,',
      '  and the supervision your activity requires. See the',
      '  [Youth Safety Guidelines](/legal/youth-safety-guidelines).',
    ].join('\n')} />);

    const link = screen.getByRole('link', { name: 'Youth Safety Guidelines' });
    expect(link).toHaveAttribute('href', '/legal/youth-safety-guidelines');
    expect(screen.getByRole('listitem')).not.toHaveTextContent('](/legal/');
  });

  it('renders a link nested inside a bold run, and keeps it bold', () => {
    render(<PolicyBody markdown={
      '**Please read the [Data Deletion Policy](/legal/data-deletion-policy) first.**'
    } />);

    const link = screen.getByRole('link', { name: 'Data Deletion Policy' });
    expect(link).toHaveAttribute('href', '/legal/data-deletion-policy');
    expect(link.closest('strong')).not.toBeNull();
  });

  it('renders a code span inside a bold run as code, not as backticks', () => {
    render(<PolicyBody markdown={'**Set `DEMO_MODE` to false.**'} />);

    const code = screen.getByText('DEMO_MODE');
    expect(code.tagName).toBe('CODE');
    expect(screen.getByRole('paragraph')).not.toHaveTextContent('`');
  });

  it('leaves ordinary bold as a single run of text', () => {
    // The nested path is opt-in: plain bold must not start carrying extra
    // wrappers, because every other consumer of these spans reads `text`.
    render(<PolicyBody markdown={'**We do not sell your data.**'} />);

    const strong = screen.getByText('We do not sell your data.');
    expect(strong.tagName).toBe('STRONG');
    expect(strong.querySelector('a, code')).toBeNull();
  });

  it('gives every heading a focus target for the deep links that point at it', () => {
    // `LegalDocument` focuses the heading a `#fragment` names. A heading is not
    // focusable by default, so without this the scroll would arrive and the
    // keyboard user would not.
    render(<PolicyBody markdown={'## How long we keep things\n\nUntil you ask.'} />);

    const heading = screen.getByRole('heading', { name: 'How long we keep things' });
    expect(heading).toHaveAttribute('id', 'how-long-we-keep-things');
    expect(heading).toHaveAttribute('tabindex', '-1');
  });
});
