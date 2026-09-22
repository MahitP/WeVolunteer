import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Sometimes it defaults to Welly Chat for some reason even if im on AI mode."
 *
 * ── Not sometimes, and not random ──
 *
 * `runtimeRef.current` is assigned only once the model has finished loading,
 * and `ask` falls back to Welly Chat for anything else. So every question asked
 * during the load was answered by Chat, silently, under a pill that said
 * "Starting up". The Advanced model takes the better part of a minute cold,
 * which is exactly the window somebody types in.
 *
 * ── And a second engine while the first was still building ──
 *
 * `loadRuntime` is called from mount, the mode control, the retry button and a
 * `storage` event from another tab. Two overlapping calls both saw
 * `runtimeRef.current` still null and each built an engine; the later
 * assignment won and the earlier one stayed loaded and unreachable. React's
 * StrictMode double-invokes effects, so this happened on every mount in
 * development — 1.4 GB of weights leaked per mount with the Advanced model.
 */

const created = vi.hoisted(() => ({ count: 0 }));
const gate = vi.hoisted(() => ({ release: null, promise: null }));

const runtime = vi.hoisted(() => ({
  status: 'idle',
  load: vi.fn(),
  unload: vi.fn(async () => {}),
  generate: vi.fn(async () => 'A conversational reply from the model.'),
  lastFinishReason: 'stop',
}));

vi.mock('../ai', async () => {
  const types = await import('../ai/runtime/types.js');
  runtime.load = vi.fn(async () => { await gate.promise; runtime.status = types.AIStatus.READY; });
  return {
    AIStatus: types.AIStatus,
    isAbort: types.isAbort,
    isLocalAIEnabled: () => true,
    detectCapability: () => ({ supported: true, reason: null }),
    offerableModels: () => [{ id: 'test-model', label: 'Test model', bytes: 1000 }],
    modelById: id => (id ? { id, label: 'Test model', bytes: 1000 } : null),
    createRuntime: async () => { created.count += 1; return runtime; },
    aiStorage: async () => ({ downloadModel: async () => {} }),
    formatBytes: n => `${n} B`,
  };
});

vi.mock('../utils/api', () => ({
  api: {
    fetchVolunteerStats: vi.fn().mockResolvedValue(null),
    fetchCertificates: vi.fn().mockResolvedValue([]),
    fetchOrganizations: vi.fn().mockResolvedValue([]),
    fetchApplications: vi.fn().mockResolvedValue([]),
    fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [], pagination: { total: 0 } }),
    verifyCertificate: vi.fn(),
  },
}));

const { default: WellyView } = await import('./WellyView.jsx');
const { writePreferences } = await import('../ai/preferences.js');

