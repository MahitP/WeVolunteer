import express from 'express';
import rateLimit from 'express-rate-limit';
import { DEMO_MODE, PLATFORM_OWNER_USERNAME } from '../config.js';
import { documentBySlug } from '../legalDocuments.js';
import { PolicyContentError } from '../legalContent.js';
import { db } from '../db.js';
import { effectiveDocuments, resolveDocument } from '../legalStore.js';
import { authenticateToken } from '../utils.js';
import { pendingNoticesFor, acknowledgeNotice } from '../legalNotices.js';

/**
 * Publishes the legal documents the product asks people to rely on.
 *
 * ── Why these routes are unauthenticated ──
 *
 * The signup form asks a fourteen-year-old to agree to the Terms. They have no
 * account at that moment — having one is what they are deciding about — so a
 * session-gated Terms page is a link that cannot be followed by the only person
 * who needs to follow it. That is not a UX wrinkle: "read the Terms" pointing at
 * something unreadable is a misrepresentation about the availability of the
 * terms, which is the same defect as pointing at a 404.
 *
 * The documents are published policy. There is nothing to protect.
 *
 * ── Why the content is not simply a static file mount ──
 *
 * `dist/` is already served statically and dropping the Markdown in there would
 * be less code. It would also serve whatever bytes are on disk, and the one
 * property that matters here is that a user never reads policy text that differs
 * from the text their acceptance record's hash points at. `legalContent.js`
 * enforces that on every read and throws instead of serving on a mismatch; a
 * static mount cannot.
 *
 * ── Markdown, rendered by the client ──
 *
 * These endpoints return the Markdown source and the client renders it. The
 * alternative — rendering to HTML here — means the server emits markup that a
 * privileged page injects, and the moment that is the shape, someone eventually
 * reaches for `dangerouslySetInnerHTML`. Shipping the source keeps the rendering
 * decision (and the escaping) on the side that owns the DOM.
 */

const router = express.Router();

/**
 * Generous, because being throttled out of reading the Terms is a bad outcome
 * and the payload is a few kilobytes of static text from an in-process cache.
 * Present at all because the endpoint is unauthenticated and therefore is a
 * free-to-call surface, which is the only reason it needs a ceiling.
 */
const legalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DEMO_MODE ? 600 : 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      code: 'rate_limited',
    });
  },
});

router.use('/api/legal', legalLimiter);

/**
 * The public shape of a resolved document. Never leaks `file`.
 *
 * Takes a document already resolved by `legalStore` rather than a raw registry
 * entry, so `version`, `effectiveAt` and `contentHash` describe whatever is
 * actually being served — the newest published revision, or the file when no
 * revision exists. Reading those three off the registry here is precisely the
 * drift `legalStore`'s header warns about: the page would print version 1.0
 * above the text of 1.1.0.
 *
 * `updatedAt` is new and nullable. It is the moment a revision was published,
 * which `effectiveAt` deliberately is not — a correction can be published on
 * Tuesday and take effect the following Monday, and a reader is entitled to see
 * which is which. Null means the document has never been edited through the
 * editor, so the only honest answer is its effective date.
 */
function publicMeta(doc) {
  return {
    slug: doc.slug,
    title: doc.title,
    version: doc.version,
    consentType: doc.consentType,
    scope: doc.scope,
    summary: doc.summary,
    effectiveAt: doc.effectiveAt,
    /**
     * What was actually published, not the pinned constant.
     *
     * `LegalDocument.jsx` renders the first 16 characters of this as a "Content
     * fingerprint" beside the text. Before launch the pinned constant is allowed
     * to lag the file (see LEGAL_HASHES_ENFORCED), so reporting it here would
     * print a fingerprint that does not describe the words underneath it — a
     * worse failure than no fingerprint, because it looks like verification.
     *
     * `resolveDocument` and `effectiveDocuments` both supply this already
     * resolved — the revision's hash, or `publishedHash(doc)` for a file.
     */
    contentHash: doc.contentHash,
    updatedAt: doc.updatedAt ?? null,
    bundledWith: doc.bundledWith,
  };
}

/**
 * The catalogue.
 *
 * Derived from the registry rather than a hand-maintained list, so registering a
 * document publishes it — the same reason `requiredConsentKeys()` is derived and
 * the signed-out route test reads `PUBLIC_ROUTES`.
 */
router.get('/api/legal/documents', async (req, res) => {
  res.json({ documents: (await effectiveDocuments(db)).map(publicMeta) });
});

/**
 * Who runs this platform.
 *
 * ── Why it is public, and why it is here ──
 *
 * Every legal document on this surface says things like "we", "the platform"
 * and "the account that can change it", and until now nothing anywhere named
 * that account. A parent deciding whether their child should sign up, or a
 * student who wants to complain to somebody real, had no way to find out who
 * that is without already having an account — which is precisely backwards.
 * It sits beside the documents because it answers the same question they raise.
 *
 * ── Resolved by ROLE, never by name ──
 *
 * `super_admin` is the definition. Nothing here matches a username, an email or
 * a display name, so an account that changes hands, or a second owner, needs no
 * edit anywhere — the same rule `distinctionFor` follows in the profile
 * serializer, for the same reason.
 *
 * Earliest-created wins when there is more than one, because a deployment can
 * legitimately hold several: it is stable across restarts, needs no new column,
 * and picks the founding account rather than whoever was promoted most recently.
 *
 * ── What is disclosed ──
 *
 * A name, a handle and an avatar: exactly what any signed-in member already sees
 * on the profile, and less than the transcript footer, which prints the
 * founder's full name on every document the platform issues. No email, no
 * hours, no history, no id — this answers "who is responsible", not "tell me
 * about this person". An empty answer is a normal 200, because a deployment
 * with no owner yet is a state the page renders around rather than an error.
 */
