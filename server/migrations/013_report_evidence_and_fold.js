/**
 * Evidence for every report type, and the fold of the legacy conversation table.
 *
 * ── Two things, and why they are one migration ──
 *
 * `report_evidence` is where snapshotted message bodies live for the unified
 * model. Folding `conversation_reports` into `reports` is what makes the unified
 * model actually unified rather than a third system beside the two it replaces.
 * They are one migration because the fold has nowhere to put its evidence until
 * the table exists, and a half-applied fold — envelopes moved, bodies left
 * behind — is the one intermediate state that must not be reachable.
 *
 * ── The fold is INSERT-only ──
 *
 * Nothing is deleted and nothing is updated. `conversation_reports` and
 * `conversation_report_messages` stay exactly where they are, frozen, holding
 * real moderation evidence about real students. Dropping them is the precise
 * shape of destruction this whole phase exists to prevent, and PR-1's triggers
 * would refuse it anyway. A later release may drop them once the fold is
 * verified against the pilot database; until then they are a second copy of
 * evidence, which is a good thing for evidence to have.
 *
 * Ids are preserved. `msg-report-…` is already unique, and any external
 * reference to one — an email to a moderator, a note in a district's file —
 * stays valid. It is also what lets PR-1's three admin routes keep working
 * against the unified table without a lookup table.
 *
 * ── The staleness hazard this migration has to close ──
 *
 * After the fold there are two rows for the same report: the frozen legacy one
 * and the live unified one. PR-1's `evidenceHolds.js` decided whether to refuse
 * an event deletion by reading `conversation_reports.status`. If it kept doing
 * that, resolving a report in the unified table would leave the legacy row
 * saying `'open'` for ever, and the hold would never release — turning a safety
 * mechanism into a permanent lock on an organizer's events and on a deleted
 * account's shell.
 *
 * So `evidenceHolds.js` now reads `reports` only, and the exhaustiveness
 * assertion at the end of this migration is what licenses that: if even one
 * legacy report failed to fold, the migration fails rather than quietly leaving
 * a report whose hold nothing enforces.
 *
 * ── Duplicates, and why the fold has to decide about them ──
 *
 * The unified model suppresses a second LIVE report of the same target by the
 * same reporter, with a partial unique index (`idx_reports_no_dup`, migration
 * 012). The legacy table had no such constraint and the old conversation modal
 * had no client-side guard, so one student double-tapping "Send report" — or
 * reporting the same conversation again a week later while the first was still
 * open — left two live rows. That is not a hypothetical: duplicate suppression
 * was added precisely because it kept happening.
 *
 * A straight `INSERT … SELECT` of those rows hits the index, throws, and takes
 * the whole migration with it. The registry runs migrations at boot and 012 has
 * already committed by then (`ownTransaction: true`), so the failure mode is a
 * server that will not start, against a database with `reports` rebuilt and
 * `report_evidence` missing, and a restart that fails again in the same place
 * for ever. A migration that can be stopped by ordinary historical data is not a
 * migration, and discovering this at boot on the pilot database is the worst
 * available time to discover it.
 *
 * So the fold decides, rather than colliding:
 *
 *   - The OLDEST live report in each `(reporter_id, conversation_id)` group is
 *     the survivor, and folds unchanged. Oldest rather than newest because the
 *     hold, the queue position and the "reaches a human within one business day"
 *     promise are all about when the student first asked for help.
 *   - Every later live report in the group folds as `dismissed` with
 *     `resolution = 'duplicate'` — the same outcome the live route produces for
 *     the same collision, so history reads consistently whichever side of the
 *     migration a duplicate was filed on.
 *   - Nothing is dropped. The demoted rows keep their id, their reporter's own
 *     words, their evidence rows, and their legacy copy; they gain a resolution
 *     note naming the report that survived, and a `moderation_actions` row so
 *     the demotion is visible in the report's own history rather than only in
 *     this file.
 *   - Ties are broken by `id`, so the choice is deterministic and re-running
 *     `up()` reaches the same answer.
 *   - Rows with a NULL `reporter_id` are never demoted: the unique index is
 *     partial on `reporter_id IS NOT NULL`, so they cannot collide, and two
 *     reports from purged accounts are not known to be from the same person.
 *
 * Already-closed legacy reports are left exactly as they are. The index does not
 * cover them, so they cannot collide, and rewriting a historical outcome to
 * satisfy a constraint it is not subject to would be a fabricated record.
 */

