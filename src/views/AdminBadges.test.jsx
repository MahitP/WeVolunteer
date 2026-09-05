import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminBadges from './AdminBadges';
import { api } from '../utils/api';
import { BADGE_CRITERIA_TYPES } from '../badgeCriteria';
import { __resetModalStack } from '../utils/useModal';

/**
 * Badge administration.
 *
 * ── What these cases are actually protecting ──
 *
 * The four endpoints behind this page were finished, validated, transactional
 * and audited, and had no caller at all: an administrator could not define a
 * badge, award one, or take back a wrong one except with `curl`. So the risk is
 * not that the endpoints are broken — it is that the screen in front of them
 * quietly stops reaching one of them, which is the state the product was
 * already in.
 *
 * Three properties matter most:
 *
 *   1. **The criteria dropdown is the server's list.** A type the evaluator
 *      does not know produces a badge that is visible in the catalogue and can
 *      never be earned by anybody — nothing throws and nothing logs, so the
 *      only symptom is "nobody has qualified yet". Asserted against the shared
 *      vocabulary rather than against a list written here, because a second
 *      copy in the test is the same defect one level up.
 *   2. **Revoking is reachable and confirmed.** It is the reason the endpoint
 *      exists: attendance can be un-marked and the hours come off the ledger
 *      while the badge earned on them stays.
 *   3. **A refusal lands on the control that caused it.** The endpoint answers
 *      `{ error, field }` for both criteria faults, and a field-level error
 *      shape has exactly one consumer.
 */

vi.mock('../utils/api');

const BADGES = [
  {
    id: 'badge-1', name: 'First shift', description: 'Turned up once.', icon: '🌱',
    category: 'Service', criteria_type: 'events_attended', criteria_value: 1, active: 1,
  },
  {
    id: 'badge-2', name: 'Retired badge', description: 'No longer given.', icon: '🗃️',
    category: 'Service', criteria_type: 'hours', criteria_value: 5, active: 0,
  },
  {
    id: 'badge-3', name: "Founder's badge", description: 'Given by hand.', icon: '🏅',
    category: 'Recognition', criteria_type: 'manual', criteria_value: 0, active: 1,
  },
];

const PERSON = { id: 'user-diana', name: 'Dana Sorensen', username: 'dsorensen', avatar: '👩' };

const draw = () => render(<MemoryRouter><AdminBadges /></MemoryRouter>);

const loaded = () => waitFor(() => expect(screen.getByText('First shift')).toBeInTheDocument());

beforeEach(() => {
  vi.clearAllMocks();
  __resetModalStack();
  api.fetchBadgeDefinitions.mockResolvedValue({ badges: BADGES });
  api.searchDirectory.mockResolvedValue({ users: [PERSON] });
  api.apiFetch.mockResolvedValue({ badges: [] });
  api.saveBadgeDefinition.mockResolvedValue({ success: true, badgeId: 'badge-9' });
  api.awardBadge.mockResolvedValue({ success: true });
  api.revokeBadge.mockResolvedValue({ success: true });
});

describe('the definitions table', () => {
  it('lists inactive definitions as well as active ones', async () => {
    draw();
    await loaded();
    /* `GET /api/admin/badges` is the ONLY route that returns inactive rows —
       the public catalogue filters them out — so an administrator who cannot
       see them here cannot reactivate one either. */
    expect(screen.getByText('Retired badge')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('says what each threshold counts, not just its number', async () => {
    draw();
    await loaded();
    /* "criteria_value: 1" against a bare `events_attended` is a number with no
       unit. `attendance_rate` is the case that bites: the evaluator compares it
       against a PERCENTAGE, and an administrator who reads 80 as "80 shifts"
       creates a badge that is either trivial or unearnable. */
    expect(screen.getByText(/Events attended · 1 events/)).toBeInTheDocument();
  });

  it('says so when a stored criteria type is one the evaluator cannot decide', async () => {
    api.fetchBadgeDefinitions.mockResolvedValue({
      badges: [{ ...BADGES[0], criteria_type: 'hourz' }],
    });
    draw();
    await waitFor(() => expect(screen.getByText('First shift')).toBeInTheDocument());
    /* Such a row can only predate the validator, and rendering it as if it
       worked is how "nobody has qualified yet" gets believed for a badge that
       is structurally unearnable. */
    expect(screen.getByText(/cannot be earned/i)).toBeInTheDocument();
  });

  it('explains what to do when there are none at all', async () => {
    api.fetchBadgeDefinitions.mockResolvedValue({ badges: [] });
    draw();
    await waitFor(() => expect(screen.getByText(/No badges are defined yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Define the first badge/i })).toBeInTheDocument();
  });

  it('offers a way back when the definitions cannot be loaded', async () => {
    const err = new Error('nope');
    api.fetchBadgeDefinitions.mockRejectedValueOnce(err);
    draw();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });
});

describe('the definition form', () => {
  it('offers exactly the criteria types the server can evaluate', async () => {
    draw();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /New badge/i }));

    const select = await screen.findByLabelText(/How it is earned/i);
    const values = [...select.querySelectorAll('option')].map(o => o.value);
    /* Compared against the SHARED vocabulary, not a list typed out here.
       `server/badgeCriteria.js` is the single source, and a copy in this file
       would be the same drift one level up. */
    expect(values).toEqual([...BADGE_CRITERIA_TYPES]);
  });

  it('hides the threshold for types that do not count anything', async () => {
    draw();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /New badge/i }));

    const select = await screen.findByLabelText(/How it is earned/i);
    expect(screen.getByLabelText(/Threshold/i)).toBeInTheDocument();

    /* `manual` is given by hand and `early_adopter` is decided by a join date.
       An empty number field for either invites a value that changes nothing. */
    fireEvent.change(select, { target: { value: 'manual' } });
    expect(screen.queryByLabelText(/Threshold/i)).toBeNull();
  });

  it('names the unit in the threshold label', async () => {
    draw();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /New badge/i }));

    const select = await screen.findByLabelText(/How it is earned/i);
    fireEvent.change(select, { target: { value: 'attendance_rate' } });
    expect(screen.getByLabelText(/Threshold \(%\)/)).toBeInTheDocument();
  });

  it('sends an id when editing, so the endpoint updates rather than creating', async () => {
    draw();
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]);

    await screen.findByLabelText(/^Name$/i);
    fireEvent.click(screen.getByRole('button', { name: /Save badge/i }));

    await waitFor(() => expect(api.saveBadgeDefinition).toHaveBeenCalled());
    expect(api.saveBadgeDefinition.mock.calls[0][0]).toMatchObject({ id: 'badge-1' });
  });

  it('puts a field-level refusal on screen rather than a generic failure', async () => {
    const err = new Error('Unknown criteria_type "hourz".');
    err.field = 'criteria_type';
    api.saveBadgeDefinition.mockRejectedValueOnce(err);

    draw();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /New badge/i }));
    await screen.findByLabelText(/^Name$/i);
    fireEvent.click(screen.getByRole('button', { name: /Save badge/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Unknown criteria_type/));
    /* And the form stays open with the values in it — a refusal that closes the
       dialog makes the administrator retype everything. */
    expect(screen.getByLabelText(/^Name$/i)).toBeInTheDocument();
  });
});

