/**
 * Choosing who an event is for, on the form that creates it.
 *
 * ── What this covers ──
 *
 * Two rules the server also enforces, said before the request rather than
 * after it. "Members only" is offered only once there is an organization for it
 * to mean something, and an account that reached this page on
 * `organization.event.create` alone cannot submit an event with no organization
 * behind it — that account is a Student Organizer, and an event under their own
 * name with no club is the `organizer` role they were not given.
 *
 * The server refuses both regardless (`server/routes.studentOrganizer.test.js`
 * and `server/routes.eventEligibility.test.js`). This is about not putting a
 * control in front of somebody whose only outcome is a refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import CreateEvent from './CreateEvent';
import { api } from '../utils/api';

vi.mock('../utils/api');

const ORGANIZER = { id: 'u-o', role: 'organizer', verified: true, grants: [], withheld: [] };
const HELPER = {
  id: 'u-h', role: 'student', verified: true,
  grants: ['organization.event.create', 'organization.post.create'], withheld: [],
};

const ORGS = [
  { id: 'org-1', name: 'Chess Club', viewerRole: 'manager' },
  { id: 'org-2', name: 'Robotics', viewerRole: 'student_organizer' },
  /* Belongs to it, does not run it — must not be offered. */
  { id: 'org-3', name: 'Book Club', viewerRole: 'member' },
];

const show = async (currentUser, organizations = ORGS) => {
  api.fetchOrganizations.mockResolvedValue({ organizations });
  api.fetchEventTags.mockResolvedValue({ tags: [] });
  render(
    <CreateEvent
      currentUser={currentUser}
      onSubmitEvent={vi.fn()}
      addToast={vi.fn()}
      setActiveTab={vi.fn()}
    />
  );
  await waitFor(() => expect(api.fetchOrganizations).toHaveBeenCalled());
};

const orgSelect = () => screen.getByLabelText(/Organization/i);

describe('the audience control', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers only the organizations this account may publish under', async () => {
    await show(ORGANIZER);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Chess Club' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Robotics' })).toBeInTheDocument();
    /* The bug this closes: `?mine=true` returns everything they BELONG to, and
       the select used to list all of it — offering a choice the server refuses. */
    expect(screen.queryByRole('option', { name: 'Book Club' })).toBeNull();
  });

  it('stays hidden until an organization is chosen', async () => {
    await show(ORGANIZER);
    await waitFor(() => expect(orgSelect()).toBeInTheDocument());
    /* "Members only" of nothing is a shift nobody can join. */
    expect(screen.queryByRole('radio', { name: /Members of this organization/i })).toBeNull();

    fireEvent.change(orgSelect(), { target: { value: 'org-1' } });
    expect(await screen.findByRole('radio', { name: /Members of this organization/i })).toBeInTheDocument();
  });

  it('defaults to everyone', async () => {
    await show(ORGANIZER);
    await waitFor(() => expect(orgSelect()).toBeInTheDocument());
    fireEvent.change(orgSelect(), { target: { value: 'org-1' } });
    expect(await screen.findByRole('radio', { name: /Everyone/i })).toBeChecked();
  });

  it('lets an organizer publish with no organization at all', async () => {
    await show(ORGANIZER);
    await waitFor(() => expect(orgSelect()).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /No organization/i })).toBeInTheDocument();
  });

  it('does not offer "no organization" to somebody who cannot publish without one', async () => {
    /**
     * A Student Organizer holds `organization.event.create` and not
     * `event.create`. The server answers 403 `organization_required`; the option
     * that produces that request is simply not in the list.
     */
    await show(HELPER);
    await waitFor(() => expect(orgSelect()).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /No organization/i })).toBeNull();
    expect(screen.getByRole('option', { name: /Choose an organization/i })).toBeInTheDocument();
  });

  it('marks the field optional only when it is', async () => {
    await show(ORGANIZER);
    await waitFor(() => expect(orgSelect()).toBeInTheDocument());
    /* Scoped to THIS field's label — "(optional)" appears on other fields too,
       and a bare text query matched those instead. */
    expect(orgSelect().labels[0].textContent).toMatch(/optional/i);
  });

  it('does not mark it optional for a Student Organizer', async () => {
    await show(HELPER);
    await waitFor(() => expect(orgSelect()).toBeInTheDocument());
    const label = orgSelect().labels[0];
    expect(label.textContent).not.toMatch(/optional/i);
  });
});

/**
 * Arriving from a club page's "Post an opportunity" (final audit, Phase 5).
 * The club is chosen already, if this account may publish under it; a club it
 * may not is ignored, exactly as if it had been chosen in the select.
 */
describe('arriving from a club page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('chooses the club the link named', async () => {
    window.history.pushState({}, '', '/events/new?organization=org-2');
    await show(ORGANIZER);
    await waitFor(() => expect(document.getElementById('ce-org')).toHaveValue('org-2'));
    window.history.pushState({}, '', '/');
  });

  it('ignores a club this account may not publish under', async () => {
    window.history.pushState({}, '', '/events/new?organization=org-3');
    await show(ORGANIZER);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Chess Club' })).toBeInTheDocument());
    expect(document.getElementById('ce-org')).toHaveValue('');
    window.history.pushState({}, '', '/');
  });
});
