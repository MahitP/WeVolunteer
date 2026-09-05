import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../utils/api', () => ({
  api: {
    fetchLegalUpdates: vi.fn(),
    acknowledgeLegalUpdate: vi.fn(),
    acceptLegalUpdate: vi.fn(),
  },
}));

const locationCtx = { showPrompt: false, requestLocation: vi.fn(), dismissPrompt: vi.fn() };
vi.mock('../../contexts/LocationContext', () => ({
  useLocationContext: () => locationCtx,
}));

import AppNotices from './AppNotices';
import { api } from '../../utils/api';
import { __resetModalStack } from '../../utils/useModal';

/**
 * The shell's notice slot: what gets said, in what order, and where the space
 * for it comes from.
 *
 * ── The two defects this replaced ──
 *
 * `App.jsx` used to mount the location banner and the legal modal side by side,
 * each deciding for itself whether to appear. Nothing ordered them and nothing
 * knew whether the slot was empty, so:
 *
 *   • a legal change and a location offer could both be on screen, stacked,
 *     each contributing its own bottom margin;
 *   • the spacing between the notices and the page belonged to the notices, so
 *     it existed only while one of them did — which is fine until anything
 *     wraps them, and then the wrapper keeps the margin after the banner inside
 *     it has gone. That is the empty strip above the dashboard.
 *
 * The last describe block is the one that pins the fix: no notice, no node.
 */

const NOTICE = {
  slug: 'privacy-policy',
  title: 'Privacy Policy',
  version: '1.1.0',
  previousVersion: '1.0',
  effectiveAt: '2026-09-01',
  severity: 'minor',
  channel: 'notice',
  requiresAcceptance: false,
  excerpt: 'A clarification.',
  changeCount: 1,
  isSample: false,
};

const REQUIRED = {
  ...NOTICE,
  slug: 'terms-of-service',
  title: 'Terms of Service',
  version: '2.0.0',
  severity: 'material',
  channel: 'acceptance',
  requiresAcceptance: true,
};

const draw = (props = {}) => render(
  <MemoryRouter>
    <AppNotices
      onAccepted={props.onAccepted ?? vi.fn()}
      onSignOut={props.onSignOut ?? vi.fn()}
    />
  </MemoryRouter>
);

/** The fetch has resolved and the component has settled. */
const settled = () => waitFor(() => expect(api.fetchLegalUpdates).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  __resetModalStack();
  locationCtx.showPrompt = false;
  api.fetchLegalUpdates.mockResolvedValue({ updates: [] });
  api.acknowledgeLegalUpdate.mockResolvedValue({ ok: true });
  api.acceptLegalUpdate.mockResolvedValue({ accepted: true });
});

describe('the priority ladder', () => {
  it('puts a mandatory acceptance above everything, and shows nothing else', async () => {
    /* The dialog covers the page. A banner behind the backdrop is a notice
       nobody can read competing with a question they have to answer. */
    locationCtx.showPrompt = true;
    api.fetchLegalUpdates.mockResolvedValue({ updates: [REQUIRED, NOTICE] });

    const { baseElement } = draw();
    await waitFor(() => expect(baseElement.querySelector('[role="alertdialog"]')).toBeTruthy());
    expect(baseElement.querySelector('.app-notices')).toBeNull();
    expect(baseElement.querySelector('.app-notice')).toBeNull();
  });

  it('puts a legal change above the location offer', async () => {
    locationCtx.showPrompt = true;
    api.fetchLegalUpdates.mockResolvedValue({ updates: [NOTICE] });

    draw();
    expect(await screen.findByText(/We have updated the Privacy Policy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use my location/i })).toBeNull();
  });

  it('shows one banner at a time, never a pile', async () => {
    locationCtx.showPrompt = true;
    api.fetchLegalUpdates.mockResolvedValue({ updates: [NOTICE] });

    const { container } = draw();
    await screen.findByText(/We have updated the Privacy Policy/);
    expect(container.querySelectorAll('.app-notice')).toHaveLength(1);
  });

  it('offers the location banner once nothing louder is pending', async () => {
    locationCtx.showPrompt = true;
    draw();
    await settled();
    expect(screen.getByRole('button', { name: /use my location/i })).toBeInTheDocument();
  });

  it('lets the location offer through after the legal notice is dismissed', async () => {
    /* Delayed rather than lost: dismissing is one press, and the location
       offer comes back for the rest of the session. */
    locationCtx.showPrompt = true;
    api.fetchLegalUpdates.mockResolvedValue({ updates: [NOTICE] });

    draw();
    fireEvent.click(await screen.findByRole('button', { name: /I have seen/i }));
    expect(await screen.findByRole('button', { name: /use my location/i })).toBeInTheDocument();
  });
});

