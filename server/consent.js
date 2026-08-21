import crypto from 'node:crypto';
import {
  SIGNUP_DOCUMENTS, CONSENT_CONTROLS, documentBySlug, LEGAL_HASHES_ENFORCED,
} from './legalDocuments.js';
/* Version and content are resolved, never read off the registry — see the note
   inside `recordAcceptances`. Neither `LEGAL_DOCUMENTS` nor `publishedHash` is
   imported any more precisely so that a future edit cannot quietly reach past
   the resolver and write a version the reader was not shown. */
import { effectiveDocuments, resolveDocument } from './legalStore.js';

/**
 * Recording and enforcing consent.
 *
 * Kept out of the route files for the same reason `authz.js` is: the rule about
 * what a valid acceptance looks like should have one home, and it should be
 * testable without booting a listener.
 *
 * The load-bearing property of everything below is that `recordAcceptances`
 * runs INSIDE the caller's transaction. An account row that exists without its
 * acceptance rows is an account that never agreed to anything, and it would
 * look completely normal in every functional test — the same failure shape
 * `spendChallenge` exists to prevent for step-up grants, and it is prevented
 * the same way: one transaction, both writes, or neither.
 */

/** Signup is refused unless every control below is affirmatively accepted. */
export class ConsentMissing extends Error {
  constructor(missing) {
    super(`Missing consent: ${missing.join(', ')}`);
    this.name = 'ConsentMissing';
    this.missing = missing;
  }
}

/**
 * Truncates an address to a network prefix: /24 for IPv4, /48 for IPv6.
 *
 * Enough to say "this came from a plausible network at this time", which is all
 * the acceptance record needs. Not enough to be a location trail for a child.
 * Returns null rather than guessing when the value is absent or unparseable —
 * a wrong prefix is worse than no prefix, because it looks like evidence.
 */
