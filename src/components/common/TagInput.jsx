import React, { useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { normaliseTag, MAX_TAGS_PER_EVENT, MAX_TAG_LENGTH } from '../../eventTags.js';

/**
 * The organizer's tag editor: chips, plus type-and-Enter.
 *
 * ── Optional, and it says so ──
 *
 * Tags are metadata for discovery. An organizer who ignores this control loses
 * nothing, and the hint says "optional" in the first word rather than leaving them
 * to infer it from the absence of an asterisk.
 *
 * ── Why suggestions, when the vocabulary is deliberately not fixed ──
 *
 * The requirement is that organizers are never restricted to a predefined list —
 * `CommunityGarden` has to be creatable on the spot. But nothing stops three
 * organizers inventing `FoodDrive`, `Food Drive` and `food-drive` for one thing,
 * and once that has happened no filter reunites them. Offering what already
 * exists makes reuse the path of least resistance without making it the only path:
 * the list is a shortcut, never a gate, and anything typed is accepted.
 *
 * ── Validation is duplicated here on purpose ──
 *
 * `normaliseTag` and the two limits are imported from the SAME module the server
 * validates with (`server/eventTags.js`, re-exported through `src/eventTags.js`),
 * so the rules cannot drift. This is a courtesy — it tells the organizer
 * immediately rather than after a round trip — and it is NOT the enforcement. The
 * route validates every tag again; see the note there.
 *
 * ── Why the rules are props, with event defaults ──
 *
 * This control is shared with the organization form, whose route permits 40
 * characters and any punctuation — real bodies are called "Food & Water" and
 * "501(c)(3)". Hard-coding the event rules here meant that form enforced limits
 * its own API did not have: punctuated names could not be typed, and a stored
 * tag that failed the event regex was dropped from the chip list and then
 * written away by the next save.
 *
 * So the caller supplies the rules it is actually validated against. The
 * defaults are the event ones, so the event editor passes nothing and is
 * unchanged. `subject` exists because the copy named events out loud — "An
 * event can have at most 8 tags" and `aria-label="Tags on this event"` both
 * rendered on the organization form.
 */
export default function TagInput({
  value = [],
  onChange,
  suggestions = [],
  disabled = false,
  normalise = normaliseTag,
  maxTags = MAX_TAGS_PER_EVENT,
  maxLength = MAX_TAG_LENGTH,
  subject = 'event',
  invalidHint = `Use letters, numbers, spaces or hyphens, up to ${MAX_TAG_LENGTH} characters.`,
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef(null);

  const atLimit = value.length >= maxTags;

  /**
   * Suggestions minus what is already on the event, capped.
   *
   * Offering a tag the event already carries is a suggestion that cannot do
   * anything. Matched on the normalised key so `NHS` typed against an existing
   * `nhs` is recognised as the same thing rather than offered as new.
   */
  const available = useMemo(() => {
    const held = new Set(value.map(t => t.tag));
    const typed = normalise(draft)?.tag ?? '';
    return suggestions
      .filter(s => !held.has(s.tag))
      .filter(s => !typed || s.tag.includes(typed))
      .slice(0, 8);
  }, [suggestions, value, draft, normalise]);

  const add = (raw) => {
    const normalised = normalise(raw);
    if (!normalised) {
      setError(raw.trim() ? invalidHint : '');
      return;
    }
    if (value.some(t => t.tag === normalised.tag)) {
      /* Already present. Not an error — the organizer meant the tag that is
         already there — so the draft is simply cleared. */
      setDraft('');
      setError('');
      return;
    }
    if (atLimit) {
      setError(`An ${subject} can have at most ${maxTags} tags.`);
      return;
    }
    onChange([...value, normalised]);
    setDraft('');
    setError('');
  };

  const remove = (tag) => {
    onChange(value.filter(t => t.tag !== tag));
    setError('');
    /* Focus returns to the field rather than being lost to the removed button's
       vanished node, which would otherwise drop the caret to the top of the form. */
    inputRef.current?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      /* Enter must not submit the surrounding form. An organizer pressing Enter
         after typing a tag means "add this tag", and publishing a half-filled
         event instead is unrecoverable from their point of view. */
      event.preventDefault();
      add(draft);
      return;
    }
    /* Backspace on an empty field removes the last chip — the behaviour every
       token field has, and the one a keyboard user reaches for first. */
    if (event.key === 'Backspace' && !draft && value.length) {
      remove(value[value.length - 1].tag);
    }
  };

  return (
    <div className="field">
      <label className="label" htmlFor={inputId}>Tags</label>
      <p className="small dim" id={`${inputId}-hint`}>
        Optional. Words that help somebody find this — a cause, a group, a subject.
        Up to {maxTags}.
      </p>

      {value.length > 0 && (
        <ul className="tag-chips tag-chips-editable" aria-label={`Tags on this ${subject}`}>
          {value.map(({ tag, label }) => (
            <li key={tag}>
              <span className="tag-chip tag-chip-editable">
                <span aria-hidden="true">#</span>{label}
                <button
                  type="button"
                  className="tag-chip-remove"
                  onClick={() => remove(tag)}
                  disabled={disabled}
                  /* Names the tag, so a screen-reader user moving through eight
                     remove buttons is not told "remove, remove, remove". */
                  aria-label={`Remove tag ${label}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <input
        id={inputId}
        ref={inputRef}
        className="input"
        type="text"
        value={draft}
        list={listId}
        disabled={disabled || atLimit}
        maxLength={maxLength * 2}
        placeholder={atLimit ? `${maxTags} tags is the maximum` : 'Type a tag and press Enter…'}
        aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => { setDraft(e.target.value); setError(''); }}
        onKeyDown={onKeyDown}
        /**
         * Committed on blur as well as on Enter.
         *
         * Somebody who types a tag and then clicks Save expects the tag they can
         * see in the box to be saved. Dropping it because they never pressed Enter
         * is the single most likely way to lose input in a control like this.
         */
        onBlur={() => { if (draft.trim()) add(draft); }}
      />

      {/**
        * A native `<datalist>`, not a custom popup.
        *
        * It is keyboard-accessible, screen-reader-announced and correctly
        * positioned on every platform for free, and — unlike a hand-built listbox —
        * it cannot trap focus or render behind a modal, which is the failure the
        * step-up dialog was just fixed for. The trade is less control over
        * appearance, which for an optional shortcut is the right way round.
        */}
      <datalist id={listId}>
        {available.map(s => <option key={s.tag} value={s.label} />)}
      </datalist>

      {error && (
        <p className="field-error" id={`${inputId}-error`} role="alert">{error}</p>
      )}
    </div>
  );
}
