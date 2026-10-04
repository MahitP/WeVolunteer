import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({
  api: {
    fetchMessages: vi.fn(),
    sendMessage: vi.fn(),
    markConversationRead: vi.fn().mockResolvedValue({}),
  },
}));

const socketHandlers = {};
vi.mock('../../services/socket', () => ({
  subscribeSocket: vi.fn((evt, fn) => { socketHandlers[evt] = fn; }),
  unsubscribeSocket: vi.fn(),
  emitTypingStart: vi.fn(),
  emitTypingStop: vi.fn(),
}));

import ConversationPane from './ConversationPane';
import { api } from '../../utils/api';

/**
 * The order a conversation reads in, and where the view sits.
 *
 * ── The bug this file exists because of ──
 *
 * The server returns messages oldest-first — it selects `ORDER BY created_at
 * DESC LIMIT ?` to take the newest N, then reverses, and a server test asserts
 * exactly that. This component reversed the response a SECOND time, so history
 * rendered newest-first while every other path (socket delivery, your own send)
 * appended to the end. History ran one way and new messages the other.
 *
 * It shipped because nothing had ever rendered this component. That is the gap
 * this file closes.
 */

const CONVERSATION = {
  id: 'conv-1',
  otherParticipant: { id: 'them', name: 'Priya Patel', lastReadAt: null },
};

/** Oldest first, exactly as the API returns it. */
const MESSAGES = [
  { id: 'm1', senderId: 'them', body: 'First, hours ago.', createdAt: '2026-08-12T10:00:00.000Z' },
  { id: 'm2', senderId: 'me', body: 'Second, a reply.', createdAt: '2026-08-12T11:00:00.000Z' },
  { id: 'm3', senderId: 'them', body: 'Third, the newest.', createdAt: '2026-08-12T12:00:00.000Z' },
];

const draw = () => render(
  <ConversationPane conversation={CONVERSATION} onBack={vi.fn()} onUpdateConversation={vi.fn()} />
);

/** The rendered bodies, in DOM order. */
const bodiesInOrder = (container) =>
  [...container.querySelectorAll('.msg-bubble, [class*="bubble"]')]
    .map(n => n.textContent.trim())
    .filter(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
  api.fetchMessages.mockResolvedValue({ messages: MESSAGES, hasMore: false });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();

  /**
   * `requestAnimationFrame` runs synchronously here.
   *
   * The component schedules its scroll in a rAF so it lands after React has
   * committed. jsdom queues that callback for later, so a test asserting
   * "scrollIntoView was NOT called" passed while the frame was simply still
   * pending — it proved nothing, and removing the guard it exists to check did
   * not fail it. Running the callback inline makes both the positive and the
   * negative case deterministic.
   */
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('conversation order', () => {
  it('renders oldest first and newest LAST', async () => {
    const { container } = draw();
    await screen.findByText('Third, the newest.');

    const order = bodiesInOrder(container);
    const first = order.findIndex(t => t.includes('First'));
    const last = order.findIndex(t => t.includes('Third'));

    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
  });

  it('does not reverse what the server already ordered', async () => {
    /* The server response is ascending. Reversing it here is the defect; this
       asserts the rendered order matches the response order exactly. */
    const { container } = draw();
    await screen.findByText('Third, the newest.');

    const order = bodiesInOrder(container);
    const rendered = MESSAGES.map(m => order.findIndex(t => t.includes(m.body.split(',')[0])));

    expect(rendered).toEqual([...rendered].sort((a, b) => a - b));
  });

  it('appends an incoming message to the END, beside the loaded history', async () => {
    /**
     * The half that was already correct, asserted so the fix cannot be undone
     * by "correcting" the append instead of the reverse.
     */
    const { container } = draw();
    await screen.findByText('Third, the newest.');

    socketHandlers['message.created']?.({
      conversationId: 'conv-1',
      message: { id: 'm4', senderId: 'them', body: 'Fourth, just arrived.', createdAt: '2026-08-12T13:00:00.000Z' },
    });

    await screen.findByText('Fourth, just arrived.');
    const order = bodiesInOrder(container);
    expect(order[order.length - 1]).toContain('Fourth');
  });

  it('ignores a message for a different conversation', async () => {
    draw();
    await screen.findByText('Third, the newest.');

    socketHandlers['message.created']?.({
      conversationId: 'someone-else',
      message: { id: 'x', senderId: 'them', body: 'Not for this thread.', createdAt: '2026-08-12T13:00:00.000Z' },
    });

    expect(screen.queryByText('Not for this thread.')).not.toBeInTheDocument();
  });

  it('does not duplicate a message delivered twice', async () => {
    draw();
    await screen.findByText('Third, the newest.');

    const dupe = { conversationId: 'conv-1', message: MESSAGES[2] };
    socketHandlers['message.created']?.(dupe);
    socketHandlers['message.created']?.(dupe);

    expect(screen.getAllByText('Third, the newest.')).toHaveLength(1);
  });
});

describe('where the view sits', () => {
  it('opens at the newest message without animating there', async () => {
    /* Opening a thread should START at the bottom. Smooth-scrolling means the
       first thing somebody sees is a conversation they have read sliding away. */
    draw();
    await waitFor(() => expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());

    const call = window.HTMLElement.prototype.scrollIntoView.mock.calls[0][0];
    expect(call.behavior).toBe('auto');
  });

  it('does not yank a reader who has scrolled up', async () => {
    /**
     * The property that matters most here. Somebody reading back through a
     * thread must not be dragged to the bottom because a message arrived — a
     * chat that fights the person using it is worse than one that lags.
     */
    const { container } = draw();
    await screen.findByText('Third, the newest.');

    const list = container.querySelector('.messages-list');
    expect(list, 'the scroll container must exist for this to mean anything').toBeTruthy();
    Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    list.scrollTop = 0; // scrolled right up

    window.HTMLElement.prototype.scrollIntoView.mockClear();
    socketHandlers['message.created']?.({
      conversationId: 'conv-1',
      message: { id: 'm5', senderId: 'them', body: 'Arrived while reading.', createdAt: '2026-08-12T14:00:00.000Z' },
    });

    await screen.findByText('Arrived while reading.');
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps following when the reader is already at the bottom', async () => {
    const { container } = draw();
    await screen.findByText('Third, the newest.');

    const list = container.querySelector('.messages-list');
    Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    list.scrollTop = 1500; // pinned to the bottom

    window.HTMLElement.prototype.scrollIntoView.mockClear();
    socketHandlers['message.created']?.({
      conversationId: 'conv-1',
      message: { id: 'm6', senderId: 'them', body: 'Arrived at the bottom.', createdAt: '2026-08-12T14:00:00.000Z' },
    });

    await screen.findByText('Arrived at the bottom.');
    await waitFor(() => expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
  });
});

/**
 * A certificate shared "with direct message" (SC-04) arrives as a draft. It
 * fills the reply box and is not sent: the student reads it, can change it, and
 * sends it themselves.
 */
describe('a draft handed in', () => {
  it('fills the reply box once, unsent, and says it took it', async () => {
    const onDraftTaken = vi.fn();
    render(
      <ConversationPane conversation={CONVERSATION} onBack={vi.fn()} onUpdateConversation={vi.fn()}
        initialDraft="I completed 2 hrs of verified service: https://app.wevolunteers.org/verify/WEV-AAAA-BBBB"
        onDraftTaken={onDraftTaken} />
    );
    const box = await screen.findByRole('textbox');
    await waitFor(() => expect(box.value).toMatch(/verify\/WEV-AAAA-BBBB/));
    expect(onDraftTaken).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
