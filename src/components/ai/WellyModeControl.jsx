import React, { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Cloud, Check, ChevronDown, AlertCircle } from 'lucide-react';
import { AIStatus } from '../../ai/runtime/types.js';
import { isLocalAIEnabled } from '../../ai';

/**
 * Which Welly is answering, and how to change it.
 *
 * ── The two names ──
 *
 * "Standard" and "on-device" described the implementation, and the first of
 * them described nothing at all — a student reading "Standard" learns only that
 * there is presumably a non-standard one. The pair is now:
 *
 *   Welly Chat   the assistant as it always works, answering from the reader's
 *                own WeVolunteer records
 *   Welly AI     the same assistant with a language model running on the
 *                reader's own device, which is what makes it conversational
 *
 * Both are Welly, which is the point of the naming: this is one assistant with
 * an optional extra rather than two products. Neither name says "local",
 * "inference", "runtime", "WASM" or "model backend"; the panel below explains
 * the difference in a sentence each, and Settings holds the detail.
 *
 * ── Why this control does not download anything ──
 *
 * It used to. The Welly page carried its own copy of the download flow —
 * progress, cancellation, writing preferences, reloading the runtime — beside
 * the one in `AISettingsCard`, which also handles removal, storage accounting
 * and digest verification. Two implementations of a 900 MB download is two
 * places for it to go wrong, and only one of them knew how to clean up after
 * itself.
 *
 * So Settings stays the single place that manages the model, and this is a way
 * in: it says which engine is answering, explains the other one, and links to
 * the flow that already exists. What it adds over hunting through Settings is
 * that it is here, next to Welly's name, at the moment somebody wonders about it.
 */

/** Everything the control needs to know, derived in one place. */
export function modeFor({ capability, prefs, status }) {
  if (!capability?.supported) {
    return {
      id: 'chat',
      label: 'Welly Chat',
      detail: 'This device can’t run Welly AI',
      reason: capability?.reason || null,
      tone: 'plain',
    };
  }
  if (status === AIStatus.READY) {
    return { id: 'ai', label: 'Welly AI', detail: 'Running on this device', tone: 'active' };
  }
  if (status === AIStatus.ERROR) {
    return { id: 'chat', label: 'Welly Chat', detail: 'Welly AI didn’t start', tone: 'warn' };
  }
  if (prefs?.enabled && prefs?.modelId) {
    return { id: 'starting', label: 'Welly AI', detail: 'Starting up', tone: 'busy' };
  }
  return { id: 'chat', label: 'Welly Chat', detail: 'Welly AI is available', tone: 'plain' };
}

export default function WellyModeControl({
  capability,
  prefs,
  status,
  onRetry = null,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();

  const mode = modeFor({ capability, prefs, status });

  /**
   * A build that opted out of on-device AI has one mode, so it needs no control.
   *
   * Rendering one here would be worse than useless: it would name Welly AI,
   * describe it, and link to a Settings card that renders nothing in this
   * build — `AISettingsCard` gates on the same flag. Every surface gates on
   * `isLocalAIEnabled()`; this is one of them, and `disabledPath.test.jsx` is
   * what holds that.
   */
  if (!isLocalAIEnabled()) return null;

  /* Escape closes and returns focus to the control that opened it; a click
     outside just closes. Both are what `useModal` gives a dialog, and this is
     deliberately not a dialog — it is a disclosure beside its trigger, so it
     does not trap focus or lock scrolling. */
  useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const Icon = mode.id === 'chat' ? Cloud : Sparkles;

  return (
    <div className="welly-mode" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`welly-mode-btn welly-mode-${mode.tone}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        /* The state is in the accessible name, not only in the colour and the
           glyph — the control has to say what it is for somebody who cannot see
           either. */
        aria-label={`Answering with ${mode.label}. ${mode.detail}. Change how Welly answers`}
      >
        <Icon size={14} className="welly-mode-glyph" aria-hidden="true" />
        <span className="welly-mode-label">{mode.label}</span>
        {!compact && <span className="welly-mode-detail">{mode.detail}</span>}
        <ChevronDown size={13} className="welly-mode-caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="welly-mode-panel" id={panelId}>
          <p className="welly-mode-panel-title">How Welly answers</p>

          <div className={`welly-mode-option${mode.id === 'chat' ? ' is-current' : ''}`}>
            <Cloud size={15} className="welly-mode-option-glyph" aria-hidden="true" />
            <div>
              <span className="welly-mode-option-name">
                Welly Chat
                {mode.id === 'chat' && <Check size={13} aria-label="in use" />}
              </span>
              <span className="welly-mode-option-body dim">
                Answers from your WeVolunteer records — your hours, applications and
                the opportunities you can see. Always available.
              </span>
            </div>
          </div>

          <div className={`welly-mode-option${mode.id !== 'chat' ? ' is-current' : ''}`}>
            <Sparkles size={15} className="welly-mode-option-glyph" aria-hidden="true" />
            <div>
              <span className="welly-mode-option-name">
                Welly AI
                {mode.id !== 'chat' && <Check size={13} aria-label="in use" />}
              </span>
              <span className="welly-mode-option-body dim">
                Adds a language model that runs on your own device, so Welly can hold
                a conversation. Nothing you type leaves this browser.
              </span>
            </div>
          </div>

          {mode.reason && (
            <p className="welly-mode-note">
              <AlertCircle size={13} aria-hidden="true" />
              <span>{mode.reason}</span>
            </p>
          )}

          {mode.tone === 'warn' && (
            <p className="welly-mode-note">
              <AlertCircle size={13} aria-hidden="true" />
              <span>Welly AI couldn’t start on this device, so Welly Chat is answering.</span>
            </p>
          )}

          <div className="welly-mode-actions">
            {mode.tone === 'warn' && onRetry && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setOpen(false); onRetry(); }}
              >
                Try again
              </button>
            )}
            {capability?.supported && (
              <Link
                className="btn btn-ghost btn-sm"
                /* `?section=privacy` as well as the fragment: Settings is
                   sectioned, and it reads the section from the query. Without
                   it the link opened Settings on Appearance, where the card
                   this is pointing at is not even mounted. */
                to="/settings?section=privacy#welly-ai"
                onClick={() => setOpen(false)}
              >
                {mode.id === 'chat' ? 'Set up Welly AI' : 'Manage Welly AI'}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
