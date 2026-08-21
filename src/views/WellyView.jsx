import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Send, Square, Trash2, Plus, MessageSquare, Clock, X,
  ChevronRight, AlertCircle, Pencil, Check
} from 'lucide-react';
import WellyMark from '../components/ai/WellyMark';
import AssistantCard, { AssistantSource } from '../components/ai/AssistantCard';
import WellyMessage from '../components/ai/WellyMessage';
import { ask } from '../ai/assistant';
import {
  AIStatus,
  createRuntime,
  modelById,
  isAbort,
  detectCapability,
} from '../ai';
import { readPreferences } from '../ai/preferences';
import WellyModeControl from '../components/ai/WellyModeControl';
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
} from '../ai/conversation';
import { can } from '../authz';


/**
 * Format relative date header for grouping conversation history.
 */
function getDateGroup(timestamp) {
  if (!timestamp) return 'Older';
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 days';
  return 'Older';
}

/**
 * Role-aware prompt suggestions.
 */
function getRoleSuggestions(user) {
  if (can(user, 'admin.create') || can(user, 'report.resolve')) {
    return [
      { label: 'Show safety reports summary', prompt: 'Show safety reports summary' },
      { label: 'Show open appeals', prompt: 'Show open appeals' },
      { label: 'Check system error health', prompt: 'Check system error health' },
      { label: 'What can admins do?', prompt: 'What can admins do?' },
    ];
  }

  if (can(user, 'event.create')) {
    return [
      { label: 'Show my events', prompt: 'Show my events' },
      { label: 'Which events need volunteers?', prompt: 'Which of my events still need volunteers?' },
      { label: 'Show organizer statistics', prompt: 'Show my organizer statistics' },
      { label: 'Create an event', prompt: 'Create an event' },
      { label: 'How do applications work?', prompt: 'How do applications work?' },
    ];
  }

  return [
    { label: 'How many hours do I have?', prompt: 'How many volunteer hours do I have?' },
    { label: 'Show my applications', prompt: 'Show my applications' },
    { label: 'Find opportunities near me', prompt: 'Find volunteering opportunities near me' },
    { label: 'What is my next shift?', prompt: 'What is my next shift?' },
    { label: 'How does Auto Select work?', prompt: 'How does Auto Select work?' },
  ];
}

/**
 * Dedicated Welly View.
 */
