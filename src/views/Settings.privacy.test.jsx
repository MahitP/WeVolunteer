import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';

/**
 * Settings → Privacy says what the server does.
 *
 * Three pieces of this screen stopped being true on 2026-10-04, when service
 * records started private and location, interests and skills moved behind the
 * profile setting (docs/legal/15-PROFILE-VISIBILITY-DEFAULTS.md):
 *
 *   - the profile hint said those fields and the volunteering totals were
 *     "always visible to signed-in members";
 *   - the service-record options said "Anyone at your school", when the
 *     audience is every member, adult organizers included, on a platform no
 *     school operates;
 *   - the leaderboard switch said nothing about the service-record setting,
 *     and the board drops anybody whose hours are private. With private as the
 *     default, turning it on would silently do nothing.
 */

beforeAll(() => {
  window.matchMedia = window.matchMedia || (query => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});

vi.mock('../utils/api', () => ({
  api: {
    signOutOtherDevices: vi.fn(),
    updatePrivacySettings: vi.fn(),
    updateProfile: vi.fn(),
  },
}));

const USER = (over = {}) => ({
  id: 'user-1',
  name: 'Sam Rivera',
  email: 'sam@example.com',
  role: 'student',
  verified: true,
  profileVisibility: 'private',
  hoursVisibility: 'private',
  certificatesVisibility: 'private',
  leaderboardOptIn: false,
  ...over,
});

const renderPrivacy = (user = USER()) => render(
  <MemoryRouter initialEntries={['/settings?section=privacy']}>
    <Settings currentUser={user} addToast={vi.fn()} onProfileChange={vi.fn()} />
  </MemoryRouter>
);

describe('Settings → Privacy', () => {
  it('names the real audience for a service record', () => {
    renderPrivacy();
    expect(screen.queryByText('Anyone at your school')).toBeNull();
    expect(screen.getAllByRole('option', { name: 'Other members' })).toHaveLength(2);
  });

  it('no longer says location, interests and skills are always visible', () => {
    renderPrivacy();
    /* The claim that was false, not the phrase: name, picture and clubs really
       are always visible, and the new hint says so. */
    expect(screen.queryByText(/hobbies,\s+skills\s+and\s+volunteering\s+totals\s+are\s+always/i)).toBeNull();
    expect(screen.getByText(/general area, hobbies and skills/i)).toBeInTheDocument();
  });

  it('explains why a leaderboard opt-in shows nothing while hours are private', () => {
    renderPrivacy(USER({ leaderboardOptIn: true, hoursVisibility: 'private' }));
    expect(screen.getByText(/only lists you while your service history is visible/i)).toBeInTheDocument();
  });

  it('says nothing extra once the hours are visible', () => {
    renderPrivacy(USER({ leaderboardOptIn: true, hoursVisibility: 'public' }));
    expect(screen.queryByText(/only lists you while your service history is visible/i)).toBeNull();
  });
});
