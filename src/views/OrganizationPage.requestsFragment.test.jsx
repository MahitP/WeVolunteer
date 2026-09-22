import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import OrganizationPage from './OrganizationPage';
import { api } from '../utils/api';

/**
 * "Review the request" has to land the manager on the requests section.
 *
 * ── The defect ──
 *
 * `ORGANIZATION_JOIN_REQUEST_RECEIVED` emits
 * `/organizations/@slug#requests` with `ctaText: 'Review the request'`
 * (`server/services/notificationContent.js`), and the design spec states the
 * destination in as many words: "every manager … → the requests section"
 * (`docs/superpowers/specs/2026-09-03-organization-share-links-design.md`).
 *
 * Nothing implemented it. `OrganizationPage` reads `location.pathname` — for
 * the canonical-address redirect — and never `location.hash`; no element
 * anywhere carried `id="requests"` (the inbox's heading is
 * `org-requests-heading`); and the only hash consumers in the client were
 * `LegalDocument` and `AdminDashboard`. So a manager pressing the CTA arrived
 * at the top of a 1,100-line page with the queue inside a `canManage` band
 * well below, having just been told somebody was waiting.
 *
 * The browser cannot rescue it either: this is an SPA, so at the moment the
 * fragment is resolved the club has not been fetched and the section does not
 * exist — the same timing failure `LegalDocument.fragment.test.jsx` was written
 * for, and for the same reason it needs its own file: the page renders, the
 * section is present, and only the arrival is missing.
 *
 * ── Focus, not just scroll ──
 *
 * Taken from the convention `LegalDocument` set: "a scroll-only jump serves the
 * sighted mouse user and leaves a keyboard or screen-reader user at the top of
 * the document — the deep link either works for everybody or it is
 * decoration." So focus is asserted as a requirement here, not as a nicety.
 */

vi.mock('../utils/api');
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ key: '@chess-club' }),
}));

const BOSS = { id: 'user-b', name: 'Jordan Whitfield', username: 'jordan', memberRole: 'manager' };

/** Reports the router's settled address, so a redirect is observable. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="where" data-path={loc.pathname} data-hash={loc.hash} />;
}

const payload = (viewer = {}) => ({
  organization: {
    id: 'org-1', slug: 'chess-club', name: 'Chess Club', description: 'Play chess.',
    memberCount: 1, eventCount: 0, allowReplies: true, tags: [],
    createdBy: { id: 'user-b', name: 'Jordan Whitfield' },
  },
  members: [BOSS],
  events: [],
  viewer: {
    isMember: true, memberRole: 'manager', canManage: true, canPost: true,
    joinPolicy: 'request', canInvite: true, shareLink: null, pendingRequests: 1,
    hours: 0, events: 0, history: [], ban: null, affordance: 'member', ...viewer,
  },
  totals: null,
});

/** Renders the page at a location carrying `hash`. */
const showAt = async (hash, viewer) => {
  api.fetchOrganization.mockResolvedValue(payload(viewer));
  const utils = render(
    <MemoryRouter initialEntries={[`/organizations/@chess-club${hash}`]}>
      <OrganizationPage addToast={vi.fn()} />
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());
  return utils;
};

beforeEach(() => {
  vi.clearAllMocks();
  /* Every child that fetches on mount. Left unmocked the auto-mock returns
     `undefined`, `.then` throws inside a passive effect and the whole page
     unmounts — which would read as "the section is correctly absent". Same
     note as OrganizationPage.moderation.test.jsx. */
  api.fetchOrganizationAnnouncements.mockResolvedValue({ announcements: [] });
  api.fetchOrganizationAppeals.mockResolvedValue({ appeals: [] });
  api.fetchOrganizationBans.mockResolvedValue({ bans: [] });
  api.fetchOrganizationInvitations.mockResolvedValue({ invitations: [] });
  api.searchDirectory.mockResolvedValue({ users: [], organizations: [] });
  api.fetchOrganizationJoinRequests.mockResolvedValue({
    requests: [{
      id: 'req-1', userId: 'user-s', name: 'Leo Chen', username: 'leo',
      requestedAt: '2026-09-01T10:00:00.000Z',
    }],
    pendingRequests: 1,
  });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { delete window.HTMLElement.prototype.scrollIntoView; });

describe('following the join-request notification', () => {
  it('renders the requests section at all, so the rest is not vacuous', async () => {
    await showAt('#requests');
    expect(await screen.findByText('Requests to join')).toBeInTheDocument();
  });

  it('gives the section the id the notification points at', async () => {
    /* The contract is the destination, not the string — but the id has to
       exist for the destination to be reachable, and nothing else in the DOM
       can stand in for it. */
    const { container } = await showAt('#requests');
    await waitFor(() => expect(container.querySelector('#requests')).not.toBeNull());
  });

  it('scrolls the manager to it rather than leaving them at the top', async () => {
    await showAt('#requests');
    await waitFor(() =>
      expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('moves focus there too, so a keyboard user arrives as well', async () => {
    const { container } = await showAt('#requests');
    await waitFor(() => {
      const target = container.querySelector('#requests');
      expect(target).not.toBeNull();
      expect(document.activeElement).toBe(target);
    });
  });

  it('does nothing of the sort on an ordinary visit with no fragment', async () => {
    /* The control. Without it a page that always scrolled and always stole
       focus would satisfy every case above. */
    await showAt('');
    await screen.findByText('Requests to join');
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores a fragment that names nothing, rather than breaking the page', async () => {
    await showAt('#no-such-section');
    expect(await screen.findByText('Chess Club')).toBeInTheDocument();
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps the fragment when the address is canonicalised on the way in', async () => {
    /**
     * `/organizations/:key` still resolves an id and a bare handle, because
     * links written before `@handle` existed must keep working — and the page
     * redirects those to the canonical address. That redirect used to rebuild
     * the URL from the pathname alone, so a non-canonical link carrying
     * `#requests` was tidied into one carrying nothing, and the reader lost the
     * destination on the way to it.
     */
    api.fetchOrganization.mockResolvedValue(payload());
    const { container } = render(
      <MemoryRouter initialEntries={['/organizations/org-1#requests']}>
        <OrganizationPage addToast={vi.fn()} />
        <LocationProbe />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Chess Club')).toBeInTheDocument());

    /**
     * The ADDRESS is what this asserts, not the focus.
     *
     * Asserting focus here proves nothing about the redirect: both effects run
     * in one commit and the hash effect reads the pre-redirect location, so it
     * lands whether or not the fragment survived. Verified by mutation — the
     * focus-only version of this case passed with the fix reverted. What the
     * reader is left holding is the URL: it is what Back returns to, what a
     * refresh re-resolves, and what they copy.
     */
    await waitFor(() => {
      const probe = screen.getByTestId('where');
      expect(probe.dataset.path).toBe('/organizations/@chess-club');
      expect(probe.dataset.hash, 'canonicalising the address discarded the fragment')
        .toBe('#requests');
    });

    /* And it still lands, which is the point of keeping it. */
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#requests')));
  });

  it('survives an environment with no scrollIntoView', async () => {
    /* jsdom does not implement it by default, and a scrolling convenience must
       never be able to take the page down. Same rule LegalDocument records. */
    delete window.HTMLElement.prototype.scrollIntoView;
    const { container } = await showAt('#requests');
    expect(await screen.findByText('Requests to join')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#requests')));
  });
});
