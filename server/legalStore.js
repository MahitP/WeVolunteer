import { createHash } from 'node:crypto';
import { LEGAL_DOCUMENTS, documentBySlug, publishedHash } from './legalDocuments.js';
import { policyContent } from './legalContent.js';
import { parsePolicyMarkdown, isSafeHref } from '../src/utils/policyMarkdown.js';

/**
 * The override layer that lets legal text change without a deploy.
 *
 * ── What this module owns ──
 *
 * One question, asked from four places: *what is the current text, version and
 * effective date of this document?* Before the Legal Center editor there was one
 * answer — the file on disk and the registry constant beside it — and each
 * caller reached for it directly. Now there are two possible answers, and the
 * moment more than one place decides between them they will disagree.
 *
 * They disagree in a specific and expensive way. `legal_acceptances` records the
 * `(slug, version, content_hash)` a person agreed to. If the endpoint that
 * SERVES a document resolves to the newest revision while the code that RECORDS
 * an acceptance resolves to the registry, then every consent row written after
 * the first edit names a version the reader was never shown. That is not a
 * display bug; it is a consent record that is false about what somebody agreed
 * to, which is the one thing this subsystem exists to keep true.
 *
 * So resolution lives here, and `legalRoutes.js`, `consent.js`,
 * `organizerAgreement.js` and the editor all call it rather than deciding for
 * themselves.
 *
 * ── The fallback is the whole install story ──
 *
 * With no revision rows — which is every existing database until an owner saves
 * something — every function here returns exactly what the registry and the file
 * returned before. There is no backfill and no seeding step, because the
 * existing text is already the answer and a copy of it in the database would be
 * a second thing to keep in step.
 *
 * ── Why the files are never rewritten ──
 *
 * A published revision is a database row. `docs/legal/policies/*.md` stays the
 * originally published text and the fallback, and a server that rewrote its own
 * repository would make the deployment self-modifying and the git history a
 * fiction.
 */

/** Longest body accepted. The published policies run 4–12 KB; this is generous. */
export const MAX_BODY_LENGTH = 400_000;

/** Raised for any rejected save. `field` lets the editor focus the right input. */
export class LegalValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'LegalValidationError';
    this.field = field;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Versions
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Parses `MAJOR.MINOR.PATCH` into comparable numbers, or returns null.
 *
 * Two-component versions parse as well, and that leniency is not sloppiness —
 * it is the migration path. Every document in the registry is at `'1.0'` today,
 * so a strict three-part parser would make the CURRENT version unreadable and
 * the first save impossible to validate against anything. Reading `1.0` as
 * `1.0.0` lets the existing corpus be compared without rewriting ten constants.
 *
 * Writes are held to the stricter rule — see `parseNewVersion`. Lenient in what
 * we accept from the past, strict in what we let somebody create.
 *
 * Leading zeros are refused in both directions: `1.01.0` and `1.1.0` would
 * compare equal while displaying differently, and a version a reader cannot
 * distinguish from another is not a version.
 */
/**
 * The most digits one MAJOR.MINOR.PATCH component may carry.
 *
 * Not style — see the note inside `parseVersion`. Beyond about 308 digits
 * `Number()` returns `Infinity`, and two of those make the comparator return
 * `NaN`, which silently disables the component it was comparing.
 */
const MAX_VERSION_COMPONENT_DIGITS = 6;

export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split('.');
  if (parts.length < 2 || parts.length > 3) return null;

  const nums = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part)) return null;
    /**
     * Each component is LENGTH-BOUNDED, and that bound is load-bearing.
     *
     * The pattern above admits digits without limit, and `Number('9'.repeat(400))`
     * is `Infinity`. Two Infinities then made `compareVersions` return
     * `Infinity - Infinity`, which is `NaN` — and `NaN` is falsy, so the
     * `||` cascade below fell straight through to `minor` and `patch` and the
     * major number stopped participating in the comparison at all. A strictly
     * LOWER version compared as greater, which is the one thing this comparator
     * exists to make impossible.
     *
     * The consequence was worse than a mis-sort. `legal_document_revisions` is
     * append-only — there is no UPDATE and no DELETE against it anywhere — so a
     * single publish at a 400-digit version made every later publication of that
     * document compare as not-greater, for ever, recoverable only by hand-editing
     * production SQL.
     *
     * Six digits is a hundred thousand major versions past anything a legal
     * document will ever carry, and it keeps every component exactly
     * representable.
     */
    if (part.length > MAX_VERSION_COMPONENT_DIGITS) return null;
    nums.push(Number(part));
  }
  while (nums.length < 3) nums.push(0);

  return { major: nums[0], minor: nums[1], patch: nums[2] };
}

