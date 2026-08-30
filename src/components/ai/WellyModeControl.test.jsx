import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AIStatus } from '../../ai/runtime/types.js';

/**
 * What the control says, against every configuration it can be in.
 *
 * ── Why the whole matrix and not the happy path ──
 *
 * This is the one component that tells a reader which engine is answering, and
 * the failure that matters is the one where it says something the configuration
 * does not support. That already happened once: the control did not consult
 * `isLocalAIEnabled()`, so a build made with `VITE_LOCAL_AI=false` — which
 * ships none of the runtime — still named Welly AI, described it, and linked to
 * a Settings card that renders nothing in that build.
 *
 * The flag-off case therefore lives in `disabledPath.test.jsx`, where the whole
 * suite mocks the flag off. Everything below is the flag-on matrix.
 */

vi.mock('../../ai', async importOriginal => ({
  ...(await importOriginal()),
  isLocalAIEnabled: () => true,
}));

const { default: WellyModeControl, modeFor } = await import('./WellyModeControl.jsx');

const SUPPORTED = { supported: true, reason: null };
const UNSUPPORTED = {
  supported: false,
  reason: 'The assistant needs more memory than this device can give a web page.',
};
const INSTALLED = { enabled: true, modelId: 'qwen2.5-0.5b-instruct-q4km' };
const NOT_INSTALLED = { enabled: false, modelId: null };
/* Downloaded, then switched off. `modelId` survives the switch — it records
   what is on the device, and `enabled` records whether it is being used. That
   distinction is the whole difference between switching on and downloading. */
const INSTALLED_OFF = { enabled: false, modelId: 'qwen2.5-0.5b-instruct-q4km' };

const show = props => render(
  <MemoryRouter><WellyModeControl capability={SUPPORTED} prefs={NOT_INSTALLED} status={AIStatus.IDLE} {...props} /></MemoryRouter>,
);

/* Open the panel. The trigger's name carries the current mode, which is the
   thing under test in half these cases, so it is matched loosely here. */
const openPanel = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Answering with Welly/i }));
  });
};

/**
 * An option inside the panel, by the name it starts with.
 *
 * Anchored, because the trigger's accessible name also contains both product
 * names — "Answering with Welly Chat. …" — and an unanchored /Welly AI/ matches
 * the control that opened the panel as well as the option inside it.
 */
const option = name => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('what the control reports, per configuration', () => {
  const CASES = [
    {
      name: 'device cannot run it',
      props: { capability: UNSUPPORTED, prefs: NOT_INSTALLED, status: AIStatus.IDLE },
      label: 'Welly Chat',
      detail: /can’t run Welly AI/i,
    },
    {
      name: 'supported, nothing installed',
      props: { capability: SUPPORTED, prefs: NOT_INSTALLED, status: AIStatus.IDLE },
      label: 'Welly Chat',
      detail: /available/i,
    },
    {
      name: 'installed, still starting',
      props: { capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.LOADING },
      label: 'Welly AI',
      detail: /Starting up/i,
    },
    {
      /* Distinct from "Starting up": this is the several-hundred-megabyte
         wait, and a reader told it is downloading knows to leave the tab
         open. See the DOWNLOADING branch in `modeFor`. */
      name: 'installed, downloading',
      props: { capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.DOWNLOADING },
      label: 'Welly AI',
      detail: /Downloading the model/i,
    },
    {
      name: 'ready',
      props: { capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.READY },
      label: 'Welly AI',
      detail: /Running on this device/i,
    },
    {
      name: 'failed to start',
      props: { capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.ERROR },
      label: 'Welly Chat',
      detail: /didn’t start/i,
    },
  ];

  for (const { name, props, label, detail } of CASES) {
    it(`${name} → ${label}`, () => {
      const mode = modeFor(props);
      expect(mode.label).toBe(label);
      expect(mode.detail).toMatch(detail);

      show(props);
      /* The state is in the accessible name too, not only in the glyph. */
      const button = screen.getByRole('button', { name: new RegExp(`Answering with ${label}`, 'i') });
      expect(button).toBeInTheDocument();
    });
  }

  it('never claims Welly AI is answering while it is only installed', () => {
    /* Installed is not running. The runtime has to reach READY, and until it
       does the answer is coming from Welly Chat. */
    expect(modeFor({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.IDLE }).id)
      .not.toBe('ai');
    expect(modeFor({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.ERROR }).id)
      .toBe('chat');
  });
});

