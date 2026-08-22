import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Send, Square, Trash2, Plus, MessageSquare, Clock, X,
  ChevronRight, AlertCircle, Pencil, Check, MapPin
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
import { readPreferences, writePreferences } from '../ai/preferences';
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
import { useModal } from '../utils/useModal';
import { useLocationContext } from '../contexts/LocationContext';


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
 * The mobile history sheet.
 *
 * A thin shell so `useModal` — Escape, focus containment, focus restore, scroll
 * lock — is called unconditionally, which the rules of hooks require and which
 * a `{open && <div role="dialog">}` branch cannot do. The contents are passed
 * in because they are the same list the desktop sidebar draws, and two copies
 * of a conversation list is how the two surfaces drift apart.
 */
function MobileHistoryDrawer({ onClose, children }) {
  const sheetRef = useModal(onClose);

  return (
    <div className="welly-mobile-drawer-root">
      <div className="welly-drawer-backdrop" onClick={onClose} />
      <div
        className="welly-drawer-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Conversation history"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * One line saying how long these conversations last.
 *
 * Two states and no third: either they survive the tab closing or they do not,
 * and the reader is told which. The link goes to the switch that changes it
 * rather than offering a second copy of it here.
 */
function HistoryNote({ saving }) {
  if (saving) {
    return (
      <p className="welly-history-note dim small">
        Saved in this browser. Nothing is sent to WeVolunteer.
      </p>
    );
  }
  return (
    <p className="welly-history-note dim small">
      Kept for this visit only.{' '}
      <Link to="/settings?section=privacy#welly-ai">Save conversations</Link> to keep them
      in this browser.
    </p>
  );
}

/**
 * Dedicated Welly View.
 */
export default function WellyView({ currentUser = null, onViewDetails = null }) {
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
  /**
   * Why Welly AI did not start, when it did not.
   *
   * The runtime already works this out — `asRuntimeError` in WllamaRuntime
   * separates out-of-memory and network failures and writes a `userMessage`
   * for each, because those are the two with a useful next step. That message
   * was then thrown away here by a bare `catch {}`, and the reader was shown
   * "Welly AI didn't start" and nothing else.
   *
   * Reported as exactly that: "the Advanced Model isnt starting up it says
   * Model couldnt start up using Chat". The Advanced model is 986 MB against
   * the Balanced model's 469, so out-of-memory is the likely answer and is one
   * the reader can act on — the diagnosis existed the whole time and had no
   * route to the screen.
   */
  const [startupError, setStartupError] = useState(null);
  const [prefs, setPrefs] = useState(() => readPreferences());

  const runtimeRef = useRef(null);
  const abortRef = useRef(null);
  /* Read inside `onToken`, where the state value would be the one captured when
     the request was made rather than the one on screen now. */
  const activeConvIdRef = useRef(activeConvId);
  /* The transcript as last written to storage, so an unchanged one is not
     written again. Declared here because `selectConversation` seeds it. */
  const persistedRef = useRef({ id: null, signature: null });
  const aliveRef = useRef(true);
  const transcriptRef = useRef(null);
  const textareaRef = useRef(null);
  const workspaceRef = useRef(null);

  /**
   * Where the reader is, and the prop that never carried it.
   *
   * This page took a `location` prop and derived `position` from
   * `location.latitude` / `location.longitude`. App.jsx supplied it from
   * `const location = useLocation()` — react-router's, which is
   * `{pathname, search, hash, state, key}`. So both coordinates were always
   * `undefined` while the object itself was truthy, and every "near me" search
   * Welly has ever run went out unlocated while looking located to the code
   * that checked.
   *
   * The name is the whole bug: two different `location`s, one of them the most
   * common hook name in a router-based app. So the prop is gone rather than
   * corrected, and the coordinates come from the context that owns them —
   * which this component already reads for the permission gesture.
   *
   * Null outside a provider, which is why every use below is guarded: the view
   * is mounted bare in several tests.
   */
  const locationCtx = useLocationContext();
  const position = locationCtx?.location
    ? { lat: locationCtx.location.latitude, lng: locationCtx.location.longitude }
    : null;

  /* State and ref together, always. Every place that changes which conversation
     is on screen goes through here, so the guard in `send()` cannot be looking
     at a stale id. */
  const selectConversation = useCallback((id, nextMessages) => {
    activeConvIdRef.current = id;
    /* Seeded so the persistence effect below recognises this content as already
       stored. Without it, opening a conversation writes it back and stamps
       `updatedAt`, which reorders the history list by reading it. */
    persistedRef.current = {
      id,
      signature: `${nextMessages.length}:${nextMessages.map(m => m.id || m.role).join(',')}:`
        + nextMessages.reduce((n, m) => n + (m.text?.length || 0), 0),
    };
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

  /**
   * The load currently running, or the last one that finished.
   *
   * ── Two jobs, both of them about the same race ──
   *
   * `loadRuntime` is called on mount, from the mode control, from a retry, and
   * from a `storage` event when Settings changes the preference in another tab.
   * Nothing stopped two of those overlapping, and the second would see
   * `runtimeRef.current` still null — the first has not assigned it yet — and
   * build a SECOND engine. Both finish, the later assignment wins, and the
   * earlier one is left loaded and unreachable, holding its weights. With the
   * Advanced model that is 1.4 GB leaked on a page whose whole premise is
   * running inside a browser tab. React's StrictMode double-invokes effects in
   * development, so this happened on every single mount there.
   *
   * Chaining rather than de-duplicating, because the calls do not always mean
   * the same thing: `selectMode` writes a new preference and then calls this,
   * and must not be handed the in-flight load of the OLD preference.
   *
   * The second job is `send`. See the wait there.
   */
  const loadingRef = useRef(Promise.resolve());

  // Load the on-device AI runtime in the background
  const loadRuntime = useCallback(async () => {
    const run = async () => {
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
      setStartupError(null);
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
    } catch (err) {
      if (!aliveRef.current) return;
      /* The technical text goes to the console and nowhere near the page;
         `userMessage` is the half written to be read. See AIRuntimeError. */
      console.error('[Welly] the on-device model did not start', err);
      setStartupError({
        message: err?.userMessage
          || 'Welly AI could not start on this device. You can try again from Settings.',
        model: model?.label || null,
      });
      setStatus(AIStatus.ERROR);
    }
    };

    /* `.then(run, run)` and not `.finally`: a previous load that REJECTED must
       still let this one start. Nothing here rejects today — the body catches
       everything — and relying on that from the outside is how the next edit
       breaks it silently. */
    const next = loadingRef.current.then(run, run);
    loadingRef.current = next.catch(() => {});
    return next;
  }, []);

  /**
   * Switching between Welly Chat and Welly AI from the mode control.
   *
   * ── Why this is here and not in the control ──
   *
   * Only two things happen: a boolean is written to `preferences.js`, and
   * `loadRuntime` is run again. Both already exist on this page — the same pair
   * runs on mount, and again when Settings changes the preference in another
   * tab. Putting the switch here reuses them instead of giving the control its
   * own copy of the runtime lifecycle.
   *
   * ── The first time, there is nothing to switch on ──
   *
   * `modelId` is written by `AISettingsCard` only after a download has finished
   * and verified, so its absence means the model is not on this device. Turning
   * the preference on in that state would set `enabled: true` with nothing to
   * load, `loadRuntime` would fall straight through to IDLE, and the control
   * would go on saying Welly Chat with no explanation.
   *
   * So that click goes to the download instead. Settings owns it — the
   * progress, the digest check, the storage accounting and the remove button
   * are all there, and duplicating any of it here is the thing WellyModeControl
   * exists to avoid.
   */
  const selectMode = useCallback(async id => {
    if (id === 'ai' && !readPreferences().modelId) {
      navigate('/settings?section=privacy#welly-ai');
      return;
    }
    writePreferences({ enabled: id === 'ai' });
    await loadRuntime();
  }, [navigate, loadRuntime]);

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
   * Persist the conversation when its DURABLE content changes — not per token,
   * and not merely because it was opened.
   *
   * ── Three failures, one effect ──
   *
   * Originally this ran on every `messages` change, and `onToken` changes
   * `messages` once per fragment: a 300-token reply performed 300 writes, each
   * a `JSON.stringify` over up to thirty stored conversations followed by a
   * re-read and re-sort of the same list.
   *
   * Skipping the write while a reply streamed fixed that and broke something
   * worse. The user's own message is appended in the same update as the
   * streaming placeholder, so it was not written either — and if the reply
   * never completed (the reader switched conversations, or left Welly), the
   * turn ended with the guard in `send()` dropping the commit. The question was
   * then written nowhere at all: coming back to the conversation showed a
   * transcript that had never heard of it.
   *
   * And a write on any change meant OPENING a conversation re-saved it, which
   * stamps `updatedAt` — so reading an old conversation moved it to the top of
   * the history list. Browsing reordered the thing being browsed.
   *
   * ── What it does now ──
   *
   * The durable form of the transcript is everything except a reply still
   * arriving. That value is identical for every token of a stream, so the
   * signature below is unchanged across all of them and one write happens when
   * the question is appended rather than none. It changes again when the reply
   * lands, which is the second and last write of the turn. Loading a
   * conversation seeds the signature, so opening one writes nothing.
   */
  const durable = useMemo(() => messages.filter(m => !m.streaming), [messages]);

  useEffect(() => {
    if (!durable.length) return;
    /* Length, ids and total text: enough to notice an append, an edit or a
       replacement, and cheap enough to compute on every render. */
    const signature = `${durable.length}:${durable.map(m => m.id || m.role).join(',')}:`
      + durable.reduce((n, m) => n + (m.text?.length || 0), 0);

    const seen = persistedRef.current;
    if (seen.id === activeConvId && seen.signature === signature) return;

    persistedRef.current = { id: activeConvId, signature };
    saveConversationRecord({ id: activeConvId, messages: durable }, { user: currentUser });
    refreshConversations();
  }, [durable, activeConvId, currentUser, refreshConversations]);

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

    /**
     * ── Waiting for the engine the reader chose ──
     *
     * Reported: "Sometimes it defaults to Welly Chat for some reason even if im
     * on AI mode."
     *
     * It was not random. `runtimeRef.current` is assigned only once the model
     * has finished loading, and `ask` falls back to Welly Chat for anything
     * else — so every question asked during the load was answered by Chat,
     * silently, while the pill overhead said "Starting up". The Advanced model
     * takes the better part of a minute on a cold start, which is exactly when
     * somebody is most likely to type something.
     *
     * The load is already running; this waits for it rather than racing it. No
     * new work and no new timeout — `loadRuntime` catches its own failures, so
     * this settles when the load does, whichever way it went. Once loaded the
     * promise is already resolved and this costs a microtask.
     *
     * Only when the reader has actually chosen Welly AI. With it off, the
     * promise resolved at mount and there is nothing to wait for.
     */
    if (!runtimeRef.current && prefs.enabled && prefs.modelId) {
      setLiveStatus('Starting Welly AI');
      await loadingRef.current;
      /* `busy` is already true, so nothing else could have started meanwhile —
         but the reader may have switched conversations or left. */
      if (!current()) { setBusy(false); return; }
    }


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
              /**
               * The interface speaking about a failure, rather than Welly
               * answering. Carried on the message so it stays out of the
               * history the model is given — a small model reads the
               * transcript as a record of how the assistant talks, and will
               * reproduce a refusal it finds there as its own answer. See
               * `sanitizeHistory`.
               */
              systemNotice: Boolean(res?.systemNotice) || Boolean(res?.cancelled),
              /* The model ran out of room rather than finishing. Reported so a
                 sentence ending mid-air reads as a limit rather than a bug —
                 the text itself is untouched. See `truncated` in assistant.js. */
              truncated: Boolean(res?.truncated),
              /* A "near me" search that ran without coordinates. The offer to
                 fix it is a button, because a browser only opens the permission
                 dialog for a gesture — and because Welly must never ask for an
                 address in words. See `needsLocation` in assistant.js. */
              needsLocation: Boolean(res?.needsLocation),
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
          ? {
              id: replyId,
              role: 'assistant',
              text: message,
              streaming: false,
              failed: !isAbort(err),
              /* "Stopped." and "Something went wrong" are both the interface,
                 not an answer. */
              systemNotice: true,
            }
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

        {/**
          * What happens to these conversations when the tab closes.
          *
          * `saveConversations` is off by default and deliberately so — a
          * transcript names the things a student volunteers for and asks
          * about, and keeping it is a choice with a cost. But nothing said so,
          * and the result was worse than either policy: the sidebar filled up
          * during a visit, the reader learned that Welly remembers, and then
          * everything was gone the next morning with no explanation and no clue
          * that a setting existed.
          */}
        <div className="welly-sidebar-foot">
          <HistoryNote saving={prefs.saveConversations} />
          {conversations.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm welly-clear-all-btn dim"
              onClick={handleClearAll}
            >
              <Trash2 size={13} aria-hidden="true" />
              <span>Clear history</span>
            </button>
          )}
        </div>
      </aside>

      {/**
        * ── Mobile history: a slide-over, and a real dialog ──────────────────
        *
        * It says `role="dialog" aria-modal="true"`, and until now it had none of
        * the behaviour that promise implies: no focus containment, no focus
        * restore, no scroll lock. `aria-modal` tells a screen reader that
        * everything outside is inert while leaving it perfectly reachable by
        * Tab, which is worse than saying nothing.
        *
        * `useModal` is what every other dialog here uses — see the note in
        * Modal.jsx — and it needs to be called unconditionally, so the sheet is
        * its own component mounted only while open rather than a branch inside
        * this one.
        */}
      {showMobileHistory && (
        <MobileHistoryDrawer onClose={() => setShowMobileHistory(false)}>
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

            <div className="welly-drawer-foot">
              <HistoryNote saving={prefs.saveConversations} />
              {conversations.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm dim"
                  style={{ width: '100%' }}
                  onClick={handleClearAll}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span>Clear all history</span>
                </button>
              )}
            </div>
        </MobileHistoryDrawer>
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
              onSelectMode={selectMode}
              startupError={startupError}
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
              onSelectMode={selectMode}
              startupError={startupError}
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

                    {m.truncated && (
                      <p className="welly-truncated dim small">
                        Welly ran out of room here. Ask it to carry on if you want more.
                      </p>
                    )}

                    {m.needsLocation && locationCtx && (
                      <div className="welly-location-offer">
                        <p className="dim small">
                          Sorting by distance needs your location. It stays on your device,
                          and nothing is saved.
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => locationCtx.requestLocation()}
                          disabled={locationCtx.loading}
                        >
                          <MapPin size={15} aria-hidden="true" />
                          {locationCtx.loading ? 'Asking your browser…' : 'Use my location'}
                        </button>
                        {locationCtx.permissionDenied && (
                          <p className="dim small">
                            Your browser is blocking it. Turn location back on for this site in
                            the address bar, then ask again.
                          </p>
                        )}
                      </div>
                    )}

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

          {/**
            * What Welly is, under the box you type into.
            *
            * ── Why this replaced a link to certificate verification ──
            *
            * That link was here because it was the only route into `/verify`
            * from inside the app. It has a proper home now — a button on every
            * dashboard — and it never belonged on this row: "I do think a small
            * legal disclaimer would fit its place."
            *
            * ── Three things, and why each is worth the line ──
            *
            * It makes mistakes. Not a formality: this is a 0.5B–1.5B model
            * running in a browser tab, and the honest description of it is
            * "often wrong", not "occasionally imprecise". A student comparing
            * Welly's answer to their transcript needs to know which one wins.
            *
            * It is for volunteering. The model will happily discuss anything,
            * which invites it to be trusted on things it has no business being
            * trusted on.
            *
            * Do not type personal details. Nothing here asks for any — see
            * `asksForPersonalInfo` — but the box accepts whatever is typed into
            * it, and "we cannot see it" is not the same as "it is a good idea".
            *
            * ── What this deliberately does NOT say ──
            *
            * "Nothing leaves your device." It is the sentence somebody reading
            * the mode pill would expect, and it is not true of the whole
            * feature: what you TYPE stays in the browser when Welly AI is
            * running, and a lookup about your own hours or events is answered
            * by WeVolunteer's server exactly as the rest of the app is. Saying
            * the stronger thing here would make the assistant's one privacy
            * claim the one place it overstates itself.
            *
            * So the on-device claim stays where it is conditional and accurate
            * — the mode panel, which knows whether the model is actually
            * running — and this links to the policy that sets out both halves.
            */}
          <div className="welly-composer-footer dim small">
            {/**
              * Two wordings, swapped by viewport height rather than one that is
              * hidden when there is no room.
              *
              * The full sentence is three wrapped lines on a phone in landscape,
              * which pushed the composer itself below the fold. The obvious fix
              * is the one that used to be here — `display: none` under
              * `max-height: 520px` — and it is not available any more: a
              * disclaimer that disappears on small screens is not a disclaimer,
              * and small screens are most of them.
              *
              * So the short form keeps the two clauses that are about the
              * reader's safety and drops the one that is a reassurance. Both are
              * asserted in WellyView.disclaimer.test.jsx so neither can quietly
              * lose a clause the other still has.
              */}
            <span className="welly-footer-long">
              Welly is a prototype for volunteering questions. It makes mistakes,
              so check anything that matters, and it never changes anything without
              your confirmation. Please don’t type personal details here.
            </span>
            <span className="welly-footer-short">
              Welly is a prototype and makes mistakes. Please don’t type personal
              details here.
            </span>
            <Link to="/legal/ai-and-on-device-processing" className="welly-policy-link">
              How Welly uses your information
            </Link>
          </div>
        </div>
      </main>

    </div>
  );
}

