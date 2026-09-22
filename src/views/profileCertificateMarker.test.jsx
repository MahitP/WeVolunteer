import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VolunteerProfile from './VolunteerProfile';
import AssistantCard from '../components/ai/AssistantCard';

/**
 * The surfaces owner decision 2 reached, and the two it did not.
 *
 * ── The contradiction, one screen wide ──
 *
 * `/api/certificates` now lists a certificate whose event was cancelled
 * afterwards, because the list enumerates issued documents rather than the
 * transcript. `CertificatesPage` and `PublicCertificates` say so on the row.
 *
 * `VolunteerProfile` renders the same list in a preview column — and its own
 * comment says the five certificates are "the SAME five as the service record
 * opposite". The service record is `completed[]`, which excludes cancelled
 * events. So after that decision the profile could show a certificate, with its
 * hours, beside a service record that does not list the event, with nothing to
 * explain the difference. That is the contradiction the decision exists to
 * remove, on the one screen that shows both halves at once.
 *
 * Welly's certificates card has the same shape and the same gap: it prints
 * "4 hours" per row from the same endpoint.
 *
 * Found by the post-implementation audit of owner decision 2.
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

const USER = { id: 'u1', name: 'Leo Chen', role: 'student' };

/** The shape `GET /api/users/:id/profile` returns, trimmed to what renders. */
const PROFILE = {
  volunteer: { id: 'u1', name: 'Leo Chen', avatar: '🙂', role: 'student' },
  stats: { hours: 21, events: 3, shifts: 3 },
  milestones: [],
  byCategory: [],
  completed: [],
  upcoming: [],
};

const LIVE = {
  eventId: 'e-live', title: 'Park Cleanup', code: 'WV-AAAA1111',
  hours: 4, endDatetime: '2026-07-02T17:00:00.000Z', eventCancelled: false,
};
const CALLED_OFF = {
  eventId: 'e-off', title: 'Winter Coat Drive', code: 'WV-BBBB2222',
  hours: 4, endDatetime: '2026-07-23T17:00:00.000Z', eventCancelled: true,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the certificate preview on a volunteer’s own profile', () => {
  const renderProfile = async () => {
    apiMock.fetchVolunteerProfile.mockResolvedValue(PROFILE);
    apiMock.fetchCertificates.mockResolvedValue([LIVE, CALLED_OFF]);
    render(
      <MemoryRouter>
        <VolunteerProfile userId="u1" currentUser={USER} onBack={() => {}} />
      </MemoryRouter>
    );
    await screen.findByText('Winter Coat Drive');
  };

  it('says when a listed certificate’s event was called off', async () => {
    await renderProfile();
    expect(
      screen.getByText(/not counted in your totals/i),
      'the profile showed a certificate beside a service record that omits its event, unexplained'
    ).toBeTruthy();
  });

  it('marks only the cancelled one', async () => {
    await renderProfile();
    expect(screen.getAllByText(/not counted in your totals/i)).toHaveLength(1);
    expect(screen.getByText('Park Cleanup')).toBeTruthy();
  });
});

describe('Welly’s certificates card', () => {
  it('says when a listed certificate’s event was called off', () => {
    render(<AssistantCard card={{ kind: 'certificates', data: {
      total: 2,
      items: [
        { code: 'WV-AAAA1111', eventTitle: 'Park Cleanup', hours: 4, eventCancelled: false },
        { code: 'WV-BBBB2222', eventTitle: 'Winter Coat Drive', hours: 4, eventCancelled: true },
      ],
    } }} />);

    const card = screen.getByLabelText('Your certificates');
    expect(card.textContent).toMatch(/event cancelled, not counted in your totals/i);
  });

  it('leaves an ordinary certificate alone', () => {
    render(<AssistantCard card={{ kind: 'certificates', data: {
      total: 1,
      items: [{ code: 'WV-AAAA1111', eventTitle: 'Park Cleanup', hours: 4, eventCancelled: false }],
    } }} />);

    const card = screen.getByLabelText('Your certificates');
    expect(card.textContent).not.toMatch(/event cancelled/i);
  });
});

/**
 * The wiring between the endpoint and the card, which nothing crossed.
 *
 * Mutation-checked and found wanting: deleting the `eventCancelled` passthrough
 * in `my_certificates` left the whole client suite green, because the card cases
 * above build their own data. A card that renders a flag it is never handed is
 * two correct halves and no feature.
 */
describe('the certificates tool carries the flag the card renders', () => {
  it('passes eventCancelled through from the endpoint', async () => {
    apiMock.fetchCertificates.mockResolvedValue([LIVE, CALLED_OFF]);
    const { TOOLS } = await import('../ai/tools.js');

    const result = await TOOLS.my_certificates.run({});
    const items = result.data.items;

    expect(items.find(i => i.code === 'WV-BBBB2222').eventCancelled).toBe(true);
    expect(items.find(i => i.code === 'WV-AAAA1111').eventCancelled).toBe(false);
  });

  it('defaults to false rather than undefined for an older payload', async () => {
    /* The card renders on truthiness; `undefined` would read the same way, but
       a boolean is what the field claims to be and what a snapshot of this
       payload should show. */
    apiMock.fetchCertificates.mockResolvedValue([
      { eventId: 'e-old', title: 'Old Shape', code: 'WV-CCCC3333', hours: 2 },
    ]);
    const { TOOLS } = await import('../ai/tools.js');

    const result = await TOOLS.my_certificates.run({});
    expect(result.data.items[0].eventCancelled).toBe(false);
  });
});
