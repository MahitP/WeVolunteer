/**
 * Turning "this document changed" into a sentence somebody will actually read.
 *
 * ── The thing this exists to avoid ──
 *
 * The obvious implementation is a line diff rendered with `+` and `-` markers.
 * That is the correct tool for reviewing a patch and the wrong one for telling a
 * fifteen-year-old that the privacy policy moved. A diff shows every reflowed
 * line, every renumbered heading and every stray whitespace change with exactly
 * the same weight as the sentence that matters, and the reader's only honest
 * response is to stop reading.
 *
 * So this does not produce a diff. It produces an EXCERPT: one or two whole
 * sentences, in the document's own voice, chosen because they are new. The
 * reader gets a true sample of what is different and a link to the rest. Nobody
 * is asked to parse anything.
 *
 * ── Why sentences and not paragraphs or lines ──
 *
 * Lines are an artifact of how the file is wrapped and change when nothing has.
 * Paragraphs are frequently longer than the space a modal can give them, and
 * truncating one mid-clause can invert its meaning — "we do not share your data
 * with…" is a dangerous place to cut. A sentence is the smallest unit that is
 * still true on its own, which is the only unit safe to quote out of context.
 *
 * ── What this deliberately does NOT claim ──
 *
 * The excerpt is a sample, never a summary, and the copy around it must say so.
 * It cannot know which change is most significant, and a component that
 * presented it as "what changed" would be overstating it. `changeCount` is
 * published alongside so the UI can say "and N other changes" honestly.
 */

/** Markdown decoration that should not survive into a plain-text excerpt. */
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    /* Links become their text: a bare URL in a modal is noise, and the reader
       is one button away from the document itself. */
    .replace(/\[(.+?)\]\((?:[^)]*)\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '');
}

/**
 * The published half of a policy file.
 *
 * These documents carry an internal `## Specification` brief above a `## Draft`
 * marker, and only what follows the marker is published. Quoting from the
 * drafting notes would put internal reasoning in front of a user — and
 * `legalDocuments.js` already slices on the same marker for hashing, so an
 * excerpt taken from the whole file would not even correspond to the version
 * whose hash we are comparing.
 */
export function publishedPortion(body) {
  if (typeof body !== 'string') return '';
  const marker = body.indexOf('\n## Draft\n');
  return marker === -1 ? body : body.slice(marker + '\n## Draft\n'.length);
}

/**
 * Splits prose into sentences.
 *
 * Deliberately conservative: it breaks on `.`/`!`/`?` followed by whitespace and
 * a capital, which leaves "e.g." and "U.S." and "Section 3.2" intact at the cost
 * of occasionally keeping two short sentences together. Over-splitting produces
 * fragments that read as broken; under-splitting produces a slightly long quote.
 * Only one of those looks like a bug to a reader.
 */
export function sentences(text) {
  return stripMarkdown(text)
    .split(/\n{2,}/)
    .flatMap(block => block.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z"“])/))
    .map(s => s.trim())
    .filter(Boolean);
}

/** Comparison form: case and punctuation should not count as a change. */
const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Sentences present in the new text that were not in the old.
 *
 * Set membership on the normalised form rather than a positional diff, so a
 * paragraph MOVED between sections is correctly reported as no change at all.
 * A positional diff would call a reordering a rewrite and quote a sentence that
 * has not changed a word — the fastest way to make a change notice untrustworthy.
 */
export function addedSentences(oldBody, newBody) {
  const before = new Set(sentences(publishedPortion(oldBody ?? '')).map(normalise));
  return sentences(publishedPortion(newBody ?? ''))
    .filter(s => !before.has(normalise(s)));
}

/** Long enough to carry meaning, short enough that a modal is not a wall. */
const MAX_EXCERPT_CHARS = 280;

/**
 * A readable excerpt of what is new in a document.
 *
 * @param {string|null} oldBody the previously published body, or null when
 *   there is nothing to compare against (a first publication)
 * @param {string} newBody the body now in effect
 * @returns {{ text: string|null, changeCount: number, isSample: boolean }}
 *   `text` is null when nothing quotable was added — a deletion-only or
 *   formatting-only change is real, and inventing a quote for it would be a lie.
 */
export function buildExcerpt(oldBody, newBody) {
  const added = addedSentences(oldBody, newBody);
  if (added.length === 0) return { text: null, changeCount: 0, isSample: false };

  /* The first added sentence long enough to stand alone. A four-word heading
     fragment is technically new and tells the reader nothing. */
  const meaningful = added.filter(s => s.length >= 40);
  const chosen = meaningful[0] ?? added[0];

  let text = chosen;
  if (text.length > MAX_EXCERPT_CHARS) {
    /* Cut at a word boundary and mark it, so the reader can see the quote is
       clipped rather than wondering whether the sentence really ends there. */
    text = `${text.slice(0, text.lastIndexOf(' ', MAX_EXCERPT_CHARS))}…`;
  }

  return {
    text,
    changeCount: added.length,
    /* True whenever the quote is one of several changes, so the UI can say
       "among other changes" instead of implying this is the whole of it. */
    isSample: added.length > 1,
  };
}
