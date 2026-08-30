/**
 * Ordered, versioned schema migrations.
 *
 * db.js keeps its `CREATE TABLE IF NOT EXISTS` + addColumnIfMissing() bootstrap
 * for the tables that predate this registry — rewriting that is risk with no
 * reward. Everything structural from v1.2 onward goes here instead, because the
 * next few changes are table REBUILDS (SQLite cannot alter a CHECK constraint)
 * and those need ordering, a record of what already ran, and a rollback story.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import authzRoles from './001_authz_roles.js';
import userCapabilities from './002_user_capabilities.js';
import reauthChallenges from './003_reauth_challenges.js';
import errorEvents from './004_error_events.js';
import errorAlerts from './005_error_alerts.js';
import accountSuspension from './006_account_suspension.js';
import legalConsent from './007_legal_consent.js';
import dateOfBirth from './008_date_of_birth.js';
import userBlocks from './009_user_blocks.js';
import graduationYear from './010_graduation_year.js';
import evidencePreservation from './011_evidence_preservation.js';
import unifiedReports from './012_unified_reports.js';
import reportEvidenceAndFold from './013_report_evidence_and_fold.js';
import appeals from './014_appeals.js';
import appealsIntegrity from './015_appeals_integrity.js';
import legalV1Republish from './016_legal_v1_republish.js';
import timedSuspension from './017_timed_suspension.js';
import adminConversations from './018_admin_conversations.js';
import auditLogHardening from './019_audit_log_hardening.js';
import administratorRoster from './020_administrator_roster.js';
import administratorPromotionMetadata from './021_administrator_promotion_metadata.js';
import systemCliActor from './022_system_cli_actor.js';
import adminInvitations from './023_admin_invitations.js';
import featuresExpansion from './024_features_expansion.js';
import tfaHardening from './025_tfa_hardening.js';
import securityAuditLogs from './026_security_audit_logs.js';
import encryptTfaSecrets from './027_encrypt_tfa_secrets.js';
import moderationActionNote from './028_moderation_action_note.js';
import totpReplayHighWater from './029_totp_replay_high_water.js';
import personaPreview from './030_persona_preview.js';
import socialDirectory from './031_social_directory.js';
import externalHoursTrackingOnly from './032_external_hours_tracking_only.js';
import distinguishedProfiles from './033_distinguished_profiles.js';
import legalDocumentRevisions from './034_legal_document_revisions.js';
import peerConversations from './035_peer_conversations.js';
import slotWindowIndex from './036_slot_window_index.js';
import checkinTokens from './037_checkin_tokens.js';
import attendanceForeignKeys from './038_attendance_foreign_keys.js';
import legalChangeNotices from './039_legal_change_notices.js';
import organizationIdentity from './040_organization_identity.js';
import organizationAnnouncements from './041_organization_announcements.js';
import organizationAllowReplies from './042_organization_allow_replies.js';
import avatarColour from './043_avatar_colour.js';
import organizationBans from './044_organization_bans.js';
import eventAudience from './045_event_audience.js';
import studentOrganizerRole from './046_student_organizer_role.js';
import emailOutbox from './047_email_outbox.js';
import hashAuthTokens from './048_hash_auth_tokens.js';
import serviceVisibility from './049_service_visibility.js';
import deliveryEvents from './050_delivery_events.js';
import issueReports from './051_issue_reports.js';
import analyticsConsent from './052_analytics_consent.js';
import ledgerDuplicateBackfill from './053_ledger_duplicate_backfill.js';
import resyncUnacceptedLegalHashes from './054_resync_unaccepted_legal_hashes.js';
import repairTfaLoginAttempts from './055_repair_tfa_login_attempts.js';
import isoLoginAttemptTimestamps from './056_iso_login_attempt_timestamps.js';
import widenEventCategories from './057_widen_event_categories.js';
import hoursCloseOut from './058_hours_close_out.js';
import eventSearchIndex from './059_event_search_index.js';
import schedulerLeases from './061_scheduler_leases.js';

export const MIGRATIONS = [
  authzRoles, userCapabilities, reauthChallenges, errorEvents, errorAlerts, accountSuspension,
  legalConsent, dateOfBirth, userBlocks, graduationYear, evidencePreservation,
  // 012 rebuilds `reports` and MUST run while it is childless; 013 is what gives
  // it a child (`report_evidence`). Reordering these two makes the rebuild
  // destructive.
  unifiedReports, reportEvidenceAndFold, appeals,
  // 015 splits the appellant's statement out of `reasoning` and freezes it, so it
  // MUST run after 014 has created the table it alters — and its backfill only
  // recovers statements from appeals not yet decided, so the longer it is
  // deferred the more of them are already overwritten.
  appealsIntegrity,
  /**
   * 016 must run BEFORE `syncLegalDocuments`, which it does: `initDatabase()` calls
   * `runMigrations` first and syncs the catalogue afterwards. Reversing that
   * ordering restores the boot crash 016 exists to repair, because sync is the
   * thing that was throwing.
   */
  legalV1Republish,
  /**
   * 017 is additive and order-independent: two nullable columns on `users`,
   * read by nothing that runs during migration. It is last because it is
   * newest, not because anything before it is a prerequisite.
   */
  timedSuspension,
  /**
   * 018 REBUILDS `conversations`, which has three ON DELETE CASCADE children —
   * one of them students' private messages. It carries the six guards
   * ENGINEERING_GUIDE §8.3 requires and runs with `ownTransaction: true`, because
   * `PRAGMA foreign_keys = OFF` is a silent no-op inside an open transaction and
   * the whole rebuild depends on it taking effect.
   */
  adminConversations,
  /**
   * 019 adds indexes and immutability triggers to admin_audit_logs.
   * Additive, no table rebuild required.
   */
  auditLogHardening,
  /**
   * 020 adds last_sign_in_at to users and a composite index to admin_audit_logs.
   */
  administratorRoster,
  /**
   * 021 adds promoted_at, promoted_by, and promotion_reason to users.
   */
  administratorPromotionMetadata,
  /**
   * 022 seeds the reserved `system-cli` account, so a privileged action taken
   * from a shell has an actor that is not its own victim.
   */
  systemCliActor,
  /**
   * 023 adds `admin_invitations`, with a partial unique index enforcing one
   * pending invitation per address (IV-13) and the token stored hashed.
   */
  adminInvitations,
  /**
   * 024 expands features for profile pictures, 2FA, and badges.
   */
  featuresExpansion,
  /**
   * 025 hardens 2FA by invalidating plain-text recovery codes, 
   * creating tables for email codes and login attempt throttling.
   */
  tfaHardening,
  /**
   * 026 adds a dedicated security_audit_logs table to isolate user
   * security lifecycle events from administrator actions.
   */
  securityAuditLogs,
  /**
   * 027 encrypts existing plaintext TOTP secrets using AES-256-GCM.
   */
  encryptTfaSecrets,
  /**
   * 028 gives `moderation_actions` a `note` column, so reopening a report keeps
   * the withdrawn decision's reasoning instead of destroying it.
   */
  moderationActionNote, totpReplayHighWater,
  /**
   * 030 adds the two columns a persona preview lives in. Additive, nullable, and
   * order-independent: nothing reads them during migration.
   */
  personaPreview,
  /**
   * 031 adds the v1.3 directory: profile fields, relationships, organizations,
   * external service records, and the flag for events that credit no hours.
   * Purely additive and order-independent — it creates new tables and appends
   * nullable/defaulted columns, and reads nothing that an earlier migration
   * writes. It must nonetheless stay after 001, which rebuilds `users` from an
   * explicit column list and would fail on a column it does not know about.
   */
  socialDirectory,
  /**
   * 032 rebuilds `external_hours` without the review columns 031 added. It must
   * run after 031 (which creates the table) and manages its own transaction,
   * because a table rebuild needs `PRAGMA foreign_keys = OFF` to take effect.
   */
  externalHoursTrackingOnly,
  /**
   * 033 adds two nullable columns to `users`. It must run AFTER 001, which
   * rebuilds that table from an explicit column list and refuses any column it
   * does not know about — the same constraint 031 sits under, and the reason
   * these two are a migration rather than an `addColumnIfMissing` guard in
   * db.js, which runs before the registry. See the file's header.
   */
  distinguishedProfiles,
  /**
   * 034 creates `legal_document_revisions`, the override layer that lets an
   * owner publish new legal text without a deploy.
   *
   * Purely additive — one new table and its index, no rebuild — so it is
   * order-independent with respect to everything above it. It must nonetheless
   * stay AFTER 007, which creates the `legal_documents` catalogue the write path
   * checks a proposed version against, and after 016, which reconciles that
   * catalogue. Both hold by position.
   *
   * There is no backfill. With no rows here every read falls back to the file on
   * disk and behaves exactly as it did before, so the existing text is already
   * the answer and copying it in would only create a second copy to keep in step.
   */
  legalDocumentRevisions,
  /**
   * 035 REBUILDS `conversations` a second time, to admit `kind = 'peer'` so two
   * friends can have a thread that is about neither an event nor a moderation
   * case. It MUST run after 018 — it copies 018's column list, including `kind`,
   * and refuses outright if that column is absent.
   *
   * Same six guards and the same `ownTransaction: true` as 018, for the same
   * reason: `PRAGMA foreign_keys = OFF` is a silent no-op inside an open
   * transaction, and `conversations` still cascades to students' private
   * messages.
   */
  peerConversations,
  /**
   * 036 adds one covering index on `slots`, for the aggregate `GET /api/events`
   * runs to derive each event's earliest shift, latest end, capacity and hours.
   * Index-only, no schema change, no data change, and safe to run on any
   * database that has a `slots` table — which is every one, since the initial
   * schema creates it.
   */
  slotWindowIndex,

  /**
   * 037 — per-volunteer check-in codes, and how a check-in mark was taken.
   *
   * Additive and order-independent: a new table, plus a defaulted column on
   * `attendance_checkin`. Nothing existing reads either, so it can be applied to
   * a database at any prior version without touching a row that is already
   * there. See the file for why the codes are stored rather than signed.
   */
  checkinTokens,

  /**
   * 038 — foreign keys for the two attendance tables that never declared any.
   *
   * A table rebuild, so it is NOT order-independent: it must run after 037,
   * which adds `attendance_checkin.method` and creates `checkin_tokens`. The
   * rebuild carries both through. Guarded by `PRAGMA foreign_key_list`, so a
   * second run is a no-op.
   */
  attendanceForeignKeys,

  /**
   * 039 — who has been told a legal document changed, and who has read it.
   *
   * Order-independent: a new table with one foreign key to `users`, no data
   * migration and no dependency on any earlier schema beyond that.
   */
  legalChangeNotices,

  /**
   * 040 — an emoji or an uploaded image for an organization.
   *
   * Three ALTER TABLE ADD COLUMNs, each guarded on `PRAGMA table_info`, so a
   * half-applied earlier run recovers rather than failing forever.
   */
  organizationIdentity,

  /**
   * 041 — organization announcements and their replies.
   *
   * Order-dependent only on `organizations` and `users` existing, both of which
   * long predate it. Idempotent: `CREATE TABLE IF NOT EXISTS` throughout.
   */
  organizationAnnouncements,

  /**
   * 042 — replies become an organization setting rather than a per-post one.
   *
   * One guarded ALTER TABLE ADD COLUMN. Depends on 041 only in meaning, not in
   * schema: it touches `organizations`, which long predates it.
   */
  organizationAllowReplies,

  /**
   * 043 — a background colour behind an emoji avatar, for people and for
   * organizations. Two guarded ALTER TABLE ADD COLUMNs; order-independent.
   */
  avatarColour,

  /**
   * 044 — organization bans. A new table plus two indexes; order-independent
   * beyond `organizations` and `users`, both of which long predate it.
   */
  organizationBans,

  /**
   * 045 — who an event is for. One column on `events` plus an index; depends
   * only on `events`, and on migration 031 having added `organization_id`,
   * which the column is meaningless without.
   */
  eventAudience,

  /**
   * 046 — the Student Organizer rank. Rebuilds `organization_members` to widen
   * its CHECK, so it must run after 031 created the table and after anything
   * that adds a column to it (nothing does).
   */
  studentOrganizerRole,
  /**
   * 047 — the outbox learns to carry a rendered message, so transactional mail
   * stops being the one category that could vanish on a restart. Additive
   * columns only, so a queue with rows in flight drains across the upgrade.
   */
  emailOutbox,
  /**
   * 048 — verification, reset and email-change tokens stop being stored in
   * plaintext. Rebuilds three tables to rename `token` to `token_hash`, so a
   * future plaintext write fails loudly instead of silently reopening the hole.
   */
  hashAuthTokens,
  /**
   * 049 — a student decides who sees their service history and certificates.
   * Two additive columns on `users`, both defaulting to 'public' so nothing a
   * student had already published silently disappears on deploy.
   */
  serviceVisibility,
  /**
   * 050 — what became of a message after the provider accepted it. Additive
   * columns plus an event table whose PRIMARY KEY is the webhook dedupe.
   */
  deliveryEvents,
  /**
   * 051 — reports about the PLATFORM, kept out of the moderation queue that
   * exists to protect children. A new table, not a reuse of `reports`.
   */
  issueReports,
  /**
   * 052 — whether a person has agreed to be measured. One nullable column, no
   * DEFAULT, no backfill: every existing row becomes "not asked", which is off.
   * The only privacy column in the schema that does NOT carry forward the
   * behaviour already in place, and the header says why.
   */
  analyticsConsent,
  /**
   * 053 — removes the duplicate rows the ledger backfill wrote while it was
   * idempotent against its own entries and blind to everybody else's. Deletes
   * only the migration-sourced copy, only where a real one survives for the
   * same (slot, user).
   */
  ledgerDuplicateBackfill,
  /**
   * 054 — lets hash enforcement start on a database that predates it, by
   * re-syncing only the published versions nobody has ever accepted. A version
   * with an acceptance row keeps its hash and keeps refusing the boot, which is
   * the invariant working rather than an obstacle to it.
   */
  resyncUnacceptedLegalHashes,
  /**
   * 055 — rebuilds `tfa_login_attempts` on databases where its key column is not
   * the `token_hash` the sign-in path writes. 025 creates the table with
   * `CREATE TABLE IF NOT EXISTS`, which skipped a pre-existing table of the same
   * name and a different shape, so every second-factor submission on the pilot
   * database answered 500 while every test — all of which build the table from
   * scratch — passed.
   */
  repairTfaLoginAttempts,
  /**
   * 056 — converts `tfa_login_attempts.last_attempt_at` from SQLite's
   * `datetime('now')` format to the ISO-8601 the rest of the schema uses, so
   * that the rate limiter can compare it against a bound timestamp instead of
   * `datetime('now','-15 minutes')`, which PostgreSQL does not have.
   *
   * Must run AFTER 055, which rebuilds the table on databases where its key
   * column is the wrong one: converting values in a table that is about to be
   * rebuilt would convert the rows that get discarded.
   */
  isoLoginAttemptTimestamps,
  /**
   * 057 — REBUILDS `events` to widen the CHECK on `category` from five values to
   * sixteen. Additive to the vocabulary: every original value survives, so no
   * existing row can fail the new constraint and none is rewritten.
   *
   * `events` has eleven ON DELETE CASCADE children, two of them students'
   * credited hours and their private messages, so it carries the same six guards
   * and the same `ownTransaction: true` as 018 — `PRAGMA foreign_keys = OFF` is
   * a silent no-op inside an open transaction, and that is the one failure here
   * nothing else can detect.
   *
   * Order-dependent only on the columns it copies existing: `organization_id`
   * and `credits_hours` arrive with 031, `audience` with 045. Both are far
   * above, and the migration refuses outright rather than dropping a column it
   * does not know about.
   */
  widenEventCategories,
  /**
   * 058 — two nullable columns recording the deliberate act of closing an
   * event's hours out, and who performed it.
   *
   * Additive on both engines and order-independent beyond `events` existing —
   * but it MUST stay after 057, which rebuilds `events` from an explicit column
   * list and refuses a column it does not know about. Running 058 first would
   * make 057 throw on every database.
   */
  hoursCloseOut,
  /**
   * 059 — the bookkeeping table that keeps the Pinecone search index in step
   * with `events`, and stops it re-embedding content that has not changed.
   *
   * A new table with a foreign key to `events`, so it must run after `events`
   * exists; nothing else depends on its order. Additive on both engines.
   */
  eventSearchIndex,
  /**
   * 061 — leader leases for the four periodic sweeps.
   *
   * A standalone table with no foreign keys, so it is order-independent.
   *
   * Numbered 061 rather than 060 deliberately: 060 is taken by an unmerged
   * branch, and two migrations sharing a version is refused at boot
   * ("Duplicate migration version"). Gaps in the sequence are fine — the loader
   * sorts and applies whatever it has not recorded — and a gap is a much
   * cheaper thing to explain than a collision is to untangle after both have
   * been applied somewhere.
   */
  schedulerLeases
];

