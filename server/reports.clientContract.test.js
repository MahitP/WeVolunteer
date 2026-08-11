/**
 * The report endpoint must accept what the shipped client actually sends.
 *
 * ── The regression this exists to prevent ──
 *
 * The unified reporting model replaced free-text `reason` with a `category`
 * from a fixed taxonomy, and `POST /api/reports` passed `reason` straight
 * through as the category. `src/components/ReportModal.jsx` sends the student's
 * own words in `reason` — it has a textarea and no category picker — so every
 * report of an event or a comment answered
 * `400 "Choose a reason for the report."` while offering no reasons to choose.
 *
 * Nothing caught it. The existing tests that touch `/api/reports` all send a
 * valid category, because they were written against the server rather than
 * against the client, and the server was self-consistent. The whole defect
 * lived in the gap between the two.
 *
 * So these assertions are deliberately written from the CLIENT's side: the
 * payload here is copied from the call site, and if the client changes shape
 * this file should be updated to match it rather than the other way round.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;
});
afterAll(async () => { await srv.close(); });

/**
 * A DISTINCT event per case.
 *
 * `idx_reports_no_dup` suppresses a second live report of the same target by the
 * same reporter and answers 200 with the FIRST report's id — correct behaviour,
 * and it silently made the first draft of these tests assert against the wrong
 * row. Each case gets its own target so it is testing what it says it is.
 */
let evSeq = 0;
const anyEventId = () => {
  const rows = db.prepare('SELECT id FROM events ORDER BY id').all();
  const row = rows[evSeq++ % rows.length];
  return row.id;
};