/**
 * Negative, zero or positive, like every other comparator.
 *
 * Written as explicit branches rather than as a chain of subtractions. The
 * subtraction form is the idiomatic one and it has a failure mode this
 * comparator cannot afford: any pair that subtracts to `NaN` is falsy, so the
 * `||` silently moves on to the next component instead of returning an answer.
 * `parseVersion` now bounds the inputs so that cannot arise — this is the second
 * lock on the same door, because what it protects is the rule that a published
 * legal version can never be reused or walked backwards.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`compareVersions: unparseable version (${a}, ${b})`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

/**
 * Validates a version an owner is trying to publish.
 *
 * All three parts required here, unlike `parseVersion`. The registry's
 * two-component versions are history; anything created from now on says which
 * of the three kinds of change it was, because that distinction is the only
 * thing that tells a reader whether they need to re-read the document.
 */
function parseNewVersion(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new LegalValidationError('Enter a version number.', 'version');
  }
  const trimmed = raw.trim();
  if (trimmed.split('.').length !== 3 || !parseVersion(trimmed)) {
    throw new LegalValidationError(
      'Use a version number of the form MAJOR.MINOR.PATCH, such as 1.1.0. '
      + 'Each part must be a whole number without leading zeros.',
      'version'
    );
  }
  return trimmed;
}

/* ────────────────────────────────────────────────────────────────────────────
   Resolution
   ──────────────────────────────────────────────────────────────────────────── */

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** True once the revisions table exists — false on a database mid-migration. */
function revisionsTableExists(db) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legal_document_revisions'"
  ).get();
}

/**
 * The newest revision for one slug, or null.
 *
 * `ORDER BY id DESC` rather than by version, because SQLite compares version
 * strings lexicographically and would rank '1.9.0' above '1.10.0'. Insertion
 * order is correct here by construction: `publishRevision` refuses any version
 * that is not strictly greater than every version already recorded, so the
 * highest id is always the highest version.
 *
 * `withBody` is false on the list path. Ten documents' worth of Markdown to
 * render a hub page that shows only titles and versions is a cost with no
 * reader on the other end of it.
 */
export function currentRevision(db, slug, { withBody = true } = {}) {
  if (!revisionsTableExists(db)) return null;
  const columns = withBody
    ? 'id, slug, version, body, content_hash, effective_at, created_at, created_by'
    : 'id, slug, version, content_hash, effective_at, created_at, created_by';
  return db.prepare(
    `SELECT ${columns} FROM legal_document_revisions WHERE slug = ? ORDER BY id DESC LIMIT 1`
  ).get(slug) || null;
}

/**
 * Registry metadata merged with whatever supersedes it.
 *
 * The registry keeps everything that is NOT content — the slug set, title,
 * summary, scope, consentType, bundling — and the editor cannot touch any of it.
 * That boundary is load-bearing: `SIGNUP_DOCUMENTS`, `ORGANIZER_DOCUMENTS` and
 * `CONSENT_CONTROLS` are computed once at module load from those fields, so a
 * document whose `scope` could change at runtime would silently stop appearing
 * in the signup consent block. Version, effective date, body and hash are the
 * only things a revision moves, and none of them are read at module load.
 *
 * `body` is omitted unless asked for; `contentHash` is always present because
 * it is what an acceptance record points at.
 */
/**
 * The merge, in one place, because there are two ways to ask for it.
 *
 * `resolveDocument` reads one row; `effectiveDocuments` reads them all in a
 * single query. Only the FETCH differs — what a resolved document looks like
 * must not. This was written out twice, and two copies of "which fields a
 * revision overrides" is exactly the shape that drifts: somebody adds a field to
 * one branch, every caller of the other keeps reading a registry value, and
 * nothing fails until an acceptance record names a version nobody was shown.
 *
 * `withBody` is false on the list path — ten documents' worth of Markdown to
 * render a page that shows only titles and versions is cost with no reader on
 * the other end of it.
 */
