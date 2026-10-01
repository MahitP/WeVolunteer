import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The settings surface, driven entirely against mocked storage.
 *
 * The capability fixture says `advanced`, which is what a real 8 GB device
 * now gets. It said `fast` until the smallest model was withdrawn from
 * conversation — a tier real detection can no longer return, so a fixture
 * claiming it was testing a state that cannot occur.
 *
 * Nothing here downloads a model or touches WebAssembly — `aiStorage()` is
 * replaced wholesale. That is the point of the abstraction: the states a
 * student actually sees (unsupported, off, downloading, ready, failed) are
 * reachable in a jsdom test in milliseconds.
 */

const storage = {
  bytesUsed: vi.fn(async () => 0),
  downloadModel: vi.fn(async () => ({ bytes: 105454144 })),
  removeAllModels: vi.fn(async () => {}),
};

let capability = {
  supported: true,
  reason: null,
  recommendedTier: 'advanced',
  maxBytes: Number.POSITIVE_INFINITY,
  webgpu: true,
  isIOS: false,
  deviceMemoryGB: 8,
};

vi.mock('../../ai', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    isLocalAIEnabled: () => true,
    detectCapability: () => capability,
    aiStorage: async () => storage,
  };
});

const { default: AISettingsCard } = await import('./AISettingsCard.jsx');

function renderCard() {
  return render(
    <MemoryRouter>
      <AISettingsCard addToast={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  capability = {
    supported: true,
    reason: null,
    recommendedTier: 'advanced',
    maxBytes: Number.POSITIVE_INFINITY,
    webgpu: true,
    isIOS: false,
    deviceMemoryGB: 8,
  };
});

describe('before anything is set up', () => {
  it('offers setup and downloads nothing on its own', () => {
    renderCard();

    expect(screen.getByRole('button', { name: /set up welly/i })).toBeInTheDocument();
    /* Rendering the panel must not fetch anything. The download begins only
       when somebody chooses a model and confirms. */
    expect(storage.downloadModel).not.toHaveBeenCalled();
  });

  it('names Hugging Face before anybody agrees to a download', () => {
    /**
     * The disclosure that is easiest to omit and least acceptable to omit. The
     * model files come from a third party, which means that company receives a
     * request from this device.
     */
    renderCard();
    expect(screen.getByText(/hugging face/i)).toBeInTheDocument();
  });
});

describe('on a device that cannot run a model', () => {
  it('explains rather than offering a control that cannot work', async () => {
    capability = {
      ...capability,
      supported: false,
      reason: 'This browser cannot run WebAssembly, which the on-device assistant needs.',
      recommendedTier: null,
    };

    renderCard();

    expect(screen.getByText(/cannot run on this device/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot run WebAssembly/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up welly/i })).toBeNull();
  });
});

describe('choosing a model', () => {
  it('marks the recommendation in words, not only with a colour', async () => {
    /**
     * A green ring is invisible to a screen reader and to anyone who cannot
     * distinguish it. The recommendation has to survive being read aloud.
     */
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /set up welly/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('shows a real size and licence for each option', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /set up welly/i }));

    const radios = await screen.findAllByRole('radio');
    expect(radios.length).toBeGreaterThan(0);
    /* Sizes come from the registry, which reads them from the publisher. An
       approximate figure here is a wrong answer to the only question being
       asked. */
    expect(screen.getAllByText(/\d+ MB download/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Apache-2\.0/).length).toBeGreaterThan(0);
  });

  it('downloads the chosen model and remembers it', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /set up welly/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /download .* and turn on/i }));

    await waitFor(() => expect(storage.downloadModel).toHaveBeenCalledTimes(1));

    /* Stored locally, and only locally — no request is made to save it. */
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem('wev-ai-prefs')).enabled).toBe(true);
    });
  });
});