export function ipPrefix(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Express may hand back "::ffff:203.0.113.9" for a v4 address on a v6 socket.
  const value = raw.startsWith('::ffff:') ? raw.slice(7) : raw;

  if (value.includes('.') && !value.includes(':')) {
    const octets = value.split('.');
    if (octets.length !== 4 || octets.some(o => o === '' || Number.isNaN(Number(o)))) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  if (value.includes(':')) {
    // Expand only as far as needed: the first three groups are the /48.
    const groups = value.split(':').filter(g => g !== '');
    if (groups.length < 3) return null;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }

  return null;
}

/**
 * Reduces a User-Agent header to a coarse family string.
 *
 * The raw header is a fingerprinting surface and is never stored. "Chrome on
 * Android" carries the evidentiary value — a real browser, consistent with the
 * account's other sessions — at a fraction of the identifiability.
 *
 * Deliberately crude, and ordered so the more specific brands are tested before
 * the strings they embed: every Chromium browser also says "Safari", and Edge
 * also says "Chrome", so a naive order labels everything Safari.
 */
export function uaFamily(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const browser =
    /\bEdgA?\//.test(raw) ? 'Edge'
      : /\bOPR\//.test(raw) ? 'Opera'
        : /\bFirefox\//.test(raw) ? 'Firefox'
          : /\bChrome\//.test(raw) ? 'Chrome'
            : /\bSafari\//.test(raw) ? 'Safari'
              : 'Other';

  const os =
    /\bAndroid\b/.test(raw) ? 'Android'
      : /\b(iPhone|iPad|iPod)\b/.test(raw) ? 'iOS'
        : /\bMac OS X\b/.test(raw) ? 'macOS'
          : /\bWindows\b/.test(raw) ? 'Windows'
            : /\bLinux\b/.test(raw) ? 'Linux'
              : 'Other';

  return `${browser} on ${os}`;
}

/**
 * Validates the consent block of a signup request.
 *
 * Accepts `{ termsOfService: true, privacyPolicy: true }` — one key per
 * CONSENT_CONTROL, camelCased from its slug. Throws `ConsentMissing` naming
 * every control that was absent or not literally `true`, so the client can mark
 * each offending checkbox rather than showing one generic form error.
 *
 * `=== true` and not a truthy check, deliberately. A consent field arriving as
 * the string "false", or as 0, or as an object, is a client bug or a probe; in
 * either case treating it as agreement is the wrong answer, and truthiness
 * would accept "false".
 */
export function assertConsent(body) {
  const provided = body?.consent;
  const missing = [];

  for (const control of CONSENT_CONTROLS) {
    const key = slugToKey(control.key);
    if (provided?.[key] !== true) missing.push(control.key);
  }

  if (missing.length > 0) throw new ConsentMissing(missing);
}

/** 'terms-of-service' -> 'termsOfService' */
export function slugToKey(slug) {
  return slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Writes one acceptance row per document, including bundled ones.
 *
 * MUST be called inside the caller's transaction — see the module header. It
 * takes `db` rather than importing it so a test can pass a throwaway handle and
 * so this module stays importable without opening a database.
 *
 * `method` records HOW the acceptance happened ('signup', 'oauth_signup',
 * 'reconsent', 'organizer_approval', …) because a record that cannot say
 * whether the person clicked a checkbox or an administrator ticked it on their
 * behalf is not much of a record.
 *
 * The default target set is SIGNUP_DOCUMENTS — the documents scoped to
 * registration — and deliberately not "everything that isn't a notice". Those
 * two were the same set until the Organizer Agreement was registered, and it is
 * `consentType: 'agree'`: under the old filter, registering it would have
 * written every new student an acceptance row for undertakings about handling
 * other students' contact details that they were never shown. Callers that mean
 * something other than signup pass `documents` explicitly.
 */
export async function recordAcceptances(db, { userId, method, context = null, req = null, documents = null, now = null }) {
  const at = now ?? new Date().toISOString();
  const targets = documents ?? SIGNUP_DOCUMENTS;

  const prefix = req ? ipPrefix(req.ip || req.socket?.remoteAddress || '') : null;
  const family = req ? uaFamily(req.get?.('user-agent') || req.headers?.['user-agent'] || '') : null;

  const insert = await db.prepare(`
    INSERT INTO legal_acceptances
      (id, user_id, document_slug, version, content_hash, accepted_at, method, context, ip_prefix, ua_family)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /**
   * Resolved, so the row records the version and hash the person was SHOWN.
   *
   * `targets` are registry entries, and since v1.4 the registry is no longer the
   * last word on version or content — a published revision supersedes it. Writing
   * `doc.version` and `publishedHash(doc)` here would record an acceptance of
   * version 1.0 for somebody who read 1.1.0, which is a consent record that is
   * false about what was agreed to. That is the exact failure `legalStore`'s
   * header exists to prevent, and this is the call site it was written for.
   */
  for (const registered of targets) {
    const doc = await resolveDocument(db, registered) ?? registered;
    await insert.run(
      `acc-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      userId,
      doc.slug,
      doc.version,
      doc.contentHash,
      at,
      method,
      context,
      prefix,
      family
    );
  }

  return targets.length;
}

/**
 * Publishes the document catalogue.
 *
 * Idempotent and derived from `legalDocuments.js`, so it runs at init on every
 * boot rather than being frozen into a migration — a document version bump
 * should not require a schema migration.
 *
 * A published (slug, version) row is never rewritten. If the registry's hash
 * for an existing version differs from the stored one, that means a published
 * document was edited without bumping its version, and the acceptance rows
 * pointing at it now describe text nobody agreed to. That is a data-integrity
 * failure, not a merge conflict, so it throws rather than silently updating.
 */
export async function syncLegalDocuments(db, { now = null } = {}) {
  const at = now ?? new Date().toISOString();

  const existing = await db.prepare('SELECT slug, version, content_hash FROM legal_documents').all();
  const bySlugVersion = new Map(existing.map(r => [`${r.slug}@${r.version}`, r]));

  const insert = await db.prepare(`
    INSERT INTO legal_documents
      (slug, version, title, consent_type, content_hash, effective_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  /**
   * Resolved, so a revision published through the editor enters the catalogue.
   *
   * This loop is what makes an owner's save durable across a restart: the new
   * `(slug, version)` lands as its own immutable row and the previous one stays
   * exactly as it was, which is the version history the editor promises.
   *
   * It is also why the write path refuses any version that is not strictly
   * greater than every version already recorded here. Publishing over an
   * existing version would reach the mismatch branch below — a silent hash
   * rewrite today, and a server that refuses to boot the day
   * LEGAL_HASHES_ENFORCED is turned on at launch.
   */
  for (const doc of await effectiveDocuments(db)) {
    const key = `${doc.slug}@${doc.version}`;
    const row = bySlugVersion.get(key);

    const hash = doc.contentHash;

    if (!row) {
      await insert.run(doc.slug, doc.version, doc.title, doc.consentType, hash, at, at);
      continue;
    }

    if (row.content_hash !== hash) {
      if (LEGAL_HASHES_ENFORCED) {
        throw new Error(
          `legal_documents: ${key} is already published with a different content hash. `
          + 'A published version is immutable — its hash is what the acceptance records point at, '
          + 'so changing it retroactively rewrites what users are recorded as having agreed to. '
          + 'Bump the version in server/legalDocuments.js instead.'
        );
      }

      /**
       * Advisory before launch — see LEGAL_HASHES_ENFORCED in legalDocuments.js.
       *
       * The row is UPDATED rather than left alone. Leaving it would make
       * `legal_documents` describe text that no longer exists, and every
       * acceptance recorded from here on would copy that stale hash — so the
       * table would drift further from the files with each signup, and flipping
       * enforcement back on at launch would then fail against a database nobody
       * could reconcile. Moving it forward keeps one answer to "what is
       * published right now", which is the only claim this table can honestly
       * make while the text is allowed to change.
       */
      await db.prepare(
        'UPDATE legal_documents SET content_hash = ?, published_at = ? WHERE slug = ? AND version = ?'
      ).run(hash, at, doc.slug, doc.version);

      console.warn(
        `[legal] ${key} text changed; updated its recorded hash (pre-launch; hashes advisory).`
      );
    }
  }
}

/**
 * Every document this user has accepted, most recent first.
 *
 * Powers the "Your agreements" view, and is the fastest honest answer to a
 * subject-access request about consent.
 */
export async function acceptancesFor(db, userId) {
  return (await db.prepare(`
    SELECT document_slug, version, content_hash, accepted_at, method
    FROM legal_acceptances
    WHERE user_id = ?
    ORDER BY accepted_at DESC
  `).all(userId)).map(r => ({
    slug: r.document_slug,
    version: r.version,
    title: documentBySlug(r.document_slug)?.title ?? r.document_slug,
    acceptedAt: r.accepted_at,
    method: r.method,
    contentHash: r.content_hash,
  }));
}