function mergeRevision(doc, revision, { withBody = false } = {}) {
  if (revision) {
    return {
      ...doc,
      version: revision.version,
      effectiveAt: revision.effective_at,
      contentHash: revision.content_hash,
      revisionId: revision.id,
      updatedAt: revision.created_at,
      source: 'revision',
      ...(withBody ? { body: revision.body } : {}),
    };
  }

  return {
    ...doc,
    revisionId: null,
    updatedAt: null,
    source: 'file',
    /* `publishedHash`, never the pinned `doc.contentHash`. The two differ while
       LEGAL_HASHES_ENFORCED is false, and that function's own header gives the
       reason this module must respect: a stored hash copied from a stale
       constant is a record claiming somebody agreed to bytes they never saw. */
    contentHash: publishedHash(doc),
    ...(withBody ? { body: policyContent(doc.slug) } : {}),
  };
}

export function resolveDocument(db, slugOrDoc, { withBody = false } = {}) {
  const doc = typeof slugOrDoc === 'string' ? documentBySlug(slugOrDoc) : slugOrDoc;
  if (!doc) return null;
  return mergeRevision(doc, currentRevision(db, doc.slug, { withBody }), { withBody });
}

/**
 * Every document, resolved. Used by the Legal Center list and by consent.
 *
 * One query for all revisions rather than one per document: the list endpoint is
 * unauthenticated and rate-limited at 120/min, so ten round trips per request is
 * ten times the database work for a page that has not changed.
 */
export function effectiveDocuments(db) {
  const latest = new Map();

  if (revisionsTableExists(db)) {
    const rows = db.prepare(`
      SELECT r.slug, r.version, r.content_hash, r.effective_at, r.created_at, r.id
      FROM legal_document_revisions r
      JOIN (SELECT slug, MAX(id) AS id FROM legal_document_revisions GROUP BY slug) newest
        ON newest.slug = r.slug AND newest.id = r.id
    `).all();
    for (const row of rows) latest.set(row.slug, row);
  }

  /* Same merge as the single-document path, so the two cannot describe a
     resolved document differently. */
  return LEGAL_DOCUMENTS.map(doc => mergeRevision(doc, latest.get(doc.slug)));
}

/* ────────────────────────────────────────────────────────────────────────────
   Content validation
   ──────────────────────────────────────────────────────────────────────────── */

/* The link-scheme allowlist lives in the parser module, imported above, so the
   rule that decides what the RENDERER will follow is the same object as the rule
   that decides what a save may contain. Two copies would drift, and the copy
   that drifted looser would be the one deciding what runs in a reader's browser. */

/** Every link span in a parsed document, flattened out of bold runs. */
function collectLinks(blocks) {
  const links = [];
  const walk = (spans) => {
    for (const span of spans || []) {
      if (span.type === 'link') links.push(span);
      if (span.spans) walk(span.spans);
    }
  };
  for (const block of blocks) {
    if (block.spans) walk(block.spans);
    if (block.items) block.items.forEach(walk);
    if (block.header) block.header.forEach(walk);
    if (block.rows) block.rows.forEach(row => row.forEach(walk));
  }
  return links;
}

/**
 * Rejects a body the renderer would mangle or a reader could be harmed by.
 *
 * Runs at write time because the equivalent checks over the on-disk corpus live
 * in `server/legalContent.test.js`, and a test cannot see text that arrives at
 * runtime. Without this, an owner could publish a link to a document that does
 * not exist and the guard that has already caught two live defects would simply
 * stop applying to the half of the corpus that can change.
 *
 * Deliberately NOT a spell-check or a style guide. It refuses three things: a
 * link that could execute, a link that goes nowhere, and a document with no
 * content. Everything else is the owner's editorial judgement, and a legal
 * editor that argues with the lawyer is a legal editor nobody uses.
 */
