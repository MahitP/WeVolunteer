import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CertificatesPage from './CertificatesPage';
import PublicCertificates from './PublicCertificates';

/**
 * A certificate for an event that was called off afterwards says so.
 *
 * ── Why the row exists at all ──
 *
 * Both lists enumerate CERTIFICATES rather than the transcript — see the two
 * queries in `attendanceRoutes.js`. That is what stopped the owner being the
 * one person hidden from a document that verifies to a college.
 *
 * The other half of that decision is this: a reader has to be told, or the
 * row reads as ordinary completed service and the hours will not be on their
 * transcript when they go looking. `CertificateView` already carries the full
 * sentence on the document itself; these are the short forms in the lists, so
 * opening one is not a surprise.
 *
 * Decided during the 2026-09-21 audit (owner decision 2).
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

const LIVE = {
  eventId: 'e-live', title: 'Park Cleanup', code: 'WV-AAAA1111',
  hours: 4, shifts: 1, endDatetime: '2026-07-02T17:00:00.000Z',
  organizerName: 'Jordan Whitfield', eventCancelled: false,
};
const CALLED_OFF = {
  eventId: 'e-off', title: 'Winter Coat Drive', code: 'WV-BBBB2222',
  hours: 4, shifts: 1, endDatetime: '2026-07-23T17:00:00.000Z',
  organizerName: 'Jordan Whitfield', eventCancelled: true,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the owner’s certificate list', () => {
  it('marks a certificate whose event was cancelled', async () => {
    apiMock.fetchCertificates.mockResolvedValue([LIVE, CALLED_OFF]);
    render(<MemoryRouter><CertificatesPage /></MemoryRouter>);

    await screen.findByText('Winter Coat Drive');
    expect(screen.getByText(/still valid, not counted in your totals/i)).toBeTruthy();
  });

  it('marks only that one', async () => {
    apiMock.fetchCertificates.mockResolvedValue([LIVE, CALLED_OFF]);
    render(<MemoryRouter><CertificatesPage /></MemoryRouter>);

    await screen.findByText('Park Cleanup');
    expect(screen.getAllByText(/still valid, not counted/i)).toHaveLength(1);
  });

  it('still links the cancelled certificate to its document', async () => {
    /* The row is only listed when a certificate was actually issued, so it
       always has a code — a row that could not be opened would be worse than
       the omission this replaced. */
    apiMock.fetchCertificates.mockResolvedValue([CALLED_OFF]);
    render(<MemoryRouter><CertificatesPage /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: /Winter Coat Drive/i });
    expect(link.getAttribute('href')).toBe('/certificates/WV-BBBB2222');
  });
});

describe('somebody else’s certificate list', () => {
  const renderPublic = () => render(
    <MemoryRouter initialEntries={['/users/@leo/certificates']}>
      <Routes>
        <Route path="/users/:handle/certificates" element={<PublicCertificates />} />
      </Routes>
    </MemoryRouter>
  );

  it('marks it for a reader who is not the subject', async () => {
    apiMock.fetchPublicProfile.mockResolvedValue({ id: 'u-leo' });
    apiMock.fetchUserCertificates.mockResolvedValue({
      volunteer: { id: 'u-leo', name: 'Leo Chen', username: 'leo' },
      isSelf: false,
      certificates: [LIVE, CALLED_OFF],
    });
    renderPublic();

    await screen.findByText('Winter Coat Drive');
    await waitFor(() =>
      expect(screen.getByText(/still valid, not counted in service totals/i)).toBeTruthy());
  });

  it('does not say "your totals" about somebody else', async () => {
    apiMock.fetchPublicProfile.mockResolvedValue({ id: 'u-leo' });
    apiMock.fetchUserCertificates.mockResolvedValue({
      volunteer: { id: 'u-leo', name: 'Leo Chen', username: 'leo' },
      isSelf: false,
      certificates: [CALLED_OFF],
    });
    renderPublic();

    await screen.findByText('Winter Coat Drive');
    expect(screen.queryByText(/your totals/i)).toBeNull();
  });
});
