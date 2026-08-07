/**
 * The Administrator Roster screen.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization: the endpoints are gated on `admin.create` and proved
 * server-side, and `App.shellByRole.test.jsx` proves the nav entry is hidden
 * from administrators.
 *
 * This covers what the screen does once the owner is inside it — and in
 * particular the one thing about a step-up flow that no server test can catch,
 * because the server is only ever handed a challenge the client already opened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminRoster from './AdminRoster';
import { api } from '../utils/api';

vi.mock('../utils/api');

const run = vi.fn((action, params, attempt) => attempt({}));
vi.mock('../components/auth/useStepUp', () => ({
  useStepUp: () => ({ run, modal: null }),
}));

const ADMIN = (over = {}) => ({
  id: 'user-admin',
  name: 'Jacquelyn Katzenback',
  email: 'admin@example.gov',
  role: 'admin',
  avatar: '🛡️',
  lastSignInAt: '2026-08-06T09:00:00.000Z',
  promotedAt: '2026-01-04T09:00:00.000Z',
  promotedBy: 'user-super',
  promotionReason: 'Runs the moderation queue',
  isOwner: false,
  capabilities: ['report.resolve'],
  grants: [],
  withholdings: [],
  decisionCount: 12,
  evidenceReadCount: 3,
  ...over,
});

const renderRoster = () => render(<MemoryRouter><AdminRoster /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchAdminRoster.mockResolvedValue([ADMIN()]);
  api.promoteAdmin.mockResolvedValue({ success: true });
  api.revokeAdmin.mockResolvedValue({ success: true });
});

describe('AdminRoster', () => {
  it('lists the administrators the API returns', async () => {
    renderRoster();
    expect(await screen.findByText('Jacquelyn Katzenback')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of rendering an empty roster', async () => {
    api.fetchAdminRoster.mockRejectedValue(new Error('the roster service is down'));
    renderRoster();
    expect(await screen.findByRole('heading', { name: /failed to load roster/i })).toBeInTheDocument();
    expect(screen.getByText(/the roster service is down/i)).toBeInTheDocument();
  });

  /**
   * The bug this test exists for.
   *
   * `sensitiveActions.js` binds `admin.promote` and `admin.revoke` to
   * `bindsParams: ['targetUserId']`, and the handlers spend the grant with
   * `spendChallenge(db, req, 'admin.promote', { targetUserId })`. The screen
   * opened its challenge with `{ id: userId }`.
   *
   * A missing key hashes as ABSENT, so the grant the client obtained and the
   * grant the server looked for could never match: every promotion and every
   * revocation would fail after the owner had already re-entered their
   * password. Nothing on the server could catch it — the server only ever sees
   * a challenge the client already opened, so from its side the params simply
   * did not match, which is indistinguishable from an attack it is right to
   * refuse.
   *
   * CLAUDE.md states the rule this breaks: params must be exactly the keys the
   * registry binds, no more and no fewer.
   */
  it('binds targetUserId, not id, whenever it runs a step-up', async () => {
    renderRoster();
    await screen.findByText('Jacquelyn Katzenback');

    // The real path: expand the row, open the revoke modal, type the
    // administrator's name to confirm, submit.
    fireEvent.click(screen.getByRole('button', { name: /view capabilities/i }));
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));

    const confirm = await screen.findByLabelText(/type .* to confirm/i);
    fireEvent.change(confirm, { target: { value: 'Jacquelyn Katzenback' } });
    fireEvent.click(screen.getByRole('button', { name: /revoke access/i }));

    await waitFor(() => expect(run).toHaveBeenCalled());
    const [, params] = run.mock.calls[0];
    expect(
      Object.keys(params),
      'the challenge must bind exactly the keys sensitiveActions.js declares — '
      + 'a missing key hashes as absent and the grant can never be spent'
    ).toEqual(['targetUserId']);
  });
});
