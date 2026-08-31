import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AIStatus } from '../ai/runtime/types.js';
import { modelForTier } from '../ai/models.js';

/**
 * Which model the page actually loads, and what it says while it is loading it.
 *
 * ── Why this file exists ──
 *
 * Reported: the Advanced model would not start, while Balanced did. Two things
 * had to be true for that report to be answerable, and neither was tested:
 *
 *   1. Choosing Advanced loads Advanced. A "fix" that quietly loaded the
 *      smaller model would satisfy every symptom and none of the request, so
 *      the model id handed to the runtime is asserted by name here.
 *   2. A failure to start says why. The runtime works the reason out —
 *      out of memory, a failed download, a damaged copy on the device — and it
 *      was thrown away by a bare catch until this page started carrying it.
 *
 * The runtime itself is faked; `WllamaRuntime.load.test.js` covers the real one
 * against a fake wllama. What is under test here is the page's lifecycle.
 */

const BALANCED = modelForTier('balanced');
const ADVANCED = modelForTier('advanced');

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal()),
  useNavigate: () => navigateMock,
}));

/**
 * A runtime that records which model it was asked for, and can be told to fail
 * or to report download progress.
 */
const runtime = vi.hoisted(() => ({
  status: 'idle',
  loadedIds: [],
  failNext: null,
  progress: null,
  /** Set to a promise to hold a load open, so a mid-load state can be read. */
  hold: null,
  load: vi.fn(async function load(model, { onProgress } = {}) {
    if (runtime.progress) runtime.progress.forEach(p => onProgress?.(p));
    if (runtime.hold) await runtime.hold;
    if (runtime.failNext) {
      const err = runtime.failNext;
      runtime.failNext = null;
      throw err;
    }
    runtime.loadedIds.push(model.id);
  }),
  unload: vi.fn(async () => {}),
  generate: vi.fn(async () => 'hello'),
}));

const createRuntime = vi.hoisted(() => vi.fn(async () => runtime));

vi.mock('../ai', async () => {
  const types = await import('../ai/runtime/types.js');
  const models = await import('../ai/models.js');
  return {
    AIStatus: types.AIStatus,
    isAbort: types.isAbort,
    isLocalAIEnabled: () => true,
    /* A machine that can run everything, so the picker is not the thing under
       test here. */
    detectCapability: () => ({
      supported: true, reason: null, recommendedTier: 'advanced',
      maxBytes: Number.POSITIVE_INFINITY, webgpu: true, isIOS: false, deviceMemoryGB: 8,
    }),
    offerableModels: () => models.MODELS.filter(m => m.conversational),
    modelById: models.modelById,
    createRuntime,
    aiStorage: async () => ({ downloadModel: async () => {} }),
    formatBytes: models.formatBytes,
  };
});

vi.mock('../utils/api', async () => {
  const { withHours } = await import('../testFixtures/volunteerStats.js');
  return {
    api: {
      fetchVolunteerStats: vi.fn().mockResolvedValue(withHours(0, 0)),
      fetchCertificates: vi.fn().mockResolvedValue([]),
      fetchOrganizations: vi.fn().mockResolvedValue([]),
      fetchApplications: vi.fn().mockResolvedValue([]),
      fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [], pagination: { total: 0 } }),
      verifyCertificate: vi.fn(),
    },
  };
});

const { default: WellyView } = await import('./WellyView.jsx');
const { writePreferences } = await import('../ai/preferences.js');
const { AIRuntimeError } = await import('../ai/runtime/types.js');

let seq = 0;
const show = () => render(
  <MemoryRouter>
    <WellyView currentUser={{ id: `stu-switch-${++seq}`, name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
  </MemoryRouter>,
);

/**
 * What the mode control is saying, read from its accessible name.
 *
 * Not from `textContent`: the page draws this control twice — once in the
 * header and once in the mobile bar — and the compact one omits the detail
 * text. The accessible name carries it in both, which is the point of putting
 * it there.
 */
const modeButton = () => screen.getAllByRole('button', { name: /Answering with Welly/i })[0];
const modeSays = () => modeButton().getAttribute('aria-label') || '';

const openPanel = async () => {
  await act(async () => { fireEvent.click(modeButton()); });
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  runtime.status = AIStatus.READY;
  runtime.loadedIds = [];
  runtime.failNext = null;
  runtime.progress = null;
  runtime.hold = null;
});

describe('starting the Advanced model', () => {
  it('loads the Advanced model, and not a smaller one', async () => {
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(runtime.load).toHaveBeenCalled());
    expect(runtime.loadedIds).toEqual([ADVANCED.id]);
    expect(runtime.load.mock.calls[0][0].parameters).toBe('1.5B');
  });

  it('reports it as running once it is, and answers', async () => {
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(runtime.load).toHaveBeenCalled());
    await waitFor(() => expect(modeSays()).toMatch(/Running on this device/i));

    fireEvent.change(screen.getByLabelText(/ask welly a question/i), {
      target: { value: 'how many hours do I have' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send question to welly/i }));

    const found = await screen.findAllByText(/You do not have any verified hours yet/);
    expect(found.length).toBeGreaterThan(0);
  });

  /**
   * The long wait, named. Fetching nearly a gigabyte and initialising it are
   * different waits, and they shared one caption — so a model being downloaded
   * again after an incomplete transfer was indistinguishable from a hang.
   */
  it('says it is downloading while the weights are still arriving', async () => {
    /* The load is held open, because "downloading" is a state that only exists
       while it is true — a fake that resolves at once would be READY before
       anything could read it. */
    let release;
    runtime.hold = new Promise(resolve => { release = resolve; });
    runtime.progress = [{ loaded: 1024, total: ADVANCED.bytes }];
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(runtime.load).toHaveBeenCalled());
    await waitFor(() => expect(modeSays()).toMatch(/Downloading the model/i));

    await act(async () => { release(); });
    await waitFor(() => expect(modeSays()).toMatch(/Running on this device/i));
  });

  it('does not claim a download for a model already on the device', async () => {
    /* `getModelOrDownload` reports once with loaded === total for a cached
       model. That is not a transfer and must not be captioned as one. */
    runtime.progress = [{ loaded: ADVANCED.bytes, total: ADVANCED.bytes }];
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(runtime.load).toHaveBeenCalled());
    await waitFor(() => expect(modeSays()).toMatch(/Running on this device/i));
    expect(modeSays()).not.toMatch(/Downloading/i);
  });
});