export default function WellyView({ currentUser = null, location = null, onViewDetails = null }) {
  const navigate = useNavigate();

  // Active conversation state
  const [activeConvId, setActiveConvId] = useState(() => `conv-${Date.now()}`);
  const [messages, setMessages] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(AIStatus.IDLE);
  const [showMobileHistory, setShowMobileHistory] = useState(false);
  const [editingConvId, setEditingConvId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  /**
   * What a screen reader is told, separately from the transcript.
   *
   * The transcript itself must NOT be a live region. It was one — `aria-live`
   * sat on the scrolling container — which means every token appended during a
   * stream re-announced the changed subtree, so a reply arriving in forty
   * fragments was read out forty times, each time from wherever the assistive
   * technology decided the change began. This holds one short string that
   * changes twice per turn: when the request starts, and when the answer is
   * final.
   */
  const [liveStatus, setLiveStatus] = useState('');

  /* What this device can run, and what the reader has chosen. Model management
     itself lives in Settings — see WellyModeControl for why this page links to
     it rather than carrying a second copy of the download flow. */
  const [capability] = useState(() => detectCapability());
  const [prefs, setPrefs] = useState(() => readPreferences());

  const runtimeRef = useRef(null);
  const abortRef = useRef(null);
  /* Read inside `onToken`, where the state value would be the one captured when
     the request was made rather than the one on screen now. */
  const activeConvIdRef = useRef(activeConvId);
  const aliveRef = useRef(true);
  const transcriptRef = useRef(null);
  const textareaRef = useRef(null);
  const workspaceRef = useRef(null);

  const position = location
    ? { lat: location.latitude, lng: location.longitude }
    : null;

  // Escape key closes mobile history drawer
  useEffect(() => {
    if (!showMobileHistory) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setShowMobileHistory(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showMobileHistory]);

  /* State and ref together, always. Every place that changes which conversation
     is on screen goes through here, so the guard in `send()` cannot be looking
     at a stale id. */
  const selectConversation = useCallback((id, nextMessages) => {
    activeConvIdRef.current = id;
    setActiveConvId(id);
    setMessages(nextMessages);
  }, []);

  // Refresh conversation list for the active user
  const refreshConversations = useCallback(() => {
    const list = getConversations({ user: currentUser });
    setConversations(list);
    return list;
  }, [currentUser]);

  // Load conversation list on user mount / change
  useEffect(() => {
    const list = refreshConversations();
    if (list.length > 0) {
      const latest = getConversation(list[0].id, { user: currentUser });
      if (latest && latest.messages?.length) {
        selectConversation(latest.id, latest.messages);
        return;
      }
    }
    // New empty conversation
    selectConversation(`conv-${Date.now()}`, []);
  }, [currentUser?.id, refreshConversations, selectConversation]);

  // Load the on-device AI runtime in the background
  const loadRuntime = useCallback(async () => {
    const currentPrefs = readPreferences();
    setPrefs(currentPrefs);
    const model = currentPrefs.modelId ? modelById(currentPrefs.modelId) : null;
    if (!currentPrefs.enabled || !model) {
      if (runtimeRef.current) {
        await runtimeRef.current.unload();
        runtimeRef.current = null;
      }
      setStatus(AIStatus.IDLE);
      return;
    }

    try {
      setStatus(AIStatus.LOADING);
      if (runtimeRef.current) {
        await runtimeRef.current.unload();
        runtimeRef.current = null;
      }
      const runtime = await createRuntime();
      await runtime.load(model);
      if (!aliveRef.current) {
        await runtime.unload();
        return;
      }
      runtimeRef.current = runtime;
      setStatus(AIStatus.READY);
    } catch {
      if (aliveRef.current) setStatus(AIStatus.ERROR);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    loadRuntime();


    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      runtimeRef.current?.unload();
      runtimeRef.current = null;
    };
  }, [loadRuntime]);

  /**
   * Settings is the other place these preferences change, and it may be open in
   * another tab.
   *
   * `storage` fires only in the OTHER tabs, which is exactly right: the tab that
   * made the change already knows. Without this, turning Welly AI on in Settings
   * left this page answering as Welly Chat until it was reloaded, with the mode
   * control confidently naming the wrong engine.
   */
  useEffect(() => {
    const onStorage = e => {
      if (e.key && e.key !== 'wev-ai-prefs') return;
      setPrefs(readPreferences());
      loadRuntime();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [loadRuntime]);



  /**
   * Persist the conversation — once a turn is finished, not once per token.
   *
   * This effect used to run on every `messages` change, and `onToken` changes
   * `messages` for each fragment the model emits. A 300-token reply therefore
   * performed 300 writes, each one `JSON.stringify` over up to thirty stored
   * conversations, immediately followed by `refreshConversations()` reading and
   * re-parsing and re-sorting the same list. On a phone that is the whole
   * budget for the frame, spent on a record that is about to be overwritten by
   * the next token anyway.
   *
   * Waiting for the stream to finish costs nothing: the only state that would
   * be lost by not writing mid-stream is a partial reply, and a partial reply
   * is not worth restoring. `streaming` on the last message is the signal, and
   * the `send()` path always clears it — on success, on error and on abort.
   */
  const streamingNow = messages.length > 0 && messages[messages.length - 1].streaming;
  useEffect(() => {
    if (!messages.length || streamingNow) return;
    saveConversationRecord({ id: activeConvId, messages }, { user: currentUser });
    refreshConversations();
  }, [messages, streamingNow, activeConvId, currentUser, refreshConversations]);

  /**
   * Keep the newest turn in view.
   *
   * Guarded on there being a turn at all. Without the guard it also ran for the
   * empty state, which is a centred column taller than the transcript on a
   * phone — so scrolling it to the bottom put the greeting and the Welly mark
   * above the top edge, and the first thing a student saw was the tail of a
   * suggestion list with no explanation above it.
   */
  useEffect(() => {
    if (!messages.length) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  /**
   * Fit the workspace to whatever room is actually left.
   *
   * The height was `calc(100dvh - 140px)`, where 140 was the topbar plus the
   * page padding on the day it was written. It is not the height of the chrome
   * on any real screen: the demo bar adds one row, the location prompt adds a
   * banner, the persona-preview and legal notices add more, and each of them
   * pushed the composer below the fold — on a chat page, where the composer is
   * the one control that must always be reachable without scrolling.
   *
   * Measuring the element's own top edge is exact and needs to know nothing
   * about what is above it. Re-measured on resize and whenever anything in the
   * content column changes size, which is what a banner appearing or being
   * dismissed looks like from here.
   */
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;

    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY - (document.scrollingElement?.scrollTop || 0);
      el.style.setProperty('--welly-top', `${Math.max(0, Math.round(top))}px`);
    };

    fit();
    window.addEventListener('resize', fit);
    const observer = new ResizeObserver(fit);
    /* The content column, not the workspace: observing the element whose height
       this sets would feed its own output back in. */
    if (el.parentElement) observer.observe(el.parentElement);
    return () => {
      window.removeEventListener('resize', fit);
      observer.disconnect();
    };
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [input]);

  // Switch to a conversation from history
  const switchConversation = useCallback((id) => {
    if (busy) abortRef.current?.abort();
    const conv = getConversation(id, { user: currentUser });
    if (conv) selectConversation(conv.id, conv.messages || []);
    setShowMobileHistory(false);
    setLiveStatus('');
  }, [busy, currentUser, selectConversation]);

  // Start a new conversation
  const startNewConversation = useCallback(() => {
    if (busy) abortRef.current?.abort();
    selectConversation(`conv-${Date.now()}`, []);
    setInput('');
    setShowMobileHistory(false);
    setLiveStatus('');
    if (textareaRef.current) textareaRef.current.focus();
  }, [busy, selectConversation]);

  // Delete a conversation
  const handleDeleteConversation = useCallback((e, id) => {
    e.stopPropagation();
    deleteConversation(id, { user: currentUser });
    const remaining = refreshConversations();
    if (activeConvId === id) {
      if (remaining.length > 0) {
        const next = getConversation(remaining[0].id, { user: currentUser });
        selectConversation(next.id, next.messages || []);
      } else {
        startNewConversation();
      }
    }
  }, [currentUser, activeConvId, refreshConversations, startNewConversation, selectConversation]);

  // Rename conversation
  const startRenaming = useCallback((e, conv) => {
    e.stopPropagation();
    setEditingConvId(conv.id);
    setEditingTitle(conv.title);
  }, []);

  const saveRename = useCallback((id) => {
    if (editingTitle.trim()) {
      renameConversation(id, editingTitle.trim(), { user: currentUser });
      refreshConversations();
    }
    setEditingConvId(null);
    setEditingTitle('');
  }, [editingTitle, currentUser, refreshConversations]);

  const cancelRename = useCallback(() => {
    setEditingConvId(null);
    setEditingTitle('');
  }, []);

  // Clear all conversations
  const handleClearAll = useCallback(() => {
    if (window.confirm('Clear all conversation history on this device?')) {
      clearAllConversations({ user: currentUser });
      refreshConversations();
      startNewConversation();
    }
  }, [currentUser, refreshConversations, startNewConversation]);

  /**
   * One turn: the question, the placeholder, the stream, the committed reply.
   *
   * ── Chunks are not messages ──
   *
   * The reply is ONE message from the moment it is created. `replyId` is
   * generated before the placeholder is appended and every subsequent update —
   * each token, the final commit, the error path — addresses that id. Nothing
   * downstream ever appends a second assistant entry, so a reply that arrives
   * as forty fragments is forty updates to one bubble and commits as one string.
   *
   * `replyId` is computed OUTSIDE the state updater on purpose. Reading it from
   * inside — `setMessages(prev => { index = prev.length; ... })` — is what broke
   * this before (6f37388): React double-invokes updaters under StrictMode, the
   * captured index came from the invocation whose result was thrown away, and
   * tokens landed in the previous reply's bubble. That produced transcripts
   * where one answer stopped mid-sentence and the next began with its missing
   * tail, which reads as a broken model and is a broken updater.
   *
   * ── And they belong to the conversation they were asked in ──
   *
   * `convId` is captured here and re-checked before every write. Switching
   * conversations aborts the request, but an abort is not instant and the tool
   * path is not always cancellable, so a late token could otherwise be applied
   * to whichever transcript happens to be on screen — an answer appearing under
   * a question nobody asked. Matching on id alone is not enough for that,
   * because ids are unique per reply but the guard has to reject a reply that
   * is merely late rather than merely unmatched.
   */
  const send = useCallback(async (text) => {
    const question = (text || '').trim();
    if (!question || busy) return;

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setBusy(true);
    setLiveStatus('Welly is thinking');

    const priorTurns = messages;
    const convId = activeConvIdRef.current;
    const turn = Date.now();
    const replyId = `welly-${turn}-${Math.random().toString(36).slice(2, 8)}`;

    /* Both entries in one update. Appended separately they are still batched by
       React 19, but one updater cannot interleave with anything. */
    setMessages(prev => [
      ...prev,
      { id: `you-${turn}`, role: 'user', text: question },
      { id: replyId, role: 'assistant', text: '', streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    /** Still the conversation this question was asked in, and still mounted. */
    const current = () => aliveRef.current && activeConvIdRef.current === convId;

    try {
      const res = await ask(question, {
        runtime: runtimeRef.current,
        position,
        history: priorTurns,
        user: currentUser,
        signal: controller.signal,
        onToken: token => {
          if (!current()) return;
          setMessages(prev => prev.map(m => (
            m.id === replyId ? { ...m, text: m.text + token } : m
          )));
        },
      });

      if (!current()) return;

      /**
       * The committed text is `res.answer`, and in the model path that string
       * is the exact concatenation of the tokens just streamed — `assistant.js`
       * returns what the runtime accumulated, and the only thing done to it is
       * whitespace trimming. So the bubble does not change under the reader at
       * the end of a stream.
       *
       * It changes in one case, deliberately: a reply rejected by
       * `isUsableReply` is replaced with the deterministic sentence, which is
       * the point of that check.
       */
      setMessages(prev => prev.map(m => (
        m.id === replyId
          ? {
              id: replyId,
              role: 'assistant',
              text: res?.cancelled ? 'Stopped.' : (res?.answer || ''),
              card: res?.card ?? null,
              kind: res?.card?.kind,
              streaming: false,
            }
          : m
      )));
      setLiveStatus(res?.cancelled ? 'Stopped.' : (res?.answer || ''));

      if (res?.navigate) navigate(res.navigate);
    } catch (err) {
      if (!current()) return;
      const message = isAbort(err)
        ? 'Stopped.'
        : "Something went wrong answering that. Please try again.";
      setMessages(prev => prev.map(m => (
        m.id === replyId
          ? { id: replyId, role: 'assistant', text: message, streaming: false, failed: !isAbort(err) }
          : m
      )));
      setLiveStatus(message);
    } finally {
      if (aliveRef.current) setBusy(false);
      abortRef.current = null;
    }
  }, [busy, messages, position, currentUser, navigate]);


  // Group conversations by time category
  const groupedConversations = useMemo(() => {
    const groups = {
      'Today': [],
      'Yesterday': [],
      'Previous 7 days': [],
      'Older': [],
    };
    for (const c of conversations) {
      const group = getDateGroup(c.updatedAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(c);
    }
    return Object.entries(groups).filter(([_, items]) => items.length > 0);
  }, [conversations]);

  const suggestions = useMemo(() => getRoleSuggestions(currentUser), [currentUser]);


  return (
    <div className="welly-workspace" data-replay-block ref={workspaceRef}>
      {/* ── Desktop / Tablet Sidebar ────────────────────────────────────────── */}
      <aside className="welly-sidebar" aria-label="Conversation history">
        <div className="welly-sidebar-head">
          <button
            type="button"
            className="btn btn-primary btn-sm welly-new-chat-btn"
            onClick={startNewConversation}
          >
            <Plus size={16} aria-hidden="true" />
            <span>New conversation</span>
          </button>
        </div>

        <div className="welly-sidebar-body">
          {conversations.length === 0 ? (
            <div className="welly-history-empty dim small">
              No previous conversations yet.
            </div>
          ) : (
            groupedConversations.map(([groupName, items]) => (
              <div key={groupName} className="welly-history-group">
                <div className="welly-history-group-title dim small">{groupName}</div>
                <ul className="welly-history-list">
                  {items.map(c => (
                    <li key={c.id} className={`welly-history-row ${activeConvId === c.id ? 'is-active' : ''}`}>
                      {editingConvId === c.id ? (
                        <div className="welly-history-rename-box">
                          <input
                            type="text"
                            className="welly-history-rename-input"
                            value={editingTitle}
                            onChange={e => setEditingTitle(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveRename(c.id);
                              if (e.key === 'Escape') cancelRename();
                            }}
                            autoFocus
                            aria-label="Conversation title"
                          />
                          <button
                            type="button"
                            className="welly-history-action-btn"
                            onClick={() => saveRename(c.id)}
                            aria-label="Save title"
                            title="Save"
                          >
                            <Check size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="welly-history-action-btn"
                            onClick={cancelRename}
                            aria-label="Cancel rename"
                            title="Cancel"
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="welly-history-item"
                            onClick={() => switchConversation(c.id)}
                            aria-current={activeConvId === c.id ? 'true' : undefined}
                          >
                            <MessageSquare size={14} className="welly-history-icon" aria-hidden="true" />
                            <span className="welly-history-title truncate">{c.title}</span>
                          </button>
                          <div className="welly-history-actions">
                            <button
                              type="button"
                              className="welly-history-action-btn welly-history-rename-btn"
                              onClick={(e) => startRenaming(e, c)}
                              aria-label={`Rename "${c.title}"`}
                              title="Rename"
                            >
                              <Pencil size={13} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="welly-history-action-btn welly-history-delete-btn"
                              onClick={(e) => handleDeleteConversation(e, c.id)}
                              aria-label={`Delete conversation "${c.title}"`}
                              title="Delete conversation"
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        {conversations.length > 0 && (
          <div className="welly-sidebar-foot">
            <button
              type="button"
              className="btn btn-ghost btn-sm welly-clear-all-btn dim"
              onClick={handleClearAll}
            >
              <Trash2 size={13} aria-hidden="true" />
              <span>Clear history</span>
            </button>
          </div>
        )}
      </aside>

      {/* ── Mobile History Slide-over Drawer ────────────────────────────────── */}
      {showMobileHistory && (
        <div className="welly-mobile-drawer-root" role="dialog" aria-modal="true" aria-label="Conversation history">
          <div className="welly-drawer-backdrop" onClick={() => setShowMobileHistory(false)} />
          <div className="welly-drawer-sheet">
            <div className="welly-drawer-head">
              <div className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
                <Clock size={16} />
                <span className="strong">History</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setShowMobileHistory(false)}
                aria-label="Close history"
              >
                <X size={18} />
              </button>
            </div>

            <div className="welly-drawer-action">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ width: '100%' }}
                onClick={startNewConversation}
              >
                <Plus size={16} />
                <span>New conversation</span>
              </button>
            </div>

            <div className="welly-drawer-body">
              {conversations.length === 0 ? (
                <div className="welly-history-empty dim small">No previous conversations.</div>
              ) : (
                groupedConversations.map(([groupName, items]) => (
                  <div key={groupName} className="welly-history-group">
                    <div className="welly-history-group-title dim small">{groupName}</div>
                    <ul className="welly-history-list">
                      {items.map(c => (
                        <li key={c.id} className={`welly-history-row ${activeConvId === c.id ? 'is-active' : ''}`}>
                          {editingConvId === c.id ? (
                            <div className="welly-history-rename-box">
                              <input
                                type="text"
                                className="welly-history-rename-input"
                                value={editingTitle}
                                onChange={e => setEditingTitle(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveRename(c.id);
                                  if (e.key === 'Escape') cancelRename();
                                }}
                                autoFocus
                                aria-label="Conversation title"
                              />
                              <button
                                type="button"
                                className="welly-history-action-btn"
                                onClick={() => saveRename(c.id)}
                                aria-label="Save title"
                              >
                                <Check size={13} />
                              </button>
                              <button
                                type="button"
                                className="welly-history-action-btn"
                                onClick={cancelRename}
                                aria-label="Cancel rename"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="welly-history-item"
                                onClick={() => switchConversation(c.id)}
                              >
                                <MessageSquare size={14} className="welly-history-icon" />
                                <span className="welly-history-title truncate">{c.title}</span>
                              </button>
                              <div className="welly-history-actions">
                                <button
                                  type="button"
                                  className="welly-history-action-btn welly-history-rename-btn"
                                  onClick={(e) => startRenaming(e, c)}
                                  aria-label={`Rename "${c.title}"`}
                                  title="Rename"
                                >
                                  <Pencil size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="welly-history-action-btn welly-history-delete-btn"
                                  onClick={(e) => handleDeleteConversation(e, c.id)}
                                  aria-label={`Delete "${c.title}"`}
                                  title="Delete"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>

            {conversations.length > 0 && (
              <div className="welly-drawer-foot">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm dim"
                  style={{ width: '100%' }}
                  onClick={handleClearAll}
                >
                  <Trash2 size={14} />
                  <span>Clear all history</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main Chat Workspace ─────────────────────────────────────────────── */}
      <main className="welly-chat-main" aria-label="Welly conversation">
        {/**
          * The mobile bar.
          *
          * Three zones, fixed: history on the left, identity in the middle,
          * actions on the right. The identity does not move when the mode
          * changes, because a title that shifts sideways as a model finishes
          * loading is the kind of small instability that reads as unfinished.
          */}
        <div className="welly-mobile-bar">
          <button
            type="button"
            className="btn btn-ghost btn-icon welly-mobile-history-toggle"
            onClick={() => setShowMobileHistory(true)}
            aria-label="Open conversation history"
          >
            <Clock size={19} aria-hidden="true" />
          </button>

          {/* The mark only. The app topbar directly above already reads
              "Welly", and repeating the word 60px below it is the same
              duplication the desktop header had. The mark is not a duplicate:
              it is the spark, next to the mode. */}
          <div className="welly-mobile-bar-center">
            <WellyMark size="sm" />
          </div>

          <div className="welly-mobile-bar-actions">
            <WellyModeControl
              capability={capability}
              prefs={prefs}
              status={status}
              onRetry={loadRuntime}
              compact
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon welly-mobile-new-btn"
              onClick={startNewConversation}
              aria-label="Start a new conversation"
              title="New conversation"
            >
              <Plus size={19} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/**
          * The desktop header — a toolbar, not a second product header.
          *
          * It carried a Welly wordmark and a subtitle directly beneath the app
          * topbar's `Welly` and ITS subtitle: the same two lines, twice, sixty
          * pixels apart. The topbar already names the destination, so what is
          * left here is what belongs to the conversation rather than to the
          * page — which engine is answering, and the way out of the current
          * thread. The mark stays because it is the one place the spark sits
          * beside the mode, and it costs a single glyph.
          */}
        <header className="welly-desktop-header">
          <div className="welly-header-info">
            <WellyMark />
            <WellyModeControl
              capability={capability}
              prefs={prefs}
              status={status}
              onRetry={loadRuntime}
            />
          </div>

          <div className="welly-header-actions">
            {messages.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={startNewConversation}
                title="Start a new conversation"
              >
                <Plus size={15} aria-hidden="true" />
                <span>New chat</span>
              </button>
            )}
          </div>
        </header>

        {/**
          * What assistive technology is told about the turn in progress.
          *
          * Outside the transcript and holding one short string, for the reason
          * given where `liveStatus` is declared: a live region wrapped around a
          * streaming transcript re-announces on every token.
          */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveStatus}
        </div>

        {/* Conversation Transcript */}
        <div className="welly-transcript" ref={transcriptRef}>
          {messages.length === 0 ? (
            <div className="welly-empty-state">
              <div className="welly-empty-mark-wrap">
                <WellyMark size="lg" />
              </div>
              <h2 className="welly-empty-title">
                Hi, {currentUser?.name ? currentUser.name.split(' ')[0] : 'there'}!
              </h2>
              {/* One sentence. It had a second — "I can suggest what to do
                  next, but I never decide anything for you" — which is the same
                  promise the composer footer makes a few inches below, and on a
                  phone the pair pushed the suggestions off the screen. */}
              <p className="welly-empty-subtitle dim">
                I can look things up in your WeVolunteer record and explain how
                the platform works.
              </p>

              <div className="welly-suggestions-container">
                <p className="welly-suggestions-label dim small">Try asking</p>
                <div className="welly-suggestions-grid">
                  {suggestions.map(({ label, prompt }) => (
                    <button
                      key={label}
                      type="button"
                      className="welly-suggestion-card"
                      onClick={() => send(prompt)}
                    >
                      <span>{label}</span>
                      <ChevronRight size={14} className="welly-suggestion-arrow" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="welly-messages-list">
              {messages.map((m, i) => (
                <div key={m.id || `turn-${i}`} className={`welly-turn welly-turn-${m.role}`}>
                  <div className="welly-turn-avatar">
                    {m.role === 'user' ? (
                      <span className="welly-user-avatar">{currentUser?.avatar || '👤'}</span>
                    ) : (
                      <WellyMark size="sm" />
                    )}
                  </div>

                  <div className="welly-turn-content">
                    <span className="sr-only">
                      {m.role === 'user' ? 'You asked:' : 'Welly replied:'}
                    </span>

                    {m.text ? (
                      <div className={`welly-bubble${m.failed ? ' welly-bubble-failed' : ''}`}>
                        {m.failed && <AlertCircle size={15} className="welly-bubble-failed-icon" aria-hidden="true" />}
                        <WellyMessage text={m.text} streaming={m.streaming} />
                      </div>
                    ) : m.streaming ? (
                      <div className="welly-bubble welly-thinking">
                        <span className="welly-thinking-dots" aria-hidden="true">
                          <i /><i /><i />
                        </span>
                        <span className="dim">Thinking</span>
                      </div>
                    ) : null}

                    {m.card && (
                      <div className="welly-card-wrapper">
                        <AssistantCard card={m.card} onAction={send} />
                      </div>
                    )}

                    {m.kind && (
                      <AssistantSource kind={m.kind} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/**
          * The composer.
          *
          * A row of suggestion chips used to sit above it once a conversation
          * had started — the same three prompts as the empty state, unchanged
          * for the rest of the thread. They answered a question the reader had
          * already stopped asking, and on a phone they took a line of height
          * directly above the control that most needs the room. The empty state
          * is where suggestions belong.
          */}
        <div className="welly-composer-container">
          <div className="welly-composer-box">
            <label className="sr-only" htmlFor="welly-prompt-input">
              Ask Welly a question
            </label>
            <textarea
              id="welly-prompt-input"
              ref={textareaRef}
              className="welly-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask Welly anything about volunteering, shifts, or WeVolunteer..."
              rows={1}
              autoComplete="off"
            />

            <div className="welly-composer-actions">
              {busy ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-icon welly-stop-btn"
                  onClick={() => abortRef.current?.abort()}
                  aria-label="Stop generating"
                  title="Stop generating"
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-icon welly-send-btn"
                  onClick={() => send(input)}
                  disabled={!input.trim()}
                  aria-label="Send question to Welly"
                  title="Send"
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>

          <div className="welly-composer-footer dim small">
            Grounded in your records. Nothing changes without your confirmation.
          </div>
        </div>
      </main>

    </div>
  );
}

