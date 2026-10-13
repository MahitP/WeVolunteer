import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Retention enforcement.
 *
 * ── What went wrong before this existed ──
 *
 * The Privacy Policy published retention periods — messages 3 years, audit logs
 * 1 year, anonymised shells 3 years — and nothing deleted anything. Publishing
 * a period you do not enforce is worse than publishing none: it turns an
 * absence into a representation about data handling, which is precisely the
 * kind FTC Act §5 reaches.
 *
 * ── The tests that matter most ──
 *
 * Not "old rows were deleted". Those are easy and obvious. The two that carry
 * the weight are:
 *
 *   1. **Certificates and hours survive, always.** A sweep that quietly widened
 *      would destroy the one thing this platform exists to build, and it would
 *      be discovered years later by a student who needed it.
 *   2. **Reported messages survive past their window.** Deletion must never
 *      silently destroy moderation evidence — an investigation opened at two
 *      years and eleven months would otherwise find its evidence gone.
 *
 * Time travel is by injected `now`, which is why `sweep()` takes it. A
 * retention test that cannot move the clock cannot test retention.
 */

let srv;
let db;
let sweep, RETENTION, preservedCounts, assertPreservedTablesUntouched;
let recordAudit;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ sweep, RETENTION, preservedCounts, assertPreservedTablesUntouched } =
    await import('./workers/retentionWorker.js'));
  ({ recordAudit } = await import('./auditLog.js'));
});
afterAll(async () => { await srv.close(); });

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/**
 * A message of a given age, inside one shared fixture conversation.
 *
 * `conversations` is UNIQUE on (student_id, organizer_id, event_id), so one
 * conversation is created for the whole file and messages are hung off it —
 * the age of the MESSAGE is what the sweep reads, not the conversation's.
 */
let fixtureConvId = null;
async function fixtureConversation() {
  if (fixtureConvId) return fixtureConvId;
  const existing = await db.prepare(`
    SELECT id FROM conversations
    WHERE student_id = 'user-student-1' AND organizer_id = 'user-org-1' AND event_id = 'event-pantry-past'
  `).get();
  if (existing) { fixtureConvId = existing.id; return fixtureConvId; }

  fixtureConvId = `conv-ret-${Date.now()}`;
  await db.prepare(`
    INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
    VALUES (?, 'event-pantry-past', 'user-student-1', 'user-org-1', 'user-student-1', ?)
  `).run(fixtureConvId, daysAgo(2000));
  return fixtureConvId;
}