describe('when the Advanced model cannot start', () => {
  it('says why, in the runtime’s own words', async () => {
    runtime.failNext = new AIRuntimeError('wasm allocation failed', {
      userMessage: 'This device ran out of memory loading that model. Try a smaller one from Settings.',
    });
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(modeSays()).toMatch(/didn’t start/i));
    await openPanel();
    expect(screen.getByText(/ran out of memory loading that model/i)).toBeInTheDocument();
    /* And names which model, so somebody with two installed knows which. */
    expect(screen.getByText(/Advanced model/i)).toBeInTheDocument();
  });

  /**
   * The failure must not be papered over by quietly loading the smaller model.
   * That would make every symptom disappear and answer none of the request.
   */
  it('does not silently fall back to the Balanced model', async () => {
    runtime.failNext = new AIRuntimeError('boom', { userMessage: 'No.' });
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(modeSays()).toMatch(/didn’t start/i));
    expect(runtime.loadedIds).toEqual([]);
    expect(runtime.load.mock.calls.every(([m]) => m.id === ADVANCED.id)).toBe(true);
  });

  it('can be retried, and starts when the retry succeeds', async () => {
    runtime.failNext = new AIRuntimeError('boom', { userMessage: 'No.' });
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();

    await waitFor(() => expect(modeSays()).toMatch(/didn’t start/i));

    await openPanel();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again/i })); });

    await waitFor(() => expect(runtime.loadedIds).toEqual([ADVANCED.id]));
    await waitFor(() => expect(modeSays()).toMatch(/Running on this device/i));
  });
});

describe('moving between the two models', () => {
  /**
   * Balanced, then Advanced, then Advanced again after a visit to Balanced.
   * The last of those is the one the report is about: returning to Advanced
   * has to load Advanced, not whatever was loaded most recently.
   */
  it('loads whichever model the preference names, each time it changes', async () => {
    writePreferences({ enabled: true, modelId: BALANCED.id });
    show();
    await waitFor(() => expect(runtime.loadedIds).toEqual([BALANCED.id]));

    /* Settings is the other place this changes, and it fires a `storage`
       event in this tab's siblings — which is the path the page listens on. */
    await act(async () => {
      writePreferences({ enabled: true, modelId: ADVANCED.id });
      window.dispatchEvent(new StorageEvent('storage', { key: 'wev-ai-prefs' }));
    });
    await waitFor(() => expect(runtime.loadedIds).toEqual([BALANCED.id, ADVANCED.id]));

    await act(async () => {
      writePreferences({ enabled: true, modelId: BALANCED.id });
      window.dispatchEvent(new StorageEvent('storage', { key: 'wev-ai-prefs' }));
    });
    await waitFor(() => expect(runtime.loadedIds).toEqual([BALANCED.id, ADVANCED.id, BALANCED.id]));

    await act(async () => {
      writePreferences({ enabled: true, modelId: ADVANCED.id });
      window.dispatchEvent(new StorageEvent('storage', { key: 'wev-ai-prefs' }));
    });
    await waitFor(() => expect(runtime.loadedIds).toEqual([
      BALANCED.id, ADVANCED.id, BALANCED.id, ADVANCED.id,
    ]));
  });

  /**
   * One engine at a time. The previous one is released before the next is
   * built — on these sizes a leaked engine is most of a gigabyte held inside a
   * browser tab with no way to reach it.
   */
  it('releases the previous engine before loading the next', async () => {
    writePreferences({ enabled: true, modelId: BALANCED.id });
    show();
    await waitFor(() => expect(runtime.loadedIds).toEqual([BALANCED.id]));

    const unloadsBefore = runtime.unload.mock.calls.length;
    await act(async () => {
      writePreferences({ enabled: true, modelId: ADVANCED.id });
      window.dispatchEvent(new StorageEvent('storage', { key: 'wev-ai-prefs' }));
    });
    await waitFor(() => expect(runtime.loadedIds).toEqual([BALANCED.id, ADVANCED.id]));
    expect(runtime.unload.mock.calls.length).toBeGreaterThan(unloadsBefore);
  });

  it('switches off without forgetting which model is installed', async () => {
    writePreferences({ enabled: true, modelId: ADVANCED.id });
    show();
    await waitFor(() => expect(runtime.loadedIds).toEqual([ADVANCED.id]));

    await openPanel();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^Welly Chat/ })[0]);
    });

    const { readPreferences } = await import('../ai/preferences.js');
    expect(readPreferences().enabled).toBe(false);
    expect(readPreferences().modelId).toBe(ADVANCED.id);
  });
});
