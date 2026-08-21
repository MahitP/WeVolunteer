import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MockRuntime } from '../ai/runtime/MockRuntime.js';
import { AIStatus } from '../ai/runtime/types.js';

/**
 * Welly AI end to end, from the runtime's fragments to what is on the screen.
 *
 * ── Why this file does not mock `ask` ──
 *
 * `WellyView.test.jsx` does, which is right for testing the page's own
 * behaviour — history, drawers, the composer. It also means the streaming path
 * is never executed there: with `ask` stubbed, no token callback ever fires and
 * the placeholder is replaced in one step.
 *
 * The defect this file exists to prevent lives exactly in that gap. A reply
 * arrives as many fragments, and every fragment is a state update against a
 * placeholder that has to still be the same message when the next one lands.
 * Get that wrong — as the impure-updater bug in 6f37388 did — and the
 * transcript fills with replies that end mid-sentence and successors that begin
 * with the missing tail. Nothing short of running the real path catches it.
 *
 * ── Why everything renders inside StrictMode ──
 *
 * That bug was invisible without it. StrictMode double-invokes state updaters
 * and effects in development, which is what turned an impure updater into
 * misplaced text; a test that renders without it would pass over the exact
 * class of fault being guarded.
 */

const runtime = new MockRuntime();
/* Restored between tests: one case below swaps `generate` for a gated stub, and
   a leaked override would silently answer every test after it. */
const realGenerate = runtime.generate.bind(runtime);

vi.mock('../ai', async () => {
  const types = await import('../ai/runtime/types.js');
  return {
    AIStatus: types.AIStatus,
    isAbort: types.isAbort,
    isLocalAIEnabled: () => true,
    detectCapability: () => ({ supported: true, reason: null }),
    offerableModels: () => [{ id: 'test-model', label: 'Test model', bytes: 1000 }],
    modelById: id => ({ id, label: 'Test model', bytes: 1000 }),
    createRuntime: async () => runtime,
    aiStorage: async () => ({ downloadModel: async () => {} }),
    formatBytes: n => `${n} B`,
  };
});

vi.mock('../ai/preferences', async () => {
  const actual = await vi.importActual('../ai/preferences');
  return {
    ...actual,
    readPreferences: () => ({ enabled: true, modelId: 'test-model', saveConversations: true }),
    writePreferences: p => ({ enabled: true, modelId: 'test-model', saveConversations: true, ...p }),
  };
});

const WellyView = (await import('./WellyView')).default;
const { clearAllConversations } = await import('../ai/conversation');

const student = {
  id: 'student-stream-1',
  name: 'Maya Lin',
  role: 'student',
  verified: true,
  withheld: [],
  avatar: '👩‍🎓',
};

/** A message that routes to conversation rather than to a lookup tool. */
const CHATTY = 'lets just talk about something for a moment';

function setup() {
  const utils = render(
    <React.StrictMode>
      <MemoryRouter>
        <WellyView currentUser={student} />
      </MemoryRouter>
    </React.StrictMode>,
  );
  return {
    ...utils,
    transcript: () => within(utils.container.querySelector('.welly-transcript')),
    bubbles: () => [...utils.container.querySelectorAll('.welly-turn-assistant .welly-md')],
  };
}

/**
 * Wait until the page reports Welly AI as ready.
 *
 * The runtime loads in an effect, so for a few ticks after mount the composer
 * is live and the model is not. Sending in that window falls back to the
 * deterministic answer — correct behaviour, and not what these tests are about.
 */
async function waitForReady() {
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: /Answering with Welly AI/i }).length)
      .toBeGreaterThan(0));
}

async function askWelly(text) {
  const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
  fireEvent.change(textarea, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTitle(/^Send$/i));
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  clearAllConversations({ user: student });
  runtime.generate = realGenerate;
  runtime.status = AIStatus.IDLE;
  runtime.model = null;
  runtime._responses = [];
  runtime.calls = [];
});

