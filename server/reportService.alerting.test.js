/**
 * The urgent safety alert, and the preference that used to be able to silence it.
 *
 * ── The defect ──
 *
 * `createReport` dispatches `SYSTEM_ALERT` to every moderator when a report's
 * derived priority is `urgent`. Its own comment calls that notification "the only
 * thing standing between that promise and a queue nobody happened to refresh" on a
 * one-to-two-person team.
 *
 * `SYSTEM_ALERT` was not in `MANDATORY_NOTICE_EVENTS`, so
 * `notificationService.dispatch` fell through to the ordinary preference path:
 *
 *     const mandatory = isMandatoryNotice(event);            // false
 *     const inAppEnabled = mandatory || getPref('inapp');
 *     const emailEnabled = mandatory || (user.email_opt_out === 1 ? false : getPref('email'));
 *
 * A moderator who had turned email off — globally with `email_opt_out`, or for the
 * category this event maps to — received nothing at all. The single signal between
 * a child-safety report and an unread queue was a user-preference toggle, on a
 * platform whose entire moderator population is one person.
 *
 * Every other member of that set is a notice the recipient must receive whatever
 * their preferences say: being suspended, being reinstated, an appeal outcome. A
 * report that may *cause* a suspension is at least as consequential as the
 * suspension notice that follows it.
 *
 * ── What these tests pin ──
 *
 * That the bypass exists for urgent reports, that it survives every way a user can
 * switch notifications off, and — equally important — that it did NOT become a
 * blanket bypass: normal-priority reports still respect preferences, because an
 * alert that fires for everything is an alert people learn to close.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;
let createReport, MANDATORY_NOTICE_EVENTS, isMandatoryNotice, rolesWithCapability;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ createReport } = await import('./reportService.js'));
  ({ MANDATORY_NOTICE_EVENTS, isMandatoryNotice } = await import('./services/notificationContent.js'));
  ({ rolesWithCapability } = await import('./authz.js'));
});
afterAll(async () => { await srv.close(); });

let seq = 0;

/** A student who can file a report. */
function makeStudent() {
  const id = `alert-student-${++seq}`;
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, created_at)
    VALUES (?, ?, 'h', 'Alert Student', 'student', '10', ?, 1, 'active', datetime('now'))
  `).run(id, `${id}@example.com`, id.replace(/-/g, '_'));
  return id;
}

/**
 * An adult to report, so the priority floor for a student-reports-adult applies.
 *
 * `moderation.js` floors that case at `urgent` whatever category was chosen, which
 * is the case these tests are about.
 */
function makeOrganizer() {
  const id = `alert-organizer-${++seq}`;
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, created_at)
    VALUES (?, ?, 'h', 'Alert Organizer', 'organizer', 'Adult', ?, 1, 'active', datetime('now'))
  `).run(id, `${id}@example.com`, id.replace(/-/g, '_'));
  return id;
}

/** Every notification row written for a user, by channel. */
const notificationsFor = (userId) =>
  db.prepare('SELECT id, kind, title FROM notifications WHERE user_id = ?').all(userId);

/** Every queued OUTBOUND EMAIL job addressed to a user. */
function emailJobsFor(userId) {
  return db.prepare("SELECT payload FROM notification_jobs WHERE channel = 'email'")
    .all()
    .map(r => { try { return JSON.parse(r.payload); } catch { return null; } })
    .filter(p => p && p.userId === userId);
}

/**
 * The seeded moderator — the account `createReport` actually alerts.
 *
 * Derived from the capability table rather than named, for the same reason
 * `moderatorIds()` in reportService.js is: `report.resolve` currently sits on
 * `admin` and `super_admin`, and a capability moved between roles should move this
 * fixture with it rather than leaving a test that silently alerts nobody. The demo
 * seed contains one `admin` (`user-admin`) and no `super_admin`.
 */
