import { effectiveDocuments, currentRevision } from './legalStore.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { documentBySlug, publishedBody, POLICY_DIR } from './legalDocuments.js';
import { buildExcerpt } from './legalExcerpt.js';

/**
 * Telling people that a legal document changed.
 *
 * ── Why this exists ──
 *
 * The published Terms say, in the product's own words: "If a change matters, we
 * will tell you in the app at least 30 days before it takes effect… We will not
 * change them quietly." The Privacy Policy says the same. Until now nothing
 * implemented it for anyone except organizers, who are re-gated on the
 * Organizer Agreement as a side effect of how their capabilities are withheld.
 *
 * So this is not a feature so much as a promise being kept.
 *
 * ── What counts as "changed" ──
 *
 * A document has changed for a user when the version now in effect is not the
 * version they last acknowledged AND not the version they accepted at signup.
 * Version, not content hash: an editorial fix that leaves the hash different but
 * the meaning identical still bumps a version deliberately, and the version is
 * the thing the acceptance record is keyed on.
 *
 * A brand-new user is not "behind" on anything — they get the current version at
 * signup and nothing to acknowledge. This is handled by treating an absent
 * acceptance for a signup-scope document as up to date rather than as a change,
 * because there is nothing they could have been told about.
 *
 * ── Cost ──
 *
 * One query for the effective versions (already batched by `effectiveDocuments`),
 * one for this user's acknowledgements, one for their acceptances. Three
 * queries, no per-document round trip, and the excerpt is only computed for
 * documents that actually differ — which is almost always none, so the common
 * case reads three rows and returns an empty array.
 */

/** Documents a user is asked to agree to or acknowledge when they sign up. */
const SIGNUP_SCOPES = new Set(['signup']);

/**
 * The body of the version immediately before the current one, or null.
 *
 * Two sources by necessity. Documents edited through the Legal Center have every
 * revision in `legal_document_revisions`, bodies included. Documents still at
 * their original 1.0 have no revision row at all — their text lives on disk — so
 * the first edit of any document has to diff against the file. Without that
 * fallback the very first change of every document would produce no excerpt,
 * which is the one time users most need to see what moved.
 */
async function previousBody(db, slug, currentVersion) {
  const rows = await db.prepare(`
    SELECT version, body FROM legal_document_revisions
    WHERE slug = ? ORDER BY id DESC LIMIT 2
  `).all(slug);

  const earlier = rows.find(r => r.version !== currentVersion);
  if (earlier) return earlier.body;

  /* No earlier revision: the previous text is whatever is on disk. */
  return fileBody(slug);
}

/**
 * A document's published text as it sits in the repository.
 *
 * Wrapped in a try because `publishedBody` throws when a file has lost its
 * `## Draft` marker — correct behaviour there, since serving the drafting brief
 * as the terms would be far worse than failing. Here the consequence of a
 * missing file is only a notice without a quote, which the modal already
 * handles, so it degrades rather than taking the whole request down.
 */
function fileBody(slug) {
  const doc = documentBySlug(slug);
  if (!doc?.file) return null;
  try {
    return publishedBody(readFileSync(path.join(POLICY_DIR, doc.file), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Legal documents this user has not been shown the change to.
 *
 * @returns {Array<{slug, title, version, effectiveAt, excerpt, changeCount, isSample}>}
 */
export async function pendingNoticesFor(db, userId) {
  if (!userId) return [];

  const acknowledged = new Map();
  for (const r of await db.prepare(
    'SELECT slug, version FROM legal_change_notices WHERE user_id = ? AND acknowledged_at IS NOT NULL'
  ).all(userId)) {
    acknowledged.set(r.slug, r.version);
  }

  const accepted = new Map();
  for (const r of await db.prepare(
    'SELECT document_slug AS slug, version FROM legal_acceptances WHERE user_id = ?'
  ).all(userId)) {
    accepted.set(r.slug, r.version);
  }

  const pending = [];
  for (const doc of await effectiveDocuments(db)) {
    const seen = acknowledged.get(doc.slug) ?? accepted.get(doc.slug);

    /**
     * Nothing to be behind on.
     *
     * A signup-scope document with no acceptance means the account predates the
     * consent record or the scope changed — either way there is no "previous
     * version they were shown", so announcing a change would be announcing
     * something that never happened to them. Notice-scope documents were never
     * accepted by anybody, so an absent record is normal and the current version
     * is the baseline.
     */
    if (!seen) continue;
    if (seen === doc.version) continue;

    const current = await currentRevision(db, doc.slug, { withBody: true });
    const newBody = current?.body ?? fileBody(doc.slug);

    const excerpt = newBody
      ? buildExcerpt(await previousBody(db, doc.slug, doc.version), newBody)
      : { text: null, changeCount: 0, isSample: false };

    pending.push({
      slug: doc.slug,
      title: doc.title,
      version: doc.version,
      previousVersion: seen,
      effectiveAt: doc.effectiveAt ?? null,
      requiresAgreement: SIGNUP_SCOPES.has(doc.scope) && doc.consentType === 'agree',
      excerpt: excerpt.text,
      changeCount: excerpt.changeCount,
      isSample: excerpt.isSample,
    });
  }

  return pending;
}

/**
 * Records that a user has seen the notice for a version.
 *
 * Upsert on the primary key rather than an INSERT, so a double-click, a retry
 * and a second tab all converge on one row instead of racing to a constraint
 * error the caller has to interpret.
 */
export async function acknowledgeNotice(db, userId, slug, version, { now = new Date() } = {}) {
  await db.prepare(`
    INSERT INTO legal_change_notices (user_id, slug, version, acknowledged_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slug, version)
      DO UPDATE SET acknowledged_at = COALESCE(legal_change_notices.acknowledged_at, excluded.acknowledged_at)
  `).run(userId, slug, version, now.toISOString());
}

/**
 * Marks that a user has been sent a notification about a version.
 *
 * Separate from acknowledgement on purpose: this is what the platform did, that
 * is what the person did, and conflating them would make "we told them" and
 * "they read it" indistinguishable in exactly the record that exists to tell
 * them apart.
 */
export async function recordNotified(db, userId, slug, version, { now = new Date() } = {}) {
  await db.prepare(`
    INSERT INTO legal_change_notices (user_id, slug, version, notified_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, slug, version)
      DO UPDATE SET notified_at = COALESCE(legal_change_notices.notified_at, excluded.notified_at)
  `).run(userId, slug, version, now.toISOString());
}

/** The dedupe key that makes delivery idempotent, in one place. */
export function noticeDedupeKey(slug, version) {
  return `legal:${slug}:${version}`;
}
