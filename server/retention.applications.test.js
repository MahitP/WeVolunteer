/**
 * Application retention — the period the Privacy Policy has always published.
 *
 * ── The gap this closes ──
 *
 * The Privacy Policy's retention table has carried "Applications | 3 years after the
 * event" since v2.0, and two rows later says "These periods are enforced by a job
 * that runs every day and deletes what has aged out — they are not just a statement
 * of intent." For this row that was false: `retentionWorker.sweep()` deleted
 * messages, audit logs and anonymised account shells, and nothing anywhere deleted an
 * application by age. The only `DELETE FROM applications` statements in the codebase
 * are the event and slot cascades in `eventRoutes.js`.
 *
 * Every other period in that table checked out against the code, which made this one
 * more dangerous rather than less: the surrounding accuracy is what earns a reader's
 * trust in the row that was wrong.
 *
 * ── Which timestamp controls it, and why ──
 *
 * The period is measured from **the end of the event's last slot**, with
 * `applications.applied_at` as the fallback for an event that has no slots. Three
 * candidates were considered:
 *
 *   - **`applications.applied_at`** — wrong on its own. A student who applies to an
 *     event two years out would have their application deleted before the event
 *     happens, taking the organizer's roster with it. The policy says "after the
 *     event", not "after you applied".
 *   - **`events.status = 'completed'`** — depends on an organizer remembering to mark
 *     it. An abandoned event never completes, so its applications would be kept for
 *     ever. That is the least privacy-preserving option available.
 *   - **`MAX(slots.end_datetime)`** — chosen. It is derived from data rather than from
 *     someone's diligence, it cannot be forgotten, it means literally "after the
 *     event", and it deletes at the earliest moment the published policy allows.
 *
 * The fallback matters for the same privacy reason: an event with no slots never
 * happened, and without a fallback its applications would have no cutoff at all and
 * would live for ever. `applied_at` bounds them.
 *
 * ── What must survive ──
 *
 * `attendance` has no foreign key to `applications` (it keys on event/slot/user), so
 * deleting an application cannot touch credited hours or certificates. That is
 * asserted below rather than assumed, because it is the one thing this sweep could
 * destroy that is unrecoverable and that `assertPreservedTablesUntouched` exists to
 * make impossible.
 *
 * `application_conflicts` cascades from `applications`, so its rows go with the
 * application they describe. That is correct — a scheduling conflict about a deleted
 * application is meaningless — and is asserted so a future schema change that turns
 * the cascade into a RESTRICT fails here rather than aborting the nightly sweep.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;
let sweep, RETENTION;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ sweep, RETENTION } = await import('./workers/retentionWorker.js'));
});
afterAll(async () => { await srv.close(); });

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

let seq = 0;

/**
 * A student, an event, one slot, and one application to it.
 *
 * `slotEnd` is what the sweep reads. `null` creates an event with NO slots, which
 * exercises the `applied_at` fallback — and the application then needs a slot_id that
 * does not resolve, so that case is built separately below.
 */
async function seedApplication({ slotEnd, appliedAt }) {
  const n = ++seq;
  const userId = `ret-app-user-${n}`;
  const eventId = `ret-app-event-${n}`;
  const slotId = `ret-app-slot-${n}`;
  const appId = `ret-app-${n}`;

  await db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, created_at)
    VALUES (?, ?, 'h', 'Retention Student', 'student', '11', ?, 1, 'active', '${new Date().toISOString()}')
  `).run(userId, `${userId}@example.com`, userId.replace(/-/g, '_'));

  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, status, created_at)
    VALUES (?, 'Retention Fixture Event', 'd', 'Other', 'Somewhere', ?, 'user-org-1', 'completed', ?)
  `).run(eventId, appliedAt, appliedAt);

  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', 'd', ?, ?, 5)
  `).run(slotId, eventId, slotEnd, slotEnd);

  await db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, 'accepted', ?)
  `).run(appId, userId, eventId, slotId, appliedAt);

  return { appId, userId, eventId, slotId };
}

const appExists = async (id) =>
  (await db.prepare('SELECT COUNT(*) AS c FROM applications WHERE id = ?').get(id)).c === 1;

beforeEach(async () => {
  await db.prepare("DELETE FROM applications WHERE id LIKE 'ret-app-%'").run();
});

describe('the published period is enforced', () => {
  it('publishes a period of 3 years, matching the Privacy Policy', () => {
    // The policy row says "3 years after the event". If this constant changes, the
    // policy has to change with it — that pairing is the whole point.
    expect(RETENTION.applicationDays).toBe(3 * 365);
  });

  it('deletes an application whose event ended past the window', async () => {
    const { appId } = await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays + 30),
      appliedAt: daysAgo(RETENTION.applicationDays + 60),
    });
    expect(await appExists(appId)).toBe(true);
    await sweep(db);
    expect(await appExists(appId)).toBe(false);
  });

  it('keeps an application whose event ended one day inside the window', async () => {
    const { appId } = await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays - 1),
      appliedAt: daysAgo(RETENTION.applicationDays + 60),
    });
    await sweep(db);
    expect(await appExists(appId)).toBe(true);
  });

  it('reports what it removed, so the sweep can be logged and asserted', async () => {
    await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays + 30),
      appliedAt: daysAgo(RETENTION.applicationDays + 60),
    });
    const result = await sweep(db);
    expect(result.applications).toBeGreaterThan(0);
  });

  it('counts without deleting on a dry run', async () => {
    const { appId } = await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays + 30),
      appliedAt: daysAgo(RETENTION.applicationDays + 60),
    });
    const result = await sweep(db, { dryRun: true });
    expect(result.applications).toBeGreaterThan(0);
    expect(await appExists(appId)).toBe(true);
  });
});

