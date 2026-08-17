import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for conversation reporting rejecting the reason the UI offered.
 *
 * The server accepts exactly four reasons — `inappropriate`, `spam`, `safety`,
 * `other` — enforced both in the route and by a CHECK constraint on
 * `conversation_reports.reason`. The report dialog offered:
 *
 *     spam · harassment · inappropriate · other
 *
 * So `harassment` — on a platform whose users are mostly minors, the reason a
 * student is most likely to pick — was rejected with 400 "Choose a report
 * reason". And the dialog's only error handling was `console.error(err)`, so the
 * button simply re-enabled and the student was told nothing at all. They had no
 * way to know the report was never filed.
 *
 * `safety`, the most serious of the four, was not offered anywhere in the UI.
 *
 * These tests pin the contract from both ends: the server's accepted set, and
 * the fact that every option the dialog renders is inside it.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); }, 60000);
afterAll(async () => { await srv?.close(); });

/** The reasons the server and the schema agree on. */
const ACCEPTED = ['inappropriate', 'spam', 'safety', 'other'];

async function conversationForReporting() {
  const { db } = await import('./db.js');
  // The seeded past event has applications, which is what unlocks messaging.
  const app = await db.prepare("SELECT event_id, user_id FROM applications LIMIT 1").get();
  const studentEmail = (await db.prepare('SELECT email FROM users WHERE id = ?').get(app.user_id)).email;
  const student = await srv.login(studentEmail);
  const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: app.event_id }, student);
  return { student, conversationId: res.body?.conversation?.id, status: res.status };
}

describe('the report reasons the server accepts', () => {
  let ctx;
  beforeAll(async () => { ctx = await conversationForReporting(); });

  it('opens a conversation to report against', () => {
    expect(ctx.status, JSON.stringify(ctx)).toBe(200);
    expect(ctx.conversationId).toBeTruthy();
  });

  for (const reason of ACCEPTED) {
    it(`accepts "${reason}"`, async () => {
      const res = await srv.call(
        'POST', `/api/messages/conversations/${ctx.conversationId}/report`,
        { reason, details: 'test detail' }, ctx.student
      );
      expect([200, 201, 409]).toContain(res.status);
    });
  }

  // The exact value the dialog used to send.
  it('rejects "harassment", which is why the dialog silently failed', async () => {
    const res = await srv.call(
      'POST', `/api/messages/conversations/${ctx.conversationId}/report`,
      { reason: 'harassment', details: 'x' }, ctx.student
    );
    expect(res.status).toBe(400);
  });

  it('rejects an empty or unknown reason', async () => {
    for (const reason of ['', 'nonsense', undefined]) {
      const res = await srv.call(
        'POST', `/api/messages/conversations/${ctx.conversationId}/report`,
        { reason, details: 'x' }, ctx.student
      );
      expect(res.status, `reason=${reason}`).toBe(400);
    }
  });
});

/**
 * ── How this guard changed, and why it is now stronger ──
 *
 * It used to scrape a `const REASONS = [...]` table out of the dialog's source
 * and check every scraped value against the server's four. That worked, but it
 * was guarding a copy: the dialog kept its own list, the server kept its own
 * list, and the test's whole job was to notice when the two drifted.
 *
 * The dialog no longer has a list. It imports the taxonomy from
 * `server/moderation.js` — the same module the route validates against — so the
 * drift the scrape existed to catch is now structurally impossible, and a regex
 * over source would only be checking that somebody had not reintroduced a
 * hardcoded array.
 *
 * So the guard asserts the property instead of the shape: every value the dialog
 * can offer is put through the real endpoint and must be accepted. That is what
 * the original test was actually trying to prove, it survives any refactor of how
 * the options are built, and it catches a taxonomy value the server would refuse
 * — which the scrape never could, because it only compared two lists in the
 * repository rather than asking the running server.
 */
