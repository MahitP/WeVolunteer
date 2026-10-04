import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMock = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ api: apiMock }));

import AdminOrganizers from './AdminOrganizers';

/**
 * "Make an approved organizer unapproved" (P2-12), from the administrator's
 * side. A revoked organizer keeps their events and every volunteer's record;
 * approving again restores them. A reason is required, because it goes in the
 * audit trail.
 */

const LIST = {
  organizers: [
    { id: 'o1', name: 'Jordan Whitfield', email: 'j@example.org', school: 'Library', events: 4, status: 'approved', revokedAt: null },
    { id: 'o2', name: 'Sam Lee', email: 's@example.org', school: null, events: 1, status: 'revoked', revokedAt: '2026-09-30T10:00:00.000Z' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.apiFetch.mockImplementation(async (url) => (url === '/api/admin/organizers/approved' ? LIST : { success: true }));
});

const draw = () => render(<MemoryRouter><AdminOrganizers addToast={vi.fn()} /></MemoryRouter>);

describe('approved organizers', () => {
  it('lists each organizer, approved or revoked, with their events', async () => {
    draw();
    const jordan = (await screen.findByText('Jordan Whitfield')).closest('li');
    expect(within(jordan).getByText(/4 events/)).toBeInTheDocument();
    expect(within(jordan).getByRole('button', { name: /Revoke approval/ })).toBeInTheDocument();
    const sam = screen.getByText('Sam Lee').closest('li');
    expect(within(sam).getByText(/Approval revoked/)).toBeInTheDocument();
    expect(within(sam).getByRole('button', { name: /Restore approval/ })).toBeInTheDocument();
  });

  it('revokes only with a reason, and sends it', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke approval for Jordan Whitfield/ }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /^Revoke approval$/ });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Why/), { target: { value: 'Posting events that are not volunteering.' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.apiFetch).toHaveBeenCalledWith('/api/admin/organizers/o1/revoke', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ reason: 'Posting events that are not volunteering.' }),
    })));
  });

  it('restores a revoked organizer by approving them again', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Restore approval for Sam Lee/ }));
    await waitFor(() => expect(apiMock.apiFetch).toHaveBeenCalledWith('/api/admin/organizers/o2/approve', expect.objectContaining({ method: 'POST' })));
  });

  it('is reached from the organizer requests on the dashboard', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/views/AdminDashboard.jsx'), 'utf8');
    expect(src).toMatch(/to="\/admin\/organizers"/);
  });
});
