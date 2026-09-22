import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The half of "never ask for an address" that happens on screen.
 *
 * `ai/personalInfo.test.js` covers the answer: a proximity search with no
 * coordinates says so, and no reply anywhere may ask a student to type where
 * they live. What is left is the part that makes that honest rather than merely
 * unhelpful — an offer to fix it.
 *
 * It has to be a button. A browser opens its permission dialog only in response
 * to a gesture, so "turn on location in your settings" is the answer that
 * cannot be acted on from here, and "tell me your address" is the answer that
 * must never be given. `LocationContext.requestLocation` is the gesture, and
 * this is the surface that offers it.
 */

const apiMock = {
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  verifyCertificate: vi.fn(),
};
vi.mock('../utils/api', () => ({ api: apiMock }));

/* The context is stubbed rather than provided, because what is under test is
   what the view does with it — the real provider's permission flow has its own
   file. */
const ctx = vi.hoisted(() => ({
  location: null,
  loading: false,
  error: null,
  permissionDenied: false,
  showPrompt: false,
  requestLocation: vi.fn(),
  dismissPrompt: vi.fn(),
  clearLocation: vi.fn(),
}));
vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => ctx,
  LocationProvider: ({ children }) => children,
}));

const { default: WellyView } = await import('./WellyView.jsx');

/**
 * A different id every test, and not for tidiness.
 *
 * `conversation.js` keeps a module-level `memoryStore` Map for the case where
 * saving is switched off, and nothing in a test file's teardown reaches it —
 * `localStorage.clear()` empties the other half of the store and leaves that
 * one intact. Four tests sharing an id therefore share one transcript, and the
 * fifth sees every answer the first four produced. Keying by test is what makes
 * these independent.
 */
let seq = 0;
const studentFor = () => ({
  id: `stu-loc-${++seq}`, name: 'Maya Lin', role: 'student', verified: true, withheld: [],
});

const show = (props = {}) => render(
  <MemoryRouter><WellyView currentUser={studentFor()} {...props} /></MemoryRouter>,
);

const askNearby = () => {
  fireEvent.change(screen.getByLabelText(/ask welly a question/i), {
    target: { value: 'find volunteering opportunities near me' },
  });
  fireEvent.click(screen.getByRole('button', { name: /send question to welly/i }));
};

/* The page also carries an `sr-only` status region holding the finished answer,
   so a bare `getByText` matches twice. See WellyView.behaviour.test.jsx. */
const inTranscript = matcher =>
  screen.findAllByText(matcher).then(found => {
    const visible = found.filter(el => !el.closest('.sr-only'));
    expect(visible.length).toBeGreaterThan(0);
    return visible[0];
  });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.assign(ctx, { location: null, loading: false, permissionDenied: false });
  apiMock.fetchEventsFiltered.mockResolvedValue({
    events: [{ id: 'e1', title: 'Beach Cleanup' }],
    pagination: { total: 1 },
  });
});

describe('a proximity search with no location', () => {
  it('offers the browser’s own permission gesture', async () => {
    show();
    askNearby();

    const button = await screen.findByRole('button', { name: /use my location/i });
    fireEvent.click(button);
    expect(ctx.requestLocation).toHaveBeenCalledTimes(1);
  });

  it('still gives the answer it does have', async () => {
    show();
    askNearby();

    await screen.findByRole('button', { name: /use my location/i });
    await inTranscript(/I found 1 opportunity/);
    await inTranscript(/aren’t sorted by distance/);
  });

  it('asks for nothing to be typed', async () => {
    show();
    askNearby();
    await screen.findByRole('button', { name: /use my location/i });

    /* The whole transcript, not just the sentence — including the offer's own
       copy, which is where a "just tell me your zip" would most plausibly be
       written by somebody trying to be helpful later. */
    const log = document.body.textContent;
    expect(log).not.toMatch(/your address|zip ?code|postcode|where do you live|what city are you/i);
  });

  /**
   * ── The offer must not overstate, for the same reason the footer must not ──
   *
   * `WellyView.disclaimer.test.jsx` already forbids "stays on your device" in
   * the composer footer, and says why: "an unconditional 'nothing leaves your
   * device' here would be false — and it is the exact sentence a future edit
   * would reach for." This offer said exactly that sentence, at the moment a
   * reader decides whether to grant location access.
   *
   * It is also false in the specific: a "near me" search sends a coordinate to
   * `GET /api/events`. What the Privacy Policy promises is that it is BLURRED
   * first — "rounded to about a kilometre to sort a list by distance" — and
   * never stored, which is what this now says.
   */
  it('does not claim the position stays on the device', async () => {
    show();
    askNearby();
    await screen.findByRole('button', { name: /use my location/i });

    const log = document.body.textContent;
    expect(
      log,
      'the location offer claims the position never leaves, at the consent moment',
    ).not.toMatch(/stays on your device|never leaves|nothing leaves/i);
  });

  it('says what actually happens: blurred before sending, never stored', async () => {
    show();
    askNearby();
    await screen.findByRole('button', { name: /use my location/i });

    const log = document.body.textContent;
    expect(log).toMatch(/blurred|rounded/i);
    expect(log).toMatch(/never stored|not stored|nothing is stored/i);
  });

  it('says what to do when the browser is the one refusing', async () => {
    ctx.permissionDenied = true;
    show();
    askNearby();

    await screen.findByRole('button', { name: /use my location/i });
    expect(screen.getByText(/browser is blocking it/i)).toBeInTheDocument();
  });
});

describe('when the app already has coordinates', () => {
  it('says nothing about location at all', async () => {
    /**
     * From the context, not a prop.
     *
     * The prop was `location`, supplied by App.jsx from `useLocation()` —
     * react-router's, which has a `pathname` and no coordinates. Both were
     * always undefined while the object was truthy, so every "near me" search
     * went out unlocated and looked located to the code that checked. The name
     * is the bug, so the prop is gone.
     */
    ctx.location = { latitude: 34.42, longitude: -119.7 };
    show();
    askNearby();

    await inTranscript(/I found 1 opportunity/);
    await waitFor(() => {
      const [args] = apiMock.fetchEventsFiltered.mock.calls[0];
      expect(args.lat).toBe(34.42);
    });
    expect(screen.queryByRole('button', { name: /use my location/i })).toBeNull();
    expect(screen.queryByText(/sorted by distance/)).toBeNull();
  });
});