describe('routing on the server\'s answer', () => {
  /**
   * The client is a router, not a judge.
   *
   * `requiresAcceptance` is computed by `legalConsentGate.js` — the same module
   * the capability gate reads. Nothing here inspects a version number or a
   * scope, so there is no second, weaker copy of the materiality rule in the
   * bundle to disagree with the first.
   */
  it('never promotes a change to mandatory on its own', async () => {
    api.fetchLegalUpdates.mockResolvedValue({
      /* A major-looking version, explicitly NOT required — the notice-period
         case. A client that read the version number would get this wrong. */
      updates: [{ ...REQUIRED, requiresAcceptance: false, channel: 'notice' }],
    });

    const { baseElement } = draw();
    await screen.findByText(/Terms of Service/);
    expect(baseElement.querySelector('[role="alertdialog"]')).toBeNull();
    expect(baseElement.querySelector('.app-notice')).toBeTruthy();
  });

  it('never demotes one either', async () => {
    api.fetchLegalUpdates.mockResolvedValue({
      updates: [{ ...NOTICE, requiresAcceptance: true, channel: 'acceptance' }],
    });

    const { baseElement } = draw();
    await waitFor(() => expect(baseElement.querySelector('[role="alertdialog"]')).toBeTruthy());
  });
});

describe('dismissing an aggregate', () => {
  const THREE = [
    NOTICE,
    { ...NOTICE, slug: 'cookie-and-tracking-notice', title: 'Cookie and Tracking Notice' },
    { ...NOTICE, slug: 'accessibility-statement', title: 'Accessibility Statement' },
  ];

  it('acknowledges every change the banner spoke for', async () => {
    api.fetchLegalUpdates.mockResolvedValue({ updates: THREE });

    draw();
    fireEvent.click(await screen.findByRole('button', { name: /I have seen/i }));

    await waitFor(() => expect(api.acknowledgeLegalUpdate).toHaveBeenCalledTimes(3));
    expect(api.acknowledgeLegalUpdate.mock.calls.map(c => c[0]).sort())
      .toEqual(['accessibility-statement', 'cookie-and-tracking-notice', 'privacy-policy']);
  });

  it('sends the version alongside the slug, so the row is keyed to it', async () => {
    api.fetchLegalUpdates.mockResolvedValue({ updates: [NOTICE] });
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /I have seen/i }));
    await waitFor(() =>
      expect(api.acknowledgeLegalUpdate).toHaveBeenCalledWith('privacy-policy', '1.1.0'));
  });

  it('goes away even if the acknowledgement request fails', async () => {
    /**
     * The upsert is idempotent and a genuinely failed acknowledgement produces
     * the notice again on the next load. Showing it twice is far better than
     * trapping somebody behind a banner whose X does nothing.
     */
    api.acknowledgeLegalUpdate.mockRejectedValue(new Error('offline'));
    api.fetchLegalUpdates.mockResolvedValue({ updates: [NOTICE] });

    const { container } = draw();
    fireEvent.click(await screen.findByRole('button', { name: /I have seen/i }));
    await waitFor(() => expect(container.querySelector('.app-notice')).toBeNull());
  });
});

