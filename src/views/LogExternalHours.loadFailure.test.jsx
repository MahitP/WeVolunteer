import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LogExternalHours from './LogExternalHours';

/**
 * A failed load must not tell a student their hours record is empty.
 *
 * The list used to load with `.catch(() => setEntries([]))`, and the empty
 * branch renders an EmptyState titled "Nothing logged yet". So a request that
 * never arrived produced a confident statement about the student's own
 * volunteer record — on the one screen where the obvious response is to type it
 * all in again. That is how a network blip becomes duplicate submissions
 * against a total that determines whether somebody meets a service requirement.
 *
 * Scoped to the load path deliberately: this view is large (certificate import,
 * extraction, validation) and a broad suite for it is a separate piece of work.
 * These two cases pin the claim and its counterpart, which is what regressed.
 */
vi.mock('../utils/api', () => ({
  api: {
    fetchExternalHours: vi.fn(),
    createExternalHours: vi.fn(),
    deleteExternalHours: vi.fn(),
  },
}));

vi.mock('../components/account/CertificateImport', () => ({
  default: () => null,
}));

const { api } = await import('../utils/api');

const renderView = (addToast) => render(
  <MemoryRouter><LogExternalHours addToast={addToast} /></MemoryRouter>
);

beforeEach(() => vi.clearAllMocks());

describe('LogExternalHours load failure', () => {
  it('does not claim "Nothing logged yet" when the request failed', async () => {
    api.fetchExternalHours.mockRejectedValue(new Error('network down'));
    const addToast = vi.fn();

    renderView(addToast);

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][1]).toBe('error');
    expect(screen.queryByText(/Nothing logged yet/i)).not.toBeInTheDocument();
  });

  it('does claim it when the server really returns no entries', async () => {
    /* The counterpart, so the fix cannot become "never show the empty state". */
    api.fetchExternalHours.mockResolvedValue({ entries: [] });
    const addToast = vi.fn();

    renderView(addToast);

    expect(await screen.findByText(/Nothing logged yet/i)).toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalled();
  });
});