export function validateBody(raw, { slug } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new LegalValidationError('This document cannot be published empty.', 'body');
  }
  if (raw.length > MAX_BODY_LENGTH) {
    throw new LegalValidationError(
      `This document is ${raw.length.toLocaleString()} characters, over the `
      + `${MAX_BODY_LENGTH.toLocaleString()} limit.`,
      'body'
    );
  }

  const body = raw.replace(/\r\n/g, '\n').trim();

  /**
   * The `## Draft` marker separates a file's internal drafting brief from its
   * published half, and only the published half is stored here. A body
   * containing the marker means somebody pasted a whole file in, which would
   * publish the specification notes to every reader.
   */
  if (/^##\s+Draft\s*$/m.test(body)) {
    throw new LegalValidationError(
      'This looks like a whole policy file rather than its published text — it still '
      + 'contains the "## Draft" marker. Paste only the part below that marker.',
      'body'
    );
  }

  const blocks = parsePolicyMarkdown(body);
  if (blocks.length === 0) {
    throw new LegalValidationError('This document cannot be published empty.', 'body');
  }

  const headingIds = new Set(blocks.filter(b => b.type === 'heading').map(b => b.id));
  const knownSlugs = new Set(LEGAL_DOCUMENTS.map(d => d.slug));
  const problems = [];

  for (const link of collectLinks(blocks)) {
    const href = String(link.href || '');

    if (!isSafeHref(href)) {
      problems.push(
        `“${link.text}” links to "${href}", which is not an allowed kind of link. `
        + 'Use https://, mailto:, a path beginning with /, or a #section anchor.'
      );
      continue;
    }

    if (href.endsWith('.md')) {
      problems.push(`“${link.text}” links to a file (${href}). Link to /legal/<slug> instead.`);
      continue;
    }

    // A fragment with no matching heading scrolls nowhere, which is worse than a
    // missing link because it looks like it worked.
    if (href.startsWith('#') && !headingIds.has(href.slice(1))) {
      problems.push(`“${link.text}” points at "${href}", but this document has no such heading.`);
      continue;
    }

    if (href.startsWith('/legal/')) {
      const target = href.slice('/legal/'.length).split('#')[0];
      if (target && !knownSlugs.has(target)) {
        problems.push(`“${link.text}” points at /legal/${target}, which is not a document here.`);
      }
    }
  }

  if (problems.length > 0) {
    throw new LegalValidationError(
      `${problems.length === 1 ? 'A link needs' : `${problems.length} links need`} fixing before `
      + `this can be published:\n${problems.map(p => `• ${p}`).join('\n')}`,
      'body'
    );
  }

  return { body, blocks, slug };
}

/**
 * How far ahead a revision may be dated. One year.
 *
 * ── Why a bound exists, and why this one ──
 *
 * Under this product's model, publication is IMMEDIATE and `effective_at` is
 * the legal date printed on the document (see `EFFECTIVE_DATE_MODEL` below). A
 * date is therefore a claim rather than a schedule, and an unbounded claim is
 * how `9999-12-31` gets typed into a legal record nobody can edit afterwards.
 *
 * The bound is set from how these are actually published:
 *
 *   - The overwhelmingly common date is TODAY — a correction, effective at once.
 *   - The legitimate future case is a NOTICE PERIOD: a substantive change to the
 *     Terms published now, effective in a few weeks so readers get warning.
 *     Common practice is two to six weeks; nobody uses more than a quarter.
 *   - The outer legitimate case is a date fixed by something external — a school
 *     year, a regulation's commencement. Those are at most about twelve months.
 *
 * So one year clears every real case with room to spare, while still catching
 * the error these fields actually attract: a mistyped leading digit. `2062`,
 * `9026`, `2126` are all refused; nothing anybody meant to type is.
 *
 * A shorter bound (ninety days) would start refusing a genuine school-year
 * alignment. A longer one (five years) stops catching the transposed digit,
 * which is the entire purpose.
 */
const MAX_EFFECTIVE_DAYS_AHEAD = 365;

/**
 * ── The effective-date model, in one place ──
 *
 * Publishing makes a revision the current public text IMMEDIATELY. Resolution
 * is by insertion order (`currentRevision`), never by date — a future-dated
 * revision is served the moment it is saved, and the date changes only the line
 * printed on the document. That is deliberate: making the reader wait for a
 * date would turn publication into a scheduler, with a queue, a clock, and a
 * window in which the catalogue and the text disagree.
 *
 * `effective_at` is therefore a RECORDED LEGAL FACT, not an instruction to the
 * software. What that leaves it owing is coherence, which is what the three
 * rules below enforce:
 *
 *   1. it is a real calendar date;
 *   2. it does not precede the day it was published — a document cannot have
 *      taken effect before it existed;
 *   3. it does not precede the effective date of the version it replaces, so
 *      the printed dates read as a timeline rather than as a shuffle.
 *
 * Rule 3 allows EQUALITY on purpose. Two corrections sharing one effective date
 * is ordinary — a typo fixed twice in an afternoon — and a strict `>` would
 * refuse the second one for no reason a reader would recognise.
 */

