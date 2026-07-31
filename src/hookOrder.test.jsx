/**
 * Behaviour cover for hoisting two `useMemo` calls above an early `return`.
 *
 * `MapPreview` and `OrganizerDashboard` both called `useMemo` *after* a
 * conditional `return`, which `oxlint` reports as
 * `react-hooks(rules-of-hooks)`. Those two errors are why `npm run lint` exited
 * 1 at the release baseline, and clearing them is the point of the change these
 * tests guard.
 *
 * ── What this is NOT ──
 *
 * Measured, not assumed: React does **not** throw on the transition these two
 * components can actually make. With zero hooks before the early return, render 1
 * calls no hooks and render 2 calls one, and React tolerates 0→1 (and 1→0)
 * without error. These tests were written first expecting a
 * "Rendered more hooks than during the previous render" failure and they passed
 * against the unfixed code — so this was a latent-fragility and release-gate
 * problem, not a live crash. Recorded here so nobody re-derives it.
 *
 * The fragility is still worth removing: the moment anyone adds a hook *above*
 * the early return, the count stops being 0-vs-1 and the violation becomes a
 * genuine mid-mount crash. The lint rule exists to stop that landing silently.
 *
 * ── What this IS ──
 *
 * A behaviour pin. Moving a hook above a `return null` is exactly the kind of
 * edit that quietly changes what renders — a map at `(undefined, undefined)`, or
 * an approval gate that stops gating. These assert the visible contract on both
 * sides of the condition so the hoist cannot alter it.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MapPreview from './components/location/MapPreview.jsx';
import OrganizerDashboard from './views/OrganizerDashboard.jsx';

// The dashboard fetches stats on mount. The hook-order contract is independent
// of that, so the call is stubbed to a never-resolving promise rather than mocked
// per-assertion.
vi.mock('./utils/api', () => ({
  api: {
    fetchOrganizerStats: () => new Promise(() => {}),
    fetchEventStats: () => new Promise(() => {})
  }
}));

// The real map pulls in leaflet, which needs a canvas/DOM surface jsdom does not
// provide. The hook-order contract is in MapPreview itself, so the child is
// stubbed out rather than exercised.
vi.mock('./components/location/LeafletMap.jsx', () => ({
  default: () => <div data-testid="leaflet-stub" />
}));

afterEach(cleanup);

describe('MapPreview hook order', () => {
  it('survives coordinates arriving after a null render', () => {
    // Render 1: no coordinates -> the early-return branch.
    const { rerender, container } = render(
      <MapPreview latitude={null} longitude={null} label="Community Center" />
    );
    expect(container.querySelector('.map-preview')).toBeNull();

    // Render 2: coordinates arrive — the real transition, since geocoding
    // resolves after first paint.
    expect(() => {
      rerender(<MapPreview latitude={40.7} longitude={-74.0} label="Community Center" />);
    }).not.toThrow();

    expect(container.querySelector('.map-preview')).not.toBeNull();
  });

  it('survives coordinates disappearing after a real render', () => {
    const { rerender, container } = render(
      <MapPreview latitude={40.7} longitude={-74.0} label="Community Center" />
    );
    expect(container.querySelector('.map-preview')).not.toBeNull();

    expect(() => {
      rerender(<MapPreview latitude={null} longitude={null} label="Community Center" />);
    }).not.toThrow();

    expect(container.querySelector('.map-preview')).toBeNull();
  });

  it('still renders nothing when either coordinate is missing', () => {
    // Guarding the behaviour the early return provided, so moving the hook above
    // it cannot quietly start rendering a map at (undefined, undefined).
    const { container: a } = render(<MapPreview latitude={40.7} longitude={null} />);
    expect(a.querySelector('.map-preview')).toBeNull();

    const { container: b } = render(<MapPreview latitude={null} longitude={-74.0} />);
    expect(b.querySelector('.map-preview')).toBeNull();
  });

  it('keeps the click affordance off when no handler is supplied', () => {
    // `containerClick` gates role/tabIndex/onKeyDown. Reordering the hook must
    // not disturb that, so it is pinned here.
    const { container } = render(<MapPreview latitude={40.7} longitude={-74.0} />);
    const el = container.querySelector('.map-preview');
    expect(el.getAttribute('tabindex')).toBeNull();
  });

  it('exposes the click affordance when a handler is supplied', () => {
    const onClick = vi.fn();
    const { container } = render(
      <MapPreview latitude={40.7} longitude={-74.0} onClick={onClick} />
    );
    const el = container.querySelector('.map-preview');
    expect(el.getAttribute('tabindex')).toBe('0');
  });
});

/**
 * OrganizerDashboard is the case that genuinely crashes.
 *
 * Unlike MapPreview, it calls five hooks (useNavigate, five useState, useEffect,
 * and four useMemo) BEFORE the `if (!currentUser.verified)` return, and one more
 * `useMemo` after it. So the transition is not 0→1 — it is N→N+1, which React
 * rejects outright with "Rendered more hooks than during the previous render".
 *
 * The trigger is ordinary: an admin approves a pending organizer who has this
 * page open, and App.jsx refreshes `currentUser` on the socket event. `verified`
 * flips 0→1 under a mounted component and the dashboard throws instead of
 * revealing itself.
 */
function renderDashboard(verified, extra = {}) {
  const currentUser = {
    id: 'org-1',
    name: 'Sarah Jenkins',
    role: 'organizer',
    verified,
    ...extra
  };
  return render(
    <MemoryRouter>
      <OrganizerDashboard
        currentUser={currentUser}
        events={[]}
        applications={[]}
        refreshEvents={vi.fn()}
        addToast={vi.fn()}
        onViewDetails={vi.fn()}
        onViewVolunteerProfile={vi.fn()}
        setActiveTab={vi.fn()}
      />
    </MemoryRouter>
  );
}

describe('OrganizerDashboard hook order', () => {
  it('does not throw when an organizer is approved while the page is open', () => {
    // Mount unverified: the approval-gate branch, which returns before the
    // trailing useMemo.
    const { rerender } = renderDashboard(0);

    // Admin approves them; App.jsx pushes a refreshed currentUser.
    // Pre-fix this threw "Rendered more hooks than during the previous render".
    expect(() => {
      rerender(
        <MemoryRouter>
          <OrganizerDashboard
            currentUser={{ id: 'org-1', name: 'Sarah Jenkins', role: 'organizer', verified: 1 }}
            events={[]}
            applications={[]}
            refreshEvents={vi.fn()}
            addToast={vi.fn()}
            onViewDetails={vi.fn()}
            onViewVolunteerProfile={vi.fn()}
            setActiveTab={vi.fn()}
          />
        </MemoryRouter>
      );
    }).not.toThrow();
  });

  it('still shows the approval gate to an unverified organizer', () => {
    // The whole reason the early return exists. Hoisting the hook must not
    // let an unapproved organizer through to the real dashboard.
    const { container } = renderDashboard(0);
    expect(container.textContent).toMatch(/approv/i);
  });

  it('shows the dashboard greeting to a verified organizer', () => {
    const { container } = renderDashboard(1);
    // The greeting is what the trailing useMemo produces; it must survive the move.
    expect(container.textContent).toMatch(/Sarah/);
  });
});