function moderatorId() {
  const roles = rolesWithCapability('report.resolve');
  const placeholders = roles.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT id FROM users WHERE role IN (${placeholders}) AND account_status = 'active' LIMIT 1`
  ).get(...roles);
  expect(row, `no seeded user holds report.resolve (roles: ${roles.join(', ')})`).toBeTruthy();
  return row.id;
}

/** Switches off every notification route this user has. */
function silenceAllPreferences(userId) {
  db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(userId);
  for (const channel of ['email', 'inapp']) {
    db.prepare(`
      INSERT INTO notification_preferences (user_id, channel, category, enabled)
      VALUES (?, ?, 'ACCOUNT', 0)
      ON CONFLICT DO UPDATE SET enabled = 0
    `).run(userId, channel);
  }
}

function clearOutbox(userId) {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
  db.prepare("DELETE FROM notification_jobs WHERE channel = 'email'").run();
}

describe('SYSTEM_ALERT is a mandatory notice', () => {
  it('is registered as mandatory, alongside the suspension and appeal notices', () => {
    // The registry entry is the fix. Asserted directly so a future edit that
    // removes it fails here with the reason rather than only in the behavioural
    // tests below.
    expect(isMandatoryNotice('SYSTEM_ALERT')).toBe(true);
    expect([...MANDATORY_NOTICE_EVENTS]).toContain('SYSTEM_ALERT');
  });

  it('did not become a blanket bypass — ordinary notices are still optional', () => {
    expect(isMandatoryNotice('APPLICATION_ACCEPTED')).toBe(false);
    expect(isMandatoryNotice('DIRECT_MESSAGE')).toBe(false);
  });
});

describe('an urgent safety report reaches the moderator whatever their preferences say', () => {
  it('emails the moderator even with notifications fully switched off', () => {
    const mod = moderatorId();
    silenceAllPreferences(mod);
    clearOutbox(mod);

    const student = makeStudent();
    const organizer = makeOrganizer();

    const res = createReport({
      reporter: { id: student, role: 'student' },
      targetType: 'user',
      targetId: organizer,
      category: 'asked_to_meet_alone',   // urgent by category AND by the adult floor
      description: 'He asked me to meet him alone after the shift.',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // This is the assertion the defect failed: with email_opt_out = 1 and the
    // category preference disabled, no email job was queued at all.
    expect(
      emailJobsFor(mod).length,
      'an urgent safety report queued no email for the only moderator'
    ).toBeGreaterThan(0);
  });

  it('also writes the in-app notification, so both routes are covered', () => {
    const mod = moderatorId();
    silenceAllPreferences(mod);
    clearOutbox(mod);

    const student = makeStudent();
    const organizer = makeOrganizer();
    createReport({
      reporter: { id: student, role: 'student' },
      targetType: 'user',
      targetId: organizer,
      category: 'threatened_me',
      description: 'They said they would make sure I never volunteer again.',
    });

    expect(notificationsFor(mod).length).toBeGreaterThan(0);
  });

  /**
   * The floor matters more than the category.
   *
   * `moderation.js` raises a student's report about an adult to `urgent` even for a
   * category that is normal on its own. A student who picks the mildest option
   * available while describing something serious must still produce an alert.
   */
  it('alerts on a student-reports-adult report filed under a NON-urgent category', () => {
    const mod = moderatorId();
    silenceAllPreferences(mod);
    clearOutbox(mod);

    const student = makeStudent();
    const organizer = makeOrganizer();
    const res = createReport({
      reporter: { id: student, role: 'student' },
      targetType: 'user',
      targetId: organizer,
      category: 'something_feels_wrong',
      description: 'I cannot say exactly what is wrong but this felt bad.',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    expect(
      emailJobsFor(mod).length,
      'the student-reports-adult urgency floor produced no alert'
    ).toBeGreaterThan(0);
  });
});

describe('normal-priority reports still respect preferences', () => {
  /**
   * Deliberately unchanged. `reportService.js` sends nothing at normal priority —
   * "an alert that fires for everything is an alert people learn to close" — and
   * making SYSTEM_ALERT mandatory must not have widened that.
   */
  it('sends no alert at all for a normal-priority report', () => {
    const mod = moderatorId();
    // Preferences fully ENABLED, so a missing alert cannot be blamed on them.
    db.prepare('UPDATE users SET email_opt_out = 0 WHERE id = ?').run(mod);
    db.prepare("DELETE FROM notification_preferences WHERE user_id = ?").run(mod);
    clearOutbox(mod);

    const reporter = makeOrganizer();   // adult reporting an adult: no student floor
    const target = makeOrganizer();
    const res = createReport({
      reporter: { id: reporter, role: 'organizer' },
      targetType: 'user',
      targetId: target,
      category: 'spam_or_advertising',
      description: 'This account is posting the same advertisement everywhere.',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    expect(emailJobsFor(mod)).toEqual([]);
    expect(notificationsFor(mod)).toEqual([]);
  });
});
