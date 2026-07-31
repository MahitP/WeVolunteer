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
  const app = db.prepare("SELECT event_id, user_id FROM applications LIMIT 1").get();
  const studentEmail = db.prepare('SELECT email FROM users WHERE id = ?').get(app.user_id).email;
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

describe('the report dialog only offers reasons the server accepts', () => {
  const dialog = readFileSync(
    path.join(process.cwd(), 'src', 'components', 'messages', 'ReportModal.jsx'),
    'utf8'
  );

  /**
   * Reads the REASONS table the dialog builds its <option>s from, which is the
   * source of truth. (It used to be inline `<option value="…">` literals; the
   * scrape is kept general so either shape is covered.)
   */
  const offered = (() => {
    const block = dialog.match(/const REASONS\s*=\s*\[([\s\S]*?)\];/);
    if (block) return [...block[1].matchAll(/value:\s*'([^']+)'/g)].map(m => m[1]);
    return [...dialog.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  })();

  it('renders a set of options at all', () => {
    expect(offered.length).toBeGreaterThan(2);
  });

  it('offers nothing the server would reject', () => {
    const invalid = offered.filter(v => !ACCEPTED.includes(v));
    expect(invalid, 'these would 400 and the user would see nothing').toEqual([]);
  });

  it('offers the safety reason, which matters most and was missing', () => {
    expect(offered).toContain('safety');
  });

  it('surfaces a failure instead of only logging it', () => {
    // The old handler was `catch (err) { console.error(err); setSubmitting(false); }`
    // which left the student with a re-enabled button and no explanation.
    expect(dialog).toMatch(/role="alert"/);
    expect(dialog).not.toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*console\.error\(err\);\s*setSubmitting\(false\);\s*\}/);
  });
});
