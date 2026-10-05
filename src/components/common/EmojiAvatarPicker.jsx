import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { AVATAR_COLORS, AVATAR_COLOR_KEYS, avatarColorValue } from '../../utils/avatarColors';

/**
 * Pick an emoji, pick a colour, see the result.
 *
 * ── Why a curated set and not an emoji library ──
 *
 * The obvious move is `emoji-mart` or `emoji-picker-element`. Both are a
 * megabyte-class dataset plus an index, downloaded by every person who opens a
 * profile editor, to solve a problem that is mostly the opposite of search: on a
 * volunteering platform somebody wants a sport, a cause, a subject or an animal,
 * and they want it in about four seconds.
 *
 * So this is a curated set of roughly two hundred, grouped the way somebody
 * actually thinks about them, with keyword search over hand-written terms. Every
 * one renders legibly at avatar size on every platform, which an arbitrary
 * codepoint from a full set does not — a flag sequence or a recent addition
 * degrades to a tofu box on the school laptops this runs on.
 *
 * If the set ever needs to be genuinely exhaustive, the shape here does not
 * change: `GROUPS` becomes a fetched dataset and everything else stands.
 *
 * ── The colour ──
 *
 * An emoji on the same tinted circle as everybody else's is a placeholder that
 * happens to differ. The colour is what makes a pick feel chosen. It is a fixed
 * palette rather than a colour input for the reason in `avatarColors.js`: a free
 * picker produces avatars nobody can read.
 */

/** Grouped the way somebody looks for them, not the way Unicode files them. */
const GROUPS = Object.freeze([
  {
    name: 'Causes',
    emoji: ['🤝', '❤️', '🌍', '🌱', '♻️', '🕊️', '🎗️', '🩺', '🏥', '🍲', '🥫', '💧', '🏠', '📦', '🧺', '🫶'],
  },
  {
    name: 'School',
    emoji: ['🏫', '📚', '✏️', '📐', '🔬', '🧪', '🧮', '🎓', '📝', '💡', '🗂️', '🖍️', '📖', '🧠', '🔭', '🧑‍🏫'],
  },
  {
    name: 'Sport',
    emoji: ['⚽', '🏀', '⚾', '🥎', '🏐', '🏈', '🎾', '🏸', '🏑', '🥍', '🏊', '🏃', '🚴', '⛳', '🥇', '🏆'],
  },
  {
    name: 'Arts',
    emoji: ['🎭', '🎨', '🎵', '🎸', '🎹', '🥁', '🎤', '🎬', '📷', '🖌️', '🪅', '💃', '🎻', '🪕', '🎺', '✨'],
  },
  {
    name: 'Nature',
    emoji: ['🌳', '🌲', '🌸', '🌻', '🍀', '🌊', '⛰️', '🏞️', '🌿', '🍁', '🐝', '🦋', '🌤️', '🌈', '🔥', '❄️'],
  },
  {
    name: 'Animals',
    emoji: ['🐾', '🐶', '🐱', '🦊', '🦉', '🦁', '🐢', '🐬', '🐰', '🐦', '🐴', '🦅', '🐐', '🐝', '🦌', '🐻'],
  },
  {
    name: 'Food',
    emoji: ['🍎', '🥕', '🍞', '🥗', '🍲', '🥪', '🍕', '🍪', '🎂', '☕', '🥤', '🧁', '🍓', '🌽', '🥐', '🍯'],
  },
  {
    name: 'Things',
    emoji: ['⭐', '🌟', '🚀', '🧭', '🔧', '🛠️', '🧰', '🚲', '🚌', '📣', '🎉', '🗺️', '⌛', '🔑', '💼', '🧩'],
  },
]);

/**
 * Search terms, written rather than derived.
 *
 * A generated index over Unicode names finds "grinning face with smiling eyes"
 * for "happy" and nothing for "football" against ⚽, whose official name is
 * "soccer ball". These are the words somebody would actually type.
 */
const KEYWORDS = Object.freeze({
  '⚽': 'soccer football', '🏈': 'football gridiron', '⚾': 'baseball', '🥎': 'softball',
  '🏀': 'basketball', '🏐': 'volleyball', '🎾': 'tennis', '🏸': 'badminton',
  '🏑': 'hockey field', '🥍': 'lacrosse', '🏊': 'swim swimming', '🏃': 'run running track',
  '🚴': 'cycling bike', '⛳': 'golf', '🥇': 'medal first', '🏆': 'trophy award',
  '🤝': 'help partner volunteer service', '❤️': 'love heart care', '🌍': 'world earth global climate',
  '🌱': 'garden grow plant environment', '♻️': 'recycle green environment', '🕊️': 'peace dove',
  '🎗️': 'awareness ribbon', '🩺': 'health medical nurse', '🏥': 'hospital health',
  '🍲': 'food kitchen soup pantry', '🥫': 'food pantry canned drive', '💧': 'water',
  '🏠': 'housing shelter home habitat', '📦': 'drive donation packing', '🧺': 'clothing laundry drive',
  '🫶': 'care kindness', '🏫': 'school', '📚': 'books library reading tutoring',
  '✏️': 'writing tutor', '🔬': 'science lab stem', '🧪': 'chemistry science stem',
  '🧮': 'math', '🎓': 'graduation senior', '🧠': 'mind学 study', '🔭': 'astronomy space',
  '🧑‍🏫': 'teacher tutor', '🎭': 'theatre drama', '🎨': 'art paint', '🎵': 'music',
  '🎸': 'guitar band music', '🎹': 'piano music', '🥁': 'drums band', '🎤': 'singing choir',
  '🎬': 'film video', '📷': 'photo photography', '💃': 'dance', '🎻': 'orchestra strings',
  '🎺': 'band brass', '🌳': 'tree park cleanup', '🌊': 'beach river water cleanup',
  '⛰️': 'trail hiking mountain', '🏞️': 'park trail nature', '🐝': 'bees pollinator',
  '🦋': 'butterfly nature', '🐾': 'animals shelter pets', '🐶': 'dog shelter',
  '🐱': 'cat shelter', '🐢': 'turtle wildlife', '🐬': 'marine wildlife',
  '🍎': 'food fruit school', '🥕': 'garden vegetable food', '🍞': 'bread food bank',
  '🥗': 'food healthy', '☕': 'coffee cafe', '🎂': 'birthday party', '🎉': 'party celebration',
  '⭐': 'star favorite', '🚀': 'launch new', '🧭': 'guide direction', '🛠️': 'build repair tools',
  '🧰': 'tools repair', '🚲': 'bike', '🚌': 'transport bus', '📣': 'announce outreach',
  '🗺️': 'map area', '🔑': 'access key', '💼': 'work career', '🧩': 'puzzle inclusion autism',
});

