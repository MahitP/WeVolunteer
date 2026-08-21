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

/**
 * The cases that were altering the model's text, and the ones that could.
 *
 * Every entry here was found by rendering it and comparing the result with the
 * source, not by reasoning about the regexes.
 */
describe('WellyMessage does not eat characters it does not understand', () => {
  it('leaves asterisks alone when they are not emphasis', () => {
    /* Measured before the inner-edge rule: "3 * 4 * 5 = 60" rendered as
       "3  4  5 = 60" — the parser deleted two characters the model wrote. */
    expect(html('3 * 4 * 5 = 60').textContent).toBe('3 * 4 * 5 = 60');
    expect(html('3 * 4 * 5 = 60').querySelector('em')).toBeNull();
  });

  it('leaves dunder identifiers alone', () => {
    /**
     * CommonMark would make this a bold "init", and that reading is defensible
     * in general and wrong here: `__` around a bare word is an identifier in
     * any technical string, and nothing Welly writes uses `__` for emphasis.
     * Rendering it as bold deletes four characters the model wrote. See the
     * note above INLINE in WellyMessage.jsx.
     */
    expect(html('Override __init__ in the subclass.').textContent)
      .toBe('Override __init__ in the subclass.');
    expect(html('Override __init__ in the subclass.').querySelector('strong')).toBeNull();
  });

  it('still renders real emphasis either side of those', () => {
    const el = html('A **bold** and an *italic* and _also italic_.');
    expect([...el.querySelectorAll('strong')].map(n => n.textContent)).toEqual(['bold']);
    expect([...el.querySelectorAll('em')].map(n => n.textContent)).toEqual(['italic', 'also italic']);
  });

  it('nests a list by its indentation instead of flattening it', () => {
    const el = html('- Shifts\n  - Morning\n  - Afternoon\n- Hours');
    const top = el.querySelector('ul');
    expect([...top.children]).toHaveLength(2);
    const nested = top.children[0].querySelector('ul');
    expect(nested).not.toBeNull();
    expect([...nested.children].map(li => li.textContent)).toEqual(['Morning', 'Afternoon']);
    expect(top.children[1].textContent).toBe('Hours');
  });

  it('nests a numbered list under a numbered parent', () => {
    const el = html('1. Apply\n   1. Pick a shift\n   2. Submit\n2. Attend');
    const top = el.querySelector('ol');
    expect([...top.children]).toHaveLength(2);
    expect([...top.children[0].querySelectorAll('ol > li')].map(li => li.textContent))
      .toEqual(['Pick a shift', 'Submit']);
  });

  it('leaves a flat list flat', () => {
    const el = html('- one\n- two\n- three');
    expect(el.querySelectorAll('ul')).toHaveLength(1);
    expect(el.querySelectorAll('li')).toHaveLength(3);
  });

  const VERBATIM = [
    ['a URL with parentheses', 'See https://en.wikipedia.org/wiki/Volunteering_(disambiguation) now'],
    ['a snake_case field', 'The field is event_id on every row.'],
    ['inline HTML as text', 'Use <b>bold</b> here'],
    ['a pipe table', '| a | b |'],
    ['a horizontal rule', 'Above\n\n---\n\nBelow'],
    ['a blockquote marker', '> Volunteering is the rent we pay.'],
    ['curly and straight apostrophes', "It's Leo’s shift, isn't it?"],
    ['double quotes', 'She said "yes" and left.'],
    ['parentheses', 'Hours (verified) count.'],
    ['semicolons and colons', 'One; two: three.'],
    ['a compound emoji', 'Family 👨‍👩‍👧‍👦 and flag 🏳️‍🌈 ok'],
    ['a Windows path', 'C:\\Users\\a_b\\file_name.txt'],
    ['maths with underscores', 'x_1 + x_2 = y'],
  ];

  for (const [name, text] of VERBATIM) {
    it(`passes ${name} through unchanged`, () => {
      /* Newlines become element boundaries, so compare on the visible run of
         characters rather than on the literal string. */
      const expected = text.split('\n').filter(l => l.trim()).join('');
      expect(html(text).textContent).toBe(expected);
    });
  }
});

/**
 * Shapes taken from what Qwen2.5-0.5B actually produced when asked, through the
 * real download, rather than from what a well-formed markdown sample looks like.
 */
describe('WellyMessage against real model output', () => {
  it('keeps a numbered list whose items are separated by blank lines as one list', () => {
    /* Verbatim shape from "Give me a short numbered list of three tips".
       Every blank line used to flush the list, so this rendered as three
       separate <ol> elements and the reader saw "1." three times. */
    const reply = [
      'Certainly! Here are three tips for being a good teammate:',
      '',
      '1. **Be Respectful**: Treat others with kindness.',
      '',
      '2. **Be Helpful**: Offer help when possible.',
      '',
      '3. **Be Open-minded**: Listen to other viewpoints.',
    ].join('\n');

    const el = html(reply);
    expect(el.querySelectorAll('ol')).toHaveLength(1);
    expect([...el.querySelectorAll('ol > li')]).toHaveLength(3);
    expect([...el.querySelectorAll('ol > li strong')].map(n => n.textContent))
      .toEqual(['Be Respectful', 'Be Helpful', 'Be Open-minded']);
  });

  it('does the same for a bulleted loose list', () => {
    const el = html('Options:\n\n- Food bank\n\n- Library\n\n- Park');
    expect(el.querySelectorAll('ul')).toHaveLength(1);
    expect([...el.querySelectorAll('li')].map(li => li.textContent))
      .toEqual(['Food bank', 'Library', 'Park']);
  });

  it('still ends the list when ordinary prose follows the blank line', () => {
    const el = html('- one\n- two\n\nThat is everything.');
    expect(el.querySelectorAll('ul')).toHaveLength(1);
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect([...el.children].pop().tagName).toBe('P');
    expect([...el.children].pop().textContent).toBe('That is everything.');
  });

  it('renders the multi-paragraph shape the model uses for a plain answer', () => {
    const reply = 'The capital of France is Paris.\n\nFirstly, it hosts the Eiffel Tower.\n\nOverall, it is important.';
    const el = html(reply);
    expect([...el.children].map(c => c.tagName)).toEqual(['P', 'P', 'P']);
  });
});

describe('WellyMessage numbering', () => {
  it('starts an ordered list at 1 without saying so', () => {
    expect(html('1. one\n2. two').querySelector('ol').getAttribute('start')).toBeNull();
  });

  it('keeps the numbers the model wrote when a list does not start at 1', () => {
    /* Observed with the real model: a stray character before the first item
       stops it parsing as one, and the rest used to renumber from the top —
       so "2." and "3." appeared on screen as "1." and "2.". */
    const el = html('.1. First tip here.\n\n2. Second tip.\n\n3. Third tip.');
    const ol = el.querySelector('ol');
    expect(ol.getAttribute('start')).toBe('2');
    expect([...ol.children]).toHaveLength(2);
  });

  it('numbers a nested ordered list from its own first number', () => {
    const el = html('1. Apply\n   3. Pick a shift\n   4. Submit\n2. Attend');
    expect(el.querySelector('ol ol').getAttribute('start')).toBe('3');
  });
});
