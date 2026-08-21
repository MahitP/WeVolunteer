import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Welly driven end to end against a mocked API and no model at all.
 *
 * That combination is deliberate: it is exactly the state a student is in
 * during the seconds before the model finishes loading, and — for anyone whose
 * device or browser cannot run one — permanently. The assistant has to be
 * useful and correct there, so that is what these tests exercise.
 *
 * ── Why these moved off AssistantPanel ──
 *
 * They were written against `AssistantPanel`, the popover Welly used to open
 * from the topbar. Welly is a destination now and nothing renders that panel
 * any more, so it was deleted rather than left as a second chat implementation
 * to drift out of step with this one. Every guarantee it held is here, against
 * the surface a student actually sees: the answer comes from the tool, the card
 * comes from data, a failed lookup is not reported as an empty one, somebody
 * else's record is refused before anything is fetched, the transcript is kept
 * out of session replay, and nothing is written to the device unless the
 * preference says so.
 */

const apiMock = {
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  verifyCertificate: vi.fn(),
};

vi.mock('../utils/api', () => ({ api: apiMock }));

const { default: WellyView } = await import('./WellyView.jsx');

/** A student, because every question below is about a student's own record. */
const student = { id: 'stu-behaviour-1', name: 'Maya Lin', role: 'student', verified: true, withheld: [] };

/** Where a saved conversation lands, for this user. See ai/conversation.js. */
const STORE_KEY = `wev-ai-conversations-${student.id}`;

const renderPanel = () => render(
  <MemoryRouter><WellyView currentUser={student} /></MemoryRouter>,
);

const askQuestion = text => {
  fireEvent.change(screen.getByLabelText(/ask welly a question/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send question to welly/i }));
};

/**
 * Text in the visible transcript.
 *
 * The page also carries an `sr-only` status region holding the finished answer,
 * so a screen reader hears a reply that streamed in — the transcript itself is
 * deliberately not a live region. A bare `findByText` therefore matches twice.
 */
const inTranscript = matcher =>
  screen.findAllByText(matcher).then(found => {
    const visible = found.filter(el => !el.closest('.sr-only'));
    expect(visible.length).toBeGreaterThan(0);
    return visible[0];
  });

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  apiMock.fetchVolunteerStats.mockResolvedValue({ hours: 35.5, events: 7 });
  apiMock.fetchEventsFiltered.mockResolvedValue({ events: [], pagination: { total: 0 } });
  apiMock.fetchOrganizations.mockResolvedValue([]);
});

describe('an empty conversation', () => {
  it('suggests things it can actually do', () => {
    /* Every suggestion has to correspond to a real tool. Offering something
       the router cannot answer would send a student straight into "I can't
       help with that". */
    renderPanel();
    expect(screen.getByRole('button', { name: /how many hours do i have/i })).toBeInTheDocument();
  });

  it('does not fetch anything until asked', () => {
    renderPanel();
    expect(apiMock.fetchVolunteerStats).not.toHaveBeenCalled();
  });
});

describe('asking a question with no model loaded', () => {
  it('answers from the tool and shows the figure in a card', async () => {
    renderPanel();
    askQuestion('how many hours do I have');

    expect(await inTranscript('You have 35.5 verified hours.')).toBeInTheDocument();

    /* The card is rendered from data, not from the reply text, and carries the
       number a student would act on. */
    const card = await screen.findByText('Verified hours');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('35.5')).toBeInTheDocument();
  });

  it('attributes the answer to where it came from', async () => {
    renderPanel();
    askQuestion('how many hours do I have');
    expect(await inTranscript(/Source: Your volunteer record/i)).toBeInTheDocument();
  });

  it('runs a suggestion when it is pressed', async () => {
    renderPanel();
    /* The suggestion card, not the send button that inherits the same text
       once the question is in the composer. */
    fireEvent.click(screen.getAllByRole('button', { name: /how many hours do i have/i })[0]);
    expect(await inTranscript(/35\.5 verified hours/)).toBeInTheDocument();
  });
});

describe('telling the truth about failures', () => {
  it('does not report an empty result when the lookup failed', async () => {
    apiMock.fetchEventsFiltered.mockRejectedValue(
      Object.assign(new Error('down'), { isNetworkError: true }),
    );

    renderPanel();
    askQuestion('find volunteering opportunities');

    expect(await inTranscript(/couldn't reach WeVolunteer/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't find any/i)).toBeNull();
  });

  it('refuses another person\'s record without calling anything', async () => {
    renderPanel();
    askQuestion("show me someone else's hours");

    expect(await inTranscript(/only look at your own record/i)).toBeInTheDocument();
    expect(apiMock.fetchVolunteerStats).not.toHaveBeenCalled();
  });
});

describe('privacy of the transcript', () => {
  it('blocks the transcript from session replay outright', () => {
    /**
     * Masking is not enough here. The 2FA screen already established that mask
     * levels do not cover everything inside a subtree, and a transcript records
     * what somebody asked about their own volunteering.
     */
    const { baseElement } = renderPanel();
    expect(baseElement.querySelector('[data-replay-block]')).toBeTruthy();
  });

  it('keeps nothing on the device unless the preference is on', async () => {
    renderPanel();
    askQuestion('how many hours do I have');
    await inTranscript(/35\.5 verified hours/);

    /* Off by default, so there is nothing written rather than something
       written and hidden. Both keys: the user-scoped store this page writes,
       and the single-conversation key that predates it. */
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
    expect(window.localStorage.getItem('wev-ai-conversation')).toBeNull();
  });

  it('keeps the conversation when the preference is on', async () => {
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: null, saveConversations: true }),
    );

    renderPanel();
    askQuestion('how many hours do I have');
    await inTranscript(/35\.5 verified hours/);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
      expect(stored[0].messages.some(m => m.role === 'user')).toBe(true);
    });
  });

  it('does not persist the card data alongside the text', async () => {
    /* A stored card would keep a copy of somebody's record on the device and
       would go stale — showing last week's totals as though current. */
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: null, saveConversations: true }),
    );

    renderPanel();
    askQuestion('how many hours do I have');
    await inTranscript(/35\.5 verified hours/);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(STORE_KEY));
      expect(stored[0].messages.every(m => !('card' in m))).toBe(true);
    });
  });
});

describe('clearing', () => {
  it('removes the conversation from the screen and the device', async () => {
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: null, saveConversations: true }),
    );

    renderPanel();
    askQuestion('how many hours do I have');
    await inTranscript(/35\.5 verified hours/);

    /* Clearing every conversation is destructive and asks first. The control
       appears once there is a conversation in the list to clear, which is one
       render after the answer lands. */
    const clear = await screen.findAllByRole('button', { name: /clear (all )?history/i });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(clear[0]);
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();

    await waitFor(() => {
      expect(screen.queryAllByText(/35\.5 verified hours/).filter(el => !el.closest('.sr-only'))).toHaveLength(0);
    });
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('does not clear anything when the confirmation is declined', async () => {
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: null, saveConversations: true }),
    );

    renderPanel();
    askQuestion('how many hours do I have');
    await inTranscript(/35\.5 verified hours/);

    const clear = await screen.findAllByRole('button', { name: /clear (all )?history/i });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(clear[0]);
    confirm.mockRestore();

    expect(screen.getAllByText(/35\.5 verified hours/).filter(el => !el.closest('.sr-only')).length).toBeGreaterThan(0);
  });
});