describe('the event decides the clock, not the application', () => {
  /**
   * The case that rules out keying on `applied_at`.
   *
   * A student applying far ahead of a real event must not have that application
   * swept before the event happens — it is the organizer's roster.
   */
  it('KEEPS an old application to an event that has not happened yet', async () => {
    const { appId } = await seedApplication({
      slotEnd: inDays(30),                                   // event is in the future
      appliedAt: daysAgo(RETENTION.applicationDays + 400),   // applied a very long time ago
    });
    await sweep(db);
    expect(await appExists(appId), 'an application to a FUTURE event was deleted').toBe(true);
  });

  it('deletes an application filed recently to an event that ended long ago', async () => {
    // The mirror image: a late-recorded application to an ancient event still ages
    // out with the event, because the event is what the policy names.
    const { appId } = await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays + 30),
      appliedAt: daysAgo(1),
    });
    await sweep(db);
    expect(await appExists(appId)).toBe(false);
  });

  /**
   * An event with no slots never happened, so `applied_at` bounds it.
   *
   * Without a fallback these rows would have no cutoff and would be retained for
   * ever, which is the outcome the policy exists to prevent.
   */
  it('falls back to applied_at for an event with no slots', async () => {
    const n = ++seq;
    const userId = `ret-app-user-${n}`;
    const eventId = `ret-app-event-${n}`;
    const slotId = `ret-app-slot-${n}`;
    const appId = `ret-app-${n}`;
    const old = daysAgo(RETENTION.applicationDays + 30);

    await db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, grade, username,
                         email_verified, account_status, created_at)
      VALUES (?, ?, 'h', 'No Slot Student', 'student', '9', ?, 1, 'active', '${new Date().toISOString()}')
    `).run(userId, `${userId}@example.com`, userId.replace(/-/g, '_'));
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at)
      VALUES (?, 'Slotless Event', 'd', 'Other', 'Somewhere', ?, 'user-org-1', 'cancelled', ?)
    `).run(eventId, old, old);
    // A slot row is required by the FK, then removed, leaving the event slotless.
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Shift', 'd', ?, ?, 1)
    `).run(slotId, eventId, old, old);
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'withdrawn', ?)
    `).run(appId, userId, eventId, slotId, old);

    // Detach the slot without cascading the application away, so the fallback path
    // is what decides. (A real slotless event reaches this state by never having had
    // one; this is the only way to construct it against the FK.)
    await db.prepare('PRAGMA foreign_keys = OFF').run();
    await db.prepare('DELETE FROM slots WHERE id = ?').run(slotId);
    await db.prepare('PRAGMA foreign_keys = ON').run();

    expect(await appExists(appId)).toBe(true);
    await sweep(db);
    expect(await appExists(appId), 'a slotless event\'s ancient application was retained for ever').toBe(false);
  });
});

describe('what the sweep must never touch', () => {
  /**
   * The unrecoverable case.
   *
   * `attendance` and `certificates` are the service record and are retained
   * indefinitely by product decision. They have no FK to `applications`, so this
   * cannot happen by cascade — but it is asserted because it is the one outcome of
   * this change that could not be undone, and `assertPreservedTablesUntouched`
   * inside the sweep is the guard that would catch it.
   */
  it('deletes the application but keeps the attendance, hours and certificate', async () => {
    const { appId, userId, eventId, slotId } = await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays + 30),
      appliedAt: daysAgo(RETENTION.applicationDays + 60),
    });

    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, ?, ?, 1, 4.5)
    `).run(eventId, slotId, userId);
    await db.prepare(`
      INSERT INTO certificates (user_id, event_id, code, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, eventId, `WEV-RET-${seq}`, daysAgo(10));

    await sweep(db);

    expect(await appExists(appId), 'the aged application should have gone').toBe(false);
    expect(
      (await db.prepare('SELECT hours_awarded FROM attendance WHERE slot_id = ? AND user_id = ?')
        .get(slotId, userId))?.hours_awarded,
      'credited hours were destroyed by the application sweep'
    ).toBe(4.5);
    expect(
      (await db.prepare('SELECT COUNT(*) AS c FROM certificates WHERE user_id = ?').get(userId)).c,
      'a certificate was destroyed by the application sweep'
    ).toBe(1);
  });

  it('takes application_conflicts with the application, and nothing else', async () => {
    const a = await seedApplication({
      slotEnd: daysAgo(RETENTION.applicationDays + 30),
      appliedAt: daysAgo(RETENTION.applicationDays + 60),
    });
    const b = await seedApplication({
      slotEnd: daysAgo(10),                                  // well inside the window
      appliedAt: daysAgo(20),
    });
    await db.prepare(`
      INSERT INTO application_conflicts
        (id, application_id, conflicting_application_id, conflict_type, created_at)
      VALUES (?, ?, ?, 'accepted', ?)
    `).run(`ret-conflict-${seq}`, a.appId, b.appId, daysAgo(20));

    await sweep(db);

    expect(await appExists(a.appId)).toBe(false);
    expect(await appExists(b.appId), 'a recent application was swept as collateral').toBe(true);
    expect(
      (await db.prepare('SELECT COUNT(*) AS c FROM application_conflicts WHERE application_id = ?')
        .get(a.appId)).c,
      'the conflict row outlived the application it describes'
    ).toBe(0);
  });

  it('leaves a recent application alone however old the account is', async () => {
    const { appId } = await seedApplication({ slotEnd: daysAgo(5), appliedAt: daysAgo(6) });
    await sweep(db);
    expect(await appExists(appId)).toBe(true);
  });
});