describe('a streamed reply is one message', () => {
  it('commits the whole generated reply, punctuation and all', async () => {
    runtime.queue('Hello, how are you?');
    const t = setup();
    await waitForReady();

    await askWelly(CHATTY);

    await waitFor(() => {
      expect(t.bubbles()).toHaveLength(1);
    });
    expect(t.bubbles()[0].textContent).toBe('Hello, how are you?');
  });

  it('does not leave the closing question mark in a message of its own', async () => {
    runtime.queue('Hello, how are you?');
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    /* The reported symptom: a second bubble holding the tail of the first. */
    expect(t.bubbles().map(b => b.textContent)).not.toContain('?');
    expect(t.transcript().queryByText('?')).toBeNull();
  });

  it('does not split a reply at a word boundary either', async () => {
    runtime.queue('I can help you with volunteering.');
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.bubbles()[0].textContent).toBe('I can help you with volunteering.');
  });

  it('keeps multi-byte characters whole across fragments', async () => {
    const reply = 'Nice work 🎉 — ¡felicidades! 日本語も大丈夫。';
    runtime.queue(reply);
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.bubbles()[0].textContent).toBe(reply);
  });

  it('renders a structured reply as structure rather than as one run-on line', async () => {
    runtime.queue('Three ideas:\n\n- Food bank\n- Library\n- Park cleanup');
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    const items = [...t.bubbles()[0].querySelectorAll('li')].map(li => li.textContent);
    expect(items).toEqual(['Food bank', 'Library', 'Park cleanup']);
  });

  it('produces exactly one reply per question under StrictMode', async () => {
    runtime.queue('First answer.', 'Second answer.');
    const t = setup();
    await waitForReady();

    await askWelly(CHATTY);
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));

    await askWelly('and another thing lets keep talking');
    await waitFor(() => expect(t.bubbles()).toHaveLength(2));

    expect(t.bubbles().map(b => b.textContent)).toEqual(['First answer.', 'Second answer.']);
    /* Two questions, two generations. A duplicated stream would show three. */
    expect(runtime.calls).toHaveLength(2);
  });

  it('carries the earlier turns into the next request', async () => {
    runtime.queue('Paris is the capital of France.', 'It has about two million residents.');
    setup();
    await waitForReady();

    await askWelly('lets chat about the capital of france');
    await askWelly('how big is it');

    await waitFor(() => expect(runtime.calls).toHaveLength(2));
    const secondPrompt = runtime.calls[1].messages;
    const roles = secondPrompt.map(m => m.role);
    expect(roles[0]).toBe('system');
    /* The prior exchange is present, verbatim — not a repaired version of it. */
    expect(secondPrompt.some(m => m.content === 'Paris is the capital of France.')).toBe(true);
    expect(secondPrompt.at(-1).content).toBe('how big is it');
  });
});

/**
 * A stream outlives the screen it started on.
 *
 * Switching conversations aborts the request, but an abort is not instant and
 * the tool path is not always cancellable, so the four scenarios below are
 * about what happens in the gap.
 */
/**
 * The same content matrix as `responseQuality.test.js`, but through the screen.
 *
 * That file asserts what `ask()` returns; this one asserts what a reader sees,
 * which is the layer where a fragment could become a second bubble. Both are
 * needed: the assembly could be right and the rendering still split it, and the
 * rendering has been the source of every symptom reported so far.
 */