describe('POST /api/reports accepts the shipped client payload', () => {
  it('takes the free-text reason the report modal sends', async () => {
    const t = await srv.login('cameron.caldwell@example.com');

    // Copied from src/components/ReportModal.jsx — `api.submitReport({ targetType,
    // targetId, reason: trimmed })`, where `trimmed` is the textarea contents.
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event',
      targetId: anyEventId(),
      reason: 'This event is misleading and is not a real volunteering opportunity.',
    }, t);

    expect(res.status, `the shipped report button is broken: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.reportId).toBeTruthy();

    /**
     * The student's words are preserved as the description rather than
     * discarded. Prose is the authoritative content of a report — losing it to
     * keep a taxonomy tidy would make the report unreadable to the moderator who
     * has to decide it.
     */
    const row = db.prepare('SELECT category, description FROM reports WHERE id = ?')
      .get(res.body.reportId);
    expect(row.category, 'prose should land in the catch-all category, not be rejected')
      .toBe('other');
    expect(row.description).toContain('misleading');
  });

  it('still honours a real category when the client sends one', async () => {
    // The fallback must not swallow the taxonomy — otherwise every report
    // becomes `other` and triage has nothing to sort on.
    const t = await srv.login('cameron.caldwell@example.com');
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event',
      targetId: anyEventId(),
      reason: 'spam_or_advertising',
      details: 'Recruiting for something that is not volunteering.',
    }, t);

    expect(res.status).toBe(200);
    const row = db.prepare('SELECT category, description FROM reports WHERE id = ?')
      .get(res.body.reportId);
    expect(row.category).toBe('spam_or_advertising');
    expect(row.description).toBe('Recruiting for something that is not volunteering.');
  });

  it('keeps both halves when the client sends prose AND details', async () => {
    // A different reporter, so duplicate suppression cannot return an earlier
    // case's report id however few events the seed happens to contain.
    const t = await srv.login('admin@example.gov');
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'event',
      targetId: anyEventId(),
      reason: 'The headline complaint.',
      details: 'The extra context.',
    }, t);

    expect(res.status).toBe(200);
    const row = db.prepare('SELECT description FROM reports WHERE id = ?').get(res.body.reportId);
    expect(row.description).toContain('The headline complaint.');
    expect(row.description).toContain('The extra context.');
  });
});

/**
 * The payload the CURRENT client sends, now that the dialogs offer the taxonomy.
 *
 * Written against the call sites the same way the prose cases above are, so the
 * two shapes are held together rather than one replacing the other. The prose
 * cases stay: the deprecated alias is what keeps a build somebody has open in
 * another tab working, and deleting its coverage is how a compatibility path
 * quietly stops being one.
 */
describe('POST /api/reports accepts the rewritten client payload', () => {
  it('takes a category and a description from the report dialog', async () => {
    const t = await srv.login('cameron.caldwell@example.com');

    // Copied from src/components/ReportModal.jsx — `api.submitReport({
    // targetType, targetId, reason: category, details })`.
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'comment',
      targetId: db.prepare('SELECT id FROM event_comments LIMIT 1').get().id,
      reason: 'bullying_or_harassment',
      details: 'They keep replying to everything I post.',
    }, t);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = db.prepare('SELECT category, description, priority FROM reports WHERE id = ?')
      .get(res.body.reportId);
    expect(row.category).toBe('bullying_or_harassment');
    expect(row.description).toBe('They keep replying to everything I post.');
    expect(row.priority, 'priority is derived, never sent').toBeTruthy();
  });

  it('takes a category with no description at all', async () => {
    // The dialog omits `details` entirely when the box is empty, because a
    // student who taps a category and cannot type more must still be able to file.
    //
    // A target of its own, for the reason the header records: with only two
    // seeded events this reporter has already reported both, and duplicate
    // suppression would answer with an earlier case's report id.
    const t = await srv.login('cameron.caldwell@example.com');
    const res = await srv.call('POST', '/api/reports', {
      targetType: 'user', targetId: 'contract_no_description', reason: 'something_feels_wrong',
    }, t);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = db.prepare('SELECT category, description FROM reports WHERE id = ?')
      .get(res.body.reportId);
    expect(row.category).toBe('something_feels_wrong');
    expect(row.description).toBeNull();
  });

  it('takes every category the dialogs can offer', async () => {
    // Driven off the shared module, so a category added to the taxonomy is
    // covered here without anybody remembering to add a case.
    const { CATEGORY_VALUES } = await import('./moderation.js');
    const t = await srv.login('cameron.caldwell@example.com');

    for (const category of CATEGORY_VALUES) {
      const res = await srv.call('POST', '/api/reports', {
        // A distinct user target per category: no lookup, so no oracle and no
        // duplicate suppression between cases.
        targetType: 'user', targetId: `contract_${category}`, reason: category,
      }, t);
      expect(res.status, `${category} was refused: ${JSON.stringify(res.body)}`).toBe(200);
      expect(db.prepare('SELECT category FROM reports WHERE id = ?').get(res.body.reportId).category)
        .toBe(category);
    }
  });

  it('takes the conversation dialog’s category through the conversation route', async () => {
    const student = db.prepare("SELECT id, email FROM users WHERE role = 'student' LIMIT 1").get();
    const organizer = db.prepare("SELECT id FROM users WHERE role = 'organizer' LIMIT 1").get();
    const eventId = db.prepare('SELECT id FROM events LIMIT 1').get().id;
    const convId = 'conv_contract_1';
    const now = new Date(Date.now() - 60_000).toISOString();

    db.prepare(`INSERT INTO conversations (id, event_id, student_id, organizer_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(convId, eventId, student.id, organizer.id, organizer.id, now);
    for (const [uid, role] of [[student.id, 'student'], [organizer.id, 'organizer']]) {
      db.prepare(`INSERT INTO conversation_participants
                    (conversation_id, user_id, role_at_creation, joined_at)
                  VALUES (?, ?, ?, ?)`).run(convId, uid, role, now);
    }
    db.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
                VALUES ('m_contract_1', ?, ?, 'where do you live', ?)`)
      .run(convId, organizer.id, now);

    // Copied from src/components/messages/ReportModal.jsx —
    // `api.reportConversation(conversationId, category, details)`.
    const res = await srv.call('POST', `/api/messages/conversations/${convId}/report`, {
      reason: 'asked_to_meet_alone', details: 'He keeps asking where I live.',
    }, await srv.login(student.email));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = db.prepare('SELECT category, description, priority FROM reports WHERE id = ?')
      .get(res.body.reportId);
    expect(row.category).toBe('asked_to_meet_alone');
    expect(row.description).toBe('He keeps asking where I live.');
    expect(row.priority, 'a student reporting an adult for this is not "normal"').toBe('urgent');
  });
});