/** The legacy shape this migration reads. Guard 4 compares against these. */
export const EXPECTED_CONVERSATION_REPORT_COLUMNS = [
  'id', 'reporter_id', 'reporter_name_snapshot', 'conversation_id',
  'reported_user_id', 'reported_name_snapshot', 'reported_role_snapshot',
  'event_id_snapshot', 'event_title_snapshot',
  'reason', 'details', 'status', 'snapshot_created_at', 'created_at',
];

/**
 * The legacy four-value reason enum, mapped onto the unified category taxonomy.
 *
 * Lossy in one direction only: `inappropriate` covered more ground than
 * `bullying_or_harassment` does. The reporter's own words survive verbatim in
 * `description`, which is the authoritative content of an old report — the
 * category on a folded row is derived, and the migration header is where that is
 * written down so a moderator reading one in two years knows not to over-read it.
 */
const REASON_TO_CATEGORY = {
  safety: 'something_feels_wrong',
  inappropriate: 'bullying_or_harassment',
  spam: 'spam_or_advertising',
  other: 'other',
};

/**
 * Priority for a folded row.
 *
 * `safety` was the legacy enum's only urgent-shaped value, so it floors at
 * `high` — the level the unified model gives "something feels wrong", which is
 * what `safety` meant. Not `critical`: that is reserved for categories naming a
 * specific danger, and a historical row cannot be read that precisely by
 * software. Everything else is `medium`, for the same reason 012 backfills
 * `medium` rather than marking history urgent and burying the live queue.
 */
const REASON_TO_PRIORITY = {
  safety: 'urgent',
  inappropriate: 'normal',
  spam: 'normal',
  other: 'normal',
};

function assertColumns(db, table, expected) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const unknown = actual.filter(c => !expected.includes(c));
  const missing = expected.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `${table} has unexpected columns [${unknown.join(', ')}]. The fold below names `
      + 'columns explicitly; add them here and to the SELECT, then re-run.'
    );
  }
  if (missing.length) {
    throw new Error(
      `${table} is missing expected columns [${missing.join(', ')}]. Migration 011 `
      + 'must have run before this one — check server/migrations/index.js ordering.'
    );
  }
}

