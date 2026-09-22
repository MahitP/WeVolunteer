import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PublicProfile from './PublicProfile';

/**
 * The fuller pages a member's profile names.
 *
 * ── The gap ──
 *
 * `/users/:handle/badges` exists, is gated on `directory.read`, and its route
 * comment says why it is a profile route at all: "reading somebody's badges is
 * reading their profile." The profile linked service history and certificates
 * and not badges, so the one page whose whole subject is this person's
 * recognitions was reachable only by typing the URL.
 *
 * ── Why this link is unconditional where certificates are not ──
 *
 * Certificates are conditional because a student can set
 * `serviceVisibility.certificates = 'private'`, and the comment beside them
 * says a link to a page that will refuse "is an invitation to discover the
 * setting". Badges carry no such setting: `GET /api/users/:userId/badges` gates
 * on `directory.read` alone, which any reader of this page already holds. So
 * the link cannot lead to a refusal, and making it conditional would withhold
 * it for no reason.
 */

const apiMock = vi.hoisted(() => {
  const made = new Map();
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!made.has(prop)) made.set(prop, vi.fn().mockResolvedValue(null));
      return made.get(prop);
    },
  });
});
vi.mock('../utils/api', () => ({ api: apiMock }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ handle: '@leo' }),
}));

const payload = (over = {}) => ({
  profile: {
    id: 'user-leo', name: 'Leo Chen', username: 'leo', avatar: '🙂',
    joinedAt: '2026-01-05T10:00:00.000Z',
    serviceVisibility: { hours: 'public', certificates: 'public' },
    stats: { hours: 12, eventsCompleted: 3 },
    ...over,
  },
  viewer: { isSelf: false, relationship: null, ban: null },
  external: null,
});

beforeEach(() => {
  apiMock.fetchPublicProfile.mockClear();
  apiMock.fetchPublicProfile.mockResolvedValue(payload());
});

const show = async () => {
  const utils = render(
    <MemoryRouter><PublicProfile currentUser={{ id: 'user-me', role: 'student' }} addToast={vi.fn()} /></MemoryRouter>
  );
  await screen.findByText('Leo Chen');
  return utils;
};

describe('the pages a profile points at', () => {
  it('names service history, which it always did', async () => {
    await show();
    expect(screen.getByRole('link', { name: /See service history/i }))
      .toHaveAttribute('href', '/users/@leo/hours');
  });

  it('names badges, which it did not', async () => {
    await show();
    expect(screen.getByRole('link', { name: /badges/i }))
      .toHaveAttribute('href', '/users/@leo/badges');
  });

  it('names certificates when the subject has left them visible', async () => {
    await show();
    expect(screen.getByRole('link', { name: /See certificates/i }))
      .toHaveAttribute('href', '/users/@leo/certificates');
  });

  it('withholds only certificates when they are private, keeping badges', async () => {
    /* The distinction this file exists for: one of these two has a privacy
       setting behind it and the other does not. */
    apiMock.fetchPublicProfile.mockResolvedValue(
      payload({ serviceVisibility: { hours: 'public', certificates: 'private' } })
    );
    await show();

    expect(screen.queryByRole('link', { name: /See certificates/i })).toBeNull();
    expect(screen.getByRole('link', { name: /badges/i })).toBeInTheDocument();
  });
});
