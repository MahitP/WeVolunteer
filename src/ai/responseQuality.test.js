import { describe, it, expect } from 'vitest';
import { formatResponseText, sanitizeHistory, ask } from './assistant';
import { isUsableReply, claimsAnAction, hasRepetitiveLoop } from './prompts/welly';
import { MockRuntime } from './runtime/MockRuntime.js';
import { AIStatus } from './runtime/types.js';

/**
 * What the presentation layer is allowed to do to a reply, which is very little.
 *
 * ── Why these tests replaced the ones that were here ──
 *
 * The previous version of this file asserted the opposite of most of what
 * follows. It pinned `formatResponseText('?I am here to help.')` returning
 * `'I am here to help.'`, `'How can I help you today?'` being rewritten to
 * `"What's on your mind?"`, and `sanitizeHistory` turning
 * `"I'm sorry, but I can't assist with"` into `"I'm sorry, but I can't assist."`.
 *
 * Those behaviours were written to clean up transcripts corrupted by the
 * StrictMode placeholder bug fixed in 6f37388, where tokens landed in the
 * previous reply's bubble. The corruption was a React bug, the fix was a React
 * fix, and the text repairs outlived the problem they were written for — while
 * still being able to delete a legitimate leading `?`, join a quoted word onto
 * the word before it, flatten the indentation of a code block, and change what
 * the model actually said.
 *
 * So the property under test is now the one that matters to a reader: the
 * pipeline moves a reply from the model to the screen without altering it.
 */

const studentUser = { id: 'stu-1', role: 'student', withheld: [] };

/** A runtime that is READY and will stream `reply` one fragment at a time. */
function readyRuntime(reply) {
  const runtime = new MockRuntime({ responses: [reply] });
  runtime.status = AIStatus.READY;
  return runtime;
}

describe('formatResponseText leaves the reply alone', () => {
  it('returns ordinary prose byte-for-byte', () => {
    const cases = [
      'You have 28 verified hours.',
      "That's a great idea!",
      'How can I help you today?',
      'Do you want me to look that up?',
      "I'm not able to change that, but I can show you where it lives.",
    ];
    for (const text of cases) expect(formatResponseText(text)).toBe(text);
  });

  it('keeps punctuation attached to the sentence that ends with it', () => {
    expect(formatResponseText('How are you?')).toBe('How are you?');
    expect(formatResponseText('Hello there!')).toBe('Hello there!');
    expect(formatResponseText('Shifts: 3, spots: 12; deadline Friday.'))
      .toBe('Shifts: 3, spots: 12; deadline Friday.');
  });

  it('does not delete a leading punctuation mark that is part of the reply', () => {
    /* The old rule stripped these. A reply that opens with an ellipsis or a
       quotation mark is a reply, not an artefact. */
    expect(formatResponseText('"Auto Select" is the weighted draw.'))
      .toBe('"Auto Select" is the weighted draw.');
    expect(formatResponseText('…and that is why hours are credited late.'))
      .toBe('…and that is why hours are credited late.');
  });

  it('does not join a quoted word onto the word before it', () => {
    /* The contraction rule could not tell `said 'yes'` from `can 't`. */
    expect(formatResponseText("The organizer said 'yes' straight away."))
      .toBe("The organizer said 'yes' straight away.");
    expect(formatResponseText("It's marked 'pending' until they review it."))
      .toBe("It's marked 'pending' until they review it.");
  });

  it('preserves paragraphs, bullets and blank lines exactly', () => {
    const text = [
      'Here is what I found:',
      '',
      '• Food Bank at 9:00 AM',
      '• Library Help at 1:00 PM',
      '',
      'Let me know if you need anything else.',
    ].join('\n');
    expect(formatResponseText(text)).toBe(text);
  });

  it('preserves the indentation inside a fenced code block and a nested list', () => {
    const code = '```js\nconst hours = 4;\n  if (hours) {\n    credit(hours);\n  }\n```';
    expect(formatResponseText(code)).toBe(code);

    const nested = '- Shifts\n  - Morning\n  - Afternoon\n- Hours';
    expect(formatResponseText(nested)).toBe(nested);
  });

  it('preserves URLs, emoji and non-Latin characters', () => {
    const text = 'See https://example.org/a_b?c=1&d=2 🎉 — ¿listo? Ståle, 日本語.';
    expect(formatResponseText(text)).toBe(text);
  });

  it('normalises CRLF to LF and trims the ends, and nothing else', () => {
    expect(formatResponseText('  A line.\r\nAnother line.  ')).toBe('A line.\nAnother line.');
  });

  it('is idempotent, so a reply cannot drift by being formatted twice', () => {
    const samples = [
      "That's a great idea!",
      '# Heading\n\n- one\n- two',
      '```\ncode  here\n```',
      'Multi\nline\n\nreply.',
    ];
    for (const s of samples) expect(formatResponseText(formatResponseText(s))).toBe(formatResponseText(s));
  });
});

