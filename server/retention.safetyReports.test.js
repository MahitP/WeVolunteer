/**
 * Safety-report retention — an intentional decision, pinned.
 *
 * ── The question this file answers ──
 *
 * The Privacy Policy used to say safety reports are kept "indefinitely", and then
 * admitted in the next paragraph that this was "the honest description of what the
 * software does today, not a considered retention period". That limbo is what this
 * file removes: indefinite retention of the report record is now a decision, with
 * reasons, enforced at the database level and asserted here.
 *
 * ── Why indefinite, and why not a timer ──
 *
 * A timer was designed and rejected. Redacting evidence bodies after N years would
 * require weakening `report_evidence_no_update`, and that trigger exists because the
 * party most motivated to destroy safety evidence is the party it is about. Opening
 * a mutation path for an automated worker opens the same path for a bug or a
 * compromised administrator, and the first thing it could damage is an OPEN
 * investigation. The privacy gained by blanking a message body after several years is
 * smaller than the safety lost by making frozen evidence editable at all.
 *
 * The claim window is the other half. New Jersey gives someone who was a minor at the
 * time a very long time to bring a claim, and for child sexual-abuse claims
 * N.J.S.A. 2A:14-2a extends it dramatically further. A report deleted inside that
 * window destroys the record that protects the student who filed it at least as much
 * as it protects the operator.
 *
 * ── What is NOT kept ──
 *
 * This is the part that makes the decision proportionate, and it is asserted below.
 * The report keeps its own minimal record — what was reported, the decision, and
 * name snapshots taken at the time. It does not keep the reporter's account: a
 * deleted account is still anonymised and still purged on schedule, and the ordinary
 * three-year message sweep still removes everything in a reported conversation that
 * the evidence snapshot did not capture, once the report is closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;
let sweep, PRESERVED_TABLES, RETENTION;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ sweep, PRESERVED_TABLES, RETENTION } = await import('./workers/retentionWorker.js'));
});
afterAll(async () => { await srv.close(); });

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

let seq = 0;

/** A resolved report with one frozen evidence row, aged well past every window. */
function seedResolvedReport({ ageDays }) {
  const n = ++seq;
  const reporter = `sr-reporter-${n}`;
  const subject = `sr-subject-${n}`;
  const reportId = `sr-report-${n}`;
  const at = daysAgo(ageDays);

  for (const [id, role, grade] of [[reporter, 'student', '10'], [subject, 'organizer', 'Adult']]) {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, grade, username,
                         email_verified, account_status, created_at)
      VALUES (?, ?, 'h', 'Safety Fixture', ?, ?, ?, 1, 'active', '${new Date().toISOString()}')
    `).run(id, `${id}@example.com`, role, grade, id.replace(/-/g, '_'));
  }

  db.prepare(`
    INSERT INTO reports (id, reporter_id, reporter_name_snapshot, target_type, target_id,
                         target_author_id, category, priority, status, resolution,
                         description, created_at, updated_at, resolved_at)
    VALUES (?, ?, 'Safety Fixture', 'user', ?, ?, 'threatened_me', 'urgent',
            'resolved', 'account_suspended', 'd', ?, ?, ?)
  `).run(reportId, reporter, subject, subject, at, at, at);

  db.prepare(`
    INSERT INTO report_evidence (report_id, message_id, sender_id, sender_name_snapshot,
                                 body, created_at, captured_at)
    VALUES (?, ?, ?, 'Safety Fixture', 'the message that was reported', ?, ?)
  `).run(reportId, `sr-msg-${n}`, subject, at, at);

  return { reportId, reporter, subject };
}

describe('the decision is enforced by the database, not by convention', () => {
  it('names reports and their evidence as tables the sweep must never touch', () => {
    // If a future sweep widens onto one of these, `assertPreservedTablesUntouched`
    // throws inside the transaction and rolls back. That is what makes indefinite
    // retention a guarantee rather than an intention.
    for (const table of ['reports', 'report_evidence', 'moderation_actions',
      'appeals', 'appeal_events', 'conversation_reports', 'conversation_report_messages']) {
      expect(PRESERVED_TABLES, `${table} is not protected from the sweep`).toContain(table);
    }
  });

  it('publishes no retention period for reports, because there deliberately is none', () => {
    // Every other retained category has a number. The absence of one here is the
    // decision — and it must stay absent rather than drift into an unenforced value,
    // which is exactly what happened to applications before this release.
    expect(RETENTION.reportDays).toBeUndefined();
    expect(RETENTION.safetyReportDays).toBeUndefined();
  });

  it('refuses to delete a resolved report, at the database', async () => {
    const { reportId } = seedResolvedReport({ ageDays: 8 * 365 });
    await expect(async () => db.prepare('DELETE FROM reports WHERE id = ?').run(reportId)).rejects
      .toThrow(/never deleted|no_delete|ABORT/i);
  });

  it('refuses to edit or blank a frozen evidence body, however old', async () => {
    const { reportId } = seedResolvedReport({ ageDays: 12 * 365 });
    await expect(async () => db.prepare(
      "UPDATE report_evidence SET body = '[redacted]' WHERE report_id = ?"
    ).run(reportId)).rejects.toThrow(/frozen|never edited|ABORT/i);
    await expect(async () => db.prepare('DELETE FROM report_evidence WHERE report_id = ?').run(reportId)).rejects
      .toThrow(/ABORT|never/i);
  });

  it('leaves a decade-old resolved report and its evidence in place after a sweep', async () => {
    const { reportId } = seedResolvedReport({ ageDays: 10 * 365 });
    await sweep(db);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM reports WHERE id = ?').get(reportId)).c).toBe(1);
    expect(
      (await db.prepare('SELECT COUNT(*) AS c FROM report_evidence WHERE report_id = ?').get(reportId)).c
    ).toBe(1);
  });
});

describe('what the decision does NOT extend to', () => {
  /**
   * The proportionality half.
   *
   * Keeping the report is not the same as keeping the person. A reporter who deletes
   * their account is still anonymised, and the report keeps only the name snapshot it
   * took at the time — which is what lets the report survive without the profile
   * surviving with it.
   */
  it('keeps the name snapshot rather than the live account', () => {
    const { reportId, reporter } = seedResolvedReport({ ageDays: 5 * 365 });

    // The account is anonymised the way DELETE /api/auth/account anonymises it.
    db.prepare(`
      UPDATE users SET name = 'Safety F.', email = ?, username = ?,
                       account_status = 'deleted', deleted_at = ?
       WHERE id = ?
    `).run(`deleted_${reporter}@system.local`, `deleted_${reporter}`, daysAgo(1), reporter);

    const row = db.prepare(
      'SELECT reporter_id, reporter_name_snapshot FROM reports WHERE id = ?'
    ).get(reportId);

    // The report still says who filed it, from the snapshot — not from the account,
    // which no longer carries the name.
    expect(row.reporter_name_snapshot).toBe('Safety Fixture');
    expect(db.prepare('SELECT name FROM users WHERE id = ?').get(reporter).name).toBe('Safety F.');
  });

  it('still applies the ordinary message sweep to a CLOSED report\'s conversation', () => {
    // The evidence snapshot is frozen; the rest of the thread is not. A resolved
    // report stops holding the conversation open, so the ordinary three-year period
    // resumes — which is what keeps this from becoming a second indefinite class of
    // data covering every message a reported thread ever contained.
    expect(RETENTION.messageDays).toBe(3 * 365);
  });
});
