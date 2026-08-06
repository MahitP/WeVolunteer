/**
 * Migrations 012 and 013 — the reports rebuild and the conversation fold.
 *
 * 012 is the second sanctioned destructive rebuild in this repository (001 is the
 * other), so it carries the six guards ENGINEERING_GUIDE §8.3 requires, and every
 * one of them is exercised here. A guard that has never been made to fire is a
 * guard nobody knows the shape of — 012's own header says it stays in the file so
 * that a FUTURE rebuild is covered, which is only true if it works.
 *
 * 013 is where the fold lands, and the assertion that matters most is the one
 * about what it does NOT do: `conversation_reports` and
 * `conversation_report_messages` hold real moderation evidence about real
 * students, they are INSERT-read only from here on, and every row must still be
 * there afterwards.
 *
 * Runs against an in-memory database built from the schema 011 leaves behind,
 * rather than booting the app — a migration test that needs a server is a
 * migration test nobody runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import unifiedReports, { EXPECTED_REPORT_COLUMNS } from './migrations/012_unified_reports.js';
import reportEvidenceAndFold from './migrations/013_report_evidence_and_fold.js';

/** The schema exactly as migration 011 leaves it. */
function seedPre012(db) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT, role TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT, organizer_id TEXT
    );
    CREATE TABLE event_comments (
      id TEXT PRIMARY KEY, event_id TEXT, user_id TEXT, body TEXT
    );
    CREATE TABLE reports (
      id                          TEXT PRIMARY KEY,
      reporter_id                 TEXT REFERENCES users(id) ON DELETE SET NULL,
      reporter_name_snapshot      TEXT,
      target_type                 TEXT NOT NULL CHECK(target_type IN ('event','comment')),
      target_id                   TEXT NOT NULL,
      target_body_snapshot        TEXT,
      target_author_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
      target_author_name_snapshot TEXT,
      reason                      TEXT,
      status                      TEXT NOT NULL DEFAULT 'open'
                                    CHECK(status IN ('open','resolved','dismissed')),
      created_at                  TEXT NOT NULL
    );
    CREATE TABLE conversation_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT, reporter_name_snapshot TEXT, conversation_id TEXT,
      reported_user_id TEXT, reported_name_snapshot TEXT, reported_role_snapshot TEXT,
      event_id_snapshot TEXT, event_title_snapshot TEXT,
      reason TEXT, details TEXT, status TEXT, snapshot_created_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE conversation_report_messages (
      report_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_id TEXT,
      body TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(report_id, message_id)
    );

    INSERT INTO users (id, name, role) VALUES
      ('u-student','Student','student'), ('u-org','Organizer','organizer');
    INSERT INTO events (id, title, organizer_id) VALUES ('ev-1','Beach Cleanup','u-org');
    INSERT INTO event_comments (id, event_id, user_id, body)
      VALUES ('cm-1','ev-1','u-org','a comment body');
  `);
}

const legacyReport = (
  db,
  {
    id, reason, status = 'open', details = 'their own words',
    conversationId = 'conv-1', reporter = 'u-student', createdAt = '2026-08-01T00:00:00Z',
  },
) =>
  db.prepare(`INSERT INTO conversation_reports
      (id, reporter_id, reporter_name_snapshot, conversation_id, reported_user_id,
       reported_name_snapshot, reported_role_snapshot, event_id_snapshot, event_title_snapshot,
       reason, details, status, snapshot_created_at, created_at)
    VALUES (?, ?, 'Student', ?, 'u-org', 'Organizer', 'organizer',
            'ev-1', 'Beach Cleanup', ?, ?, ?, ?, ?)`)
    .run(id, reporter, conversationId, reason, details, status, createdAt, createdAt);

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const objectNames = (db, type) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type).map(r => r.name);
const tableSql = (db, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name)?.sql ?? '';

let db;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  seedPre012(db);
});

describe('migration 012 — the rebuild', () => {
  it('is a no-op the second time it runs', () => {
    db.prepare(`INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at)
                VALUES ('rep-1','u-student','event','ev-1','prose','open','2026-08-01T00:00:00Z')`).run();

    unifiedReports.up(db);
    const afterFirst = tableSql(db, 'reports');
    const rowsAfterFirst = db.prepare('SELECT COUNT(*) c FROM reports').get().c;

    expect(() => unifiedReports.up(db)).not.toThrow();
    expect(tableSql(db, 'reports')).toBe(afterFirst);
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c).toBe(rowsAfterFirst);
  });

  /**
   * `reason` becomes `description` and `category` backfills to `'other'` —
   * existing rows carry free text that was always the reporter's own words, and
   * no category was ever collected, so inventing one would be a fabricated
   * record. `priority` backfills to `normal` because a historical report cannot
   * be triaged retroactively by software, and marking them all urgent would bury
   * the live queue on day one.
   */
  it('carries pre-012 rows across, row by row', () => {
    db.prepare(`INSERT INTO reports
        (id, reporter_id, reporter_name_snapshot, target_type, target_id,
         target_body_snapshot, target_author_id, target_author_name_snapshot,
         reason, status, created_at)
      VALUES ('rep-ev','u-student','Student','event','ev-1','Beach Cleanup','u-org','Organizer',
              'this listing is misleading','open','2026-08-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO reports
        (id, reporter_id, reporter_name_snapshot, target_type, target_id,
         target_body_snapshot, target_author_id, target_author_name_snapshot,
         reason, status, created_at)
      VALUES ('rep-cm','u-student','Student','comment','cm-1','a comment body','u-org','Organizer',
              'abusive','dismissed','2026-08-02T00:00:00Z')`).run();

    unifiedReports.up(db);

    const ev = db.prepare('SELECT * FROM reports WHERE id = ?').get('rep-ev');
    expect(ev.description, 'the reporter’s own words were dropped').toBe('this listing is misleading');
    expect(ev.category).toBe('other');
    expect(ev.priority).toBe('normal');
    expect(ev.status).toBe('open');
    expect(ev.target_name_snapshot).toBe('Beach Cleanup');
    expect(ev.target_role_snapshot).toBe('organizer');
    expect(ev.event_id_snapshot).toBe('ev-1');
    expect(ev.updated_at).toBe(ev.created_at);

    const cm = db.prepare('SELECT * FROM reports WHERE id = ?').get('rep-cm');
    expect(cm.status, 'a closed report was reopened by the copy').toBe('dismissed');
    expect(cm.target_name_snapshot).toBe('Comment on “Beach Cleanup”');
    expect(cm.event_id_snapshot).toBe('ev-1');
  });

  it('accepts all seven target types and refuses an eighth', () => {
    unifiedReports.up(db);
    const insert = (id, type) => db.prepare(
      `INSERT INTO reports (id, target_type, target_id, category, status, priority, created_at, updated_at)
       VALUES (?, ?, 'x', 'other', 'open', 'normal', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
    ).run(id, type);

    for (const t of ['event', 'comment', 'message', 'conversation', 'user', 'announcement', 'certificate']) {
      expect(() => insert(`t-${t}`, t), `${t} was refused`).not.toThrow();
    }
    expect(() => insert('t-bad', 'organizer'),
      'organizer must be an alias resolved before the write, never a stored value').toThrow();
  });

  it('accepts all five statuses and both priorities, and refuses anything else', () => {
    unifiedReports.up(db);
    const insert = (id, status, priority = 'normal') => db.prepare(
      `INSERT INTO reports (id, target_type, target_id, category, status, priority, created_at, updated_at)
       VALUES (?, 'event', 'x', 'other', ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
    ).run(id, status, priority);

    for (const s of ['open', 'reviewing', 'escalated', 'resolved', 'dismissed']) {
      expect(() => insert(`s-${s}`, s), `${s} was refused`).not.toThrow();
    }
    expect(() => insert('s-bad', 'closed')).toThrow();
    expect(() => insert('p-bad', 'open', 'critical')).toThrow();
  });

  /**
   * `category` deliberately carries no CHECK. The list changes as students tell
   * us what is happening to them, and a CHECK on it buys a table rebuild every
   * time one is added; validation lives at the route, where a bad value is a 400
   * naming the valid ones rather than a SQLite constraint failure.
   */
  it('leaves category unconstrained at the database', () => {
    unifiedReports.up(db);
    expect(() => db.prepare(
      `INSERT INTO reports (id, target_type, target_id, category, status, priority, created_at, updated_at)
       VALUES ('c-new','event','x','a_category_invented_next_year','open','normal','t','t')`
    ).run()).not.toThrow();
  });

  // ── Guard 4 ────────────────────────────────────────────────────────────────
  it('refuses a reports table carrying a column it does not know about', () => {
    db.exec('ALTER TABLE reports ADD COLUMN pilot_only_note TEXT');
    expect(() => unifiedReports.up(db)).toThrow(/unexpected columns \[pilot_only_note\]/);
  });

  it('refuses a reports table missing a column it expects', () => {
    db.exec('ALTER TABLE reports DROP COLUMN reporter_name_snapshot');
    expect(() => unifiedReports.up(db)).toThrow(/missing expected columns/);
  });

  it('names the same columns the migration actually copies', () => {
    expect([...EXPECTED_REPORT_COLUMNS].sort()).toEqual([...cols(db, 'reports')].sort());
  });

  // ── Guard 2 ────────────────────────────────────────────────────────────────
  /**
   * The guard nothing else catches. `PRAGMA foreign_keys = OFF` is a silent
   * no-op inside an open transaction, so a rebuild that ran there would drop the
   * table with foreign keys still enforced and cascade its children away. The
   * migration must abort rather than proceed.
   */
  it('aborts rather than rebuilding inside an already-open transaction', () => {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN');
    try {
      expect(() => unifiedReports.up(db)).toThrow(/did not take effect|transaction/i);
    } finally {
      db.exec('ROLLBACK');
    }
    expect(cols(db, 'reports'), 'the table was rebuilt anyway').not.toContain('priority');
  });

  // ── Guard 5 ────────────────────────────────────────────────────────────────
  /**
   * Vacuous today and that is the point: nothing references `reports` at 012, so
   * the rebuild happens at the last moment the destructive step is free. 013
   * gives the table children. This proves the guard works BEFORE it has to.
   */
  it('preserves the rows of a table that holds a foreign key to reports', () => {
    db.exec(`
      CREATE TABLE report_notes (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE
      );
    `);
    db.prepare(`INSERT INTO reports (id, target_type, target_id, reason, status, created_at)
                VALUES ('rep-1','event','ev-1','prose','open','2026-08-01T00:00:00Z')`).run();
    db.prepare("INSERT INTO report_notes (id, report_id) VALUES ('n-1','rep-1')").run();

    unifiedReports.up(db);

    expect(
      db.prepare('SELECT COUNT(*) c FROM report_notes').get().c,
      'a child row cascaded away under the rebuild',
    ).toBe(1);
  });

  // ── Guard 6 ────────────────────────────────────────────────────────────────
  it('leaves no foreign key violations behind', () => {
    db.prepare(`INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at)
                VALUES ('rep-1','u-student','event','ev-1','prose','open','2026-08-01T00:00:00Z')`).run();
    unifiedReports.up(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('restores the foreign_keys pragma it turned off', () => {
    db.exec('PRAGMA foreign_keys = ON');
    unifiedReports.up(db);
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  // ── Indexes and triggers ───────────────────────────────────────────────────
  /**
   * `DROP TABLE` takes indexes and triggers with it. A rebuild that forgot the
   * triggers would silently un-freeze every report in the table, and nothing
   * would fail until somebody edited one.
   */
  it('recreates every index the queue and the holds depend on', () => {
    unifiedReports.up(db);
    const indexes = objectNames(db, 'index');
    for (const name of [
      'idx_reports_target', 'idx_reports_status', 'idx_reports_queue',
      'idx_reports_assignee', 'idx_reports_author', 'idx_reports_reporter',
      'idx_reports_conversation', 'idx_reports_event', 'idx_reports_no_dup',
    ]) {
      expect(indexes, `${name} is missing after the rebuild`).toContain(name);
    }
  });

  it('recreates the immutability triggers', () => {
    unifiedReports.up(db);
    const t = objectNames(db, 'trigger');
    expect(t).toContain('reports_no_delete');
    expect(t).toContain('reports_immutable');
  });

  it('suppresses a second live report of the same target by the same reporter', () => {
    unifiedReports.up(db);
    const file = (id, status = 'open') => db.prepare(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, category, status, priority, created_at, updated_at)
       VALUES (?, 'u-student', 'event', 'ev-1', 'other', ?, 'normal', 't', 't')`
    ).run(id, status);

    file('d-1');
    expect(() => file('d-2')).toThrow(/UNIQUE/);
    // ...and every live status counts, not just 'open'.
    db.prepare("UPDATE reports SET status = 'escalated' WHERE id = 'd-1'").run();
    expect(() => file('d-3'), 'an escalated report is still live').toThrow(/UNIQUE/);

    db.prepare("UPDATE reports SET status = 'resolved' WHERE id = 'd-1'").run();
    expect(() => file('d-4'), 'a closed report must not block a fresh one').not.toThrow();
  });

  it('does not suppress two reporters reporting the same thing', () => {
    unifiedReports.up(db);
    const file = (id, reporter) => db.prepare(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, category, status, priority, created_at, updated_at)
       VALUES (?, ?, 'event', 'ev-1', 'other', 'open', 'normal', 't', 't')`
    ).run(id, reporter);
    file('r-1', 'u-student');
    expect(() => file('r-2', 'u-org')).not.toThrow();
  });
});

describe('migration 013 — evidence and the fold', () => {
  beforeEach(() => { unifiedReports.up(db); });

  it('is a no-op the second time it runs, including the backfill', () => {
    legacyReport(db, { id: 'msg-report-1', reason: 'safety' });
    db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                VALUES ('msg-report-1','m-1','u-org','said something','2026-08-01T00:00:00Z')`).run();

    reportEvidenceAndFold.up(db);
    const reports = db.prepare('SELECT COUNT(*) c FROM reports').get().c;
    const evidence = db.prepare('SELECT COUNT(*) c FROM report_evidence').get().c;

    expect(() => reportEvidenceAndFold.up(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c,
      'the fold duplicated every historical report').toBe(reports);
    expect(db.prepare('SELECT COUNT(*) c FROM report_evidence').get().c).toBe(evidence);
  });

  /** Whether the pilot database holds any legacy rows at all is unknown from
   *  here, so the backfill has to be correct at zero. */
  it('is correct with no legacy reports at all', () => {
    expect(() => reportEvidenceAndFold.up(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c).toBe(0);
    expect(cols(db, 'report_evidence')).toContain('sender_name_snapshot');
  });

  it('folds a legacy report into reports, keeping its id', () => {
    legacyReport(db, { id: 'msg-report-7', reason: 'safety', details: 'he asked to meet me' });
    db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                VALUES ('msg-report-7','m-1','u-org','meet me alone','2026-08-01T00:00:00Z')`).run();

    reportEvidenceAndFold.up(db);

    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get('msg-report-7');
    expect(row, 'the legacy report did not fold').toBeTruthy();
    expect(row.target_type).toBe('conversation');
    expect(row.target_id).toBe('conv-1');
    expect(row.conversation_id_snapshot).toBe('conv-1');
    expect(row.description, 'the reporter’s own words are the authoritative content')
      .toBe('he asked to meet me');
    expect(row.target_author_id).toBe('u-org');
    expect(row.target_name_snapshot).toBe('Conversation about “Beach Cleanup”');

    const evidence = db.prepare('SELECT * FROM report_evidence WHERE report_id = ?').get('msg-report-7');
    expect(evidence.body).toBe('meet me alone');
    expect(evidence.sender_name_snapshot, 'a purged sender leaves an unattributable accusation')
      .toBe('Organizer');
  });

  it.each([
    ['safety', 'something_feels_wrong', 'urgent'],
    ['inappropriate', 'bullying_or_harassment', 'normal'],
    ['spam', 'spam_or_advertising', 'normal'],
    ['other', 'other', 'normal'],
  ])('maps the legacy reason %s onto %s at %s priority', (reason, category, priority) => {
    legacyReport(db, { id: `msg-report-${reason}`, reason });
    reportEvidenceAndFold.up(db);
    const row = db.prepare('SELECT category, priority FROM reports WHERE id = ?').get(`msg-report-${reason}`);
    expect(row.category).toBe(category);
    expect(row.priority).toBe(priority);
  });

  it('carries the legacy status across rather than reopening closed reports', () => {
    legacyReport(db, { id: 'msg-report-closed', reason: 'spam', status: 'resolved' });
    reportEvidenceAndFold.up(db);
    expect(db.prepare('SELECT status FROM reports WHERE id = ?').get('msg-report-closed').status)
      .toBe('resolved');
  });

  /**
   * The legacy tables stay, frozen. Dropping them is the precise shape of
   * destruction this whole phase exists to prevent, and they are a second copy of
   * evidence — which is a good thing for evidence to have.
   */
  it('leaves both legacy tables and every row in them exactly where they were', () => {
    legacyReport(db, { id: 'msg-report-keep', reason: 'safety' });
    db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                VALUES ('msg-report-keep','m-1','u-org','still here','2026-08-01T00:00:00Z')`).run();

    reportEvidenceAndFold.up(db);

    expect(db.prepare('SELECT COUNT(*) c FROM conversation_reports').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM conversation_report_messages').get().c).toBe(1);
    expect(db.prepare('SELECT body FROM conversation_report_messages').get().body).toBe('still here');
  });

  /**
   * `evidenceHolds.js` reads the unified table only from here on. That is safe
   * exactly as far as the fold is exhaustive — a legacy report left behind is a
   * live investigation whose delete hold nothing enforces, which is silent, and
   * silent is the failure PR-1 existed to end. The migration asserts it rather
   * than assuming it, so this asserts the assertion holds over a mixed set.
   */
  it('folds every legacy report, whatever its reason or status', () => {
    const cases = [
      ['msg-report-a', 'safety', 'open'],
      ['msg-report-b', 'inappropriate', 'reviewing'],
      ['msg-report-c', 'spam', 'resolved'],
      ['msg-report-d', 'other', 'dismissed'],
    ];
    // A conversation each: two LIVE legacy reports of the same conversation by
    // the same reporter collide with `idx_reports_no_dup` and abort the fold.
    // That is a real defect, isolated in its own case below; this one is about
    // the reason and status mapping.
    for (const [id, reason, status] of cases) {
      legacyReport(db, { id, reason, status, conversationId: `conv-${id}` });
      db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                  VALUES (?, ?, 'u-org', 'body', '2026-08-01T00:00:00Z')`).run(id, `${id}-m1`);
    }

    reportEvidenceAndFold.up(db);

    expect(
      db.prepare(`SELECT COUNT(*) c FROM conversation_reports cr
                  WHERE NOT EXISTS (SELECT 1 FROM reports r WHERE r.id = cr.id)`).get().c,
      'a legacy report was left behind with no delete hold',
    ).toBe(0);
    expect(
      db.prepare(`SELECT COUNT(*) c FROM conversation_report_messages crm
                  WHERE NOT EXISTS (SELECT 1 FROM report_evidence re
                                    WHERE re.report_id = crm.report_id
                                      AND re.message_id = crm.message_id)`).get().c,
      'snapshotted evidence did not migrate',
    ).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c).toBe(cases.length);
  });

  /**
   * Ids are preserved, which is what keeps an external reference to a report —
   * an email to a moderator, a note in a district's file — valid across the fold.
   *
   * Note for whoever next reads the exhaustiveness guard: it is keyed on the same
   * `id` predicate the INSERT skips on, so a pre-existing `reports` row occupying
   * a legacy id would satisfy the guard without the legacy report having folded.
   * Unreachable today (new ids are `rep_<hex>`, legacy ones are `msg-report-*`)
   * and recorded here so it stays that way.
   */
  it('preserves legacy report ids across the fold', () => {
    legacyReport(db, { id: 'msg-report-external-ref', reason: 'safety' });
    reportEvidenceAndFold.up(db);
    expect(db.prepare('SELECT id FROM reports').get().id).toBe('msg-report-external-ref');
  });

  /* ── Duplicate legacy reports ─────────────────────────────────────────────
   *
   * `idx_reports_no_dup` (migration 012) is UNIQUE on
   * `(reporter_id, target_type, target_id)` for live statuses. The legacy table
   * had no such constraint and the old conversation modal had no client-side
   * guard, so one student double-tapping "Send report" left two live rows —
   * which is the exact behaviour duplicate suppression was later added to
   * prevent, and therefore evidence that it happened.
   *
   * A fold that inserts them both throws, and the registry runs migrations at
   * boot, so the failure mode was a server that would not start against ordinary
   * pilot data — with 012 already committed and `report_evidence` missing.
   */

  it('folds two live legacy reports of the same conversation without colliding', () => {
    legacyReport(db, { id: 'msg-report-dup-1', reason: 'safety', status: 'open' });
    legacyReport(db, { id: 'msg-report-dup-2', reason: 'safety', status: 'open' });

    expect(() => reportEvidenceAndFold.up(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c).toBe(2);
  });

  /**
   * Oldest survives, and it is the oldest rather than the newest because the
   * hold, the queue position and the one-business-day promise are all about when
   * the student first asked for help.
   */
  it('keeps the oldest live duplicate and dismisses the later one', () => {
    legacyReport(db, {
      id: 'msg-report-first', reason: 'safety', details: 'the first time',
      status: 'open', createdAt: '2026-08-01T00:00:00Z',
    });
    legacyReport(db, {
      id: 'msg-report-second', reason: 'safety', details: 'it happened again',
      status: 'reviewing', createdAt: '2026-08-09T00:00:00Z',
    });

    reportEvidenceAndFold.up(db);

    const first = db.prepare('SELECT * FROM reports WHERE id = ?').get('msg-report-first');
    const second = db.prepare('SELECT * FROM reports WHERE id = ?').get('msg-report-second');

    expect(first.status, 'the earliest cry for help was the one closed').toBe('open');
    expect(first.resolution).toBeNull();

    expect(second.status).toBe('dismissed');
    expect(second.resolution).toBe('duplicate');
    expect(second.resolution_note, 'the note must name the report that survived')
      .toContain('msg-report-first');
    expect(second.resolved_by, 'no person decided this — a migration did').toBeNull();
    expect(second.resolved_at).toBeTruthy();
  });

  it('leaves the demoted duplicate its own words and its own evidence', () => {
    legacyReport(db, { id: 'msg-report-keep-1', reason: 'safety', details: 'first account' });
    legacyReport(db, { id: 'msg-report-keep-2', reason: 'safety', details: 'second account' });
    for (const id of ['msg-report-keep-1', 'msg-report-keep-2']) {
      db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                  VALUES (?, ?, 'u-org', ?, '2026-08-01T00:00:00Z')`)
        .run(id, `${id}-m1`, `body for ${id}`);
    }

    reportEvidenceAndFold.up(db);

    const demoted = db.prepare(
      "SELECT * FROM reports WHERE resolution = 'duplicate'"
    ).get();
    expect(demoted, 'nothing was demoted').toBeTruthy();
    expect(demoted.description, 'the reporter’s own words were discarded').toBeTruthy();
    expect(
      db.prepare('SELECT COUNT(*) c FROM report_evidence WHERE report_id = ?').get(demoted.id).c,
      'a demoted duplicate lost its preserved messages',
    ).toBe(1);
  });

  it('records the demotion in the report’s own history, attributed to nobody', () => {
    legacyReport(db, { id: 'msg-report-hist-1', reason: 'safety' });
    legacyReport(db, { id: 'msg-report-hist-2', reason: 'safety' });
    reportEvidenceAndFold.up(db);

    const demoted = db.prepare("SELECT id FROM reports WHERE resolution = 'duplicate'").get();
    const action = db.prepare(
      "SELECT * FROM moderation_actions WHERE report_id = ? AND action = 'folded_duplicate'"
    ).get(demoted.id);
    expect(action, 'a migration closed a report with no trace in its history').toBeTruthy();
    expect(action.actor_id).toBeNull();
    expect(action.new_resolution).toBe('duplicate');
  });

  it('does not demote a duplicate whose reporter has been purged', () => {
    // The unique index is partial on `reporter_id IS NOT NULL`, so these cannot
    // collide — and two reports from purged accounts are not known to be from the
    // same person.
    legacyReport(db, { id: 'msg-report-null-1', reason: 'safety', reporter: null });
    legacyReport(db, { id: 'msg-report-null-2', reason: 'safety', reporter: null });

    reportEvidenceAndFold.up(db);

    expect(db.prepare("SELECT COUNT(*) c FROM reports WHERE status = 'open'").get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM reports WHERE resolution = 'duplicate'").get().c).toBe(0);
  });

  it('does not touch an already-closed legacy duplicate', () => {
    legacyReport(db, { id: 'msg-report-closed-1', reason: 'safety', status: 'resolved' });
    legacyReport(db, { id: 'msg-report-closed-2', reason: 'safety', status: 'dismissed' });
    legacyReport(db, { id: 'msg-report-closed-3', reason: 'safety', status: 'open' });

    reportEvidenceAndFold.up(db);

    // A closed report is outside the partial index, so it cannot collide, and
    // rewriting a historical outcome to satisfy a constraint it is not subject to
    // would be a fabricated record.
    expect(db.prepare('SELECT status FROM reports WHERE id = ?').get('msg-report-closed-1').status)
      .toBe('resolved');
    expect(db.prepare('SELECT resolution FROM reports WHERE id = ?').get('msg-report-closed-1').resolution)
      .toBeNull();
    expect(db.prepare('SELECT status FROM reports WHERE id = ?').get('msg-report-closed-3').status)
      .toBe('open');
  });

  it('does not treat two different reporters as duplicates of each other', () => {
    db.prepare("INSERT INTO users (id, name, role) VALUES ('u-student2','Other','student')").run();
    legacyReport(db, { id: 'msg-report-p1', reason: 'safety' });
    legacyReport(db, { id: 'msg-report-p2', reason: 'safety', reporter: 'u-student2' });

    reportEvidenceAndFold.up(db);

    expect(db.prepare("SELECT COUNT(*) c FROM reports WHERE status = 'open'").get().c,
      'two people reporting the same thing is corroboration, not duplication').toBe(2);
  });

  it('does not treat one reporter’s two different conversations as duplicates', () => {
    legacyReport(db, { id: 'msg-report-c1', reason: 'safety', conversationId: 'conv-a' });
    legacyReport(db, { id: 'msg-report-c2', reason: 'safety', conversationId: 'conv-b' });

    reportEvidenceAndFold.up(db);

    expect(db.prepare("SELECT COUNT(*) c FROM reports WHERE status = 'open'").get().c).toBe(2);
  });

  it('picks the same survivor deterministically when timestamps tie', () => {
    legacyReport(db, { id: 'msg-report-tie-b', reason: 'safety' });
    legacyReport(db, { id: 'msg-report-tie-a', reason: 'safety' });

    reportEvidenceAndFold.up(db);

    // Tie broken by id, so a re-run — and a second database — reach the same answer.
    expect(db.prepare('SELECT status FROM reports WHERE id = ?').get('msg-report-tie-a').status)
      .toBe('open');
    expect(db.prepare('SELECT status FROM reports WHERE id = ?').get('msg-report-tie-b').status)
      .toBe('dismissed');
  });

  it('de-duplicates a group of five without leaving two live', () => {
    for (let i = 1; i <= 5; i++) {
      legacyReport(db, { id: `msg-report-many-${i}`, reason: 'safety' });
    }
    reportEvidenceAndFold.up(db);

    expect(db.prepare("SELECT COUNT(*) c FROM reports WHERE status = 'open'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM reports WHERE resolution = 'duplicate'").get().c).toBe(4);
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c,
      'a duplicate was dropped rather than demoted').toBe(5);
  });

  /**
   * The state the fold produces must be one `idx_reports_no_dup` would accept —
   * otherwise the next database to run 013 from scratch throws at the INSERT
   * instead, at boot, which is the failure this whole section exists to prevent.
   */
  it('leaves a state the duplicate index would accept', () => {
    for (let i = 1; i <= 3; i++) legacyReport(db, { id: `msg-report-idx-${i}`, reason: 'safety' });
    reportEvidenceAndFold.up(db);

    expect(db.prepare(`
      SELECT COUNT(*) c FROM (
        SELECT 1 FROM reports
         WHERE status IN ('open','reviewing','escalated') AND reporter_id IS NOT NULL
         GROUP BY reporter_id, target_type, target_id HAVING COUNT(*) > 1)
    `).get().c).toBe(0);
  });

  it('is still idempotent with duplicates present', () => {
    for (let i = 1; i <= 3; i++) {
      legacyReport(db, { id: `msg-report-idem-${i}`, reason: 'safety' });
      db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                  VALUES (?, ?, 'u-org', 'body', '2026-08-01T00:00:00Z')`)
        .run(`msg-report-idem-${i}`, `m-${i}`);
    }

    reportEvidenceAndFold.up(db);
    const snapshot = db.prepare(
      'SELECT id, status, resolution FROM reports ORDER BY id'
    ).all();
    const actions = db.prepare('SELECT COUNT(*) c FROM moderation_actions').get().c;

    expect(() => reportEvidenceAndFold.up(db)).not.toThrow();
    expect(db.prepare('SELECT id, status, resolution FROM reports ORDER BY id').all(),
      'a second pass changed the outcome').toEqual(snapshot);
    expect(db.prepare('SELECT COUNT(*) c FROM moderation_actions').get().c,
      'the demotion was recorded twice').toBe(actions);
    expect(db.prepare('SELECT COUNT(*) c FROM report_evidence').get().c).toBe(3);
  });

  /**
   * A restart after a failed boot must be able to finish the job. 013 runs inside
   * the registry's own transaction, so a throw rolls it back entirely — the
   * database is left at 012, and the next boot re-runs 013 from a clean slate.
   */
  it('completes on a retry after an interrupted first attempt', () => {
    for (let i = 1; i <= 3; i++) legacyReport(db, { id: `msg-report-retry-${i}`, reason: 'safety' });

    // Simulate the registry's rollback: nothing from a failed attempt survives.
    db.exec('BEGIN');
    reportEvidenceAndFold.up(db);
    db.exec('ROLLBACK');

    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c).toBe(0);
    expect(() => reportEvidenceAndFold.up(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM reports').get().c).toBe(3);
  });

  it('freezes report_evidence against editing and deletion', () => {
    legacyReport(db, { id: 'msg-report-frozen', reason: 'safety' });
    db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                VALUES ('msg-report-frozen','m-1','u-org','frozen','2026-08-01T00:00:00Z')`).run();
    reportEvidenceAndFold.up(db);

    expect(() => db.prepare("UPDATE report_evidence SET body = 'rewritten'").run())
      .toThrow(/never edited/);
    expect(() => db.prepare('DELETE FROM report_evidence').run()).toThrow(/never deleted/);
    expect(db.prepare('SELECT COUNT(*) c FROM report_evidence').get().c).toBe(1);
  });

  /**
   * `message_id` deliberately carries NO foreign key to `messages`: a snapshot
   * whose rows vanish with the message it snapshotted is not a snapshot.
   */
  it('holds evidence that outlives the message it was taken from', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(report_evidence)').all();
    expect(fks.map(f => f.from)).not.toContain('message_id');
  });

  it('refuses to delete a report that has evidence attached', () => {
    db.exec('PRAGMA foreign_keys = ON');
    legacyReport(db, { id: 'msg-report-restrict', reason: 'safety' });
    db.prepare(`INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
                VALUES ('msg-report-restrict','m-1','u-org','held','2026-08-01T00:00:00Z')`).run();
    reportEvidenceAndFold.up(db);

    // The trigger refuses first; RESTRICT is the second lock behind it.
    expect(() => db.prepare('DELETE FROM reports WHERE id = ?').run('msg-report-restrict'))
      .toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM report_evidence').get().c).toBe(1);
  });
});