const label = (m) => `${m.version}_${m.name}`;

/**
 * A migration's source reduced to the form the checksum actually cares about:
 * comments removed, whitespace collapsed.
 *
 * Hand-written rather than regex-based because a regex cannot tell a comment
 * from the characters `//` inside a string, and deleting real code would turn
 * the checksum's false-positive problem into a false-NEGATIVE one — two
 * different migrations hashing the same. This walks the source once, copying
 * string and template-literal contents verbatim and dropping only genuine
 * comments.
 *
 * Exported for its own tests: everything the migration guard promises rests on
 * this being right, so it is verified directly rather than only through the
 * hashes it feeds.
 */
export function canonicalSource(source) {
  // After one of these, a '/' starts a regex literal rather than being
  // division. Migration files have no regexes today, but misreading one would
  // let a '//' inside it eat the rest of the line — the false negative above.
  const REGEX_MAY_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

  let out = '';
  let prev = '';           // last non-whitespace character of real code
  let i = 0;

  const copyDelimited = (open, close) => {
    const start = i;
    i++;                                        // opening delimiter
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }    // escape: skip the pair
      // `${ ... }` may itself contain a backtick, so track nesting rather than
      // stopping at the first one.
      if (open === '`' && ch === '$' && source[i + 1] === '{') { depth++; i += 2; continue; }
      if (open === '`' && depth > 0 && ch === '}') { depth--; i++; continue; }
      if (depth === 0 && ch === close) { i++; break; }
      i++;
    }
    out += source.slice(start, i);
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {            // line comment
      while (i < source.length && source[i] !== '\n') i++;
      continue;                                 // the newline collapses below
    }
    if (c === '/' && next === '*') {            // block comment
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';                               // a comment still separates tokens
      continue;
    }
    if (c === "'" || c === '"') { copyDelimited(c, c); prev = c; continue; }
    if (c === '`') { copyDelimited('`', '`'); prev = '`'; continue; }
    if (c === '/' && REGEX_MAY_FOLLOW.has(prev)) {
      // A regex literal: copy it whole. Character classes may contain an
      // unescaped '/', so track them.
      const start = i;
      i++;
      let inClass = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i++; break; }
        else if (ch === '\n') break;            // not a regex after all
        i++;
      }
      out += source.slice(start, i);
      prev = '/';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * What the checksum is computed over.
 *
 * Two failure modes drove this away from `String(m.up)`:
 *
 *   - FALSE POSITIVE. `Function.prototype.toString` includes the comments and
 *     whitespace inside `up`, and 001's `up` is ~120 lines of heavily commented
 *     code. Reflowing a sentence in a comment caused a hard boot failure that
 *     could only be cleared with manual SQL — training operators to reach for
 *     the override, which is the last habit this guard wants to encourage.
 *   - FALSE NEGATIVE, and the more dangerous one. `String(m.up)` covers only
 *     the function body, so a migration's module-level dependencies were
 *     invisible to it: 001's `countCascadingChildren()` and
 *     `EXPECTED_USER_COLUMNS` could be rewritten with no change to the hash at
 *     all — and those are precisely what changes when a users column is added.
 *
 * Hashing the whole module file, canonicalised, covers the dependencies and
 * ignores the cosmetics. `fileUrl` is the module's own `import.meta.url`, so
 * the path never depends on the process working directory. Inline migrations
 * (the registry's own tests) carry no file and fall back to their `up` source;
 * `migrations.registry.test.js` asserts every real migration declares a
 * fileUrl, so that fallback cannot silently become the production path.
 */
function hashBasis(m) {
  if (m.fileUrl) return canonicalSource(readFileSync(new URL(m.fileUrl), 'utf8'));
  return canonicalSource(String(m.up));
}

const checksumOf = (m) => createHash('sha256').update(hashBasis(m)).digest('hex');

/**
 * The checksum a given migration would record today.
 *
 * Exported so `bin/migration-checksums.mjs` can print the backfill values an
 * operator needs after a checksum-scheme change, without that script
 * reimplementing (and drifting from) the hash this module actually enforces.
 */
export const checksumFor = checksumOf;

function ensureBookkeeping(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // checksum is nullable and added via ALTER TABLE, not part of the CREATE
  // TABLE above, because databases that ran before this guard existed already
  // have rows with no checksum — see the NULL-checksum handling in
  // runMigrations() for why those rows must throw rather than be backfilled.
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all();
  if (!columns.some(c => c.name === 'checksum')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  }
}

export function appliedVersions(db) {
  ensureBookkeeping(db);
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
}

/**
 * Builds the "what happened, what to do" text shared by both checksum-failure
 * cases. Whoever hits this is at boot, with no other context, so the message
 * carries the full remedy rather than pointing at documentation.
 */
function checksumErrorMessage(m, reason) {
  return (
    `Migration ${label(m)} is recorded as applied, but its stored checksum ${reason}. `
    + "This means the migration's code may not match what actually ran against this "
    + 'database — running it now could silently do nothing or duplicate work. '
    + `Verify by hand whether ${label(m)}'s schema change is already present. `
    + `If it is NOT present: delete the row WHERE version = ${m.version} from `
    + 'schema_migrations and restart, so the migration runs for real. '
    + 'If the change IS already present: do NOT delete the row — that would re-run '
    + 'the migration against a database it has already changed. Backfill the row '
    + `instead, with UPDATE schema_migrations SET checksum = '<current>' WHERE `
    + `version = ${m.version}; the correct value is printed by `
    + 'bin/migration-checksums.mjs. This is also the expected one-time step after a '
    + 'change to the checksum SCHEME itself (v1.2a rebased checksums from the `up` '
    + 'function source onto the whole migration file), which invalidates every '
    + 'previously recorded checksum at once. '
    + 'Full procedure: docs/ENGINEERING_GUIDE.md section 8.5, "Migration checksum failures".'
  );
}

/**
 * Applies every migration not yet recorded, lowest version first.
 *
 * Each migration runs inside its own transaction so a failure leaves the
 * database exactly as it was — including the schema_migrations row, which is
 * written inside the same transaction as the DDL it describes. A migration that
 * manages its own transaction (the table rebuilds must, because
 * `PRAGMA foreign_keys` cannot change inside one) sets `ownTransaction = true`.
 */
export function runMigrations(db, migrations = MIGRATIONS) {
  ensureBookkeeping(db);

  const seenVersions = new Set();
  for (const m of migrations) {
    if (seenVersions.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seenVersions.add(m.version);
  }

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const alreadyRows = db.prepare('SELECT version, checksum FROM schema_migrations').all();
  const already = new Map(alreadyRows.map(r => [r.version, r.checksum]));
  const applied = [], skipped = [];

  for (const m of ordered) {
    if (already.has(m.version)) {
      const stored = already.get(m.version);
      if (stored === null) {
        throw new Error(checksumErrorMessage(m, 'is missing (NULL)'));
      }
      if (stored !== checksumOf(m)) {
        throw new Error(checksumErrorMessage(m, "does not match the migration's current source"));
      }
      skipped.push(label(m));
      continue;
    }

    const record = () => db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)'
    ).run(m.version, m.name, new Date().toISOString(), checksumOf(m));

    try {
      if (m.ownTransaction) {
        m.up(db);
        record();
      } else {
        db.exec('BEGIN');
        try { m.up(db); record(); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
      }
      console.log(`Migration applied: ${label(m)}`);
      applied.push(label(m));
    } catch (err) {
      throw new Error(`Migration ${label(m)} failed: ${err.message}`, { cause: err });
    }
  }

  return { applied, skipped };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PostgreSQL
   ═══════════════════════════════════════════════════════════════════════════

   ── The gap this closes ──

   A PostgreSQL database is created at the DESTINATION rather than walked to it:
   `applyPostgresSchema` runs `server/db/postgresSchema.js`, which is generated
   from a freshly-booted SQLite database and therefore already contains the
   result of every migration in the registry. That is the right design for a
   NEW database, and it was the whole design — which meant PostgreSQL had a
   fresh-install path and no upgrade path at all.

   Every statement in the generated schema is `CREATE TABLE IF NOT EXISTS` or
   `CREATE OR REPLACE`. Against a database that already has the tables, all of
   them are no-ops. So a schema change made after a deployment was provisioned
   — a widened CHECK, a new column, a new index — never reached it, and nothing
   said so: the boot succeeded, the application served traffic, and the first
   symptom was a constraint violation on a value the UI offered.

   It was worse than merely absent. The baseline row was written
   `WHERE NOT EXISTS (SELECT 1 … WHERE version = ?)` against the CURRENT latest
   version, so every release that added a migration inserted ANOTHER row named
   `postgres_baseline` claiming that migration had been applied. The bookkeeping
   did not just fail to record the change; it recorded a change that never
   happened, which is the one state a migration system must never reach.

   ── The rule ──

   Migrations at or below `POSTGRES_BASELINE_VERSION` never run on PostgreSQL.
   They are the SQLite-only history — fourteen of them are the create-copy-drop-
   rename dance SQLite requires because it cannot `ALTER` a CHECK constraint,
   and translating a workaround for a limitation PostgreSQL does not have would
   be a longer route to the same schema with fourteen more chances to get it
   wrong. The generated DDL already IS their result.

   Every migration ABOVE that line must carry a `postgres.up`, and
   `runPostgresMigrations` throws at boot if one does not. Failing the boot is
   deliberate: the alternative is skipping the migration silently, which is
   exactly the defect above wearing a different hat.
*/

/**
 * The last migration whose effect a PRE-EXISTING PostgreSQL database already
 * has, purely because the generated schema built it.
 *
 * ── Why this is frozen and not derived ──
 *
 * It reads like `LATEST_MIGRATION_VERSION` and must never be computed from the
 * registry the way that one is. `LATEST_MIGRATION_VERSION` answers "what does
 * the DDL in postgresSchema.js contain today", which moves with every
 * regeneration. This answers "what had already been applied to databases out in
 * the world when PostgreSQL support shipped", which is a fact about the past and
 * cannot move. Deriving it would make every new migration retroactively part of
 * the baseline — the deployed database would be told the change was already
 * there, and it would not be.
 *
 * 56 because `postgresSchema.js` was generated at version 56 when the engine
 * was declared ready. Migration 57 is the first change PostgreSQL has to be
 * walked through.
 *
 * ── The one database this could get wrong, checked ──
 *
 * A PostgreSQL database provisioned slightly earlier carries a baseline row at
 * 55, so 56 is neither recorded nor run on it. That is deliberate and safe:
 * migration 056 rewrites `tfa_login_attempts.last_attempt_at` from SQLite's
 * `datetime('now')` format into the ISO-8601 the rest of the schema uses, and
 * PostgreSQL never wrote a value in that format — the only writer is the
 * application, which writes ISO. There is nothing there to convert. Every other
 * migration at or below this line is SQLite DDL whose result the generated
 * schema already contains.
 *
 * Raise this ONLY when re-baselining deliberately — that is, when no deployed
 * PostgreSQL database predates the new number. Raising it to silence the
 * "no PostgreSQL implementation" refusal below would tell every deployed
 * database that a change it has not received is already applied.
 */
export const POSTGRES_BASELINE_VERSION = 56;

/**
 * The checksum recorded for a version the generated schema supplied rather than
 * a migration having run.
 *
 * Distinguished from a real checksum because there is no code to hash: nothing
 * executed, the DDL simply already said so. `runPostgresMigrations` therefore
 * skips the source-drift check on these rows instead of failing every boot on a
 * hash that could never match.
 */
export const POSTGRES_BASELINE_CHECKSUM = 'baseline';

/** Migrations that must run on PostgreSQL, lowest version first. */
export function postgresMigrations(migrations = MIGRATIONS) {
  return [...migrations]
    .filter(m => m.version > POSTGRES_BASELINE_VERSION)
    .sort((a, b) => a.version - b.version);
}

/**
 * `schema_migrations`, on PostgreSQL.
 *
 * A separate function from `ensureBookkeeping` rather than a branch inside it,
 * because that one is synchronous and reads `PRAGMA table_info` — neither of
 * which exists here. The shape is the same, and `db.postgresSchema.test.js`
 * pins the generated DDL that normally creates it; this runs first anyway so
 * that a database provisioned before the table existed still gets one.
 */
async function ensurePostgresBookkeeping(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      applied_at text NOT NULL,
      checksum   text
    );
    ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
  `);
}

/**
 * Records every registry version as supplied-by-the-schema, for a database that
 * was EMPTY when the schema was applied.
 *
 * ── Why every version and not just the highest ──
 *
 * The previous code wrote one row, at the latest version. That is enough to
 * answer "how far along is this database" and not enough to drive a runner:
 * add migration 58 and a database freshly created at 57 has no row for 58, so
 * 58 is outstanding — and its `postgres.up` would run against DDL that already
 * contains 58's change, because the generated schema is regenerated with it.
 * Applying a change to a database that already has it is the failure mode this
 * whole file exists to prevent, so the fresh database records the lot.
 *
 * Exported for `applyPostgresSchema`, which is generated and must not carry
 * logic of its own.
 */
export async function seedPostgresBaseline(db, migrations = MIGRATIONS) {
  await ensurePostgresBookkeeping(db);
  const now = new Date().toISOString();
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    await db.prepare(
      `INSERT INTO schema_migrations (version, name, applied_at, checksum)
            SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ?)`
    ).run(m.version, m.name, now, POSTGRES_BASELINE_CHECKSUM, m.version);
  }
}

/** Whether this PostgreSQL database has ever been through schema bookkeeping. */
export async function postgresIsFresh(db) {
  await ensurePostgresBookkeeping(db);
  const row = await db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
  return Number(row?.count ?? row?.COUNT ?? 0) === 0;
}

/**
 * Applies every outstanding PostgreSQL migration, lowest version first.
 *
 * The async twin of `runMigrations`, and deliberately a twin rather than a
 * branch: that one is synchronous top to bottom (`node:sqlite` is), and the
 * PostgreSQL adapter is async top to bottom. Threading `await` through the
 * SQLite path to share one function would make the engine every deployment
 * actually runs on pay for the one that is being ported to.
 *
 * Each migration runs inside `runInTransaction`, so a failure leaves the
 * database exactly as it was — including the `schema_migrations` row, which is
 * written inside the same transaction as the DDL it describes. PostgreSQL has
 * transactional DDL, so unlike SQLite there is no rebuild that has to opt out:
 * `ownTransaction` is a SQLite concern (`PRAGMA foreign_keys` cannot change
 * inside an open transaction) and is ignored here.
 */
export async function runPostgresMigrations(db, migrations = MIGRATIONS) {
  await ensurePostgresBookkeeping(db);

  const seenVersions = new Set();
  for (const m of migrations) {
    if (seenVersions.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seenVersions.add(m.version);
  }

  const rows = await db.prepare('SELECT version, checksum FROM schema_migrations').all();
  const already = new Map(rows.map(r => [Number(r.version), r.checksum]));
  const applied = [], skipped = [];

  const { runInTransaction } = await import('../db/connectionContext.js');

  for (const m of postgresMigrations(migrations)) {
    if (already.has(m.version)) {
      const stored = already.get(m.version);
      /* A baseline row records that the generated DDL already contained this
         change. No code ran, so there is nothing to hash and nothing to have
         drifted — verifying it would fail every boot on a value that could
         never match. */
      if (stored !== POSTGRES_BASELINE_CHECKSUM) {
        if (stored === null) throw new Error(checksumErrorMessage(m, 'is missing (NULL)'));
        if (stored !== checksumOf(m)) {
          throw new Error(checksumErrorMessage(m, "does not match the migration's current source"));
        }
      }
      skipped.push(label(m));
      continue;
    }

    /**
     * Refused rather than skipped.
     *
     * A migration above the baseline with no PostgreSQL implementation is a
     * schema change that reaches SQLite and not PostgreSQL. Skipping it is how
     * the two engines drift into disagreeing about the same table, and the
     * symptom is a constraint violation in production on a value development
     * accepts. The boot stops, and it names what to write.
     */
    if (typeof m.postgres?.up !== 'function') {
      throw new Error(
        `Migration ${label(m)} has no PostgreSQL implementation.\n`
        + `  Every migration above POSTGRES_BASELINE_VERSION (${POSTGRES_BASELINE_VERSION}) must export\n`
        + '  `postgres: { up: async (db) => … }` alongside its SQLite `up`, because a\n'
        + '  PostgreSQL database that already exists receives no DDL from\n'
        + '  postgresSchema.js — every statement in it is CREATE … IF NOT EXISTS.\n'
        + '  Refusing to boot rather than skipping: a skipped schema change is a\n'
        + '  production constraint violation on a value development accepts.'
      );
    }

    try {
      await runInTransaction(db, async (tx) => {
        await m.postgres.up(tx);
        await tx.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)'
        ).run(m.version, m.name, new Date().toISOString(), checksumOf(m));
      });
      console.log(`Migration applied (postgres): ${label(m)}`);
      applied.push(label(m));
    } catch (err) {
      throw new Error(`Migration ${label(m)} failed on PostgreSQL: ${err.message}`, { cause: err });
    }
  }

  return { applied, skipped };
}
