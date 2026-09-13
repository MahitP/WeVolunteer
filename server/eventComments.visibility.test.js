/**
 * Who may read, and post into, an event's comment thread — and read the leaderboard.
 *
 * ── The failure this forbids ──
 *
 * A thread is a list of the people who wrote in it: every question carries the
 * author's name, avatar and role. On this platform most authors are students.
 * The routes were open to any signed-in account, so two accounts the rest of
 * the authorization model deliberately keeps away from schoolchildren's names
 * could read every thread on the platform by event id, and post into it:
 *
 *   - a `partner` — an external organization, which does not hold
 *     `directory.read` for exactly this reason;
 *   - an organizer who has not accepted the Organizer Agreement, from whom
 *     `directory.read` is withheld until they do.
 *
 * Asserted as the disclosure, not only as the status: the refused response must
 * not carry the student's name, and a refused post must leave no row behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

const EVENT = 'event-softball';
const QUESTION = 'Is there shade near the concession stand?';

let srv, db;
let student, otherStudent, partner, unagreedOrganizer;

async function account(tag, role) {
  const email = `thread.${tag}@example.org`;
  const s = await srv.signupConfirmed({
    name: `Thread ${tag}`, username: `thread_${tag}`, email,
    password: 'Password123', grade: role === 'student' ? '10' : 'Adult', role: 'student'
  });
  if (role !== 'student') {
    await db.prepare('UPDATE users SET role = ?, verified = 1 WHERE email = ?').run(role, email);
  }
  return s.cookie;
}

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;
  student = await srv.login('leo.chen@example.com');
  otherStudent = await account('peer', 'student');
  partner = await account('partner', 'partner');
  unagreedOrganizer = await account('neworg', 'organizer');

  const posted = await srv.call('POST', `/api/events/${EVENT}/comments`, { body: QUESTION }, student);
  expect(posted.status, 'fixture: a student could not post a question').toBe(201);
});

afterAll(async () => { await srv?.close(); });

const threadText = (res) => JSON.stringify(res.body ?? '');

describe('an event comment thread', () => {
  it('is readable by another member of the school community', async () => {
    const res = await srv.call('GET', `/api/events/${EVENT}/comments`, undefined, otherStudent);
    expect(res.status).toBe(200);
    const mine = res.body.find(c => c.body === QUESTION);
    expect(mine?.author.name).toBe('Leo Chen');
  });

  it('is not readable by an external partner, and the refusal names nobody', async () => {
    const res = await srv.call('GET', `/api/events/${EVENT}/comments`, undefined, partner);
    expect(res.status).toBe(403);
    expect(threadText(res)).not.toContain('Leo Chen');
    expect(threadText(res)).not.toContain(QUESTION);
  });

  it('is not readable by an organizer who has not accepted the agreement', async () => {
    /* Precondition, asserted rather than assumed: the account really is in the
       withheld state. If a fixture change ever pre-accepted the agreement this
       case would pass for the wrong reason. */
    const me = await srv.call('GET', '/api/auth/me', undefined, unagreedOrganizer);
    expect(me.body.withheld ?? me.body.user?.withheld).toContain('directory.read');

    const res = await srv.call('GET', `/api/events/${EVENT}/comments`, undefined, unagreedOrganizer);
    expect(res.status).toBe(403);
    expect(threadText(res)).not.toContain('Leo Chen');
  });

  it('cannot be posted into by a partner, and nothing is written or sent', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM event_comments WHERE event_id = ?').get(EVENT);
    const notesBefore = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'user-org-1'").get();

    const res = await srv.call('POST', `/api/events/${EVENT}/comments`, { body: 'Hello from outside' }, partner);
    expect(res.status).toBe(403);

    const after = await db.prepare('SELECT COUNT(*) AS n FROM event_comments WHERE event_id = ?').get(EVENT);
    const notesAfter = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'user-org-1'").get();
    expect(Number(after.n)).toBe(Number(before.n));
    expect(Number(notesAfter.n)).toBe(Number(notesBefore.n));
  });

  it('cannot be posted into by an organizer who has not accepted the agreement', async () => {
    const res = await srv.call('POST', `/api/events/${EVENT}/comments`, { body: 'Hello' }, unagreedOrganizer);
    expect(res.status).toBe(403);
  });
});

/**
 * The leaderboard is the same disclosure: a student's name beside their hours,
 * opted in for the school community.
 */
describe('the leaderboard', () => {
  beforeAll(async () => {
    await db.prepare("UPDATE users SET leaderboard_opt_in = 1, hours_visibility = 'public' WHERE id = 'user-student-1'").run();
  });

  it('shows an opted-in student to another student', async () => {
    const res = await srv.call('GET', '/api/leaderboard', undefined, otherStudent);
    expect(res.status).toBe(200);
    expect(threadText(res)).toContain('Leo Chen');
  });

  it('refuses a partner and an unagreed organizer without naming anyone', async () => {
    for (const cookie of [partner, unagreedOrganizer]) {
      const res = await srv.call('GET', '/api/leaderboard', undefined, cookie);
      expect(res.status).toBe(403);
      expect(threadText(res)).not.toContain('Leo Chen');
    }
  });
});