describe('what the panel offers', () => {
  it('explains both engines and links to the flow that manages the model', async () => {
    show({ capability: SUPPORTED, prefs: NOT_INSTALLED, status: AIStatus.IDLE });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Answering with Welly Chat/i }));
    });

    expect(screen.getByText(/Answers from your WeVolunteer records/i)).toBeInTheDocument();
    expect(screen.getByText(/runs on your own device/i)).toBeInTheDocument();

    /* Settings owns model management; this is a way in, not a second copy. The
       section matters as much as the fragment — Settings reads its section from
       the query, and without it the link opens on Appearance. */
    expect(screen.getByRole('link', { name: /Set up Welly AI/i }))
      .toHaveAttribute('href', '/settings?section=privacy#welly-ai');
  });

  it('says manage rather than set up once a model is running', async () => {
    show({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.READY });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Answering with Welly AI/i }));
    });
    expect(screen.getByRole('link', { name: /Manage Welly AI/i })).toBeInTheDocument();
  });

  it('offers a retry, and only when starting actually failed', async () => {
    const onRetry = vi.fn();
    const { unmount } = show({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.ERROR, onRetry });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Answering with Welly Chat/i }));
    });
    expect(screen.getByText(/couldn’t start on this device/i)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Try again/i })); });
    expect(onRetry).toHaveBeenCalled();
    unmount();

    show({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.READY, onRetry });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Answering with Welly AI/i }));
    });
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull();
  });

  it('gives the device reason rather than a bare refusal when it cannot run', async () => {
    show({ capability: UNSUPPORTED, prefs: NOT_INSTALLED, status: AIStatus.IDLE });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Answering with Welly Chat/i }));
    });
    expect(screen.getByText(/needs more memory than this device/i)).toBeInTheDocument();
    /* And no offer to set up something this device cannot run. */
    expect(screen.queryByRole('link', { name: /Set up Welly AI/i })).toBeNull();
  });
});

describe('switching between the two', () => {
  /**
   * ── Why the options are buttons ──
   *
   * They were captioned paragraphs with a tick beside whichever was in use.
   * Reported: "the mode dropdown should let you click between On-Device/Local
   * AI to switch seamlessly". A panel that lists two options, marks one, and
   * cannot be used to pick the other reads as broken rather than as
   * informative.
   *
   * The control does not switch anything itself. It reports the choice; the
   * page owns the preference and the runtime, which is what keeps this from
   * becoming a second copy of the model-management flow.
   * `WellyView.mode.test.jsx` covers what the page then does — including the
   * first-time case, where there is nothing installed to switch on and the
   * click has to reach the download instead.
   */
  it('reports a switch to Welly AI when a model is installed', async () => {
    const onSelectMode = vi.fn();
    /* Downloaded and switched off, which is the state a switch back on starts
       from — and is distinct from never having downloaded it. */
    show({ capability: SUPPORTED, prefs: INSTALLED_OFF, status: AIStatus.IDLE, onSelectMode });
    await openPanel();

    await act(async () => { fireEvent.click(option('Welly AI')); });
    expect(onSelectMode).toHaveBeenCalledWith('ai');
  });

  it('reports a switch back to Welly Chat while Welly AI is running', async () => {
    const onSelectMode = vi.fn();
    show({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.READY, onSelectMode });
    await openPanel();

    await act(async () => { fireEvent.click(option('Welly Chat')); });
    expect(onSelectMode).toHaveBeenCalledWith('chat');
  });

  it('does nothing when the option already in use is clicked', async () => {
    const onSelectMode = vi.fn();
    show({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.READY, onSelectMode });
    await openPanel();

    await act(async () => { fireEvent.click(option('Welly AI')); });
    expect(onSelectMode).not.toHaveBeenCalled();
    /* Still closes — a panel left open over an unchanged state is a dead end. */
    expect(screen.queryByText(/How Welly answers/)).toBeNull();
  });

  it('says a download is needed, and still lets the option be picked', async () => {
    /* The click that has nothing to switch on is the one that has to work:
       it is the way in to installing it. Disabling it would leave the panel
       naming a mode with no route to it. */
    const onSelectMode = vi.fn();
    show({ capability: SUPPORTED, prefs: NOT_INSTALLED, status: AIStatus.IDLE, onSelectMode });
    await openPanel();

    expect(screen.getByText(/Needs a one-time download/i)).toBeInTheDocument();
    const aiOption = option('Welly AI');
    expect(aiOption).toBeEnabled();
    await act(async () => { fireEvent.click(aiOption); });
    expect(onSelectMode).toHaveBeenCalledWith('ai');
  });

  it('does not offer Welly AI on a device that cannot run it', async () => {
    const onSelectMode = vi.fn();
    show({ capability: UNSUPPORTED, prefs: NOT_INSTALLED, status: AIStatus.IDLE, onSelectMode });
    await openPanel();

    expect(option('Welly AI')).toBeDisabled();
    /* And no download tag on something that could not run once downloaded. */
    expect(screen.queryByText(/Needs a one-time download/i)).toBeNull();
  });

  it('takes both options away while a runtime is loading', async () => {
    /* Switching mid-load races the load: `loadRuntime` unloads and reloads from
       the preference it reads at the start, so a second call overlapping the
       first can leave the runtime and the caption disagreeing. */
    show({ capability: SUPPORTED, prefs: INSTALLED, status: AIStatus.LOADING, onSelectMode: vi.fn() });
    await openPanel();

    expect(option('Welly Chat')).toBeDisabled();
    expect(option('Welly AI')).toBeDisabled();
  });

  it('is inert rather than broken with no handler', async () => {
    /* Rendered without `onSelectMode` in several tests and, historically, in
       Storybook. A click must not throw. */
    show({ capability: SUPPORTED, prefs: INSTALLED_OFF, status: AIStatus.IDLE });
    await openPanel();
    await act(async () => { fireEvent.click(option('Welly AI')); });
    expect(screen.queryByText(/How Welly answers/)).toBeNull();
  });
});
