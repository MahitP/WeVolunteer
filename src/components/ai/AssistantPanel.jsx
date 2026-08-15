import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Square, Trash2, Mic, MicOff } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import AssistantCard, { AssistantSource } from './AssistantCard';
import { ask } from '../../ai/assistant';
import { AIStatus, createRuntime, modelById, isAbort } from '../../ai';
import { readPreferences } from '../../ai/preferences';
import { loadConversation, saveConversation, clearConversation } from '../../ai/conversation';
import { isVoiceSupported, startDictation } from '../../ai/voice';

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
export default function AssistantPanel({ onClose, position }) {
  const [messages, setMessages] = useState(() => loadConversation());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(AIStatus.IDLE);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const dictationRef = useRef(null);

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
      dictationRef.current?.stop();
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
  }, [busy, position]);

  /**
   * Dictate a question.
   *
   * Offered only when the browser has a recogniser AND the person switched it
   * on — it is the one capability here that sends audio away, so it is opt-in
   * separately from the assistant itself.
   */
  const toggleDictation = useCallback(() => {
    if (dictationRef.current) {
      dictationRef.current.stop();
      return;
    }
    setVoiceError(null);
    setListening(true);

    const session = startDictation({ onInterim: text => setInput(text) });
    dictationRef.current = session;

    session.result
      .then(text => { if (aliveRef.current && text) setInput(text); })
      .catch(err => { if (aliveRef.current) setVoiceError(err.message); })
      .finally(() => {
        dictationRef.current = null;
        if (aliveRef.current) setListening(false);
      });
  }, []);

  const clearAll = useCallback(() => {
    clearConversation();
    setMessages([]);
  }, []);

  /* Both halves required: a browser that can, and a person who asked. */
  const voiceEnabled = readPreferences().voiceInput && isVoiceSupported();

  const statusLine = status === AIStatus.LOADING
    ? 'Getting the model ready. You can ask now — answers will be plainer until it is.'
    : status === AIStatus.ERROR
      ? 'The model could not start, so answers will be plainer. Everything still works.'
      : null;

  return (
    <Modal onClose={onClose} label="WeVolunteer assistant" size="lg">
      <ModalHead
        title="Assistant"
        description="Runs on this device. It can suggest, but never decides."
        onClose={onClose}
      />

      {/*
        Blocked from session replay, not merely masked. A transcript is a record
        of what somebody asked about their own volunteering, and the 2FA screen
        already established that mask levels do not reliably cover everything
        rendered inside a subtree.
      */}
      <div className="modal-body stack-sm" data-replay-block>
        {statusLine && <p className="dim small" role="status">{statusLine}</p>}
        {listening && <p className="dim small" role="status">Listening. Your browser is turning this into text.</p>}
        {voiceError && <p className="alert alert-danger" role="alert">{voiceError}</p>}

        <div className="ai-transcript stack-sm" ref={transcriptRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="stack-xs">
              <p className="dim small">
                Ask about opportunities, your hours, your certificates, or the organizations
                you are part of.
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
              <span className="sr-only">{m.role === 'user' ? 'You said' : 'Assistant replied'}</span>
              <p>{m.text}{m.streaming && !m.text ? 'Thinking...' : ''}</p>
              {m.card && <AssistantCard card={m.card} />}
              {m.kind && <AssistantSource kind={m.kind} />}
            </div>
          ))}
        </div>
      </div>

      <div className="modal-foot ai-composer">
        <label className="sr-only" htmlFor="ai-input">Ask the assistant</label>
        <input
          id="ai-input"
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
          placeholder="Ask about volunteering..."
          autoComplete="off"
        />
        {voiceEnabled && (
          <button
            className={`btn btn-icon ${listening ? 'btn-danger' : 'btn-ghost'}`}
            onClick={toggleDictation}
            disabled={busy}
            aria-label={listening ? 'Stop listening' : 'Ask by voice'}
            aria-pressed={listening}
          >
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
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
