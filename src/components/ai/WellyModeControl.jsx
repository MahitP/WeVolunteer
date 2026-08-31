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
 *
 * ── Why the two options became buttons ──
 *
 * They were captioned paragraphs with a tick beside whichever was in use, and a
 * link underneath to Settings. Reported: "the mode dropdown should let you
 * click between On-Device/Local AI to switch seamlessly". That is right, and
 * the read-only version was a worse thing than it looked — a panel that lists
 * two options, marks one, and cannot be used to pick the other reads as broken
 * rather than as informative.
 *
 * Switching is not model management, which is the distinction that keeps this
 * from becoming the second download flow the paragraphs above are about. Off
 * and on is one boolean in `preferences.js` plus a runtime load, both of which
 * the page already does on mount and on a `storage` event from another tab.
 * Downloading is not: the first time somebody picks Welly AI there is nothing
 * to switch on, so that click goes to Settings, where the download, the digest
 * check, the storage accounting and the remove button already live.
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
  /**
   * Fetching weights is a different wait from initialising them, and it is the
   * long one — several hundred megabytes for the smaller model and nearly a
   * gigabyte for the larger.
   *
   * It shared a caption with LOADING, which meant a model being re-downloaded
   * after an incomplete transfer looked exactly like a model that had hung. A
   * reader who is told it is downloading knows to leave the tab open; one who
   * is told it is "starting up" for four minutes reasonably concludes it is
   * broken. Same tone, because both are the same kind of wait to the control
   * around it.
   */
  if (status === AIStatus.DOWNLOADING) {
    return { id: 'starting', label: 'Welly AI', detail: 'Downloading the model', tone: 'busy' };
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
  onSelectMode = null,
  startupError = null,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();

  const mode = modeFor({ capability, prefs, status });

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

  /**
   * A build that opted out of on-device AI has one mode, so it needs no control.
   *
   * Rendering one would be worse than useless: it would name Welly AI, describe
   * it, and link to a Settings card that renders nothing in this build —
   * `AISettingsCard` gates on the same flag. Every surface gates on
   * `isLocalAIEnabled()`; this is one of them, and `disabledPath.test.jsx` is
   * what holds that.
   *
   * AFTER every hook, not before. `hookOrder.test.jsx` states the rule for the
   * repository and oxlint's `rules-of-hooks` caught this one: an early return
   * above `useEffect` changes how many hooks run between one render and the
   * next, which is a crash rather than a missing control.
   */
  if (!isLocalAIEnabled()) return null;

  const Icon = mode.id === 'chat' ? Cloud : Sparkles;
  const onChat = mode.id === 'chat';
  /* A model has been downloaded on this device. `preferences.js` only records a
     `modelId` once a download has finished and verified, which is what makes it
     the right question to ask here rather than "is it switched on". */
  const installed = Boolean(prefs?.modelId);
  const switching = status === AIStatus.LOADING || status === AIStatus.DOWNLOADING;

  /**
   * Picking a mode.
   *
   * The panel closes first in every branch. Leaving it open over a runtime that
   * is loading gives a disabled pair of options and a caption that is about to
   * be wrong, and leaving it open across a navigation to Settings leaves a
   * disclosure hanging over a different page.
   */
  const choose = id => {
    setOpen(false);
    if (id === (onChat ? 'chat' : 'ai')) return;
    onSelectMode?.(id);
  };

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

          <button
            type="button"
            className={`welly-mode-option${onChat ? ' is-current' : ''}`}
            onClick={() => choose('chat')}
            disabled={switching}
            aria-current={onChat ? 'true' : undefined}
          >
            <Cloud size={15} className="welly-mode-option-glyph" aria-hidden="true" />
            <div>
              <span className="welly-mode-option-name">
                Welly Chat
                {onChat && <Check size={13} aria-label="in use" />}
              </span>
              <span className="welly-mode-option-body dim">
                Answers from your WeVolunteer records — your hours, applications and
                the opportunities you can see. Always available.
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`welly-mode-option${onChat ? '' : ' is-current'}`}
            onClick={() => choose('ai')}
            /* Not disabled when there is nothing installed — that click is the
               way in to installing it. Only an unsupported device and a switch
               already in progress take the option away. */
            disabled={!capability?.supported || switching}
            aria-current={onChat ? undefined : 'true'}
          >
            <Sparkles size={15} className="welly-mode-option-glyph" aria-hidden="true" />
            <div>
              <span className="welly-mode-option-name">
                Welly AI
                {!onChat && <Check size={13} aria-label="in use" />}
                {capability?.supported && !installed && (
                  <span className="welly-mode-option-tag">Needs a one-time download</span>
                )}
              </span>
              <span className="welly-mode-option-body dim">
                Adds a language model that runs on your own device, so Welly can hold
                a conversation. Nothing you type leaves this browser.
              </span>
            </div>
          </button>

          {mode.reason && (
            <p className="welly-mode-note">
              <AlertCircle size={13} aria-hidden="true" />
              <span>{mode.reason}</span>
            </p>
          )}

          {mode.tone === 'warn' && (
            /**
             * The reason, when there is one.
             *
             * "Welly AI didn't start" on its own is a dead end — it names the
             * symptom the reader can already see. The runtime distinguishes
             * out-of-memory from a failed download and writes a sentence for
             * each; both have a different next step, and neither is "try
             * again". Falling back to the generic line only when nothing more
             * specific reached here.
             */
            <p className="welly-mode-note">
              <AlertCircle size={13} aria-hidden="true" />
              <span>
                {startupError?.message
                  || 'Welly AI couldn’t start on this device, so Welly Chat is answering.'}
                {startupError?.model && ` (${startupError.model} model.)`}
              </span>
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