let seq = 0;
const show = () => render(
  <MemoryRouter>
    <WellyView currentUser={{ id: `stu-wait-${++seq}`, name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
  </MemoryRouter>,
);

const askQuestion = text => {
  fireEvent.change(screen.getByLabelText(/ask welly a question/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send question to welly/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  created.count = 0;
  runtime.status = 'idle';
  gate.promise = new Promise(resolve => { gate.release = resolve; });
  writePreferences({ enabled: true, modelId: 'test-model' });
});

describe('a question asked while the model is loading', () => {
  it('waits for Welly AI rather than quietly answering as Welly Chat', async () => {
    show();
    await waitFor(() => expect(runtime.load).toHaveBeenCalled());

    /* Typed mid-load, which is the reported situation. */
    askQuestion('do you think volunteering is worth it');

    /* Nothing has been asked of the model, because it is not ready — and
       crucially, Welly Chat has not answered in its place either. */
    expect(runtime.generate).not.toHaveBeenCalled();

    gate.release();

    await waitFor(() => expect(runtime.generate).toHaveBeenCalledTimes(1));
    const shown = await screen.findAllByText(/A conversational reply from the model/);
    expect(shown.length).toBeGreaterThan(0);
  });

  it('does not wait when the reader has not turned Welly AI on', async () => {
    /* With it off there is nothing to wait for, and a question must not hang
       behind a load that is never going to happen.

       `modelId` is KEPT rather than cleared, which is the state switching to
       Welly Chat actually produces — `selectMode` writes `{enabled: false}`
       and leaves the chosen model alone. The earlier fixture cleared it, so
       `enabled` was never the thing under test: dropping that half of the
       guard left this case green. */
    window.localStorage.clear();
    writePreferences({ enabled: false, modelId: 'test-model' });
    show();

    askQuestion('how many hours do I have');

    const shown = await screen.findAllByText(/couldn.t look that up|verified hours/i);
    expect(shown.length).toBeGreaterThan(0);
    expect(runtime.generate).not.toHaveBeenCalled();
  });
});

describe('two loads cannot build two engines', () => {
  it('serialises overlapping calls', async () => {
    show();
    await waitFor(() => expect(runtime.load).toHaveBeenCalled());

    /* A retry landing while the first load is still gated. Before the chain,
       both calls saw a null ref and each built an engine. */
    fireEvent.click(screen.getAllByRole('button', { name: /Answering with Welly/i })[0]);
    const retryish = screen.queryByRole('button', { name: /Try again/i });
    if (retryish) fireEvent.click(retryish);

    gate.release();
    await waitFor(() => expect(runtime.status).toBe('ready'));

    /* One engine per completed load, never two at once. StrictMode is not on in
       this render, so the honest assertion is that nothing overlapped. */
    expect(created.count).toBeLessThanOrEqual(1);
  });
});

/**
 * The same defect, reached through the mode control instead of a reload.
 *
 * ── Why the existing cases could not see it ──
 *
 * Both start with `enabled: true` already in storage, so `prefs` is correct at
 * mount and `send`'s closure is correct with it. The reported window is the
 * other one: Welly Chat is on, the reader switches to Welly AI, and types while
 * the model is still arriving.
 *
 * `send` is `useCallback(..., [busy, messages, position, currentUser, navigate])`
 * and reads `prefs.enabled` to decide whether to wait for the load. `prefs` is
 * not in that array. On an EMPTY conversation nothing else in it changes when
 * the mode is switched — `messages` is still empty, `busy` is still false — so
 * `send` keeps the closure it had when Welly AI was off, skips the wait, and
 * `ask` is handed a null runtime. The question is answered by Welly Chat under
 * a pill that says "Starting Welly AI", which is the exact behaviour
 * `engineWait` was written to remove.
 *
 * Found by the post-closeout sweep of R-12, which named the dependency array.
 */
describe('switching to Welly AI and typing before it has loaded', () => {
  it('waits for the engine the reader just chose', async () => {
    /* Welly Chat at mount — the state the defect needs. */
    window.localStorage.clear();
    writePreferences({ enabled: false, modelId: 'test-model' });
    show();

    /* Switch to Welly AI through the control, on an empty conversation. */
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Answering with Welly/i })[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Welly AI/ })[0]);
    });
    await waitFor(() => expect(runtime.load).toHaveBeenCalled());

    /* Typed while the load is still gated. */
    askQuestion('do you think volunteering is worth it');

    /* Let everything that is going to settle, settle. Without this the
       assertion below runs before Welly Chat has committed its answer and
       passes for the wrong reason. */
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(
      runtime.generate,
      'the model was asked before it was ready',
    ).not.toHaveBeenCalled();
    /* And Welly Chat must not have answered in its place. This is the
       assertion that fails without the fix: the transcript carried Chat's
       refusal — "I can't help with that one. I can look up opportunities…" —
       under a pill reading "Welly AI · Running on this device". */
    expect(
      document.body.textContent,
      'Welly Chat answered while the pill said Welly AI',
    ).not.toMatch(/I can.t help with that one/i);

    gate.release();

    await waitFor(() => expect(runtime.generate).toHaveBeenCalledTimes(1));
    const shown = await screen.findAllByText(/A conversational reply from the model/);
    expect(shown.length).toBeGreaterThan(0);
  });
});