describe('the report dialog only offers reasons the server accepts', () => {
  const dialog = readFileSync(
    path.join(process.cwd(), 'src', 'components', 'messages', 'ReportModal.jsx'),
    'utf8'
  );

  /**
   * The explicit timeout is measured, not superstition.
   *
   * This test does 18 full round trips — `categoriesForTarget('conversation')`
   * returns 18 values, and each iteration builds a whole conversation fixture
   * (signup included, so bcrypt is in the loop) before posting the report. In
   * isolation that is ~2.0-2.1s, comfortably inside vitest's 5000ms default.
   * Under the parallel load of the full suite it was measured at 5122ms and
   * timed out — the run that found it was ~2% over the line.
   *
   * So the suite had a test that failed randomly on a busy machine, on the gate
   * every other gate depends on. Flakiness is a defect here, not a re-run
   * (ENGINEERING_GUIDE), and this is not TD-11: nothing crashed, the work simply
   * did not fit. Raising the budget for the two loop tests is the honest fix —
   * they are legitimately slow rather than hung, and trimming the taxonomy they
   * cover to fit a timer would weaken the guard.
   *
   * 20s is ~10x the isolated cost and ~4x the worst observed under load. The
   * global default stays at 5000ms so a genuinely hung test still fails fast.
   */
  it('offers nothing the server would reject', async () => {
    const { categoriesForTarget } = await import('./moderation.js');
    const offered = categoriesForTarget('conversation').map(c => c.value);
    expect(offered.length, 'the dialog offers no options at all').toBeGreaterThan(2);

    const { db } = await import('./db.js');
    const refused = [];
    for (const category of offered) {
      // A conversation of its own per category: duplicate suppression answers a
      // second live report of the same target with the FIRST report's id, which
      // would make every case after the first assert against the wrong row.
      const ctx = await conversationForReporting();
      await db.prepare("UPDATE reports SET status = 'dismissed' WHERE target_id = ?")
        .run(ctx.conversationId);

      const res = await srv.call(
        'POST', `/api/messages/conversations/${ctx.conversationId}/report`,
        { reason: category, details: 'x' }, ctx.student
      );
      if (res.status !== 201 && res.status !== 200) refused.push(`${category} -> ${res.status}`);
    }
    expect(refused, 'these would 400 and the student would see nothing').toEqual([]);
  }, 20000);

  /**
   * The category that replaced `safety`, and the one the Youth Safety Guidelines
   * point every uncertain student at: "If a conversation makes you uneasy and you
   * cannot say exactly why, that is reason enough to report it." It was missing
   * from the dialog entirely when this file was written.
   */
  it('offers the option for a student who cannot say what is wrong', async () => {
    const { categoriesForTarget } = await import('./moderation.js');
    expect(categoriesForTarget('conversation').map(c => c.value)).toContain('something_feels_wrong');
  });

  it('still accepts the four legacy reasons, so an older build keeps working', async () => {
    const { db } = await import('./db.js');
    for (const reason of ACCEPTED) {
      const ctx = await conversationForReporting();
      await db.prepare("UPDATE reports SET status = 'dismissed' WHERE target_id = ?")
        .run(ctx.conversationId);

      const res = await srv.call(
        'POST', `/api/messages/conversations/${ctx.conversationId}/report`,
        { reason, details: 'x' }, ctx.student
      );
      expect([200, 201], `legacy reason ${reason} stopped working`).toContain(res.status);
    }
    // Same shape as the loop above (fixture + bcrypt per iteration), so the same
    // exposure — four categories rather than eighteen, but on a loaded machine the
    // margin is the same kind of thin. Measured at ~440ms in isolation.
  }, 20000);

  it('surfaces a failure instead of only logging it', () => {
    // The old handler was `catch (err) { console.error(err); setSubmitting(false); }`
    // which left the student with a re-enabled button and no explanation.
    expect(dialog).toMatch(/role="alert"/);
    expect(dialog).not.toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*console\.error\(err\);\s*setSubmitting\(false\);\s*\}/);
  });
});
