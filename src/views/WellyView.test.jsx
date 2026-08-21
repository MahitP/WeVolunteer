import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import WellyView from './WellyView';
import * as assistant from '../ai/assistant';
import * as conversation from '../ai/conversation';
import * as prefs from '../ai/preferences';

vi.mock('../ai/assistant');

/**
 * The build flag, on.
 *
 * `LOCAL_AI` is folded to a literal at transform time (see src/ai/index.js), so
 * under vitest it resolves to false and the mode control — which gates on it,
 * like every other Welly AI surface — renders nothing. The enabled-path suites
 * mock the seam rather than the env for exactly this reason; see the note in
 * `disabledPath.test.jsx`, which asserts the other direction.
 */
vi.mock('../ai', async importOriginal => ({
  ...(await importOriginal()),
  isLocalAIEnabled: () => true,
}));

const studentUser = {
  id: 'student-1',
  name: 'Maya Lin',
  role: 'student',
  verified: true,
  withheld: [],
  avatar: '👩‍🎓',
};

const organizerUser = {
  id: 'org-1',
  name: 'Carlos Gomez',
  role: 'organizer',
  verified: true,
  withheld: [],
  avatar: '🧑‍💼',
};

const adminUser = {
  id: 'admin-1',
  name: 'Admin Sarah',
  role: 'admin',
  verified: true,
  withheld: [],
  avatar: '🛡️',
};

/**
 * Queries scoped to the visible transcript.
 *
 * The page also carries an `sr-only` `role="status"` region holding the final
 * answer, so a screen reader hears a reply that finished streaming — the
 * transcript itself is deliberately not a live region, because announcing it
 * would re-announce on every token. A bare `getByText` therefore matches the
 * answer twice, which is correct markup and an ambiguous query; these tests ask
 * about what is on screen.
 */
function transcript(container) {
  return within(container.querySelector('.welly-transcript'));
}

