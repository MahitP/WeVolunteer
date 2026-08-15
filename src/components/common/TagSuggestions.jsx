import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Plus } from 'lucide-react';
import { isLocalAIEnabled, createRuntime, modelById, AIStatus } from '../../ai';
import { suggestTags } from '../../ai/tags';
import { readPreferences } from '../../ai/preferences';

/**
 * Suggested tags, offered beside the tag input on the event form.
 *
 * ── The organizer decides ──
 *
 * Nothing is applied automatically. Each suggestion is a button that adds one
 * tag; ignoring them costs nothing and is the default outcome. The event's tags
 * remain whatever the organizer chose, which is the point — WeVolunteer has no
 * canonical vocabulary on purpose, and a suggester that filled the field in
 * would quietly become one.
 *
 * ── Asked for, not volunteered ──
 *
 * Suggestions appear when the organizer presses a button, not as they type.
 * Running a model on every keystroke would spend a laptop's battery on
 * half-written sentences, and a form that starts thinking while somebody is
 * mid-sentence is unpleasant to use.
 */
export default function TagSuggestions({ title, description, value = [], onAdd, vocabulary = [] }) {
  const [suggestions, setSuggestions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);

  const runtimeRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => () => {
    aliveRef.current = false;
    /* The model is released with the form. An organizer writing one event
       should not leave several hundred megabytes resident for the session. */
    runtimeRef.current?.unload();
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setRan(true);
    try {
      const prefs = readPreferences();
      if (!prefs.enabled || !prefs.modelId) { setSuggestions([]); return; }

      if (!runtimeRef.current) {
        const runtime = await createRuntime();
        await runtime.load(modelById(prefs.modelId));
        if (!aliveRef.current) { await runtime.unload(); return; }
        runtimeRef.current = runtime;
      }
      if (runtimeRef.current.status !== AIStatus.READY) { setSuggestions([]); return; }

      const out = await suggestTags({
        title, description, runtime: runtimeRef.current, vocabulary, existing: value,
      });
      if (aliveRef.current) setSuggestions(out);
    } catch {
      /* A convenience on a form that works without it. An organizer should
         never see an error about a suggestion they did not ask for. */
      if (aliveRef.current) setSuggestions([]);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [title, description, value, vocabulary]);

  if (!isLocalAIEnabled()) return null;
  const prefs = readPreferences();
  if (!prefs.enabled || !prefs.modelId) return null;

  const enoughText = [title, description].filter(Boolean).join(' ').trim().length >= 20;

  return (
    <div className="stack-xs">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={run}
        disabled={busy || !enoughText}
      >
        <Sparkles size={14} aria-hidden="true" />
        {' '}{busy ? 'Thinking...' : 'Suggest tags'}
      </button>

      {!enoughText && (
        <span className="dim small">
          Add a title and a description first, and suggestions will have something to go on.
        </span>
      )}

      {suggestions.length > 0 && (
        <>
          <span className="dim small" id="suggested-tags-help">
            Suggestions only. Add the ones that fit and ignore the rest.
          </span>
          <ul className="chips" aria-label="Suggested tags" aria-describedby="suggested-tags-help">
            {suggestions.map(s => (
              <li key={s.tag}>
                <button
                  type="button"
                  className="tag tag-chip-action"
                  onClick={() => {
                    onAdd?.(s.label);
                    setSuggestions(list => list.filter(x => x.tag !== s.tag));
                  }}
                  aria-label={`Add the tag ${s.label}`}
                >
                  <Plus size={11} aria-hidden="true" /> {s.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {ran && !busy && suggestions.length === 0 && (
        <span className="dim small">
          No suggestions this time. Your own tags are usually better anyway.
        </span>
      )}
    </div>
  );
}
