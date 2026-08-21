import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import WellyMessage from './WellyMessage';

/**
 * The renderer's contract is narrow and mostly negative: show the structure the
 * reply already has, and do not alter a single character of its content.
 */

function html(text, props = {}) {
  const { container } = render(<WellyMessage text={text} {...props} />);
  return container.querySelector('.welly-md');
}

describe('WellyMessage structure', () => {
  it('renders a single line as one paragraph', () => {
    const el = html('You have 28 verified hours.');
    expect(el.querySelectorAll('p')).toHaveLength(1);
    expect(el.textContent).toBe('You have 28 verified hours.');
  });

  it('splits on blank lines into separate paragraphs', () => {
    const el = html('First thought.\n\nSecond thought.');
    const paragraphs = [...el.querySelectorAll('p')].map(p => p.textContent);
    expect(paragraphs).toEqual(['First thought.', 'Second thought.']);
  });

  it('keeps a single newline as a line break inside one paragraph', () => {
    /* This is the case that used to collapse: `<p>{text}</p>` put both lines in
       one text node and CSS folded the newline into a space. */
    const el = html('Line one\nLine two');
    expect(el.querySelectorAll('p')).toHaveLength(1);
    expect(el.querySelectorAll('br')).toHaveLength(1);
  });

  it('gathers consecutive bullets into one list', () => {
    const el = html('Here is what I found:\n\n• Food Bank\n• Library Help\n• Park cleanup');
    const items = [...el.querySelectorAll('ul li')].map(li => li.textContent);
    expect(items).toEqual(['Food Bank', 'Library Help', 'Park cleanup']);
    expect(el.querySelectorAll('ul')).toHaveLength(1);
  });

  it('handles dash and asterisk bullets the same way', () => {
    expect([...html('- one\n- two').querySelectorAll('li')]).toHaveLength(2);
    expect([...html('* one\n* two').querySelectorAll('li')]).toHaveLength(2);
  });

  it('renders numbered steps as an ordered list', () => {
    const el = html('1. Apply\n2. Attend\n3. Get credited');
    expect([...el.querySelectorAll('ol li')].map(li => li.textContent))
      .toEqual(['Apply', 'Attend', 'Get credited']);
  });

  it('does not merge a bulleted list into a numbered one', () => {
    const el = html('- a\n- b\n1. c\n2. d');
    expect(el.querySelectorAll('ul')).toHaveLength(1);
    expect(el.querySelectorAll('ol')).toHaveLength(1);
  });

  it('renders a fenced code block verbatim, indentation included', () => {
    const el = html('Try this:\n\n```js\nif (hours) {\n    credit(hours);\n}\n```');
    const code = el.querySelector('pre code');
    expect(code.textContent).toBe('if (hours) {\n    credit(hours);\n}');
  });

  it('renders an unclosed fence as a code block while it is still streaming', () => {
    const el = html('```js\nconst a = 1;', { streaming: true });
    expect(el.querySelector('pre code').textContent).toBe('const a = 1;');
  });

  it('renders a heading line as emphasised text, not as a heading element', () => {
    /* The transcript sits inside the page's heading outline; a reply is not a
       section of it. See headingLevels.test.js. */
    const el = html('## How hours work\n\nThey are credited by the organizer.');
    expect(el.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(el.querySelector('.welly-md-heading').textContent).toBe('How hours work');
  });
});

describe('WellyMessage inline formatting', () => {
  it('renders bold, italic and inline code', () => {
    const el = html('That is **important**, mildly *interesting*, and uses `checkIn()`.');
    expect(el.querySelector('strong').textContent).toBe('important');
    expect(el.querySelector('em').textContent).toBe('interesting');
    expect(el.querySelector('code').textContent).toBe('checkIn()');
  });

  it('picks the earliest marker rather than applying patterns in a fixed order', () => {
    /* `*` inside a code span must not italicise the rest of the sentence. */
    const el = html('Run `a * b` and then **stop**.');
    expect(el.querySelector('code').textContent).toBe('a * b');
    expect(el.querySelector('strong').textContent).toBe('stop');
    expect(el.textContent).toBe('Run a * b and then stop.');
  });

  it('renders markdown links and bare URLs, opening external ones safely', () => {
    const el = html('See [the guide](https://example.org/guide) or https://example.org/raw');
    const links = [...el.querySelectorAll('a')];
    expect(links.map(a => a.getAttribute('href')))
      .toEqual(['https://example.org/guide', 'https://example.org/raw']);
    expect(links[0].textContent).toBe('the guide');
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });

  it('leaves snake_case identifiers alone', () => {
    const el = html('The field is event_id on every row.');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('The field is event_id on every row.');
  });
});

describe('WellyMessage never alters the reply', () => {
  const SAMPLES = [
    "That's a great idea!",
    'How are you?',
    'Hours: 12, events: 3; next shift Friday.',
    'Nice work 🎉 — ¡felicidades! 日本語も大丈夫。',
    "The organizer said 'yes' straight away.",
    'A stray ** marker and one ` backtick survive.',
    'Windows path C:\\Users\\a_b\\file_name.txt',
    'Ellipsis… and an em—dash.',
  ];

  for (const sample of SAMPLES) {
    it(`round-trips: ${JSON.stringify(sample.slice(0, 40))}`, () => {
      expect(html(sample).textContent).toBe(sample);
    });
  }

  it('treats markup in the reply as text, never as elements', () => {
    const el = html('Write <script>alert(1)</script> in your notes.');
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toBe('Write <script>alert(1)</script> in your notes.');
  });

  it('renders nothing for empty or non-string input', () => {
    expect(html('').textContent).toBe('');
    expect(html(null).textContent).toBe('');
    expect(html(undefined).textContent).toBe('');
  });

  it('shows a partially arrived reply without waiting for it to be well formed', () => {
    render(<WellyMessage text="I can help you with" streaming />);
    expect(screen.getByText(/I can help you with/)).toBeInTheDocument();
  });
});