/** Today, as `YYYY-MM-DD`, from a clock the caller may pin. */
function dayOf(instant) {
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD`, matching `effectiveAt` throughout the registry.
 *
 * Exported so it can be tested directly. Every date test before this was an
 * HTTP round trip through the adversarial suite, which is a slow way to assert
 * a calendar rule and an easy way to leave the boundary cases untested.
 *
 * ── Comparisons are on DATE STRINGS, in JavaScript, never in SQL ──
 *
 * `effective_at` is ten characters; `created_at` and `published_at` are
 * twenty-four-character ISO timestamps. A lexicographic comparison between the
 * two is wrong in one specific and costly direction — `'2026-09-01'` sorts
 * BELOW `'2026-09-01T09:00:00.000Z'`, because the date is a strict prefix of
 * the timestamp — so a naive `effective_at >= created_at` would refuse every
 * SAME-DAY publication, which is the normal case. Both sides are reduced to a
 * day before anything is compared. `server/datetimeComparison.test.js` exists
 * for the same class of mistake one column over.
 *
 * @param {string} raw the submitted date
 * @param {object} [opts]
 * @param {Date|string|number} [opts.now] the publication instant, pinnable by tests
 * @param {string|null} [opts.previousEffectiveAt] the date of the version being replaced
 */
export function parseEffectiveAt(raw, { now = new Date(), previousEffectiveAt = null } = {}) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    throw new LegalValidationError('Choose a date this version takes effect.', 'effectiveAt');
  }
  const value = raw.trim();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new LegalValidationError('That is not a real date.', 'effectiveAt');
  }

  const today = dayOf(now);

  /**
   * Rule 2, with one day of slack, and the slack is not politeness.
   *
   * The server computes "today" in UTC; the browser computes the date it
   * prefills and the `min` it puts on the picker from the OWNER's local
   * calendar. Those are different days for part of every day. In America/New_York
   * the UTC date rolls over at 20:00 local, so for four hours each evening — five
   * in winter — the editor would offer a default of "today", mark the field with
   * `min="today"`, and then be refused by a server that had already moved on.
   * The owner would have to type tomorrow's date to publish tonight, on a field
   * whose whole purpose is to record what the document says.
   *
   * Making the server read local time is not the fix: `effective_at` is a
   * calendar date with no zone, and `legalDates.js` documents at length why
   * treating it as an instant prints the wrong day west of Greenwich.
   *
   * So the floor is yesterday-in-UTC. No inhabited offset is more than fourteen
   * hours from UTC, so one day of slack accepts every owner's genuine "today"
   * wherever they are, while still refusing a date that is actually in the past —
   * which is what this rule is for. Backdating a legal document by one day is
   * not the abuse anybody was worried about; `1970-01-01` was.
   */
  const earliest = dayOf(new Date(new Date(today).getTime() - 86400000));
  if (value < earliest) {
    throw new LegalValidationError(
      'A version cannot take effect before it is published. '
      + `The earliest date you can choose is ${earliest}.`,
      'effectiveAt'
    );
  }

  /* Rule 1's other half: a date so far out it is a typo rather than a plan. */
  const latest = dayOf(new Date(new Date(today).getTime() + MAX_EFFECTIVE_DAYS_AHEAD * 86400000));
  if (value > latest) {
    throw new LegalValidationError(
      'A version cannot take effect more than a year after it is published '
      + `(the latest is ${latest}). If that really is the date, publish it closer to the time.`,
      'effectiveAt'
    );
  }

  /**
   * Rule 3. Equality allowed — see the model note above.
   *
   * ── And it never argues with rule 1 ──
   *
   * The two bounds are `value >= previousEffectiveAt` and `value <= latest`. If
   * a revision published before this validation existed carries a date beyond
   * `latest` — `9999-12-31` was accepted right up until this commit — those two
   * have no common solution, and because `legal_document_revisions` is
   * append-only there would be no way to correct it: the document could never
   * be revised again, by anybody, ever.
   *
   * So a previous date that is itself out of range is ignored rather than
   * enforced. The floor is only a floor while it is a reachable one.
   */
  if (previousEffectiveAt && previousEffectiveAt <= latest && value < previousEffectiveAt) {
    throw new LegalValidationError(
      `The version this replaces takes effect on ${previousEffectiveAt}, so this one `
      + 'cannot be dated earlier. Effective dates only move forward.',
      'effectiveAt'
    );
  }

  return value;
}

/* ────────────────────────────────────────────────────────────────────────────
   Publishing
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The highest version this slug has ever carried, across all three records of it.
 *
 * All three are consulted rather than just the newest revision, and each one
 * closes a real gap:
 *
 *   - the revisions table, so two saves cannot both claim 1.1.0;
 *   - the registry, so the first save cannot land *below* the version the files
 *     ship at — with an empty revisions table there is nothing else to compare
 *     against, and 0.0.1 would otherwise be accepted over a published 1.0;
 *   - `legal_documents`, because that table's primary key is `(slug, version)`
 *     and `syncLegalDocuments` throws at boot if a published version's hash
 *     moves. Reusing a version that table already holds is not a validation
 *     nicety — it is a server that will not start.
 */
function highestVersion(db, slug) {
  const candidates = [];

  const registered = documentBySlug(slug);
  if (registered) candidates.push(registered.version);

  if (revisionsTableExists(db)) {
    for (const row of db.prepare(
      'SELECT version FROM legal_document_revisions WHERE slug = ?'
    ).all(slug)) candidates.push(row.version);
  }

  const hasCatalogue = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legal_documents'"
  ).get();
  if (hasCatalogue) {
    for (const row of db.prepare(
      'SELECT version FROM legal_documents WHERE slug = ?'
    ).all(slug)) candidates.push(row.version);
  }

  return candidates
    .filter(v => parseVersion(v))
    .sort((a, b) => compareVersions(a, b))
    .pop() || null;
}

/**
 * Validates and inserts one revision. **Call inside the caller's transaction.**
 *
 * That is not a style preference. The version check reads the highest existing
 * version and the insert writes one above it, and between those two statements a
 * second save must not be able to land — outside a transaction, two concurrent
 * publishes both read 1.0 and both write 1.1.0, and the `UNIQUE(slug, version)`
 * constraint turns the loser into a 500 after its step-up grant has already been
 * spent. Inside one, the loser is refused before it costs anything.
 *
 * The caller also spends the re-authentication grant in the same transaction, so
 * the publication and the proof of identity commit or roll back together.
 */
export function publishRevision(db, { slug, version, body, effectiveAt, userId, now = null }) {
  /**
   * The publication instant is decided BEFORE validation, not after.
   *
   * `parseEffectiveAt` refuses a date earlier than the day of publication, so
   * it has to be given the same instant that lands in `created_at` — otherwise
   * the row could record a publication timestamp the validator never saw, and a
   * save crossing midnight would be checked against yesterday and stored under
   * today.
   */
  const at = now ?? new Date().toISOString();

  const { version: nextVersion, body: cleanBody, effectiveAt: effective } =
    validatePublication(db, { slug, version, body, effectiveAt }, { now: at });

  /* Non-null: `validatePublication` refuses an unregistered slug above. */
  const doc = documentBySlug(slug);
  const contentHash = sha256(cleanBody);

  db.prepare(`
    INSERT INTO legal_document_revisions
      (slug, version, body, content_hash, effective_at, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slug, nextVersion, cleanBody, contentHash, effective, at, userId ?? null);

  /**
   * The catalogue is written here, not left to the next boot.
   *
   * `syncLegalDocuments` publishes the CURRENT version of each document, so a
   * server that restarts after two revisions records only the second — and the
   * first, which people were reading and accepting in the meantime, never
   * appears in `legal_documents` at all. An acceptance row naming a version the
   * catalogue has never heard of is precisely the gap that table exists to
   * close.
   *
   * Writing it at publication time also means the catalogue is correct
   * immediately rather than eventually. Sync at the next boot then finds this
   * row already present with a matching hash and does nothing, which is the
   * quiet no-op that branch is written for.
   *
   * `INSERT OR IGNORE` rather than a plain insert: the row is keyed
   * `(slug, version)` and published rows are immutable, so if one somehow
   * already exists it must not be rewritten from here. The version rules above
   * make that unreachable; the clause is what keeps it unreachable rather than
   * merely unlikely.
   */
  const catalogued = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legal_documents'"
  ).get();
  if (catalogued) {
    db.prepare(`
      INSERT OR IGNORE INTO legal_documents
        (slug, version, title, consent_type, content_hash, effective_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(slug, nextVersion, doc.title, doc.consentType, contentHash, effective, at);
  }

  return { slug, version: nextVersion, contentHash, effectiveAt: effective, createdAt: at };
}

/**
 * Everything that can refuse a publication, and nothing that writes.
 *
 * Separated from the insert so a caller can answer refusals BEFORE spending a
 * step-up grant — a request that delivers nothing must not cost a verification
 * the owner then has to repeat. `legalAdminRoutes.js` calls this once outside its
 * transaction for that purpose, and `publishRevision` calls it again inside,
 * where the version comparison has to be atomic with the insert.
 *
 * Running it twice is deliberate and cheap: it is pure apart from two indexed
 * reads, and the alternative — a separate `canPublish` that is supposed to agree
 * with the real thing — is the shape that eventually disagrees with it.
 *
 * Returns the normalised values, so the caller writes exactly what was checked
 * rather than re-deriving them from the request.
 */
export function validatePublication(db, { slug, version, body, effectiveAt }, { now = new Date() } = {}) {
  const doc = documentBySlug(slug);
  if (!doc) throw new LegalValidationError(`No such legal document: ${slug}`, 'slug');

  const nextVersion = parseNewVersion(version);

  /**
   * The date this revision replaces, so the printed dates read as a timeline.
   *
   * The current revision when there is one, and otherwise the registry's own
   * `effectiveAt` — which is the date the reader is being shown right now, and
   * therefore the one a new revision must not silently predate. Read from the
   * same place `highestVersion` reads versions, and inside the same function,
   * so the two move together and the check is atomic with the insert when
   * `publishRevision` calls this a second time.
   */
  const previous = currentRevision(db, slug, { withBody: false });
  const previousEffectiveAt = previous?.effective_at ?? doc.effectiveAt ?? null;

  const effective = parseEffectiveAt(effectiveAt, { now, previousEffectiveAt });
  const { body: cleanBody } = validateBody(body, { slug });

  const highest = highestVersion(db, slug);
  if (highest && compareVersions(nextVersion, highest) <= 0) {
    throw new LegalValidationError(
      compareVersions(nextVersion, highest) === 0
        ? `Version ${nextVersion} has already been published for this document. `
          + 'Every revision needs its own number, so that an acceptance record and the '
          + 'text it points at can never disagree — try '
          + `${suggestNext(highest)}.`
        : `Version ${nextVersion} is lower than ${highest}, which is already published. `
          + `Version numbers only move forward — try ${suggestNext(highest)}.`,
      'version'
    );
  }

  /**
   * Refused rather than silently accepted as a no-op.
   *
   * Publishing identical text under a new version tells every reader the
   * document changed and makes them re-read it to find out that it did not. It
   * is also the shape of an accidental double-submit.
   */
  const current = currentRevision(db, slug, { withBody: true });
  const existingBody = current ? current.body : policyContent(slug);
  if (existingBody.replace(/\r\n/g, '\n').trim() === cleanBody) {
    throw new LegalValidationError(
      'This is identical to the version already published, so there is nothing to save.',
      'body'
    );
  }

  return { slug, version: nextVersion, body: cleanBody, effectiveAt: effective };
}

/** The next patch version, offered in the error rather than left as an exercise. */
function suggestNext(version) {
  const parsed = parseVersion(version);
  if (!parsed) return '1.0.1';
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** Every revision of one document, newest first. Bodies omitted. */
export function revisionHistory(db, slug) {
  if (!revisionsTableExists(db)) return [];
  return db.prepare(`
    SELECT r.id, r.version, r.content_hash, r.effective_at, r.created_at, r.created_by,
           u.name AS author_name
    FROM legal_document_revisions r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.slug = ?
    ORDER BY r.id DESC
  `).all(slug).map(row => ({
    id: row.id,
    version: row.version,
    contentHash: row.content_hash,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
    /* Falls back rather than showing an empty byline: `created_by` is
       ON DELETE SET NULL, so a published revision outlives its author's
       account. The document is still attributable to a moment; it stops being
       attributable to a person, and saying so is more honest than a blank. */
    author: row.author_name || 'Account no longer on the platform',
  }));
}