describe('when the download fails', () => {
  it('says so in words a student can act on', async () => {
    storage.downloadModel.mockRejectedValueOnce(
      Object.assign(new Error('boom'), {
        userMessage: 'This device ran out of memory loading that model. Try a smaller one.',
      }),
    );

    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /set up welly/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /download .* and turn on/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ran out of memory/i);
    /* A failed download must not leave the feature reading as switched on. */
    expect(JSON.parse(window.localStorage.getItem('wev-ai-prefs') || '{}').enabled)
      .not.toBe(true);
  });

  it('reports nothing when the student cancelled', async () => {
    /* Cancelling is not a failure. Showing an error would tell somebody
       something went wrong when they were the one who stopped it. */
    storage.downloadModel.mockRejectedValueOnce(
      Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
    );

    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /set up welly/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /download .* and turn on/i }));

    await waitFor(() => expect(storage.downloadModel).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('once a model is installed', () => {
  beforeEach(() => {
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: 'smollm2-135m-instruct-q4km' }),
    );
    storage.bytesUsed.mockResolvedValue(105454144);
  });

  it('reports what is installed and how much space it uses', async () => {
    renderCard();

    expect(screen.getByText('Fast')).toBeInTheDocument();
    expect(await screen.findByText(/using 101 MB on this device/i)).toBeInTheDocument();
  });

  it('defaults conversation history to off', async () => {
    /* Named "Pick up where I left off" since 2026-08-19. The label now says what
       the setting does rather than what it does not do — the old wording
       volunteered that conversations are "never sent to WeVolunteer", which is
       true and is also what made readers wonder whether the other setting sends
       them somewhere. The default itself is unchanged and is what this asserts:
       school computers are shared, and a transcript should not greet whoever
       sits down next. */
    renderCard();
    const toggle = screen.getByRole('checkbox', { name: /pick up where i left off/i });
    expect(toggle).not.toBeChecked();
  });

  it('removes the model and the settings together, behind a confirmation', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /turn off and remove/i }));

    /* Destructive and irreversible without re-downloading, so it asks first. */
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/removes the downloaded model/i);

    fireEvent.click(
      screen.getAllByRole('button', { name: /turn off and remove/i }).at(-1),
    );

    await waitFor(() => expect(storage.removeAllModels).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.localStorage.getItem('wev-ai-prefs')).toBeNull());
  });

  it('leaves unrelated settings on the device alone when removing', async () => {
    window.localStorage.setItem('wevol-theme', 'dark');

    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /turn off and remove/i }));
    await screen.findByRole('dialog');
    fireEvent.click(
      screen.getAllByRole('button', { name: /turn off and remove/i }).at(-1),
    );

    await waitFor(() => expect(storage.removeAllModels).toHaveBeenCalled());
    expect(window.localStorage.getItem('wevol-theme')).toBe('dark');
  });
});

/**
 * Arriving from the Welly AI offer on Discover (ruling 7).
 *
 * "Set up Welly AI" links to `/settings?section=privacy&setup=1#welly-ai`. A
 * button that only scrolled to another button would make the student find and
 * press it twice; `setup=1` opens the setup dialog itself. Nothing downloads
 * until they choose a model and confirm.
 */
describe('arriving from the offer', () => {
  it('opens the setup dialog, and downloads nothing on its own', () => {
    window.history.pushState({}, '', '/settings?section=privacy&setup=1#welly-ai');
    Element.prototype.scrollIntoView ??= () => {};
    try {
      renderCard();
      expect(screen.getByRole('dialog', { name: /set up welly ai/i })).toBeInTheDocument();
      expect(storage.downloadModel).not.toHaveBeenCalled();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('does not open it on an ordinary visit to the section', () => {
    window.history.pushState({}, '', '/settings?section=privacy#welly-ai');
    Element.prototype.scrollIntoView ??= () => {};
    try {
      renderCard();
      expect(screen.queryByRole('dialog', { name: /set up welly ai/i })).toBeNull();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
