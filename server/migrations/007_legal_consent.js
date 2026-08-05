/**
 * Consent: what each user agreed to, which version, and when.
 *
 * ── What did not exist before this ──
 *
 * Nothing. `Signup.jsx` validated a privacy checkbox client-side and dropped it
 * before the request was sent; the server never saw it and no table held it. So
 * the platform could publish policies and could not show that a single user had
 * ever accepted one. That is not a paperwork gap — it makes the Terms
 * unenforceable, because the question in any dispute is "what did this person
 * agree to, and when", and there was no answer.
 *
 * ── Two tables, and why the hash is on both ──
 *
 * `legal_documents` is the catalogue: one row per (slug, version), immutable
 * once published. `legal_acceptances` is one row per person per document
 * version.
 *
 * `content_hash` is denormalised onto the acceptance row on purpose. Joining to
 * the catalogue answers "what did they agree to" only for as long as the
 * catalogue is intact and honest. Carrying the hash on the acceptance makes the
 * record self-proving: if the catalogue is later edited, the two disagree and
 * the tampering is visible instead of silent. The cost is one duplicated column;
 * the alternative is evidence that depends on the good behaviour of the party
 * relying on it.
 *
 * ── ON DELETE RESTRICT, not CASCADE ──
 *
 * Acceptance records must survive the account. Today's deletion path is
 * anonymisation — an UPDATE that blanks the profile and keeps the row — so
 * RESTRICT never actually fires. It is here as a guard against a future
 * hard-delete path quietly taking the evidence with it, which is precisely the
 * evidence you would need if someone later said they never agreed.
 *
 * ── What is deliberately NOT stored ──
 *
 * Full IP addresses, raw user-agent strings, precise geolocation, device ids,
 * session tokens, the document body, or how long the page was open.
 *
 * `ip_prefix` holds a truncated address (/24 for v4, /48 for v6). That retains
 * everything the record needs — "this came from a plausible network at this
 * time" — without keeping a per-child location trail. `ua_family` holds a
 * coarse family string, not the raw header, which is a fingerprinting surface.
 * On a platform whose users are mostly minors, storing full addresses
 * indefinitely to prove a checkbox is collection that reads badly in exactly
 * the proceeding where it would be produced.
 *
 * "Seconds spent on the page" is tempting and excluded on principle: it proves
 * nothing about reading and turns a consent record into a surveillance record.
 *
 * ── Additive; §8.3's rebuild guards do not apply ──
 *
 * Two CREATE TABLE statements and their indexes. No existing table is touched,
 * nothing is copied, no constraint changes. `ownTransaction` is unset so the
 * registry's BEGIN/COMMIT wraps it, which is correct for additive DDL.
 *
 * The catalogue is NOT seeded here. Seeding is idempotent and derived from
 * `server/legalDocuments.js`, so it runs at init on every boot (see
 * `syncLegalDocuments`) rather than being frozen into a migration that would
 * then need a new migration every time a document version changes.
 *
 * ── Rollback ──
 *
 *     DROP TABLE legal_acceptances;
 *     DROP TABLE legal_documents;
 *     DELETE FROM schema_migrations WHERE version = 7;
 *
 * Do not delete that row while the tables still exist (§8.5).
 */
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_documents (
      slug            TEXT NOT NULL,
      version         TEXT NOT NULL,
      title           TEXT NOT NULL,
      consent_type    TEXT NOT NULL CHECK(consent_type IN ('agree','acknowledge','notice')),
      content_hash    TEXT NOT NULL,
      effective_at    TEXT NOT NULL,
      published_at    TEXT NOT NULL,
      PRIMARY KEY (slug, version)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_legal_documents_effective
      ON legal_documents(slug, effective_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_acceptances (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      version       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      accepted_at   TEXT NOT NULL,
      method        TEXT NOT NULL,
      context       TEXT,
      ip_prefix     TEXT,
      ua_family     TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_acceptances_user
      ON legal_acceptances(user_id, document_slug, accepted_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_acceptances_doc
      ON legal_acceptances(document_slug, version)
  `);
}

export default { version: 7, name: 'legal_consent', up, fileUrl: import.meta.url };
