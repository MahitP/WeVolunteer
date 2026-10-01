import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  api: {
    fetchLeaderboard: vi.fn(),
    fetchVolunteerStats: vi.fn(),
    fetchVolunteerProfile: vi.fn(),
    fetchCertificates: vi.fn(),
    getWeather: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock('../utils/errorReporting', () => ({ reportClientError: vi.fn() }));
vi.mock('../contexts/LocationContext', () => ({ useLocationContext: () => ({ location: null }) }));

import { api } from '../utils/api';
import VolunteerDashboard from './VolunteerDashboard';
import VolunteerPortfolio from './VolunteerPortfolio';
import CertificatesPage from './CertificatesPage';
import { PAGE_META } from '../App.jsx';

/**
 * Two documents, each explained where it is (A7, FX-45, ruling 15).
 *
 * ── The third document ──
 *
 * The owner asked what the difference between a transcript and a certificate
 * is (FX-45), and that the transcript list events rather than shifts (FX-36).
 * There were in fact three documents. The dashboard's "Hours certificate"
 * button opened a modal titled "Certificate of Community Service": every shift
 * in a table, a total, two signature lines — and no verification code, so it
 * was the one certificate on the platform nobody could check. It summarised the
 * same service the transcript does, the other way the owner had asked it not
 * to.
 *
 * Now there are two. A certificate is one event's, with a code anyone can
 * verify. The transcript is the whole record, one row per event. The dashboard
 * button opens the transcript, and each page says in a sentence what the other
 * one is for.
 */

const READ = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const currentUser = { id: 'u1', name: 'Leo Chen', role: 'student', volunteeredHours: 6, serviceHourGoal: 25 };
const pastIso = days => new Date(Date.now() - days * 86400000).toISOString();
const events = [{ id: 'e3', title: 'Book Fair', location: 'Library', status: 'completed' }];
const applications = [{
  id: 'a1', userId: 'u1', eventId: 'e3', status: 'accepted',
  attendance: { present: true, hoursAwarded: 2 },
  slot: { id: 's1', name: 'Morning', startDatetime: pastIso(8), endDatetime: pastIso(8) },
}];

beforeEach(() => {
  vi.mocked(api.fetchLeaderboard).mockResolvedValue([]);
  vi.mocked(api.fetchVolunteerStats).mockReturnValue(new Promise(() => {}));
  vi.mocked(api.fetchVolunteerProfile).mockResolvedValue({
    volunteer: { id: 'u1', name: 'Leo Chen', username: 'leo' },
    stats: { hours: 2, eventsCompleted: 1, shiftsCompleted: 1 },
    completed: [{
      eventId: 'e3', title: 'Book Fair', organizerName: 'Sam Lee', location: 'Library',
      slotName: 'Morning', hours: 2, startDatetime: pastIso(8), endDatetime: pastIso(8),
    }],
  });
  vi.mocked(api.fetchCertificates).mockResolvedValue({ certificates: [] });
});

describe('the dashboard\'s hours card', () => {
  it('opens the transcript rather than a document of its own', () => {
    render(
      <MemoryRouter>
        <VolunteerDashboard currentUser={currentUser} events={events} applications={applications}
          addToast={vi.fn()} setActiveTab={vi.fn()} onViewDetails={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /^Transcript$/ })).toHaveAttribute('href', '/portfolio');
    expect(screen.queryByRole('button', { name: /Hours certificate/i })).toBeNull();
  });

  it('carries no certificate of its own', () => {
    /* Comments out first: the note explaining the removal names the title. */
    const src = READ('src/views/VolunteerDashboard.jsx').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/Certificate of Community Service/);
    expect(src).not.toMatch(/className="certificate"/);
  });
});

describe('each document says what the other is for', () => {
  it('names the transcript page what every button calls it', () => {
    expect(PAGE_META.volunteer.portfolio.title).toBe('Transcript');
    /* `staff` too: an owner holds `portfolio.write` through the wildcard. */
    expect(PAGE_META.staff.portfolio.title).toBe('Transcript');
  });

  it('explains certificates on the transcript, and links to them', async () => {
    render(<MemoryRouter><VolunteerPortfolio currentUser={{ id: 'u1' }} /></MemoryRouter>);
    const note = await screen.findByText(/A certificate is for one event/i);
    expect(note).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /your certificates/i })).toHaveAttribute('href', '/certificates');
  });

  it('explains the transcript on the certificates page, and links to it', async () => {
    render(<MemoryRouter><CertificatesPage /></MemoryRouter>);
    expect(await screen.findByText(/Your transcript is your whole record/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /your transcript/i })).toHaveAttribute('href', '/portfolio');
  });
});

describe('the transcript on paper (ruling 15)', () => {
  /**
   * Plain white, no panel. An earlier fix read the owner's "print it without
   * the white background" as "it printed as bare white paper" and added a
   * cream panel on purpose (9a2465b). The words read equally the other way,
   * and the owner ruled: the transcript prints straight onto the sheet. The
   * certificate keeps its look.
   */
  it('prints with no cream panel behind it', () => {
    const css = READ('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const start = css.indexOf('@media print {');
    const printBlock = css.slice(start, css.indexOf('Messages UI', start) > 0 ? css.indexOf('Messages UI', start) : undefined);
    const rule = /\.transcript-page \.transcript\s*\{([^}]*)\}/.exec(printBlock);
    expect(rule, 'no print rule for .transcript-page .transcript').toBeTruthy();
    expect(rule[1]).not.toMatch(/--cert-bg/);
    expect(rule[1]).toMatch(/background:\s*#fff\b/);
  });

  /**
   * And it has to WIN. The print rule was `.transcript { … }` inside the print
   * block, and the screen rule `.transcript { background: var(--cert-bg) … }`
   * comes later in the file at the same specificity — so on paper the screen
   * rule won, and none of the print block's padding, border or background ever
   * applied. The cream panel the earlier fix described was the screen rule all
   * along. Two classes beat one wherever each sits.
   */
  it('outranks the screen rule rather than relying on its place in the file', () => {
    const css = READ('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const screenRules = [...css.matchAll(/(?:^|\})\s*([^{}]*?)\s*\{[^}]*background:\s*var\(--cert-bg\)[^}]*\}/g)]
      .map(m => m[1].trim())
      .filter(sel => /(^|[\s,])\.transcript$/.test(sel));
    expect(screenRules.length, 'the screen rule moved — re-check the specificity argument').toBeGreaterThan(0);
    for (const sel of screenRules) expect(sel).toBe('.transcript');
  });
});