describe('sanitizeHistory hands back the turns that were shown', () => {
  it('does not rewrite an assistant turn that lacks terminal punctuation', () => {
    /* The old behaviour cut the trailing word and appended a full stop, so the
       model was told "I can't assist." while the reader saw "I can't assist
       with" — two different sentences, one of them asserting the opposite. */
    const history = [
      { role: 'user', text: 'How do I volunteer?' },
      { role: 'assistant', text: "I'm sorry, but I can't assist with" },
    ];
    const sanitized = sanitizeHistory(history);
    expect(sanitized[1].content).toBe("I'm sorry, but I can't assist with");
  });

  it('keeps complete sentences intact', () => {
    const history = [
      { role: 'user', text: 'Where is the event?' },
      { role: 'assistant', text: 'The event is at South Bay Community Center.' },
    ];
    const sanitized = sanitizeHistory(history);
    expect(sanitized.map(m => m.content)).toEqual([
      'Where is the event?',
      'The event is at South Bay Community Center.',
    ]);
  });

  it('drops empty turns and bounds how many are sent back', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `q${i}` }));
    expect(sanitizeHistory([...many, { role: 'assistant', text: '   ' }])).toHaveLength(6);
  });

  it('ignores entries that are not conversation turns', () => {
    const history = [
      { role: 'system', text: 'ignore me' },
      { role: 'user', text: 'real question' },
    ];
    expect(sanitizeHistory(history)).toEqual([{ role: 'user', content: 'real question' }]);
  });
});

