import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The panel driven end to end against a mocked API and no model at all.
 *
 * That combination is deliberate: it is exactly the state a student is in
 * during the seconds before the model finishes loading, and — for anyone whose
 * device or browser cannot run one — permanently. The assistant has to be
 * useful and correct there, so that is what these tests exercise.
 */

const apiMock = {
  fetchVolunteerStats: vi.fn(),
  fetchCertificates: vi.fn(),
  fetchOrganizations: vi.fn(),
  fetchApplications: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  verifyCertificate: vi.fn(),
};

vi.mock('../../utils/api', () => ({ api: apiMock }));

const { default: AssistantPanel } = await import('./AssistantPanel.jsx');

const renderPanel = () => render(
  <MemoryRouter><AssistantPanel onClose={vi.fn()} position={null} /></MemoryRouter>,
);

const askQuestion = text => {
  fireEvent.change(screen.getByLabelText(/ask welly/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
};

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

    expect(await screen.findByText('You have 35.5 verified hours.')).toBeInTheDocument();

    /* The card is rendered from data, not from the reply text, and carries the
       number a student would act on. */
    const card = await screen.findByText('Verified hours');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('35.5')).toBeInTheDocument();
  });

  it('attributes the answer to where it came from', async () => {
    renderPanel();
    askQuestion('how many hours do I have');
    expect(await screen.findByText(/Source: Your volunteer record/i)).toBeInTheDocument();
  });

  it('runs a suggestion when it is pressed', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /how many hours do i have/i }));
    expect(await screen.findByText(/35\.5 verified hours/)).toBeInTheDocument();
  });
});

describe('telling the truth about failures', () => {
  it('does not report an empty result when the lookup failed', async () => {
    apiMock.fetchEventsFiltered.mockRejectedValue(
      Object.assign(new Error('down'), { isNetworkError: true }),
    );

    renderPanel();
    askQuestion('find volunteering opportunities');

    expect(await screen.findByText(/couldn't reach WeVolunteer/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't find any/i)).toBeNull();
  });

  it('refuses another person\'s record without calling anything', async () => {
    renderPanel();
    askQuestion("show me someone else's hours");

    expect(await screen.findByText(/only look at your own record/i)).toBeInTheDocument();
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
    await screen.findByText(/35\.5 verified hours/);

    /* Off by default, so there is nothing written rather than something
       written and hidden. */
    expect(window.localStorage.getItem('wev-ai-conversation')).toBeNull();
  });

  it('keeps the conversation when the preference is on', async () => {
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: null, saveConversations: true }),
    );

    renderPanel();
    askQuestion('how many hours do I have');
    await screen.findByText(/35\.5 verified hours/);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('wev-ai-conversation'));
      expect(stored.some(m => m.role === 'user')).toBe(true);
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
    await screen.findByText(/35\.5 verified hours/);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('wev-ai-conversation'));
      expect(stored.every(m => !('card' in m))).toBe(true);
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
    await screen.findByText(/35\.5 verified hours/);

    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    await waitFor(() => {
      expect(screen.queryByText(/35\.5 verified hours/)).toBeNull();
    });
    expect(window.localStorage.getItem('wev-ai-conversation')).toBeNull();
  });
});