describe('WellyView full-page workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    conversation.clearAllConversations({ user: studentUser });
    conversation.clearAllConversations({ user: organizerUser });
    conversation.clearAllConversations({ user: adminUser });
    vi.spyOn(prefs, 'readPreferences').mockReturnValue({ saveConversations: true, enabled: false });

    assistant.ask.mockResolvedValue({
      answer: 'You currently have 28 verified volunteer hours.',
      card: { kind: 'hours', data: { hours: 28, events: 6 } },
      phrasedByModel: false,
    });
  });

  it('renders personalized empty state with student suggestions', () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    expect(screen.getByText(/Hi, Maya!/i)).toBeInTheDocument();
    expect(screen.getByText(/How many hours do I have\?/i)).toBeInTheDocument();
    expect(screen.getByText(/Show my applications/i)).toBeInTheDocument();
    expect(screen.getByText(/Find opportunities near me/i)).toBeInTheDocument();
  });

  it('renders organizer-specific prompt suggestions for organizers', () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={organizerUser} />
      </MemoryRouter>
    );

    expect(screen.getByText(/Hi, Carlos!/i)).toBeInTheDocument();
    expect(screen.getByText(/Show my events/i)).toBeInTheDocument();
    expect(screen.getByText(/Create an event/i)).toBeInTheDocument();
  });

  it('renders admin-specific prompt suggestions for administrators', () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={adminUser} />
      </MemoryRouter>
    );

    expect(screen.getByText(/Hi, Admin!/i)).toBeInTheDocument();
    expect(screen.getByText(/Show safety reports summary/i)).toBeInTheDocument();
    expect(screen.getByText(/Show open appeals/i)).toBeInTheDocument();
  });

  it('sends user message and renders assistant reply with card', async () => {
    const { container } = render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    fireEvent.change(textarea, { target: { value: 'How many hours do I have?' } });

    const sendBtn = screen.getByTitle(/Send/i);
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    expect(assistant.ask).toHaveBeenCalledWith(
      'How many hours do I have?',
      expect.objectContaining({ user: studentUser })
    );

    await waitFor(() => {
      expect(transcript(container).getByText(/You currently have 28 verified volunteer hours\./i)).toBeInTheDocument();
      expect(transcript(container).getByText('28')).toBeInTheDocument();
    });
  });

  it('sends message via Enter key without shift key', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    fireEvent.change(textarea, { target: { value: 'My applications' } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    expect(assistant.ask).toHaveBeenCalledWith(
      'My applications',
      expect.objectContaining({ user: studentUser })
    );
  });

  it('starts a new conversation on New conversation button click', async () => {
    const { container } = render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    fireEvent.change(textarea, { target: { value: 'What is my next shift?' } });
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Send/i));
    });

    await waitFor(() => {
      expect(transcript(container).getByText(/You currently have 28 verified volunteer hours\./i)).toBeInTheDocument();
    });

    // Click New conversation button
    /* Several controls legitimately start a new conversation — the sidebar
       button, the mobile bar and the drawer. The first is the sidebar's. */
    const newChatBtn = screen.getAllByRole('button', { name: /new conversation/i })[0];
    await act(async () => {
      fireEvent.click(newChatBtn);
    });

    // Should return to empty state
    expect(screen.getByText(/Hi, Maya!/i)).toBeInTheDocument();
  });

  it('handles draft cards with interactive confirmation', async () => {
    assistant.ask.mockResolvedValueOnce({
      answer: 'Draft prepared.',
      card: {
        kind: 'draft',
        data: {
          preview: 'Withdraw application for Shift A',
          summary: 'Withdraw shift',
        },
      },
      phrasedByModel: false,
    });

    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    fireEvent.change(textarea, { target: { value: 'Withdraw my application' } });
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Send/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Pending Confirmation/i)).toBeInTheDocument();
      expect(screen.getByText(/Withdraw application for Shift A/i)).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole('button', { name: /Confirm/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(assistant.ask).toHaveBeenCalledWith(
      'confirm',
      expect.objectContaining({ user: studentUser })
    );
  });

  it('toggles mobile conversation history drawer', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const mobileHistoryToggle = screen.getByLabelText(/Open conversation history/i);
    await act(async () => {
      fireEvent.click(mobileHistoryToggle);
    });

    expect(screen.getByRole('dialog', { name: /Conversation history/i })).toBeInTheDocument();

    const closeBtn = screen.getByLabelText(/Close history/i);
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    expect(screen.queryByRole('dialog', { name: /Conversation history/i })).not.toBeInTheDocument();
  });

  it('allows renaming a conversation in history', async () => {
    conversation.saveConversationRecord({
      id: 'conv-rename-test',
      title: 'Original Title',
      messages: [{ role: 'user', text: 'Original question' }],
    }, { user: studentUser });

    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    expect(screen.getByText('Original Title')).toBeInTheDocument();

    const renameBtn = screen.getByRole('button', { name: /Rename "Original Title"/i });
    await act(async () => {
      fireEvent.click(renameBtn);
    });

    const renameInput = screen.getByLabelText(/Conversation title/i);
    fireEvent.change(renameInput, { target: { value: 'Renamed Chat Title' } });

    const saveBtn = screen.getByRole('button', { name: /Save title/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(screen.getByText('Renamed Chat Title')).toBeInTheDocument();
  });

  it('prevents sending empty or whitespace-only messages', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    const sendBtn = screen.getByTitle(/Send/i);

    expect(sendBtn).toBeDisabled();

    fireEvent.change(textarea, { target: { value: '    ' } });
    expect(sendBtn).toBeDisabled();

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    expect(assistant.ask).not.toHaveBeenCalled();
  });

  it('allows multiline entry with Shift+Enter without sending', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2' } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    });

    expect(assistant.ask).not.toHaveBeenCalled();
  });

  it('handles aborting / stopping generation cleanly', async () => {
    let resolveAsk;
    const askPromise = new Promise(resolve => {
      resolveAsk = resolve;
    });
    assistant.ask.mockReturnValue(askPromise);

    const { container } = render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const textarea = screen.getByPlaceholderText(/Ask Welly anything/i);
    fireEvent.change(textarea, { target: { value: 'Tell me a long story' } });

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Send/i));
    });

    const stopBtn = screen.getByTitle(/Stop generating/i);
    expect(stopBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(stopBtn);
    });

    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    await act(async () => {
      resolveAsk(Promise.reject(abortErr));
    });

    await waitFor(() => {
      expect(transcript(container).getByText('Stopped.')).toBeInTheDocument();
    });
  });

  /**
   * The sheet says `aria-modal="true"`, and a claim of modality is a promise
   * about the keyboard: everything outside is inert. It had none of that — no
   * focus containment, no focus restore, no scroll lock — which tells a screen
   * reader the page behind is unreachable while leaving it perfectly reachable
   * by Tab. `useModal` is what every other dialog here uses.
   */
  it('gives the mobile history sheet real dialog behaviour', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open conversation history/i }));
    });

    const sheet = screen.getByRole('dialog', { name: /conversation history/i });
    expect(sheet).toHaveAttribute('aria-modal', 'true');

    /* Scroll lock and focus containment both come from the shared hook, and the
       lock is the one with an observable side effect outside the dialog. */
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });

    expect(screen.queryByRole('dialog', { name: /conversation history/i })).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('dismisses mobile drawer when Escape key is pressed', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const mobileHistoryToggle = screen.getByLabelText(/Open conversation history/i);
    await act(async () => {
      fireEvent.click(mobileHistoryToggle);
    });

    expect(screen.getByRole('dialog', { name: /Conversation history/i })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(screen.queryByRole('dialog', { name: /Conversation history/i })).not.toBeInTheDocument();
  });

  it('switches and isolates multiple conversations correctly', async () => {
    conversation.saveConversationRecord({
      id: 'conv-a',
      title: 'Topic A Conversation',
      messages: [
        { role: 'user', text: 'Question about Topic A' },
        { role: 'assistant', text: 'Answer for Topic A' }
      ]
    }, { user: studentUser });

    conversation.saveConversationRecord({
      id: 'conv-b',
      title: 'Topic B Conversation',
      messages: [
        { role: 'user', text: 'Question about Topic B' },
        { role: 'assistant', text: 'Answer for Topic B' }
      ]
    }, { user: studentUser });

    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const topicBBtn = screen.getByText('Topic B Conversation').closest('button');
    await act(async () => {
      fireEvent.click(topicBBtn);
    });

    expect(screen.getByText('Question about Topic B')).toBeInTheDocument();
    expect(screen.getByText('Answer for Topic B')).toBeInTheDocument();

    const topicABtn = screen.getByText('Topic A Conversation').closest('button');
    await act(async () => {
      fireEvent.click(topicABtn);
    });

    expect(screen.getByText('Question about Topic A')).toBeInTheDocument();
    expect(screen.getByText('Answer for Topic A')).toBeInTheDocument();
  });

  it('deletes a conversation without deleting others', async () => {
    conversation.saveConversationRecord({
      id: 'conv-stay',
      title: 'Keep this chat',
      messages: [{ role: 'user', text: 'Staying question' }]
    }, { user: studentUser });

    conversation.saveConversationRecord({
      id: 'conv-remove',
      title: 'Delete this chat',
      messages: [{ role: 'user', text: 'Remove question' }]
    }, { user: studentUser });

    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    expect(screen.getByText('Keep this chat')).toBeInTheDocument();
    expect(screen.getByText('Delete this chat')).toBeInTheDocument();

    const deleteBtn = screen.getByRole('button', { name: /Delete conversation "Delete this chat"/i });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(screen.getByText('Keep this chat')).toBeInTheDocument();
    expect(screen.queryByText('Delete this chat')).not.toBeInTheDocument();
  });

  /**
   * The mode control replaced a pair of buttons that opened a second copy of
   * the model-download flow. Settings owns that flow; this is the way in.
   */
  it('names the engine that is answering, and explains the other one', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const control = screen.getAllByRole('button', { name: /Answering with Welly Chat/i })[0];
    expect(control).toBeInTheDocument();
    expect(control).toHaveAttribute('aria-expanded', 'false');

    await act(async () => { fireEvent.click(control); });

    expect(control).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/How Welly answers/i)).toBeInTheDocument();
    expect(screen.getByText(/Answers from your WeVolunteer records/i)).toBeInTheDocument();
    expect(screen.getByText(/runs on your own device/i)).toBeInTheDocument();
  });

  it('sends on-device setup to Settings rather than carrying its own copy of it', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Answering with Welly Chat/i })[0]);
    });

    const link = screen.getByRole('link', { name: /Set up Welly AI/i });
    /* The section matters as much as the fragment: Settings reads its section
       from the query, and without it this opened on Appearance, where the card
       being linked to is not mounted at all. */
    expect(link).toHaveAttribute('href', '/settings?section=privacy#welly-ai');
  });

  it('closes the mode panel on Escape and returns focus to its control', async () => {
    render(
      <MemoryRouter>
        <WellyView currentUser={studentUser} />
      </MemoryRouter>
    );

    const control = screen.getAllByRole('button', { name: /Answering with Welly Chat/i })[0];
    await act(async () => { fireEvent.click(control); });
    expect(screen.getByText(/How Welly answers/i)).toBeInTheDocument();

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });

    expect(screen.queryByText(/How Welly answers/i)).toBeNull();
    expect(control).toHaveFocus();
  });
});