const ALL = GROUPS.flatMap(g => g.emoji);

/**
 * @param {string|null} emoji currently chosen emoji
 * @param {string|null} color currently chosen palette key
 * @param {(patch: {emoji?: string|null, color?: string|null}) => void} onChange
 *   receives ONLY the field that changed; the caller merges it into its own
 *   state. Sending both would mean reading one of them from a stale closure.
 * @param {string} idPrefix unique per instance, so two pickers on one page do
 *   not produce duplicate element ids
 */
export default function EmojiAvatarPicker({ emoji, color, onChange, idPrefix = 'avatar' }) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL.filter(e => (KEYWORDS[e] || '').includes(q));
  }, [query]);

  const swatch = avatarColorValue(color);

  /**
   * A PATCH, not a whole value.
   *
   * These used to send both fields — `pick` sent `{ emoji: next, color }` and
   * `paint` sent `{ emoji, color: next }` — each reading the other from the
   * closure it was created in. Two picks in quick succession therefore came
   * from the same render, and the second one wrote the FIRST one's stale
   * partner back: choose an emoji, then a colour, and the emoji silently
   * reverted. Found by clicking both in a browser inside one frame.
   *
   * Sending only what changed makes the merge the parent's job, where the
   * current value actually lives.
   */
  const pick = (next) => onChange({ emoji: next });
  const paint = (next) => onChange({ color: next });

  return (
    <div className="emoji-picker stack-sm">
      {/* The result, at the size it will actually be seen. A picker that shows
          only the choices makes somebody commit before they can tell whether a
          dark emoji is legible on a dark swatch. */}
      <div className="row" style={{ gap: 'var(--s4)', alignItems: 'center' }}>
        <span
          className="avatar avatar-lg"
          style={swatch ? { '--avatar-bg': swatch } : undefined}
          aria-hidden="true"
        >
          {emoji || '🙂'}
        </span>
        <div className="stack-xs">
          <span className="small strong">Preview</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChange({ emoji: null, color: null })}
          >
            Clear
          </button>
        </div>
      </div>

      <label className="field">
        <span className="sr-only">Search icons</span>
        <span className="input-with-icon">
          <Search size={14} aria-hidden="true" />
          <input
            className="input"
            type="search"
            placeholder="Search — try “soccer”, “food”, “music”…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </span>
      </label>

      {/**
        * A radiogroup, because these are one choice among many — which is what
        * the role means, and it brings arrow-key navigation with it rather than
        * making somebody tab through two hundred buttons.
        */}
      <div className="emoji-grid-wrap" role="radiogroup" aria-label="Choose an icon">
        {results
          ? (results.length === 0
            ? <p className="small dim">No icons match “{query}”.</p>
            : (
              <div className="emoji-grid">
                {results.map(e => (
                  <EmojiButton key={e} value={e} selected={emoji === e} onPick={pick} />
                ))}
              </div>
            ))
          : GROUPS.map(group => (
            <div key={group.name} className="emoji-group">
              <div className="emoji-group-name">{group.name}</div>
              <div className="emoji-grid">
                {group.emoji.map(e => (
                  <EmojiButton key={e} value={e} selected={emoji === e} onPick={pick} />
                ))}
              </div>
            </div>
          ))}
      </div>

      <div>
        <span className="small strong" id={`${idPrefix}-colour-label`}>Background</span>
        <div className="row row-wrap emoji-colours" role="radiogroup" aria-labelledby={`${idPrefix}-colour-label`}>
          {AVATAR_COLOR_KEYS.map(key => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={color === key}
              aria-label={AVATAR_COLORS[key].label}
              title={AVATAR_COLORS[key].label}
              className={`emoji-colour ${color === key ? 'is-selected' : ''}`}
              style={{ '--swatch': AVATAR_COLORS[key].value }}
              onClick={() => paint(key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function EmojiButton({ value, selected, onPick }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`Use ${value}`}
      className={`emoji-option ${selected ? 'is-selected' : ''}`}
      onClick={() => onPick(value)}
    >
      <span aria-hidden="true">{value}</span>
    </button>
  );
}
