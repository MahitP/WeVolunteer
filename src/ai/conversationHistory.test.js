import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getConversations,
  getConversation,
  saveConversationRecord,
  deleteConversation,
  clearAllConversations,
  renameConversation,
  generateConversationTitle,
  loadConversation,
  saveConversation,
  clearConversation,
  MAX_TURNS,
} from './conversation.js';
import * as prefs from './preferences.js';

describe('multi-conversation history & session isolation', () => {
  const userA = { id: 'user-alice-123', name: 'Alice' };
  const userB = { id: 'user-bob-456', name: 'Bob' };

  beforeEach(() => {
    window.localStorage.clear();
    clearAllConversations({ user: userA });
    clearAllConversations({ user: userB });
    vi.spyOn(prefs, 'readPreferences').mockReturnValue({ saveConversations: true });
  });

  it('generates a clean title from the initial user message', () => {
    expect(generateConversationTitle([])).toBe('New conversation');
    expect(generateConversationTitle([{ role: 'assistant', text: 'Hello' }])).toBe('New conversation');
    expect(generateConversationTitle([
      { role: 'user', text: 'How many volunteer hours do I have?' }
    ])).toBe('How many volunteer hours do I have?');
    expect(generateConversationTitle([
      { role: 'user', text: 'Can you please check all of my upcoming shifts and events for next weekend?' }
    ])).toBe('Can you please check all of my up...');
  });

  it('creates and saves conversation records per user', () => {
    const convId = 'conv-1';
    const messages = [
      { role: 'user', text: 'Show my hours' },
      { role: 'assistant', text: 'You have 24 hours.' },
    ];

    saveConversationRecord({ id: convId, messages }, { user: userA });

    const list = getConversations({ user: userA });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(convId);
    expect(list[0].title).toBe('Show my hours');
    expect(list[0].messageCount).toBe(2);

    const full = getConversation(convId, { user: userA });
    expect(full.id).toBe(convId);
    expect(full.messages).toHaveLength(2);
    expect(full.messages[0].text).toBe('Show my hours');
  });

  it('isolates conversation history strictly between User A and User B', () => {
    saveConversationRecord({
      id: 'conv-alice-1',
      messages: [{ role: 'user', text: 'Alice private inquiry' }]
    }, { user: userA });

    saveConversationRecord({
      id: 'conv-bob-1',
      messages: [{ role: 'user', text: 'Bob private inquiry' }]
    }, { user: userB });

    const aliceChats = getConversations({ user: userA });
    const bobChats = getConversations({ user: userB });

    expect(aliceChats).toHaveLength(1);
    expect(aliceChats[0].id).toBe('conv-alice-1');
    expect(getConversation('conv-bob-1', { user: userA })).toBeNull();

    expect(bobChats).toHaveLength(1);
    expect(bobChats[0].id).toBe('conv-bob-1');
    expect(getConversation('conv-alice-1', { user: userB })).toBeNull();
  });

  it('deletes specific conversations without affecting others', () => {
    saveConversationRecord({ id: 'c1', messages: [{ role: 'user', text: 'First chat' }] }, { user: userA });
    saveConversationRecord({ id: 'c2', messages: [{ role: 'user', text: 'Second chat' }] }, { user: userA });

    expect(getConversations({ user: userA })).toHaveLength(2);

    deleteConversation('c1', { user: userA });

    const remaining = getConversations({ user: userA });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('c2');
    expect(getConversation('c1', { user: userA })).toBeNull();
  });

  it('clears all conversations for a user', () => {
    saveConversationRecord({ id: 'c1', messages: [{ role: 'user', text: 'Chat 1' }] }, { user: userA });
    saveConversationRecord({ id: 'c2', messages: [{ role: 'user', text: 'Chat 2' }] }, { user: userA });

    clearAllConversations({ user: userA });

    expect(getConversations({ user: userA })).toEqual([]);
  });

  it('prunes stored messages to MAX_TURNS', () => {
    const longChat = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Turn ${i}`,
    }));

    saveConversationRecord({ id: 'long-conv', messages: longChat }, { user: userA });

    const full = getConversation('long-conv', { user: userA });
    expect(full.messages.length).toBeLessThanOrEqual(MAX_TURNS);
    expect(full.messages.at(-1).text).toBe('Turn 39');
  });

  it('maintains backwards compatibility for single conversation methods', () => {
    const turns = [
      { role: 'user', text: 'Old style question' },
      { role: 'assistant', text: 'Old style answer' },
    ];

    saveConversation(turns, { user: userA });
    const loaded = loadConversation({ user: userA });
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe('Old style question');

    clearConversation({ user: userA });
    expect(loadConversation({ user: userA })).toEqual([]);
  });

  it('renames an existing conversation title', () => {
    saveConversationRecord({ id: 'c1', messages: [{ role: 'user', text: 'Original Title' }] }, { user: userA });
    const updated = renameConversation('c1', 'Custom User Title', { user: userA });
    expect(updated.title).toBe('Custom User Title');

    const full = getConversation('c1', { user: userA });
    expect(full.title).toBe('Custom User Title');
  });
});
