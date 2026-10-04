import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ai = vi.hoisted(() => ({
  isLocalAIEnabled: vi.fn(() => true),
  detectCapability: vi.fn(() => ({ supported: true, experimental: false, recommendedTier: 'balanced' })),
}));
const prefs = vi.hoisted(() => ({ readPreferences: vi.fn(() => ({ enabled: false })) }));
const location = vi.hoisted(() => ({ showPrompt: false }));

vi.mock('../../ai', async (importOriginal) => ({ ...(await importOriginal()), ...ai }));
vi.mock('../../ai/preferences', async (importOriginal) => ({ ...(await importOriginal()), ...prefs }));
vi.mock('../../contexts/LocationContext', () => ({ useLocationContext: () => location }));

import WellyOfferBanner from './WellyOfferBanner';
import AIEnableModal from '../account/AIEnableModal';

/**
 * "Enable AI mode?" on Discover, in the location offer's style (ruling 7).
 *
 * The owner asked for Welly AI to be offered where a student meets the
 * suggestions (P2-32). It was reachable only from Settings, which nobody opens
 * looking for it. The offer uses the same notice as "See how far away
 * opportunities are", and never stands beside it: the shell shows one offer at
 * a time, and this one waits until the location offer is out of the way.
 */

const STUDENT = { id: 's1', role: 'student', withheld: [], verified: true };
const PARTNER = { id: 'p1', role: 'partner', withheld: [], verified: true };
const draw = (user = STUDENT) => render(<MemoryRouter><WellyOfferBanner currentUser={user} /></MemoryRouter>);

beforeEach(() => {
  try { localStorage.clear(); } catch { /* storage unavailable */ }
  ai.isLocalAIEnabled.mockReturnValue(true);
  ai.detectCapability.mockReturnValue({ supported: true, experimental: false, recommendedTier: 'balanced' });
  prefs.readPreferences.mockReturnValue({ enabled: false });
  location.showPrompt = false;
});

describe('the Welly AI offer', () => {
  it('offers setup to a student who can run it and has not turned it on', () => {
    draw();
    expect(screen.getByRole('region', { name: 'Welly AI' })).toBeInTheDocument();
    expect(screen.getByText('Turn on Welly AI?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set up Welly AI/ }))
      .toHaveAttribute('href', '/settings?section=privacy&setup=1#welly-ai');
  });

  it('is not offered where it cannot or need not be', () => {
    ai.isLocalAIEnabled.mockReturnValue(false);
    const { unmount } = draw();
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
    unmount();

    ai.isLocalAIEnabled.mockReturnValue(true);
    prefs.readPreferences.mockReturnValue({ enabled: true });
    const second = draw();
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
    second.unmount();

    prefs.readPreferences.mockReturnValue({ enabled: false });
    ai.detectCapability.mockReturnValue({ supported: false, reason: 'no' });
    const third = draw();
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
    third.unmount();

    ai.detectCapability.mockReturnValue({ supported: true, experimental: false });
    draw(PARTNER);
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
  });

  it('waits while the location offer is on screen — one offer at a time', () => {
    location.showPrompt = true;
    draw();
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
  });

  it('stays dismissed on this device once dismissed', () => {
    const { unmount } = draw();
    fireEvent.click(screen.getByRole('button', { name: /Not now/ }));
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
    unmount();
    draw();
    expect(screen.queryByText('Turn on Welly AI?')).toBeNull();
  });

  it('says plainly when it would be experimental on this device', () => {
    ai.detectCapability.mockReturnValue({ supported: true, experimental: true, recommendedTier: 'balanced' });
    draw();
    expect(screen.getByText(/experimental on this device/i)).toBeInTheDocument();
  });

  it('sits on Discover, above Suggested for you', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/views/BrowseEvents.jsx'), 'utf8');
    const offer = src.indexOf('<WellyOfferBanner');
    const suggested = src.indexOf("'Suggested for you'");
    expect(offer).toBeGreaterThan(-1);
    expect(offer).toBeLessThan(suggested);
  });
});

describe('setting up on an iPhone (ruling 7)', () => {
  const BALANCED = { id: 'qwen-1.5b', tier: 'balanced', label: 'Balanced', bytes: 491400032, parameters: '1.5B', license: 'Apache-2.0' };

  it('names the risk and will not download until the student agrees to it', () => {
    const onConfirm = vi.fn();
    render(
      <MemoryRouter>
        <AIEnableModal
          capability={{ supported: true, experimental: true, recommendedTier: 'balanced', reason: 'Experimental on iPhone and iPad.' }}
          models={[BALANCED]}
          onConfirm={onConfirm}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Experimental on this device/)).toBeInTheDocument();
    const go = screen.getByRole('button', { name: /Download .* and turn on/ });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand this is experimental/ }));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(onConfirm).toHaveBeenCalledWith(BALANCED);
  });

  it('asks nothing extra anywhere else', () => {
    render(
      <MemoryRouter>
        <AIEnableModal capability={{ supported: true, experimental: false, recommendedTier: 'balanced' }}
          models={[BALANCED]} onConfirm={vi.fn()} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('checkbox', { name: /I understand this is experimental/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Download .* and turn on/ })).toBeEnabled();
  });
});

describe('the disclaimer (ruling 14, as amended 2026-10-04)', () => {
  it('says exactly what runs on the device and what does not', () => {
    /* The ruling's first wording, "what you type stays on your device", was
       false: a search sends the words searched for. This is its replacement,
       and the info site's sentence word for word. */
    const src = fs.readFileSync(path.join(process.cwd(), 'src/views/WellyView.jsx'), 'utf8');
    expect(src).toContain(
      "With Welly AI on, the model that writes Welly's replies runs on your device. "
      + 'Looking something up, like your hours or events to join, is a request to '
      + 'WeVolunteer like the rest of the app, and a search sends the words you searched for.',
    );
    expect(src).not.toContain('With Welly AI on, what you type stays on your device');
  });
});