function up(db) {
  assertColumns(db, 'conversation_reports', EXPECTED_CONVERSATION_REPORT_COLUMNS);

  /**
   * `report_evidence` mirrors `conversation_report_messages` with three changes,
   * each load-bearing:
   *
   *   - ON DELETE RESTRICT rather than CASCADE. The legacy table cascades from
   *     its report, which means deleting a report destroys its evidence. Reports
   *     are not deletable at all after PR-1; RESTRICT makes that a property of
   *     the database rather than of the trigger alone.
   *   - `message_id` carries NO foreign key to `messages`. It has to survive the
   *     message row being swept or hard-deleted — that is the entire purpose of a
   *     snapshot. A CASCADE would make evidence preservation a lie and a RESTRICT
   *     would make retention impossible.
   *   - `sender_name_snapshot`, which the legacy table lacks. It stored only
   *     `sender_id`, so a purged sender left a moderator reading an accusation
   *     with no attributable author.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_evidence (
      report_id            TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
      message_id           TEXT NOT NULL,
      sender_id            TEXT,
      sender_name_snapshot TEXT,
      body                 TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      captured_at          TEXT NOT NULL,
      PRIMARY KEY(report_id, message_id)
    )
  `);

  // Probed by the retention sweep's exemption on every pass.
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_evidence_message ON report_evidence(message_id)');

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS report_evidence_no_update
    BEFORE UPDATE ON report_evidence BEGIN
      SELECT RAISE(ABORT, 'report_evidence is a frozen evidence snapshot: it is never edited');
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS report_evidence_no_delete
    BEFORE DELETE ON report_evidence BEGIN
      SELECT RAISE(ABORT, 'report_evidence is a frozen evidence snapshot: it is never deleted');
    END;
  `);

  /* ── The fold ──────────────────────────────────────────────────────────
   *
   * Every clause is written to be safe to re-run: the registry's own idempotency
   * test calls `up()` twice, and a fold that duplicated envelopes on the second
   * pass would double every historical report in the queue.
   */

  /**
   * True for a legacy report that would collide with `idx_reports_no_dup`.
   *
   * Two halves, and both are needed. The first looks inside the legacy table
   * itself, which is where the duplicates actually are — it is the one that does
   * the work, and it reads a table this statement is not writing, so its answer
   * cannot depend on how far the INSERT has got. The second is defensive: it
   * catches a legacy row colliding with a unified report that already exists,
   * which is unreachable in the ordinary boot sequence and is exactly the sort of
   * thing that stops being unreachable later.
   *
   * `p.id <> cr.id` in both, so a row is never its own duplicate.
   */
  const IS_DUPLICATE = `
    cr.status IN ('open', 'reviewing')
    AND cr.reporter_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM conversation_reports p
         WHERE p.reporter_id     = cr.reporter_id
           AND p.conversation_id = cr.conversation_id
           AND p.status IN ('open', 'reviewing')
           AND p.id <> cr.id
           AND (p.created_at < cr.created_at
                OR (p.created_at = cr.created_at AND p.id < cr.id))
      )
      OR EXISTS (
        SELECT 1 FROM reports r
         WHERE r.reporter_id = cr.reporter_id
           AND r.target_type = 'conversation'
           AND r.target_id   = cr.conversation_id
           AND r.status IN ('open', 'reviewing', 'escalated')
           AND r.id <> cr.id
      )
    )
  `;

  /** The report a demoted duplicate is a duplicate OF, named in its note. */
  const SURVIVOR_ID = `
    (SELECT p.id FROM conversation_reports p
      WHERE p.reporter_id     = cr.reporter_id
        AND p.conversation_id = cr.conversation_id
        AND p.status IN ('open', 'reviewing')
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT 1)
  `;

  const foldedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO reports (
      id, reporter_id, reporter_name_snapshot, target_type, target_id,
      target_name_snapshot, target_body_snapshot, target_author_id,
      target_author_name_snapshot, target_role_snapshot,
      conversation_id_snapshot, event_id_snapshot,
      category, description, status, priority,
      resolution, resolution_note, resolved_by, resolved_at,
      created_at, updated_at
    )
    SELECT
      cr.id, cr.reporter_id, cr.reporter_name_snapshot, 'conversation', cr.conversation_id,
      CASE WHEN cr.event_title_snapshot IS NOT NULL
           THEN 'Conversation about “' || cr.event_title_snapshot || '”'
           ELSE 'Conversation' END,
      NULL, cr.reported_user_id,
      cr.reported_name_snapshot, cr.reported_role_snapshot,
      cr.conversation_id, cr.event_id_snapshot,
      CASE cr.reason
        WHEN 'safety'        THEN '${REASON_TO_CATEGORY.safety}'
        WHEN 'inappropriate' THEN '${REASON_TO_CATEGORY.inappropriate}'
        WHEN 'spam'          THEN '${REASON_TO_CATEGORY.spam}'
        ELSE '${REASON_TO_CATEGORY.other}'
      END,
      cr.details,

      -- Status: the survivor keeps its own; a later live duplicate is dismissed.
      CASE WHEN ${IS_DUPLICATE} THEN 'dismissed' ELSE cr.status END,

      CASE cr.reason
        WHEN 'safety'        THEN '${REASON_TO_PRIORITY.safety}'
        WHEN 'inappropriate' THEN '${REASON_TO_PRIORITY.inappropriate}'
        WHEN 'spam'          THEN '${REASON_TO_PRIORITY.spam}'
        ELSE '${REASON_TO_PRIORITY.other}'
      END,

      CASE WHEN ${IS_DUPLICATE} THEN 'duplicate' END,
      CASE WHEN ${IS_DUPLICATE}
           THEN 'Folded from the legacy conversation-report table by migration 013. '
             || 'The same person had already reported this same conversation in report '
             || COALESCE(${SURVIVOR_ID}, 'unknown')
             || ', which is still open — that report carries the investigation and the '
             || 'evidence hold. Nothing here was discarded: this report keeps its own '
             || 'words and its own preserved messages.'
      END,
      -- resolved_by stays NULL: no person decided this, a migration did, and
      -- naming an administrator who was not involved would be a false record.
      NULL,
      CASE WHEN ${IS_DUPLICATE} THEN ? END,

      cr.created_at, cr.created_at
    FROM conversation_reports cr
    WHERE cr.id NOT IN (SELECT id FROM reports)
  `).run(foldedAt);

  /**
   * The demotion, written into the report's own history.
   *
   * Without this, the only record that a migration closed somebody's report is a
   * comment in this file. `moderation_actions.actor_id` is nullable exactly so a
   * non-person actor can be recorded honestly rather than attributed to whoever
   * happened to be an administrator that day.
   */
  db.prepare(`
    INSERT INTO moderation_actions
      (id, report_id, actor_id, action, old_status, new_status, new_resolution, created_at)
    SELECT
      'act_fold_' || r.id, r.id, NULL, 'folded_duplicate',
      cr.status, 'dismissed', 'duplicate', ?
    FROM reports r
    JOIN conversation_reports cr ON cr.id = r.id
    WHERE r.target_type = 'conversation'
      AND r.resolution  = 'duplicate'
      AND NOT EXISTS (
        SELECT 1 FROM moderation_actions m WHERE m.id = 'act_fold_' || r.id
      )
  `).run(foldedAt);

  db.exec(`
    INSERT INTO report_evidence
      (report_id, message_id, sender_id, sender_name_snapshot, body, created_at, captured_at)
    SELECT crm.report_id, crm.message_id, crm.sender_id, u.name, crm.body, crm.created_at,
           COALESCE(cr.snapshot_created_at, crm.created_at)
    FROM conversation_report_messages crm
    LEFT JOIN users u                ON u.id  = crm.sender_id
    LEFT JOIN conversation_reports cr ON cr.id = crm.report_id
    WHERE NOT EXISTS (
      SELECT 1 FROM report_evidence re
      WHERE re.report_id = crm.report_id AND re.message_id = crm.message_id
    )
  `);

  /**
   * Exhaustiveness, asserted rather than assumed.
   *
   * `evidenceHolds.js` reads only `reports` from here on. That is correct only if
   * every legacy report has a unified counterpart — a legacy report left behind
   * would be a live investigation whose delete hold nothing enforces, which is
   * silent and is exactly the failure PR-1 existed to end. Fail the migration
   * instead.
   */
  const unfolded = db.prepare(`
    SELECT COUNT(*) c FROM conversation_reports cr
    WHERE NOT EXISTS (SELECT 1 FROM reports r WHERE r.id = cr.id)
  `).get().c;
  if (unfolded > 0) {
    throw new Error(
      `${unfolded} conversation report(s) did not fold into reports. evidenceHolds.js reads `
      + 'the unified table only, so leaving them behind would leave live investigations with '
      + 'no delete hold. Investigate before retrying.'
    );
  }

  const orphanedEvidence = db.prepare(`
    SELECT COUNT(*) c FROM conversation_report_messages crm
    WHERE NOT EXISTS (
      SELECT 1 FROM report_evidence re
      WHERE re.report_id = crm.report_id AND re.message_id = crm.message_id
    )
  `).get().c;
  if (orphanedEvidence > 0) {
    throw new Error(
      `${orphanedEvidence} snapshotted message(s) did not migrate into report_evidence.`
    );
  }

  /**
   * The result satisfies the constraint the fold was written to survive.
   *
   * Asserted rather than trusted to the index, because the index only refuses at
   * INSERT time and this statement has already run: if the de-duplication above
   * were ever weakened, the next `up()` — on a database that had not yet applied
   * 013 — would throw at the INSERT instead, at boot, which is the failure this
   * whole section exists to move earlier. Checking here means a change to the
   * grouping is caught by the migration's own test rather than by a pilot.
   */
  const stillColliding = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT reporter_id, target_type, target_id
        FROM reports
       WHERE status IN ('open', 'reviewing', 'escalated') AND reporter_id IS NOT NULL
       GROUP BY reporter_id, target_type, target_id
      HAVING COUNT(*) > 1
    )
  `).get().c;
  if (stillColliding > 0) {
    throw new Error(
      `${stillColliding} reporter/target group(s) hold more than one live report after the `
      + 'fold. idx_reports_no_dup would refuse this state, so the de-duplication above is '
      + 'wrong rather than the data being unusual. Fix the grouping, do not relax the index.'
    );
  }

  /**
   * Every legacy report that was live and is no longer, other than the ones this
   * migration deliberately demoted, would be a silently closed investigation.
   * There is no such case today; the check is here so that there cannot be one.
   */
  const silentlyClosed = db.prepare(`
    SELECT COUNT(*) c
      FROM conversation_reports cr
      JOIN reports r ON r.id = cr.id
     WHERE cr.status IN ('open', 'reviewing')
       AND r.status NOT IN ('open', 'reviewing')
       AND r.resolution IS NOT 'duplicate'
  `).get().c;
  if (silentlyClosed > 0) {
    throw new Error(
      `${silentlyClosed} live legacy report(s) folded into a closed state without being marked `
      + 'as duplicates. A report that stops being live releases its evidence hold, so this '
      + 'would end an investigation nobody decided to end.'
    );
  }
}

export default {
  version: 13,
  name: 'report_evidence_and_fold',
  up,
  fileUrl: import.meta.url,
};
