import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AIStatus } from '../ai/runtime/types.js';

/**
 * What the page does when somebody picks a mode.
 *
 * `WellyModeControl.test.jsx` covers the panel: two buttons, which one is
 * marked, when they are disabled, and that a choice is reported rather than
 * acted on. This is the other half — the page owns the preference and the
 * runtime, so this is where a switch either happens or does not.
 *
 * ── The case worth having a file for ──
 *
 * The first time somebody picks Welly AI there is nothing on the device to
 * switch on. Writing `enabled: true` in that state is the quiet failure:
 * `loadRuntime` finds no model, falls straight through to IDLE, and the control
 * goes back to saying Welly Chat with no explanation of why the thing they just
 * clicked did not happen. So that click goes to Settings, where the download
 * lives — which is also the rule the mode control exists to enforce, that this
 * page never grows a second copy of the model-management flow.
 */

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal()),
  useNavigate: () => navigateMock,
}));

const runtime = vi.hoisted(() => ({
  status: 'idle',
  load: vi.fn(async () => {}),
  unload: vi.fn(async () => {}),
  generate: vi.fn(async () => 'hello'),
}));

const createRuntime = vi.hoisted(() => vi.fn(async () => runtime));

vi.mock('../ai', async () => {
  const types = await import('../ai/runtime/types.js');
  return {
    AIStatus: types.AIStatus,
    isAbort: types.isAbort,
    isLocalAIEnabled: () => true,
    detectCapability: () => ({ supported: true, reason: null }),
    offerableModels: () => [{ id: 'test-model', label: 'Test model', bytes: 1000 }],
    modelById: id => (id ? { id, label: 'Test model', bytes: 1000 } : null),
    createRuntime,
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
const { readPreferences, writePreferences } = await import('../ai/preferences.js');

/* A fresh id per test: conversation.js keeps a module-level store that
   localStorage.clear() does not reach. See WellyView.location.test.jsx. */
let seq = 0;
const show = () => render(
  <MemoryRouter>
    <WellyView currentUser={{ id: `stu-mode-${++seq}`, name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
  </MemoryRouter>,
);

const openPanel = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /Answering with Welly/i })[0]);
  });
};

const option = name =>
  screen.getAllByRole('button', { name: new RegExp(`^${name}`) })[0];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  runtime.status = AIStatus.READY;
});

describe('picking Welly AI for the first time', () => {
  it('goes to the download rather than switching a preference nothing backs', async () => {
    show();
    await openPanel();
    await act(async () => { fireEvent.click(option('Welly AI')); });

    /* The section as well as the fragment — Settings reads its section from the
       query, and without it this opens on Appearance where the card is not
       mounted. */
    expect(navigateMock).toHaveBeenCalledWith('/settings?section=privacy#welly-ai');
    /* And nothing was switched on behind it. */
    expect(readPreferences().enabled).toBe(false);
  });
});

describe('picking Welly AI when it is already downloaded', () => {
  beforeEach(() => {
    writePreferences({ enabled: false, modelId: 'test-model' });
  });

  it('switches it on and loads the runtime, without leaving the page', async () => {
    show();
    await openPanel();
    await act(async () => { fireEvent.click(option('Welly AI')); });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(readPreferences().enabled).toBe(true);
    await waitFor(() => expect(runtime.load).toHaveBeenCalled());
  });
});

describe('switching back to Welly Chat', () => {
  beforeEach(() => {
    writePreferences({ enabled: true, modelId: 'test-model' });
  });

  it('switches it off and unloads, keeping the downloaded model', async () => {
    show();
    await waitFor(() => expect(runtime.load).toHaveBeenCalled());

    await openPanel();
    await act(async () => { fireEvent.click(option('Welly Chat')); });

    expect(readPreferences().enabled).toBe(false);
    /* `modelId` survives. Switching off is not removing — removal is in
       Settings, with the storage accounting that belongs to it. */
    expect(readPreferences().modelId).toBe('test-model');
    await waitFor(() => expect(runtime.unload).toHaveBeenCalled());
  });

  it('leaves Welly answering, just without the model', async () => {
    show();
    await waitFor(() => expect(runtime.load).toHaveBeenCalled());
    await openPanel();
    await act(async () => { fireEvent.click(option('Welly Chat')); });

    fireEvent.change(screen.getByLabelText(/ask welly a question/i), {
      target: { value: 'how many hours do I have' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send question to welly/i }));

    const found = await screen.findAllByText(/You do not have any verified hours yet/);
    expect(found.length).toBeGreaterThan(0);
    expect(runtime.generate).not.toHaveBeenCalled();
  });
});