async function seedMessage(ageDays, id = `msg-ret-${Math.random().toString(36).slice(2, 9)}`) {
  const convId = await fixtureConversation();
  await db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
    VALUES (?, ?, 'user-student-1', 'retention fixture', ?)
  `).run(id, convId, daysAgo(ageDays));
  return { id, convId };
}

/**
 * An audit row of a given age.
 *
 * Inserted via `recordAudit` and then aged with an UPDATE, rather than written
 * directly: `auditLog.test.js` enforces that the helper is the only writer of
 * this table in server/, because it owns the UUID generation that fixed a real
 * primary-key collision between two deletions in the same millisecond.
 */
async function seedAudit(marker, ageDays) {
  const { id } = await recordAudit(db, {
    adminId: 'user-admin',
    action: 'RETENTION_FIXTURE',
    details: marker,
    createdAt: daysAgo(ageDays)
  });
  return id;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM messages WHERE body = 'retention fixture'").run();
  await db.prepare("DELETE FROM admin_audit_logs WHERE action = 'RETENTION_FIXTURE'").run();
});

describe('the sweep deletes what the policy says it deletes', () => {
  it('removes messages past the published window', async () => {
    const stale = await seedMessage(RETENTION.messageDays + 30);
    const fresh = await seedMessage(10);

    await sweep(db, { now: new Date() });

    expect(await db.prepare('SELECT 1 FROM messages WHERE id = ?').get(stale.id)).toBeFalsy();
    expect(await db.prepare('SELECT 1 FROM messages WHERE id = ?').get(fresh.id)).toBeTruthy();
  });

  it('keeps a message that is one day inside the window', async () => {
    // Boundary: off-by-one here means deleting a year of messages early, or a
    // year late. Both are policy violations in opposite directions.
    const justInside = await seedMessage(RETENTION.messageDays - 1);
    await sweep(db, { now: new Date() });
    expect(await db.prepare('SELECT 1 FROM messages WHERE id = ?').get(justInside.id)).toBeTruthy();
  });

  it('removes audit rows past their window', async () => {
    // Written through recordAudit, then aged. auditLog.test.js guards that the
    // helper is the ONLY writer of this table anywhere in server/ — a raw
    // INSERT here would pass this test and fail that guard, which is the guard
    // working: the id generation it owns is what fixed a real collision bug.
    const old = await seedAudit('old', RETENTION.auditDays + 30);
    const fresh = await seedAudit('new', 5);

    await sweep(db, { now: new Date() });

    expect(await db.prepare('SELECT 1 FROM admin_audit_logs WHERE id = ?').get(old)).toBeFalsy();
    expect(await db.prepare('SELECT 1 FROM admin_audit_logs WHERE id = ?').get(fresh)).toBeTruthy();
  });

  /**
   * Two-factor security records carry the IP address and browser of every
   * sign-in attempt, and nothing deleted them. They cascade with the user row,
   * but a deleted account's shell is kept while it has hours or a certificate —
   * which for a real volunteer is for ever — so a deleted student's IP history
   * outlived their account indefinitely. Found on 2026-10-12 while checking
   * Privacy Policy 2.0 against the schema. Same period as the administrator
   * audit log, the other record of who did what to an account.
   *
   * Seeded by raw INSERT because the table is append-only (no UPDATE), so a row
   * cannot be written by `recordSecurityEvent` and aged afterwards.
   */
  async function seedSecurityEvent(ageDays) {
    const id = `sec-ret-${Math.random().toString(36).slice(2, 11)}`;
    await db.prepare(`
      INSERT INTO security_audit_logs (id, user_id, event_type, ip_address, user_agent, metadata, created_at)
      VALUES (?, 'user-student-1', '2FA_FAILED', '203.0.113.7', 'retention fixture', NULL, ?)
    `).run(id, daysAgo(ageDays));
    return id;
  }

  it('removes two-factor security records past the audit window', async () => {
    const old = await seedSecurityEvent(RETENTION.auditDays + 30);
    const fresh = await seedSecurityEvent(5);

    const result = await sweep(db, { now: new Date() });

    expect(result.securityEvents).toBeGreaterThanOrEqual(1);
    expect(await db.prepare('SELECT 1 FROM security_audit_logs WHERE id = ?').get(old)).toBeFalsy();
    expect(await db.prepare('SELECT 1 FROM security_audit_logs WHERE id = ?').get(fresh)).toBeTruthy();
  });

  it('keeps a two-factor security record one day inside the window', async () => {
    const justInside = await seedSecurityEvent(RETENTION.auditDays - 1);
    await sweep(db, { now: new Date() });
    expect(await db.prepare('SELECT 1 FROM security_audit_logs WHERE id = ?').get(justInside)).toBeTruthy();
  });

  it('reports counts without deleting when asked for a dry run', async () => {
    await seedMessage(RETENTION.messageDays + 30);
    const result = await sweep(db, { now: new Date(), dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.messages).toBeGreaterThan(0);
    expect(
      (await db.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = 'retention fixture'").get()).c,
      'a dry run must not delete anything'
    ).toBeGreaterThan(0);
  });
});

describe('what retention must NEVER touch', () => {
  it('preserves certificates and attendance across a sweep', async () => {
    const before = await preservedCounts(db);
    expect(before.certificates, 'precondition: the seed has certificates').toBeGreaterThan(0);
    expect(before.attendance, 'precondition: the seed has attendance').toBeGreaterThan(0);

    // Age everything well past every window, so nothing is spared by luck.
    await sweep(db, { now: new Date(Date.now() + 20 * 365 * DAY) });

    const after = await preservedCounts(db);
    expect(
      after.certificates,
      'certificates are retained indefinitely — a certificate that stops verifying is '
      + 'worthless exactly when a college asks about it'
    ).toBe(before.certificates);
    expect(
      after.attendance,
      'credited hours are a service record people come back for years later'
    ).toBe(before.attendance);
  });

  it('has an assertion that fires if a future sweep widens', async () => {
    // Guards the guarantee itself, not just today's behaviour. A convention
    // says "do not widen this"; an assertion notices when somebody does.
    const before = await preservedCounts(db);
    const tampered = { ...before, certificates: before.certificates + 5 };

    /* A rejection now, not a throw: the preserved-table counts are queries, so
       the assertion helper is async. The refusal itself is unchanged. */
    await expect(assertPreservedTablesUntouched(db, tampered))
      .rejects.toThrow(/retained indefinitely|certificates/i);
  });

  it('KEEPS A REPORTED MESSAGE past its retention window', async () => {
    // Deletion must never silently destroy moderation evidence.
    const reported = await seedMessage(RETENTION.messageDays + 60);

    const reportId = `rep-ret-${Date.now()}`;
    await db.prepare(`
      INSERT INTO conversation_reports (id, reporter_id, conversation_id, reason, details, snapshot_created_at, created_at)
      VALUES (?, 'user-student-1', ?, 'safety', 'fixture', ?, ?)
    `).run(reportId, reported.convId, new Date().toISOString(), new Date().toISOString());
    await db.prepare(`
      INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
      VALUES (?, ?, 'user-student-1', 'retention fixture', ?)
    `).run(reportId, reported.id, daysAgo(RETENTION.messageDays + 60));

    await sweep(db, { now: new Date() });

    expect(
      await db.prepare('SELECT 1 FROM messages WHERE id = ?').get(reported.id),
      'an investigation opened at two years and eleven months would otherwise find its '
      + 'evidence deleted underneath it'
    ).toBeTruthy();

    /**
     * The fixture is deliberately NOT cleaned up.
     *
     * It used to delete both rows here so later tests started from a clean
     * slate. Migration 011 made that impossible on purpose: evidence rows take
     * no DELETE at all, from any code path including this one, and the report
     * envelope takes none either. Resolving the report is the supported way to
     * release everything that hangs off it, and it is what the product does.
     */
    await db.prepare("UPDATE conversation_reports SET status = 'resolved' WHERE id = ?").run(reportId);
    expect(
      (await db.prepare('SELECT COUNT(*) c FROM conversation_report_messages WHERE report_id = ?')
        .get(reportId)).c,
      'resolving a report must not remove the evidence it was decided on'
    ).toBe(1);
  });

  it('refuses to delete or rewrite a preserved snapshot, at the database', async () => {
    /**
     * The immutability is a trigger rather than a convention, so this asserts
     * against raw SQL rather than through a route. A test that only exercised
     * the application would prove nothing about a bin/ script or a sqlite3
     * session, and those are exactly the paths a person destroying evidence
     * about themselves would reach for if they could.
     */
    const reported = await seedMessage(10);
    const reportId = `rep-immut-${Date.now()}`;
    await db.prepare(`
      INSERT INTO conversation_reports (id, reporter_id, conversation_id, reason, details, snapshot_created_at, created_at)
      VALUES (?, 'user-student-1', ?, 'safety', 'original disclosure', ?, ?)
    `).run(reportId, reported.convId, new Date().toISOString(), new Date().toISOString());
    await db.prepare(`
      INSERT INTO conversation_report_messages (report_id, message_id, sender_id, body, created_at)
      VALUES (?, ?, 'user-student-1', 'what was actually said', ?)
    `).run(reportId, reported.id, new Date().toISOString());

    await expect(async () => await db.prepare('DELETE FROM conversation_report_messages WHERE report_id = ?').run(reportId)).rejects.toThrow(/frozen evidence snapshot/);
    await expect(async () => await db.prepare("UPDATE conversation_report_messages SET body = 'nothing happened' WHERE report_id = ?").run(reportId)).rejects.toThrow(/frozen evidence snapshot/);
    await expect(async () => await db.prepare('DELETE FROM conversation_reports WHERE id = ?').run(reportId)).rejects.toThrow(/never deleted/);
    await expect(async () => await db.prepare("UPDATE conversation_reports SET details = 'I made it up' WHERE id = ?").run(reportId)).rejects.toThrow(/record of what was said/);

    // The one column that must stay writable, or a report could never be closed
    // and every hold keyed on it would be permanent.
    await db.prepare("UPDATE conversation_reports SET status = 'resolved' WHERE id = ?").run(reportId);

    expect(
      (await db.prepare('SELECT body FROM conversation_report_messages WHERE report_id = ?').get(reportId)).body,
      'the snapshot must still say what it said'
    ).toBe('what was actually said');
  });
});

describe('anonymised account shells', () => {
  it('purges a shell with no service record past the window', async () => {
    const id = `user-ret-${Date.now()}`;
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                         account_status, deleted_at, created_at)
      VALUES (?, 'Alex R.', ?, ?, 'x', '11', 'student', 1, 'deleted', ?, ?)
    `).run(id, `deleted_${id}@system.local`, `deleted_${id}`,
      daysAgo(RETENTION.deletedAccountDays + 30), daysAgo(2000));

    await sweep(db, { now: new Date() });
    expect(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)).toBeFalsy();
  });

  it('does NOT purge a shell that still carries attendance', async () => {
    // The service record outranks the shell. Deleting the row would cascade
    // the attendance away with it — destroying a volunteer's credited hours as
    // a side effect of housekeeping.
    const survivors = await db.prepare(`
      SELECT DISTINCT user_id FROM attendance LIMIT 1
    `).get();
    expect(survivors, 'precondition: some account has attendance').toBeTruthy();

    await db.prepare(`
      UPDATE users SET account_status = 'deleted', deleted_at = ? WHERE id = ?
    `).run(daysAgo(RETENTION.deletedAccountDays + 100), survivors.user_id);

    const attendanceBefore = (await db.prepare(
      'SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?'
    ).get(survivors.user_id)).c;

    await sweep(db, { now: new Date() });

    expect(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(survivors.user_id)).toBeTruthy();
    expect(
      (await db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?').get(survivors.user_id)).c,
      'purging a shell must never cascade away a volunteer service record'
    ).toBe(attendanceBefore);

    await db.prepare("UPDATE users SET account_status = 'active', deleted_at = NULL WHERE id = ?")
      .run(survivors.user_id);
  });

  it('leaves an active account alone no matter how old', async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM users WHERE account_status = 'active'").get()).c;
    await sweep(db, { now: new Date(Date.now() + 20 * 365 * DAY) });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM users WHERE account_status = 'active'").get()).c).toBe(before);
  });

  it('clears consent evidence with the account, never before it', async () => {
    // legal_acceptances is ON DELETE RESTRICT so a hard delete cannot silently
    // take the evidence. Retention is the one place it may expire — and it
    // expires WITH the account.
    const id = `user-ret2-${Date.now()}`;
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                         account_status, deleted_at, created_at)
      VALUES (?, 'Sam T.', ?, ?, 'x', '12', 'student', 1, 'deleted', ?, ?)
    `).run(id, `deleted_${id}@system.local`, `deleted_${id}`,
      daysAgo(RETENTION.deletedAccountDays + 5), daysAgo(2000));
    await db.prepare(`
      INSERT INTO legal_acceptances (id, user_id, document_slug, version, content_hash, accepted_at, method)
      VALUES (?, ?, 'terms-of-service', '1.0', 'abc', ?, 'signup')
    `).run(`acc-ret-${Date.now()}`, id, daysAgo(2000));

    /* Rejection is the async form of the throw this used to assert: the sweep
       must get through the legal_acceptances RESTRICT constraint, not trip on it. */
    await expect(sweep(db, { now: new Date() })).resolves.toBeDefined();
    expect(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)).toBeFalsy();
    expect(await db.prepare('SELECT 1 FROM legal_acceptances WHERE user_id = ?').get(id)).toBeFalsy();
  });
});

describe('published periods match the code', () => {
  it('uses the values the Privacy Policy states', () => {
    // If these change, docs/legal/policies/01-privacy-policy.md changes in the
    // same commit. The retention table is a representation, not a note.
    expect(RETENTION.messageDays).toBe(3 * 365);
    expect(RETENTION.auditDays).toBe(365);
    expect(RETENTION.deletedAccountDays).toBe(3 * 365);
  });
});
