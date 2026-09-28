import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BadgesPage from './BadgesPage';

/**
 * A username nobody has is not a failure to load.
 *
 * ── The bug ──
 *
 * `BadgesPage` caught every throw into one string — "These achievements could
 * not be loaded." — so `/users/nobody/badges` read as though the page had
 * broken on its way to a real person's badges. The honest response to that
 * sentence is to try again, and trying again does the same thing forever.
 *
 * Its two siblings did not have this problem. `PublicCertificates` and
 * `PublicServiceHistory` both separate `missing` from `error` and both say "No
 * such profile / We could not find that volunteer." So one wrong username gave
 * three different answers depending on which of a profile's three sub-pages you
 * happened to be on, and only the badges one was wrong.
 *
 * ── Why the wording is asserted, not just the branch ──
 *
 * The three pages are reached from the same profile by tabs. A reader who tries
 * the other two after a bad link should not have to work out whether three
 * sentences mean the same thing, so the string is pinned to the siblings'.
 *
 * ── Why `data-error-kind` is asserted ──
 *
 * The accessibility sweep walks every route and must not count one that
 * rendered a not-found panel: React Router serves the shell for any path, so
 * this page returns 200 at a username that does not exist and the sweep filed
 * the panel's numbers under `/users/:handle/badges`. `EmptyState`'s `notFound`
 * sets the marker `a11y/harness/walk.mjs` reads. `src/routes/notFoundMarker.guard.test.js`
 * holds the inventory; this asserts the behaviour that inventory claims.
 */

const apiMock = vi.hoisted(() => ({
  fetchPublicProfile: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ handle: '@nobody' }),
}));

const draw = () => render(
  <MemoryRouter><BadgesPage currentUser={{ id: 'user-me', username: 'me' }} /></MemoryRouter>
);

beforeEach(() => {
  apiMock.fetchPublicProfile.mockReset();
  apiMock.apiFetch.mockReset();
});

describe('badges for a username nobody has', () => {
  it('says the profile does not exist rather than that loading failed', async () => {
    const notFound = Object.assign(new Error('Not found'), { status: 404 });
    apiMock.fetchPublicProfile.mockRejectedValue(notFound);

    draw();

    expect(await screen.findByText('No such profile')).toBeInTheDocument();
    expect(screen.getByText('We could not find that volunteer.')).toBeInTheDocument();

    /* The bug, stated as the reader met it. */
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it('does not claim the person exists and has earned nothing', async () => {
    /* The quieter half. "No badges yet" about somebody who does not exist is a
       confident answer to a question nobody asked, and it is what this page
       showed whenever the profile lookup resolved to no id. */
    apiMock.fetchPublicProfile.mockResolvedValue({ profile: null });

    draw();

    expect(await screen.findByText('No such profile')).toBeInTheDocument();
    expect(screen.queryByText('No badges yet')).not.toBeInTheDocument();
  });

  it('marks the panel so the accessibility sweep discards the measurement', async () => {
    apiMock.fetchPublicProfile.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 })
    );

    const { container } = draw();
    await screen.findByText('No such profile');

    expect(container.querySelector('[data-error-kind="404"]')).not.toBeNull();
  });
});

describe('badges for a profile that does exist', () => {
  const person = { profile: { id: 'user-leo', name: 'Leo Chen', username: 'leo' } };

  it('still says "no badges yet" when the person is real and has none', async () => {
    /* The over-correction to guard against: an empty list is the real page, and
       the sweep must go on measuring it. */
    apiMock.fetchPublicProfile.mockResolvedValue(person);
    apiMock.apiFetch.mockResolvedValue({ badges: [] });

    const { container } = draw();

    expect(await screen.findByText('No badges yet')).toBeInTheDocument();
    expect(screen.queryByText('No such profile')).not.toBeInTheDocument();
    expect(container.querySelector('[data-error-kind]')).toBeNull();
  });

  it('still reports a genuine load failure as one', async () => {
    /* A fault at our end is not a wrong address. Marking it would discard
       coverage of a page that was reached correctly. */
    apiMock.fetchPublicProfile.mockResolvedValue(person);
    apiMock.apiFetch.mockRejectedValue(new Error('network down'));

    const { container } = draw();

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('No such profile')).not.toBeInTheDocument();
    expect(container.querySelector('[data-error-kind]')).toBeNull();
  });
});