describe('isUsableReply length and quality boundaries', () => {
  it('accepts comprehensive natural responses longer than 500 characters', () => {
    const detailedReply = `
Auto Select automatically assigns volunteers to shifts based on their availability, skills, and sign-up order.
When an organizer publishes an event with Auto Select enabled, registered volunteers are notified and placed into confirmed slots.
If all slots fill up, additional volunteers are placed on the waitlist in order of registration. If a volunteer cancels, the next person on the waitlist is automatically promoted.
You can review your confirmed shifts and application status in the Calendar or Applications view.
    `.trim();

    expect(detailedReply.length).toBeGreaterThan(500);
    expect(isUsableReply(detailedReply)).toBe(true);
  });

  it('rejects runaway responses that exceed safety thresholds', () => {
    const runaway = 'This is an excessively long runaway generation without useful content. '.repeat(70);
    expect(runaway.length).toBeGreaterThan(4000);
    expect(isUsableReply(runaway)).toBe(false);
  });

  /**
   * A reply that used its whole token budget must still be shown.
   *
   * Generation stops at 512 tokens, which is roughly 2000–3000 characters of
   * English, and the display ceiling used to be 2000 — below what the sampler
   * permits. Measured against the real model: 2203 characters of coherent prose
   * were generated, streamed to the screen, and then replaced by "I can't help
   * with that one." See MAX_REPLY_CHARS in prompts/welly.js.
   */
  it('accepts a reply the length a full 512-token generation actually produces', () => {
    /* Ordinary long-form prose on one subject: the topic noun recurs, as it
       does in any essay, and nothing else does. */
    const long = [
      'Public libraries began as subscription collections open only to paying members.',
      'A rate-supported alternative was proposed repeatedly before anywhere adopted one.',
      'Birmingham argued the question through three separate council sessions.',
      'Manchester moved faster, and its reading room opened above a market hall.',
      'Norwich kept its shelves behind a grille, so borrowers asked for each volume.',
      'Leeds admitted apprentices on Saturday evenings and nobody else after dark.',
      'Bristol charged a penny for a ticket and abolished it within a decade.',
      'Hull recorded every loan by hand in ledgers that survive today.',
      'Derby appointed its first paid librarian at a salary below a clerk.',
      'Exeter built a separate entrance so women need not pass the news room.',
      'Cataloguing was a craft before it was a standard, done differently everywhere.',
      'Fines were meaningful money, and defaulters were named in the annual report.',
      'Opening hours became the next argument, because working people could not attend by day.',
      'Gas lighting settled that, at considerable expense and some risk.',
      'Children were excluded from most reading rooms until surprisingly late.',
      'Fiction was treated with suspicion, and several committees tried to limit it.',
      'The idea that reading was infrastructure rather than charity took a generation.',
      'By the end of the century the argument had been won almost everywhere.',
      'What replaced it was a quieter question about who the buildings were for.',
      'That question has never entirely gone away, and it is a reasonable one.',
    ].join(' ');

    expect(long.length).toBeGreaterThan(1000);
    expect(long.length).toBeLessThan(4000);
    /* The subject noun recurs; that is a topic, not a loop. */
    expect(hasRepetitiveLoop(long)).toBe(false);
    expect(isUsableReply(long)).toBe(true);
  });

  /**
   * The loop detector still catches a loop, and now says so proportionally.
   *
   * The old rule fired on any 4-word phrase appearing three times anywhere,
   * whatever the length of the reply — so an essay was rejected for naming its
   * own subject. Measured against the real model: 2823 characters of coherent
   * prose about the history of public libraries, rejected, with "I can't help
   * with that one" shown instead.
   */
  it('still catches a reply that is mostly one repeated phrase', () => {
    expect(hasRepetitiveLoop('You have hours. You have hours. You have hours. You have hours.')).toBe(true);
    expect(hasRepetitiveLoop('I can look that up for you. I can look that up for you. I can look that up for you.')).toBe(true);
  });

  it('does not call a recurring subject a loop', () => {
    const essay = 'The history of public libraries is long. Early public libraries charged a '
      + 'subscription. Rate-supported public libraries came later, and the history of public '
      + 'libraries turns on that change. Nothing about the history of public libraries was '
      + 'inevitable, and the buildings that survive were argued over for years by councils '
      + 'that did not agree about who should pay or who should be allowed inside them.';
    expect(hasRepetitiveLoop(essay)).toBe(false);
  });

  it('rejects repetitive loops regardless of length', () => {
    const loop = 'You have hours. You have hours. You have hours. You have hours. You have hours.';
    expect(hasRepetitiveLoop(loop)).toBe(true);
    expect(isUsableReply(loop)).toBe(false);
  });

  it('rejects unauthorized action claims', () => {
    expect(claimsAnAction("I'll create the event for you right now.")).toBe(true);
    expect(isUsableReply("I'll create the event for you right now.")).toBe(false);
  });
});

/**
 * The guarantee the reader actually experiences: chunks are transport, and the
 * answer that lands is the answer that was generated.
 *
 * These drive the real `ask()` against a streaming runtime rather than calling
 * the formatter directly, because the property is about the whole path — what
 * the runtime emitted, what the caller collected, and what came back.
 */