describe('what arrives on screen is what was generated', () => {
  const MATRIX = [
    ['a one-word reply', 'Yes.'],
    ['a question', 'How are you?'],
    ['an exclamation', "That's a great idea!"],
    ['separators', 'Shifts: 3, spots: 12; deadline Friday.'],
    ['contractions and quotes', `It's the organizer's call, and she said "wait".`],
    ['parentheses', 'Hours (verified) are the ones that count.'],
    ['multiple paragraphs', 'First paragraph.\n\nSecond paragraph.'],
    ['unicode', 'Ståle, 日本語, Привет.'],
    ['emoji', 'Nice work! 🎉 Top of your grade — ¡felicidades!'],
    ['a URL', 'Read https://example.org/hours for the detail.'],
  ];

  for (const [name, reply] of MATRIX) {
    it(`renders ${name} as one message`, async () => {
      runtime.queue(reply);
      const t = setup();
      await waitForReady();
      await askWelly(CHATTY);

      await waitFor(() => expect(t.bubbles()).toHaveLength(1));
      /* Paragraph breaks become element boundaries, so compare on the visible
         run of characters. */
      expect(t.bubbles()[0].textContent).toBe(reply.split('\n\n').join(''));
    });
  }

  it('renders a numbered list as a list, not as three paragraphs', async () => {
    runtime.queue('Three options:\n\n1. Food bank\n2. Library\n3. Park cleanup');
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect([...t.bubbles()[0].querySelectorAll('ol li')].map(li => li.textContent))
      .toEqual(['Food bank', 'Library', 'Park cleanup']);
  });

  it('renders a fenced block without letting it wrap', async () => {
    runtime.queue('Try:\n\n```js\nawait checkIn(id);\n```');
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.bubbles()[0].querySelector('pre code').textContent).toBe('await checkIn(id);');
  });

  it('links a URL without altering the address', async () => {
    runtime.queue('Read https://example.org/a_b?c=1 for the detail.');
    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.bubbles()[0].querySelector('a').getAttribute('href'))
      .toBe('https://example.org/a_b?c=1');
  });
});

describe('a stream belongs to the conversation it was asked in', () => {
  /** A generation the test holds open until it says otherwise. */
  function gatedRuntime(reply) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    runtime.generate = async (messages, { onToken } = {}) => {
      runtime.calls.push({ messages });
      onToken?.(reply.slice(0, 4));
      await gate;
      onToken?.(reply.slice(4));
      return reply;
    };
    return () => release();
  }

  const newConversation = async () => {
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /new conversation/i })[0]);
    });
  };

  /** Open the Nth conversation in the sidebar list (0 = most recent). */
  const openHistory = async (index) => {
    const rows = document.querySelectorAll('.welly-sidebar .welly-history-item');
    await act(async () => { fireEvent.click(rows[index]); });
  };

  it('A — a reply that lands after a switch does not appear in the other conversation', async () => {
    const finish = gatedRuntime('Late answer.');

    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await newConversation();
    expect(screen.getByText(/Hi, Maya!/i)).toBeInTheDocument();

    await act(async () => { finish(); await Promise.resolve(); });

    await waitFor(() => expect(t.bubbles()).toHaveLength(0));
    expect(screen.getByText(/Hi, Maya!/i)).toBeInTheDocument();
  });

  it('C — the question asked before a switch is still there on the way back', async () => {
    /**
     * The failure this catches is not a misplaced reply but a LOST one.
     * Persistence waits for a turn to finish, and the guard drops a reply that
     * finishes after a switch — so between them the user's own message could be
     * written nowhere at all, and returning to the conversation showed a
     * transcript that had never heard of it.
     */
    const finish = gatedRuntime('Late answer.');

    const t = setup();
    await waitForReady();
    await askWelly('what happens to my question');

    await newConversation();
    await act(async () => { finish(); await Promise.resolve(); });

    /* Back to the conversation the question was asked in. */
    await waitFor(() => expect(document.querySelectorAll('.welly-sidebar .welly-history-item').length)
      .toBeGreaterThan(0));
    await openHistory(0);

    await waitFor(() => {
      expect(t.transcript().getByText('what happens to my question')).toBeInTheDocument();
    });
    /* And exactly once — not duplicated by the round trip. */
    expect(t.transcript().getAllByText('what happens to my question')).toHaveLength(1);
  });

  it('B — two conversations generating in turn keep their own replies', async () => {
    runtime.queue('Answer for the first.', 'Answer for the second.');

    const t = setup();
    await waitForReady();

    await askWelly('the first question here');
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.bubbles()[0].textContent).toBe('Answer for the first.');

    await newConversation();
    await askWelly('the second question here');
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.bubbles()[0].textContent).toBe('Answer for the second.');

    /* The second conversation holds only its own turn. */
    expect(t.transcript().queryByText('the first question here')).toBeNull();

    /* And the first still holds only its own. */
    await openHistory(1);
    await waitFor(() => {
      expect(t.transcript().getByText('the first question here')).toBeInTheDocument();
    });
    expect(t.transcript().queryByText('the second question here')).toBeNull();
    expect(t.bubbles().map(b => b.textContent)).toEqual(['Answer for the first.']);
  });

  it('C — switching back and forth loses and duplicates nothing', async () => {
    runtime.queue('First reply.', 'Second reply.');

    const t = setup();
    await waitForReady();

    await askWelly('question one goes here');
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    await newConversation();
    await askWelly('question two goes here');
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));

    for (let i = 0; i < 3; i += 1) {
      await openHistory(1);
      await openHistory(0);
    }

    await openHistory(1);
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.transcript().getAllByText('question one goes here')).toHaveLength(1);
    expect(t.bubbles().map(b => b.textContent)).toEqual(['First reply.']);

    await openHistory(0);
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    expect(t.transcript().getAllByText('question two goes here')).toHaveLength(1);
    expect(t.bubbles().map(b => b.textContent)).toEqual(['Second reply.']);
  });

  it('D — leaving Welly mid-stream keeps the question and strands nothing', async () => {
    const finish = gatedRuntime('Reply nobody waited for.');

    const first = setup();
    await waitForReady();
    await askWelly('asked just before leaving');

    /* Navigating away from /welly unmounts the view. */
    first.unmount();
    await act(async () => { finish(); await Promise.resolve(); });

    /* Coming back mounts it again and reloads from storage. */
    const second = setup();
    await waitFor(() => {
      expect(second.transcript().getByText('asked just before leaving')).toBeInTheDocument();
    });

    /* No placeholder left mid-flight, and no half-written reply. */
    expect(second.container.querySelectorAll('.welly-thinking')).toHaveLength(0);
    const replies = second.bubbles().map(b => b.textContent);
    expect(replies.every(r => r !== '')).toBe(true);
  });
});