describe('accepting a mandatory change', () => {
  it('records it, re-reads what is pending, and refreshes the session', async () => {
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    api.fetchLegalUpdates
      .mockResolvedValueOnce({ updates: [REQUIRED] })
      .mockResolvedValue({ updates: [] });

    const { baseElement } = draw({ onAccepted });
    fireEvent.click(await screen.findByRole('button', { name: /Accept and continue/i }));

    await waitFor(() =>
      expect(api.acceptLegalUpdate).toHaveBeenCalledWith('terms-of-service', '2.0.0'));
    /* The refresh is not a nicety: the acceptance releases withheld
       capabilities, so every gated control on the page is stale until the
       session is refetched. */
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    await waitFor(() => expect(baseElement.querySelector('[role="alertdialog"]')).toBeNull());
  });
});

describe('two mandatory changes, through the real accept cycle', () => {
  const SECOND = {
    ...REQUIRED, slug: 'community-guidelines', title: 'Community Guidelines',
  };

  /**
   * The case a local cursor in the dialog got wrong.
   *
   * `AppNotices` re-reads the pending list after every acceptance, so the
   * accepted document leaves it — and the dialog renders the head of what comes
   * back. An earlier version advanced an index in the dialog instead, which
   * raced the parent's `setRequired`: depending on which update React flushed
   * first, the reader saw the second document or an empty screen with the
   * account still gated and nothing explaining why.
   *
   * So this drives the whole cycle through the mocked endpoint rather than
   * handing the dialog a fixed array.
   */
  it('shows the second document, then closes, without an empty step in between', async () => {
    api.fetchLegalUpdates
      .mockResolvedValueOnce({ updates: [REQUIRED, SECOND] })
      .mockResolvedValueOnce({ updates: [SECOND] })
      .mockResolvedValue({ updates: [] });

    const { baseElement } = draw();

    expect(await screen.findByText(/Please accept the updated Terms of Service/))
      .toBeInTheDocument();
    expect(screen.getByText(/1 more after this/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Accept and go on/i }));

    expect(await screen.findByText(/Please accept the updated Community Guidelines/))
      .toBeInTheDocument();
    /* The dialog never disappeared on the way: one acceptance recorded, one
       document still owed, and the dialog is the only thing on screen. */
    expect(baseElement.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(screen.queryByText(/more after this/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Accept and continue/i }));
    await waitFor(() => expect(baseElement.querySelector('[role="alertdialog"]')).toBeNull());

    expect(api.acceptLegalUpdate.mock.calls.map(c => c[0]))
      .toEqual(['terms-of-service', 'community-guidelines']);
  });
});

describe('when there is nothing to say', () => {
  /**
   * The layout property, asserted three ways.
   *
   * "Nothing" has to mean no node — not an empty wrapper — because the wrapper
   * is what carries the bottom margin. An empty `.app-notices` above the
   * dashboard IS the awkward strip.
   */
  it('renders no node at all', async () => {
    const { container } = draw();
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders no node when the fetch fails', async () => {
    api.fetchLegalUpdates.mockRejectedValue(new Error('offline'));
    const { container } = draw();
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders no node once the only notice is dismissed', async () => {
    api.fetchLegalUpdates.mockResolvedValue({ updates: [NOTICE] });
    const { container } = draw();

    fireEvent.click(await screen.findByRole('button', { name: /I have seen/i }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders no node once the location offer is answered', async () => {
    /* Granting permission and dismissing are the same thing here: the context
       clears `showPrompt`, and the slot has to disappear with it rather than
       leaving the space it occupied. */
    locationCtx.showPrompt = true;
    const { container, rerender } = draw();
    await waitFor(() => expect(container.querySelector('.app-notice')).toBeTruthy());

    locationCtx.showPrompt = false;
    rerender(
      <MemoryRouter>
        <AppNotices onAccepted={vi.fn()} onSignOut={vi.fn()} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not render an empty slot while the fetch is still in flight', async () => {
    /* The first paint. A wrapper rendered optimistically would reserve the
       space before anybody knows whether there is anything to put in it, which
       is the layout jump from the other direction. */
    let resolve;
    api.fetchLegalUpdates.mockReturnValue(new Promise(r => { resolve = r; }));

    const { container } = draw();
    expect(container).toBeEmptyDOMElement();

    resolve({ updates: [] });
    await settled();
    expect(container).toBeEmptyDOMElement();
  });
});
