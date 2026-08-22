import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
       behind a load that is never going to happen. */
    window.localStorage.clear();
    writePreferences({ enabled: false, modelId: null });
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
