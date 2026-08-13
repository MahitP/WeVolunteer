import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LocationProvider, useLocationContext, readGeolocationPermission } from './LocationContext';

/**
 * When the location banner may appear.
 *
 * ── The bug this file exists because of ──
 *
 * The provider asked `sessionStorage.getItem('wv_asked_location')` and treated
 * the answer as "does the browser have permission?". Those coincide only inside
 * one tab's lifetime, so every new tab, window and browser restart re-asked
 * somebody whose browser had already granted permission permanently — for whom
 * `getCurrentPosition` resolves with no dialog at all.
 *
 * There was no test for the provider whatsoever; the only location test mocked
 * this context out entirely, so the bug was invisible to the suite by
 * construction.
 */

function Probe() {
  const { showPrompt, location, permissionDenied, dismissPrompt } = useLocationContext();
  return (
    <div>
      <button type="button" onClick={dismissPrompt}>dismiss</button>
      <span data-testid="prompt">{showPrompt ? 'shown' : 'hidden'}</span>
      <span data-testid="denied">{permissionDenied ? 'denied' : 'ok'}</span>
      <span data-testid="coords">{location ? `${location.latitude},${location.longitude}` : 'none'}</span>
    </div>
  );
}

/** Sets the browser's answer, or removes the API entirely. */
function permission(state) {
  if (state === 'unsupported') {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
    return;
  }
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state }) },
  });
}

/** Sets what `getCurrentPosition` does. */
function geolocation({ grants = true } = {}) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: vi.fn((ok, fail) => {
        if (grants) ok({ coords: { latitude: 40.3, longitude: -74.5 } });
        else fail({ code: 1, PERMISSION_DENIED: 1, message: 'denied' });
      }),
    },
  });
}

const draw = () => render(<LocationProvider><Probe /></LocationProvider>);

beforeEach(() => {
  sessionStorage.clear();
  geolocation();
  permission('prompt');
});

afterEach(() => { vi.restoreAllMocks(); });

describe('when the browser has already granted permission', () => {
  beforeEach(() => permission('granted'));

  it('never shows the banner', async () => {
    /* The bug, exactly. Nothing to ask: `getCurrentPosition` resolves with no
       dialog for an origin the browser already trusts. */
    draw();
    await waitFor(() => expect(screen.getByTestId('coords')).toHaveTextContent('40.3,-74.5'));
    expect(screen.getByTestId('prompt')).toHaveTextContent('hidden');
  });

  it('uses the location without being asked', async () => {
    draw();
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled());
  });

  it('stays silent in a FRESH session, which is where the bug lived', async () => {
    /* Empty sessionStorage is exactly a new tab. The old code read that as
       "never asked" and showed the banner. */
    sessionStorage.clear();
    draw();
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled());
    expect(screen.getByTestId('prompt')).toHaveTextContent('hidden');
  });
});

describe('when permission has not been decided', () => {
  it('offers the banner', async () => {
    permission('prompt');
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));
  });

  it('does not request a position on load', async () => {
    /* The permission dialog must follow a gesture, never a page load. */
    permission('prompt');
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));
    expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
  });
});

describe('when permission is denied', () => {
  beforeEach(() => permission('denied'));

  it('still offers the banner, so the feature is not invisible', async () => {
    /**
     * Pressing it will not raise a dialog — the browser suppresses that — but
     * the banner is the only thing on the page that says location exists and
     * can be switched back on in browser settings. Hiding it would make the
     * feature permanently unreachable for the people most likely to want it.
     */
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));
  });

  it('reports the denial', async () => {
    draw();
    await waitFor(() => expect(screen.getByTestId('denied')).toHaveTextContent('denied'));
  });
});

describe('dismissal', () => {
  it('is remembered for the rest of the session', async () => {
    permission('prompt');
    const { unmount } = draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));

    /* Through the real `dismissPrompt`, not by writing the key by hand — a
       test that sets the storage itself proves nothing about the function. */
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('hidden'));
    unmount();

    /* A remount is a navigation: the banner must not come back. */
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('hidden'));
  });

  it('records nothing about permission', async () => {
    /**
     * The conflation that caused the bug. The old `dismissPrompt` wrote
     * `wv_location_granted = 'false'` — asserting a denial from somebody who
     * had merely not answered yet.
     */
    permission('prompt');
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('hidden'));

    expect(sessionStorage.getItem('wv_location_granted'),
      'dismissing must not record a claim about permission').toBeNull();
  });

  it('does not survive a new session', async () => {
    /* Dismissal is a courtesy, not a permanent opt-out — somebody who changes
       their mind must be able to find the affordance again. */
    sessionStorage.setItem('wv_location_dismissed', 'true');
    permission('prompt');
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('hidden'));

    sessionStorage.clear();
    draw();
    await waitFor(() => expect(screen.getAllByTestId('prompt')[1]).toHaveTextContent('shown'));
  });

  it('a granted permission beats a dismissal', async () => {
    /* Dismissing and then granting in browser settings must not leave the app
       ignoring a permission it has. */
    sessionStorage.setItem('wv_location_dismissed', 'true');
    permission('granted');
    draw();
    await waitFor(() => expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled());
  });
});

describe('when the browser will not answer', () => {
  it('falls back to offering the banner', async () => {
    /* Safari has historically not supported `permissions.query` for
       geolocation. Unknown is the case where asking is most worthwhile. */
    permission('unsupported');
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));
  });

  it('survives a query that rejects', async () => {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockRejectedValue(new Error('nope')) },
    });
    draw();
    await waitFor(() => expect(screen.getByTestId('prompt')).toHaveTextContent('shown'));
  });
});

describe('readGeolocationPermission', () => {
  it('returns null when there is no Permissions API', async () => {
    expect(await readGeolocationPermission({})).toBeNull();
  });

  it('returns null rather than throwing when the query rejects', async () => {
    expect(await readGeolocationPermission({ permissions: { query: () => Promise.reject(new Error('x')) } }))
      .toBeNull();
  });

  it('passes the state through', async () => {
    expect(await readGeolocationPermission({ permissions: { query: async () => ({ state: 'granted' }) } }))
      .toBe('granted');
  });
});
