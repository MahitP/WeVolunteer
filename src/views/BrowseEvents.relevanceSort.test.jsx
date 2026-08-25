import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowseEvents from './BrowseEvents';

/**
 * "Most relevant" — the one control semantic search adds to Discover.
 *
 * ── Why the option is conditional, and why that needs a test ──
 *
 * `relevance` orders by the candidate ranking the server got from Pinecone. With
 * an empty search box there is no ranking, and the server resolves the sort to
 * `soonest`. An option that silently means the same as another option is a
 * control that lies, so it appears only while there is a query to be relevant
 * to — and, more importantly, it has to STOP being selected when the query goes
 * away. A `<select>` holding a value none of its options carry renders blank and
 * announces nothing, which is an accessibility failure rather than a cosmetic
 * one.
 *
 * ── What this does not claim ──
 *
 * Nothing here asserts that results are better ordered. That is decided by the
 * server and by a vendor, and a component test that mocked its way to an opinion
 * about ranking quality would be testing its own mock.
 */

const fetchEventsFiltered = vi.fn().mockResolvedValue({ events: [], total: 0, pagination: { total: 0 } });

vi.mock('../utils/api', () => ({
  api: {
    fetchEventsFiltered: (...args) => fetchEventsFiltered(...args),
    fetchRecommendations: vi.fn().mockResolvedValue([]),
    fetchOrganizations: vi.fn().mockResolvedValue({ organizations: [] }),
    searchDirectory: vi.fn().mockResolvedValue({ users: [], organizations: [] }),
  },
}));

vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => ({ location: null, requestLocation: vi.fn() }),
}));

const STUDENT = { id: 'user-1', role: 'student', verified: true, withheld: [], volunteeredHours: 0 };

const renderBrowse = () => render(
  <MemoryRouter>
    <BrowseEvents currentUser={STUDENT} onViewDetails={() => {}} onEventsSeen={() => {}} />
  </MemoryRouter>,
);

const sortControl = () => screen.getByRole('combobox', { name: /sort by/i });
const searchBox = () => screen.getByRole('searchbox');

/* `fireEvent` rather than `user-event`: this repository does not carry
   @testing-library/user-event, and adding a dependency to type into one input is
   not a trade ENGINEERING_GUIDE §3.2 would accept. A controlled React input
   reads its value from the change event either way. */
const type = (text) => fireEvent.change(searchBox(), { target: { value: text } });
const choose = (value) => fireEvent.change(sortControl(), { target: { value } });

describe('the "Most relevant" sort', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is not offered while the search box is empty', () => {
    renderBrowse();
    expect(screen.queryByRole('option', { name: /most relevant/i })).not.toBeInTheDocument();
  });

  it('appears once there is a query worth ranking', async () => {
    renderBrowse();

    type('animals');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /most relevant/i })).toBeInTheDocument();
    });
  });

  /** Two characters is a prefix, and the server keeps prefixes on substring search. */
  it('does not appear for a query too short to mean anything', async () => {
    renderBrowse();

    type('an');

    expect(screen.queryByRole('option', { name: /most relevant/i })).not.toBeInTheDocument();
  });

  /** A `#tag` search has an exact answer and is routed to the tag facet. */
  it('does not appear for a sigil search', async () => {
    renderBrowse();

    type('#nhs');

    expect(screen.queryByRole('option', { name: /most relevant/i })).not.toBeInTheDocument();
  });

  it('is sent to the server when chosen', async () => {
    renderBrowse();

    type('outdoors with animals');
    await waitFor(() => screen.getByRole('option', { name: /most relevant/i }));
    choose('relevance');

    await waitFor(() => {
      const sorts = fetchEventsFiltered.mock.calls.map(([args]) => args?.sort);
      expect(sorts).toContain('relevance');
    });
  });

  /**
   * Clearing the box must reset the STATE, not just the rendering.
   *
   * When the option is removed the browser moves the select to its first
   * remaining option by itself, so the DISPLAYED value looks correct whether or
   * not anything was reset — a mutation test showed an assertion on the
   * displayed value passing with the reset deleted. What actually changes is
   * what happens NEXT: without the reset `sortBy` is still `relevance`, so the
   * moment the student types again the list silently re-sorts by a ranking they
   * did not ask for.
   */
  it('stops asking for relevance once the query is gone', async () => {
    renderBrowse();

    type('outdoors with animals');
    await waitFor(() => screen.getByRole('option', { name: /most relevant/i }));
    choose('relevance');
    await waitFor(() => {
      expect(fetchEventsFiltered.mock.calls.map(([a]) => a?.sort)).toContain('relevance');
    });

    type('');
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /most relevant/i })).not.toBeInTheDocument();
    });

    /* Type again. The sort must be the default, not the one that is no longer
       offered and was never re-chosen. */
    fetchEventsFiltered.mockClear();
    type('gardening');

    await waitFor(() => {
      expect(fetchEventsFiltered.mock.calls.length).toBeGreaterThan(0);
      const sorts = fetchEventsFiltered.mock.calls.map(([a]) => a?.sort);
      expect(sorts, 'a sort the student never chose came back').not.toContain('relevance');
    });
  });

  /** The control keeps its label and stays reachable throughout. */
  it('keeps the sort control labelled and operable', async () => {
    renderBrowse();
    type('outdoors with animals');

    const control = sortControl();
    expect(control).toBeEnabled();
    expect(control).toHaveAccessibleName(/sort by/i);
  });
});
