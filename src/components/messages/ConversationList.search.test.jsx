import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConversationList from './ConversationList';
import { api } from '../../utils/api';

/**
 * The one search box, and the two questions it answers.
 *
 * ── What was wrong ──
 *
 * The box filtered already-loaded conversation METADATA — the other
 * participant's name and the event title — and was labelled "Search
 * conversations…". `GET /api/messages/search`, which searches message BODIES
 * scoped through `conversation_participants` to the caller's own threads, had
 * no caller at all. It even carried a bug fix: the `events` join was an inner
 * join and dropped every event-less thread, and the comment on that fix says a
 * member could "search their messages, match nothing from a friend, and
 * reasonably conclude the search was broken rather than that it had never
 * looked."
 *
 * So somebody typing a phrase they remembered got nothing, silently, from a
 * control that looked like it had looked.
 *
 * ── What must stay true ──
 *
 *   • One box. A second search field would ask the reader to decide in advance
 *     whether what they remember is a name or a sentence, which is the same
 *     question folding `/directory` into Discover removed.
 *   • The two halves fail independently. The names are filtered locally and
 *     cannot fail; the bodies are a request that can.
 *   • Below two characters nothing is requested, because the server answers an
 *     empty list rather than scanning.
 */

vi.mock('../../utils/api');

const CONVERSATIONS = [
  {
    id: 'conv-1',
    otherParticipant: { name: 'Jordan Whitfield' },
    event: { title: 'Softball Snack Shack' },
    lastMessage: { body: 'See you there.', createdAt: '2026-09-01T10:00:00.000Z' },
    unreadCount: 0,
  },
];

const HIT = {
  message: { id: 'msg-1', conversationId: 'conv-9', createdAt: '2026-08-20T10:00:00.000Z' },
  eventTitle: null,
  senderName: 'Priya Patel',
  snippet: 'bringing the folding tables on Saturday',
};

const draw = (props = {}) => render(
  <ConversationList
    conversations={CONVERSATIONS}
    activeId={null}
    onSelect={props.onSelect ?? vi.fn()}
    loading={false}
    error={null}
    emptyText="No conversations yet."
  />
);

const box = () => screen.getByLabelText(/Search conversations and messages/i);

beforeEach(() => {
  vi.clearAllMocks();
  api.searchMessages.mockResolvedValue({ results: [] });
});

describe('the conversation search box', () => {
  it('says it searches messages too, because it does', () => {
    draw();
    /* The label was "Search conversations", which was an accurate description
       of a narrower search than anybody would assume from a search box in a
       messaging client. */
    expect(box()).toBeInTheDocument();
  });

  it('asks for nothing below two characters', async () => {
    draw();
    fireEvent.change(box(), { target: { value: 'a' } });
    await new Promise(r => setTimeout(r, 400));
    expect(api.searchMessages).not.toHaveBeenCalled();
  });

  it('searches message bodies once there is something to search for', async () => {
    draw();
    fireEvent.change(box(), { target: { value: 'tables' } });
    await waitFor(() => expect(api.searchMessages).toHaveBeenCalled());
    expect(api.searchMessages.mock.calls[0][0]).toBe('tables');
  });

  it('debounces, so one word is not one request per keystroke', async () => {
    draw();
    for (const v of ['ta', 'tab', 'tabl', 'table', 'tables']) {
      fireEvent.change(box(), { target: { value: v } });
    }
    await waitFor(() => expect(api.searchMessages).toHaveBeenCalled());
    expect(api.searchMessages).toHaveBeenCalledTimes(1);
    expect(api.searchMessages.mock.calls[0][0]).toBe('tables');
  });

  it('shows message matches under their own heading', async () => {
    api.searchMessages.mockResolvedValue({ results: [HIT] });
    draw();
    fireEvent.change(box(), { target: { value: 'tables' } });

    /* Its own group, because a conversation match and a message match answer
       different questions and merging them hides which one produced a row. */
    expect(await screen.findByText(/Found in messages/i)).toBeInTheDocument();
    expect(screen.getByText(/bringing the folding tables/i)).toBeInTheDocument();
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
  });

  it('opens the thread a matched message belongs to', async () => {
    const onSelect = vi.fn();
    api.searchMessages.mockResolvedValue({ results: [HIT] });
    draw({ onSelect });
    fireEvent.change(box(), { target: { value: 'tables' } });

    fireEvent.click(await screen.findByRole('button', { name: /bringing the folding tables/i }));
    /* The point of returning `conversationId`: a result that cannot be opened
       is a search that tells you something exists and not where. */
    expect(onSelect).toHaveBeenCalledWith('conv-9');
  });

  it('keeps the name matches when the message search fails', async () => {
    api.searchMessages.mockRejectedValue(new Error('offline'));
    draw();
    fireEvent.change(box(), { target: { value: 'Jordan' } });

    await waitFor(() => expect(api.searchMessages).toHaveBeenCalled());
    /* The two halves fail independently and one of them working is still a
       useful list — the posture BrowseEvents takes for the directory half. */
    expect(screen.getByText('Jordan Whitfield')).toBeInTheDocument();
  });

  it('does not claim nothing matched while the message half is still running', async () => {
    let release;
    api.searchMessages.mockReturnValue(new Promise(r => { release = () => r({ results: [HIT] }); }));
    draw();
    /* A term that matches no conversation NAME, so the local list is empty and
       the only possible answer is still in flight. */
    fireEvent.change(box(), { target: { value: 'tables' } });

    expect(await screen.findByText(/^Searching…$/)).toBeInTheDocument();
    release();
    expect(await screen.findByText(/bringing the folding tables/i)).toBeInTheDocument();
  });

  it('says nothing matched only when neither half found anything', async () => {
    api.searchMessages.mockResolvedValue({ results: [] });
    draw();
    fireEvent.change(box(), { target: { value: 'zzzzz' } });
    expect(await screen.findByText(/Nothing matched that/i)).toBeInTheDocument();
  });
});