describe('awarding and taking back', () => {
  const pickPerson = async () => {
    fireEvent.change(screen.getByLabelText(/Find a volunteer/i), { target: { value: 'dana' } });
    const hit = await screen.findByRole('button', { name: /Dana Sorensen/i }, { timeout: 3000 });
    fireEvent.click(hit);
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/users/user-diana/badges'));
  };

  it('shows what somebody already holds before offering to change it', async () => {
    api.apiFetch.mockResolvedValue({
      badges: [{ id: 'badge-1', name: 'First shift', icon: '🌱', earned_at: '2026-05-01T00:00:00.000Z' }],
    });
    draw();
    await loaded();
    await pickPerson();

    /* This is what makes revoking possible at all: an administrator correcting
       a mistake has to be able to see the mistake. */
    expect(await screen.findByRole('button', { name: /^Remove$/ })).toBeInTheDocument();
  });

  it('only offers active definitions to award', async () => {
    draw();
    await loaded();
    await pickPerson();

    const select = await screen.findByLabelText(/Award a badge by hand/i);
    const names = [...select.querySelectorAll('option')].map(o => o.textContent);
    /* Awarding an inactive badge would put something on a profile that the
       catalogue does not list. */
    expect(names).not.toContain('Retired badge');
    expect(names).toContain('First shift');
  });

  it('sends the award with the reason that goes into the audit row', async () => {
    draw();
    await loaded();
    await pickPerson();

    fireEvent.change(await screen.findByLabelText(/Award a badge by hand/i), { target: { value: 'badge-3' } });
    fireEvent.change(screen.getByLabelText(/Why \(optional/i), { target: { value: 'district recognition' } });
    fireEvent.click(screen.getByRole('button', { name: /^Award badge$/ }));

    await waitFor(() => expect(api.awardBadge).toHaveBeenCalledWith({
      userId: 'user-diana', badgeId: 'badge-3', reason: 'district recognition',
    }));
  });

  it('reports "they already hold that" instead of a generic error', async () => {
    const err = new Error('This volunteer already holds that badge.');
    err.status = 409;
    api.awardBadge.mockRejectedValueOnce(err);

    draw();
    await loaded();
    await pickPerson();
    fireEvent.change(await screen.findByLabelText(/Award a badge by hand/i), { target: { value: 'badge-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Award badge$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/already holds that badge/i));
  });

  it('confirms before removing, and says what removal does', async () => {
    api.apiFetch.mockResolvedValue({
      badges: [{ id: 'badge-3', name: "Founder's badge", icon: '🏅', earned_at: '2026-05-01T00:00:00.000Z' }],
    });
    draw();
    await loaded();
    await pickPerson();

    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));

    /* A badge is a permanent, publicly visible statement on a minor's profile
       that an adult chose to put there. Taking one off is confirmed, and the
       dialog says which way it can come back. */
    expect(await screen.findByText(/will not come back on its own/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Why it is being removed/i), { target: { value: 'awarded in error' } });
    fireEvent.click(screen.getByRole('button', { name: /^Remove badge$/ }));

    await waitFor(() => expect(api.revokeBadge).toHaveBeenCalledWith({
      userId: 'user-diana', badgeId: 'badge-3', reason: 'awarded in error',
    }));
  });

  it('re-reads what they hold after a change rather than patching state', async () => {
    draw();
    await loaded();
    await pickPerson();
    const before = api.apiFetch.mock.calls.length;

    fireEvent.change(await screen.findByLabelText(/Award a badge by hand/i), { target: { value: 'badge-3' } });
    fireEvent.click(screen.getByRole('button', { name: /^Award badge$/ }));

    /* The server decides what somebody holds — `badgeService` can withdraw its
       own awards, so a locally-patched list can disagree with the record the
       student sees on their profile. */
    await waitFor(() => expect(api.apiFetch.mock.calls.length).toBeGreaterThan(before));
  });
});
