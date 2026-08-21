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

describe('a stream belongs to the conversation it was asked in', () => {
  it('does not drop a late reply into a different transcript', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });

    /* A generation that does not finish until the test says so. */
    runtime.generate = async (messages, { onToken } = {}) => {
      runtime.calls.push({ messages });
      onToken?.('Late ');
      await gate;
      onToken?.('answer.');
      return 'Late answer.';
    };

    const t = setup();
    await waitForReady();
    await askWelly(CHATTY);

    /* Switch away while it is still generating. */
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /new conversation/i })[0]);
    });
    expect(screen.getByText(/Hi, Maya!/i)).toBeInTheDocument();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    /* The new conversation is still empty: nothing from the old turn arrived. */
    await waitFor(() => expect(t.bubbles()).toHaveLength(0));
    expect(screen.getByText(/Hi, Maya!/i)).toBeInTheDocument();
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
