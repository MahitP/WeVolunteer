import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Reopening a report must not destroy the decision it withdraws.
 *
 * ── The data loss ──
 *
 * Reopening clears `resolution`, `resolution_note`, `resolved_by` and
 * `resolved_at` from the report, which is correct — a reopened report that still
 * reads as resolved by a named person is a lie the next moderator acts on.
 *
 * The handler's comment said the withdrawn decision survived in
 * `moderation_actions`. It did not. That table stored the resolution ENUM
 * (`warning_issued`, `no_action`) and had no column for text at all, so the
 * NOTE — the moderator's account of what they decided and why — was destroyed.
 *
 * `ResolutionModal.jsx` tells the moderator writing that note it is "kept
 * permanently and… what an appeal is reviewed against". So a student appealing a
 * decision that had been reopened once was appealing against nothing: the
 * reviewer opened the case and found the reasoning gone, with the interface still
 * promising it was there. On a platform whose users are mostly minors, the
 * appeal is the due-process promise, and this quietly emptied it.
 *
 * Migration 028 added `moderation_actions.note`.
 *
 * ── What is asserted ──
 *
 * That the note is GONE from the report (the clearing is still correct) and
 * PRESENT on the history row that withdrew it. Testing only the second half
 * would pass if the reopen stopped clearing; testing only the first is the
 * behaviour that lost the note in the first place.
 */
describe('reopening a report keeps the withdrawn reasoning', () => {
  let srv, db, admin, reportId;

  const NOTE = 'Spoke to both students. The messages were a misunderstanding about a '
    + 'group project deadline, and both agreed to keep it in the event thread.';

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    admin = await srv.login('admin@example.gov');

    const now = new Date().toISOString();
    reportId = 'rep-reopen-note';
    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, target_author_id,
                           category, description, status, priority, created_at, updated_at)
      VALUES (?, 'user-student-1', 'comment', 'c-reopen', 'user-student-2',
              'harassment', 'test', 'reviewing', 'normal', ?, ?)
    `).run(reportId, now, now);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('preserves the resolution note on the reopened history row', async () => {
    /* Close it with a real decision and a real note. */
    const closed = await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'resolved', resolution: 'no_action', resolutionNote: NOTE,
    }, admin);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(db.prepare('SELECT resolution_note FROM reports WHERE id = ?').get(reportId)
      .resolution_note).toBe(NOTE);

    /* Reopen it. */
    const reopened = await srv.call('PATCH', `/api/admin/reports/${reportId}`, {
      status: 'reviewing',
    }, admin);
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);

    /* Cleared from the report — the reopen's whole purpose. */
    const row = db.prepare(
      'SELECT resolution, resolution_note, resolved_by, resolved_at FROM reports WHERE id = ?'
    ).get(reportId);
    expect(row.resolution).toBeNull();
    expect(row.resolution_note).toBeNull();
    expect(row.resolved_by).toBeNull();
    expect(row.resolved_at).toBeNull();

    /* And kept on the row that withdrew it, which is what an appeal is reviewed
       against a year later. */
    const withdrawal = db.prepare(
      "SELECT note FROM moderation_actions WHERE report_id = ? AND action = 'reopened'"
    ).get(reportId);
    expect(withdrawal, 'no `reopened` history row was written').toBeTruthy();
    expect(withdrawal.note).toBe(NOTE);
  });

  /**
   * Every other action leaves `note` null.
   *
   * The column exists to carry a withdrawn decision, not to become a general
   * free-text field that later readers have to guess the meaning of.
   */
  it('writes no note on actions that withdraw nothing', () => {
    const others = db.prepare(
      "SELECT action, note FROM moderation_actions WHERE report_id = ? AND action != 'reopened'"
    ).all(reportId);

    expect(others.length, 'fixture: no other history rows to check').toBeGreaterThan(0);
    for (const row of others) {
      expect(row.note, `${row.action} carried a note`).toBeNull();
    }
  });
});
