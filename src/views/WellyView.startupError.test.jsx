import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Saying why Welly AI did not start.
 *
 * ── The report ──
 *
 * "the Advanced Model isnt starting up it says 'Model couldnt start up using
 * Chat'" — followed by a transcript of Welly answering badly, which is what
 * Welly Chat sounds like: every reply in it is one of the written fallbacks,
 * because there was no model behind them.
 *
 * ── The diagnosis existed and had no route to the screen ──
 *
 * `asRuntimeError` in WllamaRuntime already separates the two failures worth
 * distinguishing and writes a sentence for each:
 *
 *   out of memory  → "This device ran out of memory loading that model. Try a
 *                     smaller one from Settings."
 *   download       → "The model could not be downloaded. Check your connection
 *                     and try again."
 *
 * `loadRuntime` then caught it with a bare `catch {}` and set ERROR. So the
 * message that says which of those happened, and what to do, was constructed
 * on every failure and thrown away every time — leaving "Welly AI didn't
 * start", which names the symptom the reader can already see.
 *
 * The Advanced model is 986 MB against Balanced's 469, so out-of-memory is the
 * likely one, and it is the one with a next step: pick the smaller model. That
 * sentence has to reach the panel.
 */

const loadMock = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({
  status: 'idle',
  load: null,
  unload: vi.fn(async () => {}),
  generate: vi.fn(async () => 'hi'),
}));

vi.mock('../ai', async () => {
  const types = await import('../ai/runtime/types.js');
  runtime.load = loadMock;
  return {
    AIStatus: types.AIStatus,
    isAbort: types.isAbort,
    isLocalAIEnabled: () => true,
    detectCapability: () => ({ supported: true, reason: null }),
    offerableModels: () => [{ id: 'advanced', label: 'Advanced', bytes: 986048768 }],
    modelById: id => (id ? { id, label: 'Advanced', bytes: 986048768 } : null),
    createRuntime: async () => runtime,
    aiStorage: async () => ({ downloadModel: async () => {} }),
    formatBytes: n => `${n} B`,
  };
});

vi.mock('../utils/api', async () => {
  /* Imported INSIDE the factory. `vi.mock` is hoisted above every top-level
     import, so a `withHours` imported at the top of the file is still in its
     temporal dead zone when this runs. */
  const { withHours } = await import('../testFixtures/volunteerStats.js');
  return ({
  api: {
    fetchVolunteerStats: vi.fn().mockResolvedValue(withHours(0, 0)),
    fetchCertificates: vi.fn().mockResolvedValue([]),
    fetchOrganizations: vi.fn().mockResolvedValue([]),
    fetchApplications: vi.fn().mockResolvedValue([]),
    fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [], pagination: { total: 0 } }),
    verifyCertificate: vi.fn(),
  },
  });
});

const { default: WellyView } = await import('./WellyView.jsx');
const { AIRuntimeError } = await import('../ai/runtime/types.js');
const { writePreferences } = await import('../ai/preferences.js');

let seq = 0;
const show = () => render(
  <MemoryRouter>
    <WellyView currentUser={{ id: `stu-err-${++seq}`, name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
  </MemoryRouter>,
);

const openPanel = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /Answering with Welly/i })[0]);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  writePreferences({ enabled: true, modelId: 'advanced' });
});

describe('when the model does not start', () => {
  it('shows the reason the runtime gave, not just that it failed', async () => {
    loadMock.mockRejectedValue(new AIRuntimeError('WebAssembly.Memory allocation failed', {
      userMessage: 'This device ran out of memory loading that model. Try a smaller one from Settings.',
    }));

    show();
    await waitFor(() => expect(loadMock).toHaveBeenCalled());
    await openPanel();

    expect(screen.getByText(/ran out of memory loading that model/i)).toBeInTheDocument();
    /* And which model it was, because a reader with two installed over time has
       no other way to tell which one this is about. */
    expect(screen.getByText(/Advanced model/i)).toBeInTheDocument();
  });

  it('distinguishes a failed download from a device that is too small', async () => {
    loadMock.mockRejectedValue(new AIRuntimeError('Failed to fetch', {
      userMessage: 'The model could not be downloaded. Check your connection and try again.',
    }));

    show();
    await waitFor(() => expect(loadMock).toHaveBeenCalled());
    await openPanel();

    expect(screen.getByText(/could not be downloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/ran out of memory/i)).toBeNull();
  });

  it('falls back to the generic line when the failure carried no message', async () => {
    loadMock.mockRejectedValue(new Error('something with no userMessage'));

    show();
    await waitFor(() => expect(loadMock).toHaveBeenCalled());
    await openPanel();

    expect(screen.getByText(/could not start on this device/i)).toBeInTheDocument();
    /* Never the raw technical text. See AIRuntimeError. */
    expect(screen.queryByText(/no userMessage/)).toBeNull();
  });

  it('clears the reason once a retry succeeds', async () => {
    loadMock.mockRejectedValueOnce(new AIRuntimeError('boom', {
      userMessage: 'This device ran out of memory loading that model. Try a smaller one from Settings.',
    }));
    loadMock.mockResolvedValue(undefined);

    show();
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
    await openPanel();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Try again/i })); });

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Answering with Welly AI/i }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/ran out of memory/i)).toBeNull();
  });

  it('still answers from the records while the model is down', async () => {
    /* The failure must cost the conversation and nothing else. Every lookup is
       deterministic and does not involve the runtime at all. */
    loadMock.mockRejectedValue(new AIRuntimeError('boom', { userMessage: 'No memory.' }));
    show();
    await waitFor(() => expect(loadMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/ask welly a question/i), {
      target: { value: 'how many hours do I have' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send question to welly/i }));

    const found = await screen.findAllByText(/You do not have any verified hours yet/);
    expect(found.length).toBeGreaterThan(0);
  });
});