describe('a reply the model could not produce', () => {
  it('shows a readable message rather than an error object', async () => {
    runtime.generate = async () => { throw new Error('wasm blew up'); };

    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    await waitFor(() => expect(t.bubbles()).toHaveLength(1));
    const shown = t.bubbles()[0].textContent;
    expect(shown).not.toMatch(/wasm|Error|stack/i);
    expect(shown.length).toBeGreaterThan(0);
  });
});

/**
 * How much work a turn costs the device.
 *
 * Each write is a `JSON.stringify` over up to thirty stored conversations, and
 * `refreshConversations()` reads, parses and sorts the same list straight
 * afterwards. Doing that per token is what made a long reply stutter on a
 * phone; doing it zero times is what lost the question. The number that is
 * both correct and cheap is two.
 */
describe('the cost of a turn', () => {
  it('writes twice per turn regardless of how many fragments arrive', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} about volunteering.`).join(' ');
    runtime.queue(long);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const t = setup();
    await waitForReady();

    setItem.mockClear();
    await askWelly('tell me something at length');
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));

    const conversationWrites = setItem.mock.calls.filter(([key]) => key.startsWith('wev-ai-conversations-'));
    /* Once for the question, once for the answer. The reply arrived in far more
       fragments than that — assert it, or this passes for the wrong reason. */
    expect(runtime.calls).toHaveLength(1);
    expect(long.split(/(?<=\s)/).length).toBeGreaterThan(60);
    expect(conversationWrites).toHaveLength(2);

    setItem.mockRestore();
  });

  it('writes nothing at all when a conversation is merely opened', async () => {
    runtime.queue('A stored answer.');
    const t = setup();
    await waitForReady();
    await askWelly('something worth storing');
    await waitFor(() => expect(t.bubbles()).toHaveLength(1));

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /new conversation/i })[0]);
    });

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const row = document.querySelector('.welly-sidebar .welly-history-item');
    await act(async () => { fireEvent.click(row); });

    /* Reading a conversation must not stamp `updatedAt` — that reorders the
       history list by browsing it. */
    expect(setItem.mock.calls.filter(([k]) => k.startsWith('wev-ai-conversations-'))).toHaveLength(0);
    setItem.mockRestore();
  });
});
