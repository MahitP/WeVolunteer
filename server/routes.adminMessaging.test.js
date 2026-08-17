/**
 * An administrator messaging a person.
 *
 * ── The defect this closes ──
 *
 * `eligibleRelationship` has had an admin branch since private messaging shipped,
 * which is what made this look built. It was not. `resolveConversation` always
 * wrote the row between `student_id` and `organizer_id`, so an administrator who
 * resolved a conversation was NOT a participant and received 404 on both read and
 * send. That branch exists so an admin can INSPECT a student↔organizer thread.
 *
 * Granting `message.send` to admin was tried once and reverted, correctly: it
 * replaced a permission error with an empty inbox, because the shape of
 * `conversations` — `(event_id, student_id, organizer_id)`, all NOT NULL — was the
 * actual problem.
 *
 * So the cases that matter here are not "does the endpoint return 200". They are:
 *
 *   - the admin is a real participant, and can therefore read AND send;
 *   - the thread is not event-scoped, and does not inherit the event-date rules
 *     that would silently close a student's channel to an administrator;
 *   - opening one twice does not split the conversation in two;
 *   - `report.resolve` is what gates it, so an organizer holding `message.send`
 *     cannot reach an arbitrary student.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => { await srv.close(); });

const adminToken = () => srv.login('admin@example.gov');
const STUDENT = 'user-student-2';
const ORGANIZER = 'user-org-1';

const openThread = async (userId, cookie) => srv.call(
  'POST', '/api/messages/admin/conversations/resolve', { userId }, cookie ?? await adminToken()
);

describe('opening a thread', () => {
  it('makes the administrator a real participant, not a bystander', async () => {
    const res = await openThread(STUDENT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const id = res.body.conversation.id;
    const participants = (await db.prepare(
      'SELECT user_id FROM conversation_participants WHERE conversation_id = ?'
    ).all(id)).map(r => r.user_id);

    expect(participants, 'the admin must be a participant or every read 404s')
      .toContain('user-admin');
    expect(participants).toContain(STUDENT);
  });

  it('classifies the thread by what the counterparty can do', async () => {
    const student = await openThread(STUDENT);
    const organizer = await openThread(ORGANIZER);

    expect(student.body.conversation.kind).toBe('admin_student');
    expect(organizer.body.conversation.kind).toBe('admin_organizer');
  });

  /**
   * No event, deliberately. Putting an admin in an event-scoped row is what the
   * audit rejected: it states in the data that an administrator is the event's
   * organizer, and it inherits the read-only rules below.
   */
  it('is not scoped to an event', async () => {
    const res = await openThread(STUDENT);
    const row = await db.prepare('SELECT event_id, student_id, organizer_id FROM conversations WHERE id = ?')
      .get(res.body.conversation.id);

    expect(row.event_id).toBe(null);
    expect(row.student_id).toBe(STUDENT);
    expect(row.organizer_id, 'an admin thread fills exactly one role column').toBe(null);
  });

  /** Pressing "message" twice must not split the conversation in half. */
  it('is idempotent — the same thread comes back', async () => {
    const first = await openThread(STUDENT);
    const second = await openThread(STUDENT);

    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    expect((await db.prepare(`
      SELECT COUNT(*) c FROM conversations
       WHERE kind = 'admin_student' AND created_by = 'user-admin' AND student_id = ?
    `).get(STUDENT)).c).toBe(1);
  });

  it('records that a channel was opened, naming who and to whom', async () => {
    await openThread(STUDENT);
    const row = await db.prepare(`
      SELECT admin_id, target_user_id, details FROM admin_audit_logs
       WHERE action = 'ADMIN_CONVERSATION_OPENED' AND target_user_id = ?
       ORDER BY rowid DESC LIMIT 1
    `).get(STUDENT);

    expect(row, 'opening a line to a student must be on the record').toBeTruthy();
    expect(row.admin_id).toBe('user-admin');
  });
});