describe('a streamed reply arrives whole', () => {
  /**
   * The content matrix.
   *
   * One entry per thing a reply can contain that a naive pipeline gets wrong:
   * each terminal punctuation mark, the separators, the possessives, the
   * structures, and the character classes that are more than one byte. The
   * assertion is the same for all of them — what the runtime emitted is what
   * comes back — so the value is in the breadth rather than in any one case.
   */
  const REPLIES = [
    /* Length */
    'Yes.',
    'You have four verified hours so far this year.',
    [
      'Service hours reach your record in a few steps.',
      'You apply to a shift, the organizer accepts you, and the shift happens.',
      'On the day, you check in with the code the organizer shows on their screen.',
      'Afterwards they open the roster and mark who actually turned up.',
      'That last action is what credits the time — nothing is added before it.',
      'Until then the shift sits in your applications rather than in your totals.',
      'If an organizer forgets, message them from the event page and they can still do it later.',
      'Anything logged outside the platform goes through the external hours form instead,',
      'where an administrator reviews the evidence before anything is counted.',
    ].join(' '),

    /* Every terminal mark */
    'That is credited already.',
    'How are you?',
    "That's a great idea!",

    /* Separators */
    'Shifts: 3, spots: 12; deadline Friday.',
    'One — two – three... and so on.',

    /* Possessives, contractions and quotation */
    "It's the organizer's call, and they haven't decided yet.",
    'She said "yes" and the roster closed.',
    "The status is 'pending' until somebody reviews it.",
    'Hours (verified) are the ones that count.',

    /* Structure */
    'Sure — here are three options:\n\n1. Food bank\n2. Library\n3. Park cleanup',
    'Two things:\n\n- Apply first\n- Then check in',
    'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
    'That is **important** and this is *worth a look*.',
    'Use `checkIn()` on the roster screen:\n\n```js\nawait checkIn(eventId);\n```\n\nThat marks attendance.',
    '- Shifts\n  - Morning\n  - Afternoon\n- Hours',

    /* Characters that are more than one byte */
    'Nice work! 🎉 That puts you at the top of your grade — ¡felicidades!',
    'Ståle, 日本語, Привет, and a family 👨‍👩‍👧‍👦.',

    /**
     * Shapes that used to be tested with URLs in them.
     *
     * This group was `/* Links *\/` and held
     * "You can read more at https://example.org/hours (it explains crediting)."
     * and "See [the guide](https://example.org/guide) when you get a moment."
     *
     * `isUsableReply` now refuses a model reply that names an absolute
     * destination, so those two are no longer committed and cannot be used to
     * prove anything about reassembly. The reassembly shapes they contributed —
     * a parenthetical tail, and bracket-then-parenthesis text — are kept here
     * without the URL, because losing the shape was never the intention.
     *
     * The policy itself is asserted below, and the reason it exists is in
     * `indirectInjection.test.js`.
     */
    'You can read more on the hours page (it explains crediting).',
    'See [the guide] under Help when you get a moment.',
  ];

  for (const reply of REPLIES) {
    it(`reassembles exactly: ${JSON.stringify(reply.slice(0, 42))}`, async () => {
      const runtime = readyRuntime(reply);
      const streamed = [];

      const res = await ask('just chatting about something', {
        runtime,
        user: studentUser,
        onToken: t => streamed.push(t),
      });

      /**
       * A multi-word reply must arrive in more than one fragment, or the
       * reassembly assertion below proves nothing. A single word legitimately
       * arrives whole — "Yes." is one fragment and still has to survive the
       * trip, which is the case this branch keeps in the matrix.
       */
      if (/\s/.test(reply.trim())) {
        expect(streamed.length).toBeGreaterThan(1);
      } else {
        expect(streamed.length).toBe(1);
      }
      /* The fragments concatenate to the reply, with nothing lost or reordered. */
      expect(streamed.join('')).toBe(reply);
      /* And the committed answer is that same string. Not a repaired version of
         it, not one with a character moved to the front or the back. */
      expect(res.answer).toBe(reply);
      expect(res.phrasedByModel).toBe(true);
    });
  }

  it('does not commit a model reply that names a destination', async () => {
    /**
     * The counterpart to the matrix above: these are the replies that
     * deliberately do NOT arrive whole.
     *
     * Welly has no source of URLs — the informational corpus is fixed
     * application text, `summarise()` composes every deterministic answer, and
     * getting somewhere in this app is a router navigation rather than a link
     * the model writes. So an absolute destination in model output is either
     * hallucinated or planted, and `WellyMessage` would render an http(s) one as
     * a clickable anchor to a fourteen-year-old.
     *
     * A rejected reply is replaced wholesale by the deterministic sentence, so
     * `phrasedByModel` is the observable difference. Nothing is repaired or
     * edited — that invariant is unchanged.
     */
    for (const planted of [
      'You can read more at https://example.org/hours (it explains crediting).',
      'See [the guide](https://example.org/guide) when you get a moment.',
    ]) {
      const runtime = readyRuntime(planted);
      const res = await ask('just chatting about something', {
        runtime, user: studentUser, onToken: () => {},
      });
      expect(res.answer, `committed a reply naming a destination: ${planted}`).not.toBe(planted);
      expect(res.phrasedByModel).toBe(false);
    }
  });

  it('does not move terminal punctuation out of the answer', async () => {
    const runtime = readyRuntime('Hello, how are you?');
    const res = await ask('hey what is up', { runtime, user: studentUser, onToken: () => {} });
    expect(res.answer).toBe('Hello, how are you?');
    expect(res.answer.endsWith('?')).toBe(true);
  });

  it('keeps a multi-byte character whole across the fragments it arrives in', async () => {
    const reply = 'Great job 🎉 — 日本語 works too.';
    const runtime = readyRuntime(reply);
    const streamed = [];
    const res = await ask('tell me something', { runtime, user: studentUser, onToken: t => streamed.push(t) });
    expect(streamed.join('')).toBe(reply);
    expect(res.answer).toBe(reply);
  });
});
