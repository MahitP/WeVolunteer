import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const apiMock = vi.hoisted(() => ({
  verifyCertificate: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchVolunteerProfile: vi.fn(),
  fetchLeaderboard: vi.fn(),
  fetchVolunteerStats: vi.fn(),
  getWeather: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./utils/api', () => ({ api: apiMock }));
vi.mock('./utils/errorReporting', () => ({ reportClientError: vi.fn() }));
vi.mock('./contexts/LocationContext', () => ({ useLocationContext: () => ({ location: null }) }));

import { aggregateServiceByEvent, creditedLabel, NO_HOURS_LABEL } from './utils/serviceRecord';
import CertificateDocument from './components/CertificateDocument';
import CertificateVerification from './views/CertificateVerification';
import CertificatesPage from './views/CertificatesPage';
import VolunteerDashboard from './views/VolunteerDashboard';
import VolunteerPortfolio from './views/VolunteerPortfolio';

/**
 * Events that give no hours, wherever they are shown (ruling 16).
 *
 * An organizer can post an event that credits no hours (P2-20). Attendance is
 * recorded with zero hours, which is right — and every surface printed the
 * zero: "+0 hrs credited" on the dashboard, "+0 hrs" on the profile, "0 hrs" on
 * the transcript, and a Certificate of Community Service reading "0 hrs of
 * verified community service". The owner ruled: "Attended · no hours" in place
 * of "+0 hrs", and a verifiable Certificate of Participation with no hours.
 *
 * Decided by the event's flag, never by the number: somebody credited 0 at an
 * hours-giving event — they left at once — still reads "+0 hrs", because that
 * is what happened.
 */

const pastIso = days => new Date(Date.now() - days * 86400000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchLeaderboard.mockResolvedValue([]);
  apiMock.fetchVolunteerStats.mockReturnValue(new Promise(() => {}));
});

describe('the label', () => {
  it('says "Attended · no hours" for an event that gives none, and the hours otherwise', () => {
    expect(NO_HOURS_LABEL).toBe('Attended · no hours');
    expect(creditedLabel({ creditsHours: false, hours: 0 })).toBe('Attended · no hours');
    expect(creditedLabel({ creditsHours: true, hours: 2 })).toBe('+2 hrs');
    /* Zero at an hours-giving event is a fact about the volunteer, not the event. */
    expect(creditedLabel({ creditsHours: true, hours: 0 })).toBe('+0 hrs');
    /* Absent means an ordinary event — every older payload. */
    expect(creditedLabel({ hours: 1 })).toBe('+1 hr');
  });

  it('survives the transcript\'s grouping by event', () => {
    const [row] = aggregateServiceByEvent([
      { eventId: 'e1', title: 'Coat Drive', hours: 0, creditsHours: false },
      { eventId: 'e1', title: 'Coat Drive', hours: 0, creditsHours: false },
    ]);
    expect(row.creditsHours).toBe(false);
  });
});

describe('a Certificate of Participation', () => {
  const certificate = {
    code: 'WEV-AAAA-BBBB', title: 'Coat Drive', hours: 0, participation: true,
    endDatetime: pastIso(2), organizerName: 'Sam Lee',
  };

  it('is titled as one, and carries no hours line', () => {
    render(<MemoryRouter><CertificateDocument certificate={certificate} volunteer={{ name: 'Leo Chen' }} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Certificate of Participation' })).toBeInTheDocument();
    expect(screen.getByText('took part in')).toBeInTheDocument();
    expect(screen.queryByText(/of verified community service/)).toBeNull();
    expect(screen.queryByText(/\b0 hrs\b/)).toBeNull();
  });

  it('verifies as participation, with no hours credited', async () => {
    apiMock.verifyCertificate.mockResolvedValue({
      valid: true, volunteerName: 'Leo Chen', eventTitle: 'Coat Drive', organizerName: 'Sam Lee',
      hours: 0, participation: true, completedAt: pastIso(2),
    });
    render(
      <MemoryRouter initialEntries={['/verify/WEV-AAAA-BBBB']}>
        <Routes><Route path="/verify/:code" element={<CertificateVerification />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Certificate of Participation/)).toBeInTheDocument();
    expect(screen.queryByText(/Hours Credited/i)).toBeNull();
    expect(screen.getByText('Attended · no hours')).toBeInTheDocument();
  });

  it('is listed without a "0 hrs"', async () => {
    apiMock.fetchCertificates.mockResolvedValue([{ ...certificate, eventId: 'e1' }]);
    render(<MemoryRouter><CertificatesPage /></MemoryRouter>);
    expect(await screen.findByText(/Participation/)).toBeInTheDocument();
    expect(screen.queryByText(/\b0 hrs\b/)).toBeNull();
  });
});

describe('the student\'s own record', () => {
  it('reads "Attended · no hours" on the dashboard, not "+0 hrs credited"', () => {
    const events = [{ id: 'e1', title: 'Coat Drive', location: 'Gym', status: 'completed', creditsHours: false }];
    const applications = [{
      id: 'a1', userId: 'u1', eventId: 'e1', status: 'accepted',
      attendance: { present: true, hoursAwarded: 0 },
      slot: { id: 's1', name: 'Collection', startDatetime: pastIso(3), endDatetime: pastIso(3) },
    }];
    render(
      <MemoryRouter>
        <VolunteerDashboard currentUser={{ id: 'u1', name: 'Leo Chen', role: 'student', volunteeredHours: 0 }}
          events={events} applications={applications} addToast={vi.fn()} setActiveTab={vi.fn()} onViewDetails={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Attended · no hours')).toBeInTheDocument();
    expect(screen.queryByText(/\+0 hrs/)).toBeNull();
  });

  it('reads "No hours" in the transcript\'s hours column', async () => {
    apiMock.fetchVolunteerProfile.mockResolvedValue({
      volunteer: { id: 'u1', name: 'Leo Chen', username: 'leo' },
      stats: { hours: 2, eventsCompleted: 2, shiftsCompleted: 2 },
      completed: [
        { eventId: 'e1', title: 'Coat Drive', organizerName: 'Sam Lee', hours: 0, creditsHours: false,
          startDatetime: pastIso(3), endDatetime: pastIso(3) },
        { eventId: 'e2', title: 'Shelving', organizerName: 'Sam Lee', hours: 2, creditsHours: true,
          startDatetime: pastIso(4), endDatetime: pastIso(4) },
      ],
    });
    render(<MemoryRouter><VolunteerPortfolio currentUser={{ id: 'u1' }} /></MemoryRouter>);
    const coat = (await screen.findByText('Coat Drive')).closest('tr');
    expect(coat.textContent).toContain('No hours');
    expect(coat.textContent).not.toMatch(/0 hrs/);
  });
});