describe('using the thread', () => {
  it('lets the administrator send, and the student read what was sent', async () => {
    const { body: { conversation } } = await openThread(STUDENT);

    const sent = await srv.call('POST', `/api/messages/conversations/${conversation.id}/messages`,
      { body: 'Please come and see me about a report we received.' }, await adminToken());
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const asStudent = await srv.call('GET', `/api/messages/conversations/${conversation.id}/messages`,
      undefined, await srv.login('priya.patel@example.com'));
    expect(asStudent.status).toBe(200);
    expect(asStudent.body.messages.at(-1).body).toContain('about a report');
  });

  it('lets the student reply', async () => {
    const { body: { conversation } } = await openThread(STUDENT);
    const cookie = await srv.login('priya.patel@example.com');

    const res = await srv.call('POST', `/api/messages/conversations/${conversation.id}/messages`,
      { body: 'Okay, I can come at lunch tomorrow.' }, cookie);
    expect(res.status).toBe(201);
  });

  it('shows up in both inboxes', async () => {
    const { body: { conversation } } = await openThread(STUDENT);

    for (const cookie of [await adminToken(), await srv.login('priya.patel@example.com')]) {
      const res = await srv.call('GET', '/api/messages/conversations', undefined, cookie);
      expect(res.body.conversations.map(c => c.id)).toContain(conversation.id);
    }
  });

  /**
   * The rule the audit named. Event-driven read-only exists so a thread about a
   * finished shift stops accepting messages; a student's channel to an
   * administrator is not about a shift, and closing it 30 days after some
   * unrelated event ended would shut the one route a person has for raising
   * something — including an appeal.
   */
  it('never becomes read-only from an event ending', async () => {
    const { body: { conversation } } = await openThread(STUDENT);
    expect(conversation.lifecycle.writable).toBe(true);

    const { computeConversationLifecycle } = await import('./messaging.js');
    const row = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id);

    // Far enough in the future that every event-based window has long closed.
    const lifecycle = await computeConversationLifecycle(row, new Date('2099-01-01T00:00:00.000Z'));
    expect(lifecycle.writable).toBe(true);
    expect(lifecycle.state).toBe('active');
  });
});

describe('refusals', () => {
  it('refuses a student and an organizer, who hold message.send but not report.resolve', async () => {
    for (const cookie of [
      await srv.login('leo.chen@example.com'),
      await srv.login('jordan.whitfield@example.org'),
    ]) {
      const res = await openThread(STUDENT, cookie);
      expect(res.status, 'message.send must not let anybody pick a stranger to message')
        .toBe(403);
    }
  });

  it('refuses an unauthenticated call', async () => {
    const res = await srv.call('POST', '/api/messages/admin/conversations/resolve',
      { userId: STUDENT }, undefined);
    expect([401, 403]).toContain(res.status);
  });

  it('400s a missing or non-string userId', async () => {
    for (const body of [{}, { userId: 42 }, { userId: '' }]) {
      const res = await srv.call('POST', '/api/messages/admin/conversations/resolve',
        body, await adminToken());
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404s somebody who does not exist', async () => {
    const res = await openThread('user-nope');
    expect(res.status).toBe(404);
  });

  it('refuses a conversation with yourself', async () => {
    const res = await openThread('user-admin');
    expect(res.status).toBe(400);
  });
});

/**
 * The constraints, asserted at the database rather than through the routes.
 *
 * A test that goes through the handler proves the handler is careful. These prove
 * the schema is, which is what protects the table from `bin/` scripts, future
 * handlers, and the second admin-messaging feature somebody writes in a year.
 */
describe('the shape is enforced by the schema', () => {
  const insert = (over) => {
    const row = {
      id: `conv_test_${Math.random().toString(36).slice(2)}`,
      kind: 'admin_student', event_id: null,
      student_id: STUDENT, organizer_id: null,
      created_by: 'user-admin', created_at: new Date().toISOString(), ...over,
    };
    return db.prepare(`
      INSERT INTO conversations (id, kind, event_id, student_id, organizer_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.kind, row.event_id, row.student_id, row.organizer_id,
      row.created_by, row.created_at);
  };

  it('refuses an unknown kind', () => {
    expect(() => insert({ kind: 'admin_everybody' })).toThrow();
  });

  /**
   * Relaxing NOT NULL to admit admin threads must not also admit an event-scoped
   * thread about no event — which every event query and the lifecycle rules would
   * read as a thread about nothing.
   */
  it('still requires an event, a student and an organizer for an event thread', () => {
    expect(() => insert({ kind: 'student_organizer', event_id: null })).toThrow();
  });

  it('refuses an admin_student row that also names an organizer', () => {
    expect(() => insert({ kind: 'admin_student', organizer_id: ORGANIZER })).toThrow();
  });

  it('refuses an admin_organizer row with no organizer', () => {
    expect(() => insert({ kind: 'admin_organizer', student_id: STUDENT, organizer_id: null }))
      .toThrow();
  });

  /**
   * `UNIQUE(student_id, organizer_id, event_id)` cannot enforce this: SQLite treats
   * NULLs as distinct, so every admin thread is unique to that constraint however
   * many times it is created. The partial index in migration 018 is what does it.
   */
  it('refuses a duplicate thread between the same admin and person', async () => {
    await openThread(ORGANIZER);
    expect(() => insert({
      kind: 'admin_organizer', student_id: null, organizer_id: ORGANIZER,
    })).toThrow(/UNIQUE|constraint/i);
  });

  it('allows a second administrator their own thread with the same person', () => {
    // Distinct `created_by`, so this is a different thread and not a duplicate —
    // a moderation contact belongs to the person who opened it, not to a shared
    // mailbox.
    expect(() => insert({ created_by: 'user-org-1', student_id: STUDENT })).not.toThrow();
  });
});
