import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Square, Trash2 } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import WellyMark from './WellyMark';
import AssistantCard, { AssistantSource } from './AssistantCard';
import { ask } from '../../ai/assistant';
import { AIStatus, createRuntime, modelById, isAbort } from '../../ai';
import { readPreferences } from '../../ai/preferences';
import { loadConversation, saveConversation, clearConversation } from '../../ai/conversation';

/**
 * The conversation.
 *
 * ── The model is loaded here, not in Settings ──
 *
 * Settings downloads; this loads. Opening the panel is the first moment
 * somebody actually wants inference, and loading a model costs real memory —
 * doing it at application start, for everyone with the feature on, would tax
 * every page load for a feature used occasionally.
 *
 * ── Answers appear before the model does ──
 *
 * A question asked while the model is still loading is answered anyway, from
 * the tool, in plain phrasing. That is not a degraded mode; it is the same
 * facts without the sentence polished. Blocking the input behind a loading
 * spinner would make the assistant feel slower than the app it lives in.
 */
export default function AssistantPanel({ onClose, position, needsSetup = false }) {
  /* Before every early return, per `hookOrder.test.jsx`. */
  const navigate = useNavigate();
  const [messages, setMessages] = useState(() => loadConversation());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(AIStatus.IDLE);

  const runtimeRef = useRef(null);
  const abortRef = useRef(null);
  const aliveRef = useRef(true);
  const transcriptRef = useRef(null);

  /* Load the chosen model in the background as soon as the panel opens. */
  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    (async () => {
      const prefs = readPreferences();
      const model = prefs.modelId ? modelById(prefs.modelId) : null;
      if (!prefs.enabled || !model) return;

      try {
        setStatus(AIStatus.LOADING);
        const runtime = await createRuntime();
        await runtime.load(model);
        if (cancelled || !aliveRef.current) { await runtime.unload(); return; }
        runtimeRef.current = runtime;
        setStatus(AIStatus.READY);
      } catch {
        /* Answers still work without it, so this is not surfaced as an error.
           The status line says the wording will be plainer and moves on. */
        if (aliveRef.current) setStatus(AIStatus.ERROR);
      }
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
      abortRef.current?.abort();
      /* Release the model with the panel. Holding several hundred megabytes
         open for a closed dialog is the difference between a usable phone and
         a reloaded tab. */
      runtimeRef.current?.unload();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => { saveConversation(messages); }, [messages]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async (text) => {
    const question = text.trim();
    if (!question || busy) return;

    setInput('');
    setBusy(true);
    /* Captured BEFORE the new turn is appended, so what goes to the model is the
       conversation so far — the question itself is added separately by `ask`.
       Reading `messages` here rather than inside the updater keeps this the
       history the person can actually see on screen. */
    const priorTurns = messages;
    setMessages(prev => [...prev, { role: 'user', text: question }]);

    const controller = new AbortController();
    abortRef.current = controller;

    /* A placeholder the streamed tokens land in, so the reply appears as it is
       written rather than arriving all at once after a silence. */
    let index = -1;
    setMessages(prev => {
      index = prev.length;
      return [...prev, { role: 'assistant', text: '', streaming: true }];
    });

    try {
      const res = await ask(question, {
        runtime: runtimeRef.current,
        position,
        history: priorTurns,
        signal: controller.signal,
        onToken: token => {
          if (!aliveRef.current) return;
          setMessages(prev => prev.map((m, i) => (
            i === index ? { ...m, text: m.text + token } : m
          )));
        },
      });

      if (!aliveRef.current) return;
      setMessages(prev => prev.map((m, i) => (
        i === index
          ? { role: 'assistant', text: res.answer, card: res.card, kind: res.card?.kind }
          : m
      )));
    } catch (err) {
      if (!aliveRef.current) return;
      setMessages(prev => prev.map((m, i) => (
        i === index
          ? {
            role: 'assistant',
            text: isAbort(err)
              ? 'Stopped.'
              : "Something went wrong answering that. Please try again.",
          }
          : m
      )));
    } finally {
      if (aliveRef.current) setBusy(false);
      abortRef.current = null;
    }
    /* `messages` is a dependency because `priorTurns` reads it. Without it the
       callback closes over the transcript as it was when `send` was last
       rebuilt, and the model would be handed a conversation that stopped
       several turns ago — which reads as Welly forgetting what was just said. */
  }, [busy, position, messages]);

  const clearAll = useCallback(() => {
    clearConversation();
    setMessages([]);
  }, []);

  const statusLine = status === AIStatus.LOADING
    ? 'Getting Welly ready on this device. You can ask now — answers will be plainer until then.'
    : status === AIStatus.ERROR
      ? 'Welly could not start on this device, so answers will be plainer. Everything still works.'
      : null;

  /**
   * Opened before a model exists.
   *
   * The launcher is visible to anybody whose device can run Welly, so this is
   * the first thing most students see — and it must be an explanation, not a
   * conversation with a broken input. It deliberately does NOT offer to start a
   * download: the choice of model, its size and where the weights come from
   * belong on the disclosure screen in Settings, which already states all three
   * and is the one place that consent is recorded from.
   *
   * Sending somebody there rather than reproducing it here is not politeness
   * about scope. The setup screen owns integrity verification, the size check
   * and the OPFS write; a second entry point into that would be a second path to
   * keep correct.
   */
  if (needsSetup) {
    return (
      <Modal onClose={onClose} label="Welly, the WeVolunteer assistant" size="lg">
        <ModalHead onClose={onClose}>
          <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center' }}>
            <WellyMark />
            <div>
              <h2>Welly</h2>
              <p className="lead">WeVolunteer&rsquo;s assistant. Not set up on this device yet.</p>
            </div>
          </div>
        </ModalHead>

        <div className="modal-body stack-sm">
          <p>
            Welly can look up opportunities, your hours, your certificates and the
            organizations you are part of. It runs inside this browser, so what you
            type to it is not sent to an AI company.
          </p>
          <p className="dim small">
            Setting it up downloads a model once — from Hugging Face, so that company
            receives a request from this device. After that it works without one. You
            choose which model, and you can remove it again at any time.
          </p>
        </div>

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>Not now</button>
          <button
            className="btn btn-primary"
            onClick={() => { onClose(); navigate('/settings?section=privacy'); }}
          >
            Set up Welly
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} label="Welly, the WeVolunteer assistant" size="lg">
      {/* The mark and the name together, so Welly reads as part of
          WeVolunteer rather than as a separate product. */}
      <ModalHead onClose={onClose}>
        <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center' }}>
          <WellyMark />
          <div>
            <h2>Welly</h2>
            <p className="lead">Runs on this device. Welly can suggest, but never decides.</p>
          </div>
        </div>
      </ModalHead>

      {/*
        Blocked from session replay, not merely masked. A transcript is a record
        of what somebody asked about their own volunteering, and the 2FA screen
        already established that mask levels do not reliably cover everything
        rendered inside a subtree.
      */}
      <div className="modal-body stack-sm" data-replay-block>
        {statusLine && <p className="dim small" role="status">{statusLine}</p>}

        <div className="ai-transcript stack-sm" ref={transcriptRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="stack-xs">
              <p className="dim small">
                Welly can look up opportunities, your hours, your certificates, and the
                organizations you are part of.
              </p>
              <ul className="ai-suggestions stack-xs">
                {[
                  'How many hours do I have?',
                  'Find volunteering opportunities near me',
                  'What organizations am I part of?',
                ].map(s => (
                  <li key={s}>
                    <button className="btn btn-secondary btn-sm" onClick={() => send(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`ai-turn ai-turn-${m.role}`}>
              <span className="sr-only">{m.role === 'user' ? 'You said' : 'Welly replied'}</span>
              <p>{m.text}{m.streaming && !m.text ? 'Thinking...' : ''}</p>
              {m.card && <AssistantCard card={m.card} />}
              {m.kind && <AssistantSource kind={m.kind} />}
            </div>
          ))}
        </div>
      </div>

      <div className="modal-foot ai-composer">
        <label className="sr-only" htmlFor="ai-input">Ask Welly</label>
        <input
          id="ai-input"
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
          placeholder="Ask Welly about volunteering..."
          autoComplete="off"
        />
        {busy ? (
          <button
            className="btn btn-secondary btn-icon"
            onClick={() => abortRef.current?.abort()}
            aria-label="Stop generating"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            className="btn btn-primary btn-icon"
            onClick={() => send(input)}
            disabled={!input.trim()}
            aria-label="Send"
          >
            <Send size={16} />
          </button>
        )}
        {messages.length > 0 && (
          <button
            className="btn btn-ghost btn-icon"
            onClick={clearAll}
            aria-label="Clear conversation"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </Modal>
  );
}
