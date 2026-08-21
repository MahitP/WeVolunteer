import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import AssistantCard, { AssistantSource } from './AssistantCard';

/**
 * The authoritative half of an answer, rendered from tool data.
 *
 * ── Why this file exists ──
 *
 * Twelve of twenty-four tool kinds had no renderer at all and fell through to
 * `null`, seven of them with no summary sentence either — so a lookup that
 * succeeded showed "Here is what I found." and nothing beneath it. Three of
 * Welly's own suggestion chips landed there: "What is my next shift?" for a
 * student, "Show my events" and "Show my organizer statistics" for an
 * organizer.
 *
 * The payloads below are the shapes `tools.js` actually returns, copied from
 * the `ok(...)` calls rather than invented, so a change to a tool's output
 * fails here rather than silently rendering blanks.
 */

const show = card => render(<MemoryRouter><AssistantCard card={card} /></MemoryRouter>);

describe('the kinds that used to render nothing', () => {
  it('shows the next shift, when there is one', () => {
    show({
      kind: 'next_shift',
      data: { total: 2, next: { eventTitle: 'Food Bank', slotName: 'Morning sort', startsAt: 'Sat 9:00 AM', hours: 3 } },
    });
    expect(screen.getByText('Food Bank')).toBeInTheDocument();
    expect(screen.getByText('Sat 9:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Morning sort')).toBeInTheDocument();
  });

  it('renders nothing for a next shift that does not exist', () => {
    /* The sentence already says there is nothing coming up. An empty card
       under it would be a box containing the word "Shift". */
    const { container } = show({ kind: 'next_shift', data: { total: 0, next: null } });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each waitlisted shift and the place in the queue', () => {
    show({
      kind: 'waitlists',
      data: { total: 2, items: [
        { eventTitle: 'Park Cleanup', slotName: 'Afternoon', position: 3 },
        { eventTitle: 'Library Help', slotName: null, position: null },
      ] },
    });
    const list = screen.getByLabelText('Shifts you are waitlisted for');
    expect(within(list).getByText('Park Cleanup')).toBeInTheDocument();
    expect(within(list).getByText(/Number 3 in the queue/)).toBeInTheDocument();
    /* No position known is still a real row, not a blank one. */
    expect(within(list).getByText(/On the waitlist/)).toBeInTheDocument();
  });

  it('links each of an organizer’s events, with how full it is', () => {
    show({
      kind: 'my_events',
      data: { total: 1, items: [{ id: 'ev-1', title: 'Beach Cleanup', status: 'open', spotsRemaining: 4, deadline: 'Fri 5 Sep' }] },
    });
    expect(screen.getByRole('link', { name: 'Beach Cleanup' }))
      .toHaveAttribute('href', '/discover?event=ev-1');
    expect(screen.getByText(/4 spots left/)).toBeInTheDocument();
    expect(screen.getByText(/Closes Fri 5 Sep/)).toBeInTheDocument();
  });

  it('shows an event with its shifts', () => {
    show({
      kind: 'event_details',
      data: {
        id: 'ev-9', title: 'Soup Kitchen', category: 'Community', location: 'Main Street',
        deadline: 'Mon 1 Sep',
        slots: [{ name: 'Serving', startsAt: 'Sat 11:00 AM', maxSpots: 6 }],
      },
    });
    expect(screen.getByRole('link', { name: 'Soup Kitchen' }))
      .toHaveAttribute('href', '/discover?event=ev-9');
    expect(screen.getByText(/Community · Main Street/)).toBeInTheDocument();
    expect(screen.getByText(/Serving · Sat 11:00 AM · 6 spots/)).toBeInTheDocument();
  });

  it('shows the organizer totals as figures rather than as a sentence alone', () => {
    show({ kind: 'organizer_summary', data: { events: 3, volunteers: 27, hours: 84, pending: 5 } });
    for (const [label, value] of [['Events', '3'], ['Volunteers', '27'], ['Hours credited', '84'], ['Awaiting review', '5']]) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(value)).toBeInTheDocument();
    }
  });

  it('shows the platform totals', () => {
    show({ kind: 'platform_stats', data: { users: 412, events: 58, hours: 1290, openReports: 0 } });
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('Open reports')).toBeInTheDocument();
  });

  it('lists recent audit entries with when they happened', () => {
    show({
      kind: 'recent_audit',
      data: { total: 2, items: [
        { action: 'organizer.approved', at: 'Today 09:12' },
        { action: 'legal.published', at: 'Yesterday 16:40' },
      ] },
    });
    const list = screen.getByLabelText('Recent audit entries');
    expect(within(list).getByText('organizer.approved')).toBeInTheDocument();
    expect(within(list).getByText('Today 09:12')).toBeInTheDocument();
  });

  const EMPTY_LISTS = [
    ['waitlists', { total: 0, items: [] }],
    ['my_events', { total: 0, items: [] }],
    ['recent_audit', { total: 0, items: [] }],
  ];
  for (const [kind, data] of EMPTY_LISTS) {
    it(`renders no empty box for ${kind} with nothing in it`, () => {
      /* The summary sentence covers the empty case; an empty `<ul>` under it
         is a border around nothing. */
      const { container } = show({ kind, data });
      expect(container).toBeEmptyDOMElement();
    });
  }
});

describe('the kinds that deliberately have no card', () => {
  /**
   * Confirmations of something that just happened. The sentence says it
   * completely — "Your application has been withdrawn." — and a card repeating
   * it in a box adds furniture rather than information. Listed here so the
   * absence is a decision on the record rather than an oversight;
   * `intentCoverage.test.js` holds the same list from the other direction.
   */
  const SENTENCE_ONLY = ['application_withdrawn', 'preferences_updated', 'profile_updated', 'event_created', 'system_health'];
  for (const kind of SENTENCE_ONLY) {
    it(`renders nothing for ${kind}`, () => {
      const { container } = show({ kind, data: { title: 'x', updated: ['bio'], openGroups: 0, last24h: 0 } });
      expect(container).toBeEmptyDOMElement();
    });
  }

  it('renders nothing at all without a card', () => {
    const { container } = render(<MemoryRouter><AssistantCard card={null} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('attribution', () => {
  it('names the source for the kinds that gained a card', () => {
    for (const kind of ['next_shift', 'waitlists', 'my_events', 'event_details', 'organizer_summary', 'platform_stats', 'recent_audit']) {
      const { container, unmount } = render(<AssistantSource kind={kind} />);
      expect(container.textContent, kind).toMatch(/^Source: .+/);
      unmount();
    }
  });

  it('says nothing for a kind with no source of its own', () => {
    const { container } = render(<AssistantSource kind="draft" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('values written by other people are text, never markup', () => {
  it('escapes an event title', () => {
    show({
      kind: 'my_events',
      data: { total: 1, items: [{ id: 'ev-x', title: '<img src=x onerror=alert(1)>', status: 'open', spotsRemaining: 1, deadline: 'Fri' }] },
    });
    expect(screen.getByRole('link', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