router.get('/api/platform/owner', async (req, res) => {
  /**
   * The role is the authority; the configured username only chooses between
   * accounts that already hold it. A `PLATFORM_OWNER_USERNAME` naming a student
   * resolves to nothing — configuration cannot mint an owner, only point at one.
   *
   * ── Why a configured name does NOT fall back ──
   *
   * The fallback used to run whenever the lookup missed, including when the
   * variable was set and simply did not match. That is the wrong direction on
   * the one deployment that matters: this installation holds two owner
   * accounts, a person and an internal service account, created in the same
   * seeding run with identical timestamps. A typo in the variable would
   * therefore have been answered by naming whichever id happened to sort first
   * — quite possibly the service account — on a public page, with nothing
   * anywhere reporting a problem.
   *
   * So the two cases are separated. Configured means configured: if it does not
   * resolve, the answer is nobody, and the page renders without an owner rather
   * than with the wrong one. The fallback survives only for a deployment that
   * has not set the variable at all, where naming the earliest owner beats
   * naming none.
   */
  const byRole = `FROM users WHERE role = 'super_admin' AND account_status = 'active'`;
  const columns = 'SELECT name, username, avatar, avatar_color, profile_picture_url';

  const owner = PLATFORM_OWNER_USERNAME
    ? await db.prepare(`${columns} ${byRole} AND LOWER(username) = LOWER(?)`).get(PLATFORM_OWNER_USERNAME)
    : await db.prepare(`${columns} ${byRole} ORDER BY created_at ASC, id ASC LIMIT 1`).get();

  if (PLATFORM_OWNER_USERNAME && !owner) {
    /* Loud, because the symptom is silence: a public page that simply stops
       naming anybody. The username is operator-supplied configuration, not user
       input, so echoing it is what makes the message actionable. */
    console.warn(
      `[platform] PLATFORM_OWNER_USERNAME="${PLATFORM_OWNER_USERNAME}" matches no active `
      + 'super_admin account. The public About page will not name an owner.'
    );
  }

  res.json({
    owner: owner ? {
      name: owner.name,
      username: owner.username,
      avatar: owner.avatar,
      avatarColor: owner.avatar_color,
      profilePictureUrl: owner.profile_picture_url,
    } : null,
  });
});

/**
 * One document, with its text.
 *
 * A `PolicyContentError` is a 500 and not a 404: the document IS registered, so
 * the deployment is broken rather than the request. Answering 404 would tell a
 * user "no such policy" when the truth is "this server cannot show you the
 * policy it is holding you to", and those want opposite responses.
 *
 * A document served from a revision cannot raise that error at all — the text is
 * a column, and there is no file to be missing or to have drifted. The try/catch
 * still wraps the call because the fallback path is unchanged and is what every
 * document uses until somebody edits it.
 */
router.get('/api/legal/documents/:slug', async (req, res) => {
  if (!documentBySlug(req.params.slug)) {
    return res.status(404).json({ error: 'No such legal document.' });
  }

  let resolved;
  try {
    resolved = await resolveDocument(db, req.params.slug, { withBody: true });
  } catch (err) {
    if (err instanceof PolicyContentError) {
      console.error(`[legal] ${err.message}`);
      return res.status(500).json({
        error: 'This document is temporarily unavailable. Please contact support.',
        code: 'policy_unavailable',
      });
    }
    throw err;
  }

  res.json({ ...publicMeta(resolved), markdown: resolved.body });
});

/**
 * Legal documents this account has not been shown the change to.
 *
 * ── Why this is authenticated when the rest of this file is not ──
 *
 * The documents themselves are public because a fourteen-year-old has to read
 * the Terms before they have an account. "Which changes has THIS person not
 * seen" is the opposite: it is a fact about one account and is answerable only
 * for the caller.
 *
 * ── Why no capability gate ──
 *
 * There is no capability that means "read your own legal notices", and the two
 * that every role happens to hold are `event.view` and `persona.preview.exit`
 * — gating on either would be a lie about what is being checked, and the next
 * person to read it would have to work out that it meant nothing. The route is
 * scoped to `req.user.id` and is declared SELF_ONLY in the completeness
 * registry, which is the mechanism this codebase provides for exactly this.
 */
router.get('/api/legal/updates', authenticateToken, async (req, res) => {
  try {
    res.json({ updates: await pendingNoticesFor(db, req.user.id) });
  } catch (err) {
    console.error('Legal updates error:', err.message);
    /* An empty list rather than a 500. A failure to compute the excerpt must
       not be able to block the application shell, which fetches this on load. */
    res.json({ updates: [] });
  }
});

/**
 * Records that this account has read a change notice.
 *
 * Acknowledgement is NOT consent and is deliberately stored in a different
 * table from `legal_acceptances` — see the migration. Dismissing a modal must
 * never become evidence that somebody agreed to anything.
 *
 * Idempotent: the upsert keeps the first acknowledgement, so a double-click, a
 * retry and a second tab all converge on one row.
 */
router.post('/api/legal/updates/acknowledge', authenticateToken, async (req, res) => {
  const { slug, version } = req.body ?? {};
  if (typeof slug !== 'string' || typeof version !== 'string' || !slug || !version) {
    return res.status(400).json({ error: 'slug and version are required.', code: 'slug_required' });
  }
  if (!documentBySlug(slug)) {
    return res.status(404).json({ error: 'No such legal document.' });
  }

  await acknowledgeNotice(db, req.user.id, slug, version);
  res.json({ ok: true });
});

export default router;
