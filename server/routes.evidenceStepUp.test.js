import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';

/**
 * Reading the private message bodies a safety report preserved.
 *
 * ── Why this needed a step-up ──
 *
 * Every other action in the sensitive-action registry is about the ACTOR's own
 * account: deleting it, changing its password, exporting its data. This one is
 * about somebody else's private messages, and that somebody is usually a minor.
 *
 * Before the v1.2c privacy review, downloading your own data archive required a
 * fresh verification while reading a child's messages required a session. The
 * read was already logged twice — to `admin_audit_logs` and to the
 * retention-exempt `moderation_actions` — so the accountability was in place.
 * What was missing was the deliberation.
 *
 * ── What this file owns ──
 *
 * That the gate cannot be walked past, that a grant for one report cannot open
 * another, and that a refused read leaves no trace. `reports.evidencePreservation`
 * owns the freezing; `routes.moderationQueue` owns the queue.
 */
describe('reading preserved evidence requires a fresh verification', () => {
  let srv, admin, db, reportA, reportB;

  const openReport = (id, targetAuthorId) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, target_author_id,
                          category, description, status, priority, created_at, updated_at)
      VALUES (?, 'user-student-1', 'comment', ?, ?, 'harassment', 'test', 'open', 'normal', ?, ?)
    `).run(id, `c-${id}`, targetAuthorId, now, now);
    db.prepare(`
      INSERT INTO report_evidence (report_id, message_id, sender_id, sender_name_snapshot,
                                   body, created_at, captured_at)
      VALUES (?, ?, ?, 'Someone', ?, ?, ?)
    `).run(id, `m-${id}`, targetAuthorId, `secret body for ${id}`, now, now);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    admin = await srv.login('admin@example.gov');
    ({ db } = await import('./db.js'));
    reportA = 'rep-stepup-a';
    reportB = 'rep-stepup-b';
    openReport(reportA, 'user-student-2');
    openReport(reportB, 'user-student-3');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const read = (reportId, challengeId) => srv.call(
    'GET', `/api/admin/reports/${reportId}/evidence`, undefined, admin,
    challengeId ? { [REAUTH_CHALLENGE_HEADER]: challengeId } : undefined
  );

  /* ── The gate ──────────────────────────────────────────────────────────── */

  it('refuses a session alone, however legitimate the moderator', async () => {
    const res = await read(reportA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  /**
   * The whole point of the change, stated as a body assertion.
   *
   * A refusal that still returned the messages would be a gate in name only, and
   * a status-only test would not notice.
   */
  it('discloses no message body with the refusal', async () => {
    const res = await read(reportA);
    expect(JSON.stringify(res.body)).not.toContain('secret body');
  });

  /**
   * A refused read must not appear in either trail. The row means "somebody read
   * this child's messages", and writing one for a read that did not happen would
   * put an accusation on a permanent record.
   */
  it('records nothing when the read was refused', async () => {
    const before = (await db.prepare(
      "SELECT COUNT(*) c FROM moderation_actions WHERE report_id = ? AND action = 'evidence_viewed'"
    ).get(reportA)).c;
    const auditBefore = (await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get()).c;

    await read(reportA);

    expect((await db.prepare(
      "SELECT COUNT(*) c FROM moderation_actions WHERE report_id = ? AND action = 'evidence_viewed'"
    ).get(reportA)).c).toBe(before);
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get()).c).toBe(auditBefore);
  });

  /* ── With a grant ──────────────────────────────────────────────────────── */

  it('allows the read once a challenge for THIS report is answered', async () => {
    const challengeId = await srv.stepUp(admin, 'report.evidence', { params: { reportId: reportA } });
    const res = await read(reportA, challengeId);

    expect(res.status).toBe(200);
    expect(res.body.messages[0].body).toContain('secret body');
  });

  it('records the read in both trails when it succeeds', async () => {
    const challengeId = await srv.stepUp(admin, 'report.evidence', { params: { reportId: reportA } });
    await read(reportA, challengeId);

    expect((await db.prepare(
      "SELECT COUNT(*) c FROM moderation_actions WHERE report_id = ? AND action = 'evidence_viewed'"
    ).get(reportA)).c).toBeGreaterThan(0);
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'REPORT_EVIDENCE_VIEWED'"
    ).get()).c).toBeGreaterThan(0);
  });

  /**
   * The binding, and the reason it exists.
   *
   * Without `bindsParams: ['reportId']`, a moderator who verified once would hold
   * a five-minute key to every child's messages on the platform — strictly worse
   * than the position this replaced, where at least each read was a deliberate
   * request.
   */
  it('will not open a different report with the same grant', async () => {
    const challengeId = await srv.stepUp(admin, 'report.evidence', { params: { reportId: reportA } });
    const res = await read(reportB, challengeId);

    /**
     * 409, not 403, and that is the platform's contract rather than a quirk:
     * `refuseReauth` maps `params_mismatch` to "That verification was for
     * different details." A 403 would say "you may not do this", which is wrong —
     * this moderator may, they just have not verified for THIS report.
     *
     * Asserted with the code as well as the status, because the code is what the
     * client keys off to re-prompt.
     */
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('params_mismatch');
    expect(JSON.stringify(res.body)).not.toContain('secret body for rep-stepup-b');
  });

  /**
   * Single use. `spendChallenge` consumes the grant inside the same transaction
   * as the two log writes, so a replayed header cannot produce a second
   * unrecorded read.
   */
  it('spends the grant, so the same challenge cannot be replayed', async () => {
    const challengeId = await srv.stepUp(admin, 'report.evidence', { params: { reportId: reportA } });
    const first = await read(reportA, challengeId);
    const second = await read(reportA, challengeId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
  });

  /** A capability refusal still comes first: a student has no business here at all. */
  it('refuses a student before it asks them to verify anything', async () => {
    const student = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', `/api/admin/reports/${reportA}/evidence`, undefined, student);
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('reauth_required');
  });
});
