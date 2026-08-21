/**
 * Keeping conversations, scoped to the authenticated user and privacy settings.
 *
 * ── User-scoped and privacy-preserving ──
 *
 * Transcripts are stored in `localStorage` under a user-scoped key:
 * `wev-ai-conversations-${user.id}`. If the account changes, User B
 * cannot see User A's past conversations.
 *
 * ── Bounded ──
 *
 * Kept to a bounded number of conversations (MAX_CONVERSATIONS) and
 * turns per conversation (MAX_TURNS) to prevent quota exhaustion.
 */

import { readPreferences } from './preferences.js';

const LEGACY_KEY = 'wev-ai-conversation';
const CONVERSATIONS_KEY_PREFIX = 'wev-ai-conversations-';

export const MAX_CONVERSATIONS = 30;
export const MAX_TURNS = 30;

// In-memory fallback for current tab session when saveConversations is disabled
const memoryStore = new Map();

function storageKeyFor(user) {
  const uid = user?.id || (typeof user === 'string' ? user : 'anonymous');
  return `${CONVERSATIONS_KEY_PREFIX}${uid}`;
}

/**
 * Generate a concise title from conversation messages.
 */
export function generateConversationTitle(messages = []) {
  if (!messages || !messages.length) return 'New conversation';
  const firstUserMsg = messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!firstUserMsg) return 'New conversation';

  const text = firstUserMsg.text.trim();
  if (text.length <= 36) return text;
  return `${text.slice(0, 33).trim()}...`;
}

/**
 * Strip volatile card data / live tokens before persisting.
 */
function forStorage(messages) {
  return (messages || []).slice(-MAX_TURNS).map(({ role, text, kind }) => ({
    role,
    text: typeof text === 'string' ? text : '',
    ...(kind ? { kind } : {}),
  }));
}

/**
 * Get all conversation summaries for a user.
 */
export function getConversations({ user } = {}) {
  const key = storageKeyFor(user);
  let list = [];

  if (readPreferences().saveConversations) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {
      list = [];
    }
  } else {
    list = memoryStore.get(key) || [];
  }

  return list
    .filter(c => c && typeof c.id === 'string')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_CONVERSATIONS)
    .map(c => ({
      id: c.id,
      title: c.title || generateConversationTitle(c.messages),
      createdAt: c.createdAt || Date.now(),
      updatedAt: c.updatedAt || Date.now(),
      preview: c.messages?.findLast?.(m => m.text)?.text?.slice(0, 60) || '',
      messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
    }));
}

/**
 * Get a full conversation by ID for a user.
 */
export function getConversation(id, { user } = {}) {
  if (!id) return null;
  const key = storageKeyFor(user);
  let list = [];

  if (readPreferences().saveConversations) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {
      list = [];
    }
  } else {
    list = memoryStore.get(key) || [];
  }

  const found = list.find(c => c.id === id);
  if (!found) return null;

  return {
    id: found.id,
    title: found.title || generateConversationTitle(found.messages),
    createdAt: found.createdAt || Date.now(),
    updatedAt: found.updatedAt || Date.now(),
    messages: (found.messages || []).map(m => ({
      role: m.role,
      text: m.text,
      ...(m.kind ? { kind: m.kind } : {}),
    })),
  };
}

/**
 * Save or update a conversation record.
 */
export function saveConversationRecord(conversation, { user } = {}) {
  if (!conversation || !conversation.id) return;
  const key = storageKeyFor(user);
  let list = [];

  if (readPreferences().saveConversations) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {
      list = [];
    }
  } else {
    list = memoryStore.get(key) || [];
  }

  const existingIdx = list.findIndex(c => c.id === conversation.id);
  const existing = existingIdx >= 0 ? list[existingIdx] : null;
  const cleanMessages = forStorage(conversation.messages || []);
  const title = conversation.title || existing?.title || generateConversationTitle(cleanMessages);
  const now = Date.now();

  const record = {
    id: conversation.id,
    title,
    createdAt: conversation.createdAt || existing?.createdAt || now,
    updatedAt: now,
    messages: cleanMessages,
  };

  if (existingIdx >= 0) {
    list[existingIdx] = record;
  } else {
    list.unshift(record);
  }

  list = list.slice(0, MAX_CONVERSATIONS);

  if (readPreferences().saveConversations) {
    try {
      window.localStorage.setItem(key, JSON.stringify(list));
    } catch {
      // Storage full or unavailable
    }
  } else {
    memoryStore.set(key, list);
  }

  return record;
}

/**
 * Delete a specific conversation.
 */
export function deleteConversation(id, { user } = {}) {
  if (!id) return;
  const key = storageKeyFor(user);
  let list = [];

  if (readPreferences().saveConversations) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {
      list = [];
    }
  } else {
    list = memoryStore.get(key) || [];
  }

  list = list.filter(c => c.id !== id);

  if (readPreferences().saveConversations) {
    try {
      if (!list.length) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(list));
      }
    } catch {
      // ignore
    }
  } else {
    memoryStore.set(key, list);
  }
}

/**
 * Rename a specific conversation.
 */
export function renameConversation(id, newTitle, { user } = {}) {
  if (!id || typeof newTitle !== 'string' || !newTitle.trim()) return null;
  const key = storageKeyFor(user);
  let list = [];

  if (readPreferences().saveConversations) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {
      list = [];
    }
  } else {
    list = memoryStore.get(key) || [];
  }

  const target = list.find(c => c.id === id);
  if (!target) return null;

  target.title = newTitle.trim().slice(0, 60);
  target.updatedAt = Date.now();

  if (readPreferences().saveConversations) {
    try {
      window.localStorage.setItem(key, JSON.stringify(list));
    } catch {
      // ignore
    }
  } else {
    memoryStore.set(key, list);
  }

  return target;
}

/**
 * Clear all conversations for a user.
 */
export function clearAllConversations({ user } = {}) {
  const key = storageKeyFor(user);
  memoryStore.delete(key);
  try {
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
}

/**
 * Backwards-compatible load method for single conversation.
 */
export function loadConversation(options = {}) {
  const user = options?.user;
  if (!readPreferences().saveConversations) {
    const list = memoryStore.get(storageKeyFor(user));
    return list?.[0]?.messages || [];
  }

  // Check user-scoped list first
  const conversations = getConversations({ user });
  if (conversations.length > 0) {
    const full = getConversation(conversations[0].id, { user });
    if (full?.messages) return full.messages;
  }

  // Fallback to legacy single conversation key
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
}

/**
 * Backwards-compatible save method.
 */
export function saveConversation(messages, options = {}) {
  if (!readPreferences().saveConversations) return;
  const user = options?.user;

  if (!messages || !messages.length) {
    try {
      window.localStorage.removeItem(LEGACY_KEY);
    } catch {
      // ignore
    }
    return;
  }

  try {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(forStorage(messages)));
  } catch {
    // ignore
  }

  // Also update latest in multi-conversation store if available
  const existing = getConversations({ user })[0];
  const convId = existing?.id || `conv-${Date.now()}`;
  saveConversationRecord({
    id: convId,
    messages,
  }, { user });
}

/**
 * Backwards-compatible clear method.
 */
export function clearConversation(options = {}) {
  const user = options?.user;
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
  clearAllConversations({ user });
}

