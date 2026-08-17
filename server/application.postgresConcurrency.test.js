/**
 * The APPLICATION's own paths, run concurrently against real PostgreSQL.
 *
 * ── Why this file exists separately from capacity.postgresConcurrency.test.js ──
 *
 * That file drives tables it creates itself. It proves PostgreSQL's locking
 * primitives behave — which is worth knowing and is not the question. The
 * question is whether *this application's* read-then-write paths are safe when
 * two requests arrive together, and a synthetic table cannot answer it because
 * the application's SQL is not the SQL under test.
 *
 * The alerting defect found in this migration is the argument for the
 * distinction. `runNotificationSweep` called `sendErrorAlerts` without awaiting
 * it, justified by a comment stating that the marking was synchronous so
 * overlapping sweeps could not double-send. That was true on SQLite and false
 * on PostgreSQL, where every statement is a round trip. No synthetic-table test
 * would ever have looked at it.
 *
 * ── How these tests are made deterministic ──
 *
 * Every case runs its operations through `Promise.all`, so they are genuinely
 * in flight together against a pool rather than interleaved by a scheduler this
 * file controls. That means a single green run proves less than it appears to,
 * so each invariant is asserted over REPEATED rounds with fresh state. A race
 * that only sometimes loses still fails, and it fails on the invariant rather
 * than on a timing assumption.
 *
 * Nothing here sleeps. The assertions are all about final state — how many rows
 * exist, what the counter reached, which id won — so there is no arbitrary
 * delay to tune and no flake to chase.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RUNNING_ON_POSTGRES } from './testEngine.js';

/**
 * Runs only when the application is genuinely on PostgreSQL.
 *
 * On SQLite these invariants are held by a different mechanism entirely — a
 * process-wide write queue and synchronous statements — so passing here would
 * say nothing about the engine being migrated to. `describe.skipIf` rather than
 * an early return, so a skip is visible in the report instead of a test that
 * asserts nothing.
 */
describe.skipIf(!RUNNING_ON_POSTGRES)('the application under real PostgreSQL concurrency', () => {
  let srv, db, reportService, errorReporter, alerting, email;

  beforeAll(async () => {
    /* Without a recipient `sendErrorAlerts` returns `not_configured` and the
       ownership race below would pass by never sending at all. */
    process.env.ALERT_EMAIL = 'ops@concurrency.test';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    reportService = await import('./reportService.js');
    errorReporter = await import('./errorReporter.js');
    alerting = await import('./alerting.js');
    email = await import('./email.js');
  }, 60_000);

  afterAll(async () => { await srv?.close(); delete process.env.ALERT_EMAIL; });

  it('is on PostgreSQL — a skip must not look like a pass', async () => {
    const { rows } = { rows: [await db.prepare('SELECT 1 AS ok').get()] };
    expect(rows[0].ok).toBe(1);
    expect(db.dialect, 'this suite is meaningless on any other engine').toBe('postgres');
  });

  /**
   * The error reporter's occurrence counter is an increment on a row several
   * requests can touch at once — the classic lost update. It is now written as
   * `INSERT … ON CONFLICT DO UPDATE SET occurrences = error_groups.occurrences + 1`,
   * which is atomic; the previous read-then-write lost reports outright, because
   * the loser's duplicate-key error aborted it before the event row was written.
   */
  describe('error reporting', () => {
    const fingerprintRow = async (message) =>
      await db.prepare('SELECT occurrences FROM error_groups WHERE message = ?').get(message);

    it('counts every one of 12 simultaneous reports of the same problem', async () => {
      for (let round = 0; round < 4; round += 1) {
        const message = `concurrent-round-${round}-${Math.random().toString(36).slice(2)}`;
        await Promise.all(Array.from({ length: 12 }, () =>
          errorReporter.recordError(db, { kind: 'TypeError', message, route: '/api/events', source: 'server' })));

        const row = await fingerprintRow(message);
        expect(row, 'twelve reports produced no group at all').toBeTruthy();
        expect(
          Number(row.occurrences),
          'a lost update: two reports read the same count and both wrote back count+1',
        ).toBe(12);
      }
    }, 60_000);

    it('creates exactly one group for simultaneous first-sightings', async () => {
      for (let round = 0; round < 4; round += 1) {
        const message = `first-sighting-${round}-${Math.random().toString(36).slice(2)}`;
        await Promise.all(Array.from({ length: 8 }, () =>
          errorReporter.recordError(db, { kind: 'RangeError', message, route: '/api/x', source: 'server' })));

        const n = (await db.prepare('SELECT COUNT(*) AS c FROM error_groups WHERE message = ?').get(message)).c;
        expect(Number(n), 'the same problem was filed under more than one group').toBe(1);
      }
    }, 60_000);
  });

  /**
   * Only one sweep may own a given alert. The claim is a conditional UPDATE …
   * RETURNING for exactly this reason: `runNotificationSweep` does not await
   * the send, so two ticks really can be inside `sendErrorAlerts` together.
   */
  describe('alert ownership', () => {
    it('lets exactly one of six overlapping sweeps claim a problem', async () => {
      for (let round = 0; round < 3; round += 1) {
        const fp = `fp-race-${round}-${Math.random().toString(36).slice(2)}`;
        const now = new Date().toISOString();
        await db.prepare('DELETE FROM error_groups').run();
        await db.prepare(`
          INSERT INTO error_groups
            (fingerprint, source, kind, message, route, status, occurrences, users_seen,
             first_seen_at, last_seen_at, alerted_at)
          VALUES (?, 'server', 'TypeError', 'race', '/r', 'open', 1, 0, ?, ?, NULL)
        `).run(fp, now, now);

        let sends = 0;
        const send = async () => { sends += 1; return { ok: true }; };
        const results = await Promise.all(Array.from({ length: 6 }, () =>
          alerting.sendErrorAlerts(db, { send, appUrl: 'http://x' })));

        const sent = results.filter(r => r.sent > 0).length;
        expect(sent, 'more than one sweep claimed the same problem — this is the alert loop').toBe(1);
        expect(sends, 'the digest was mailed more than once').toBe(1);
        expect(await claimedAt(fp)).not.toBeNull();
      }
    }, 60_000);

    const claimedAt = async (fp) =>
      (await db.prepare('SELECT alerted_at FROM error_groups WHERE fingerprint = ?').get(fp))?.alerted_at;
  });

  /**
   * Filing the same report twice is an insert guarded by a unique index, with
   * the collision handled by reading back the original id. Under concurrency
   * both callers can reach the INSERT, so the loser MUST take the handled
   * branch rather than surfacing a 500 — which is what it did on PostgreSQL
   * until `isUniqueViolation()` stopped matching SQLite's error wording.
   */
  describe('report duplicate suppression', () => {
    /**
     * Isolation is by DISTINCT TARGET, not by cleanup.
     *
     * `reports` and `moderation_actions` are both append-only — their triggers
     * refuse DELETE outright, which is the audit guarantee working. So each
     * round races against a different event rather than resetting, and the
     * uniqueness under test is per `(reporter, target_type, target_id)` anyway.
     */
    it('files one report and returns the same id to all six simultaneous callers', async () => {
      const reporter = await db.prepare(
        "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' LIMIT 1"
      ).get();
      const events = await db.prepare('SELECT id FROM events ORDER BY id LIMIT 3').all();
      expect(reporter?.id, 'fixture: no student to report with').toBeTruthy();
      expect(events.length, 'fixture: needs distinct events to race against').toBeGreaterThan(0);

      for (const target of events) {
        const already = (await db.prepare(
          'SELECT COUNT(*) AS c FROM reports WHERE reporter_id = ? AND target_id = ?'
        ).get(reporter.id, target.id)).c;
        if (Number(already) > 0) continue;   // a seeded report already owns this pair

        const results = await Promise.all(Array.from({ length: 6 }, () =>
          reportService.createReport({
            reporter: { id: reporter.id, role: 'student' },
            targetType: 'event',
            targetId: target.id,
            category: 'something_feels_wrong',
            description: 'concurrent duplicate suppression probe',
          }).catch((err) => ({ ok: false, threw: String(err?.message ?? err) }))));

        const ok = results.filter(r => r.ok);
        expect(
          ok.length,
          `a duplicate surfaced as a failure instead of the original id: ${JSON.stringify(results.filter(r => !r.ok))}`,
        ).toBe(6);

        const ids = new Set(ok.map(r => r.reportId));
        expect(ids.size, 'six callers were given more than one report id for one report').toBe(1);

        const stored = (await db.prepare(
          'SELECT COUNT(*) AS c FROM reports WHERE reporter_id = ? AND target_id = ?'
        ).get(reporter.id, target.id)).c;
        expect(Number(stored), 'the unique index did not hold under concurrency').toBe(1);
      }
    }, 60_000);
  });


  /**
   * Event capacity is the highest-stakes read-then-write in the product.
   *
   * `PATCH /api/applications/:id` accepts by reading
   * `SELECT COUNT(*) … WHERE status = 'accepted'`, comparing it to the slot's
   * `max_spots`, and only then writing — and that read happens on the ambient
   * handle, outside the transaction that performs the write. Two organizers
   * clicking Accept at the same moment can therefore both read the same count.
   *
   * On SQLite the process-wide write queue serialised this so completely that
   * the window never opened. A connection pool opens it.
   *
   * Oversubscription is not a cosmetic bug: it puts more volunteers on a shift
   * than the host asked for, and the person who arrives to be turned away is a
   * student who arranged a ride.
   */
  describe('event capacity', () => {
    const ORGANIZER = 'jordan.whitfield@example.org';

    /** An event with one slot of `spots`, and `n` pending applications on it. */
    async function raceFixture(spots, n, tag) {
      const organizer = await srv.login(ORGANIZER);
      const start = new Date(Date.now() + 40 * 864e5).toISOString();
      const made = await srv.call('POST', '/api/events', {
        title: `Capacity race ${tag}`, description: 'd', category: 'Other', location: 'Somewhere',
        applicationDeadline: new Date(Date.now() + 30 * 864e5).toISOString(),
        slots: [{
          name: 'S', description: 'd', startDatetime: start,
          endDatetime: new Date(Date.now() + 40 * 864e5 + 108e5).toISOString(), maxSpots: spots,
        }],
      }, organizer);
      expect(made.status, `fixture: event not created (${JSON.stringify(made.body)})`).toBe(201);

      const slot = await db.prepare('SELECT id FROM slots WHERE event_id = ?').get(made.body.id);

      /* Applications are written directly: the goal is to race the ACCEPT path,
         and going through the apply endpoint n times only adds fixture that can
         fail for unrelated eligibility reasons. */
      const students = await db.prepare(
        "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' ORDER BY id LIMIT ?"
      ).all(n);
      expect(students.length, `fixture: needs ${n} students, seed has ${students.length}`).toBe(n);

      const ids = [];
      for (const [i, u] of students.entries()) {
        const id = `app-race-${tag}-${i}`;
        await db.prepare(`
          INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
        `).run(id, u.id, made.body.id, slot.id, new Date().toISOString());
        ids.push(id);
      }
      return { organizer, slotId: slot.id, applicationIds: ids };
    }

    const acceptedIn = async (slotId) => Number((await db.prepare(
      "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
    ).get(slotId)).c);

    for (const [spots, attempts] of [[1, 2], [1, 5], [2, 5]]) {
      it(`never puts more than ${spots} into a ${spots}-spot slot when ${attempts} accepts race`, async () => {
        for (let round = 0; round < 3; round += 1) {
          const tag = `${spots}x${attempts}r${round}-${Math.random().toString(36).slice(2, 7)}`;
          const { organizer, slotId, applicationIds } = await raceFixture(spots, attempts, tag);

          const results = await Promise.all(applicationIds.map(id =>
            srv.call('PATCH', `/api/applications/${id}`, { status: 'accepted' }, organizer)
              .catch(err => ({ status: 0, body: { error: String(err?.message ?? err) } }))));

          const accepted = await acceptedIn(slotId);
          expect(
            accepted,
            `oversubscribed: ${accepted} accepted into ${spots} spot(s). `
            + `statuses: ${results.map(r => r.status).join(',')}`,
          ).toBeLessThanOrEqual(spots);

          /* And it must not UNDER-fill either: refusing everybody would satisfy
             the bound above while breaking the product. */
          expect(accepted, 'the slot was left emptier than it should be').toBe(Math.min(spots, attempts));

          const okays = results.filter(r => r.status === 200).length;
          expect(okays, 'more requests reported success than there were spots').toBe(accepted);
        }
      }, 120_000);
    }
  });


  /**
   * Waitlist promotion is the same read-then-write, one layer down.
   *
   * `promoteFromWaitlist` counts accepted rows, computes
   * `free = max_spots - accepted`, and promotes that many. Two spots released at
   * the same moment each compute a free count from a slot the other is also
   * changing, so the same waitlisted person can be promoted twice — or two
   * people can be promoted into one freed spot.
   *
   * It runs inside the caller's transaction (`AsyncLocalStorage` binds the
   * module-level handle to the transaction's connection, so this is not a
   * cross-connection bug), which means the lock has to be taken on the slot for
   * the same reason it is in the accept path.
   */
  describe('waitlist promotion', () => {
    const ORGANIZER = 'jordan.whitfield@example.org';

    it('never promotes more people than the spots actually released', async () => {
      for (let round = 0; round < 3; round += 1) {
        const tag = `wl${round}-${Math.random().toString(36).slice(2, 7)}`;
        const organizer = await srv.login(ORGANIZER);
        const start = new Date(Date.now() + 45 * 864e5).toISOString();
        const made = await srv.call('POST', '/api/events', {
          title: `Waitlist race ${tag}`, description: 'd', category: 'Other', location: 'Somewhere',
          applicationDeadline: new Date(Date.now() + 30 * 864e5).toISOString(),
          slots: [{
            name: 'S', description: 'd', startDatetime: start,
            endDatetime: new Date(Date.now() + 45 * 864e5 + 108e5).toISOString(), maxSpots: 2,
          }],
        }, organizer);
        expect(made.status, `fixture: event (${JSON.stringify(made.body)})`).toBe(201);
        const slot = await db.prepare('SELECT id FROM slots WHERE event_id = ?').get(made.body.id);

        const students = await db.prepare(
          "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' ORDER BY id LIMIT 5"
        ).all();
        expect(students.length, 'fixture: needs five students').toBe(5);

        /* Two accepted (filling the slot), three waitlisted behind them. */
        const accepted = [], now = new Date().toISOString();
        for (const [i, u] of students.entries()) {
          const id = `app-${tag}-${i}`;
          const status = i < 2 ? 'accepted' : 'waitlisted';
          await db.prepare(`
            INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, u.id, made.body.id, slot.id, status, now, i < 2 ? null : i);
          if (i < 2) accepted.push(id);
        }

        /* Release BOTH accepted spots at the same instant. Exactly two of the
           three waitlisted people may be promoted — never three, never the same
           person twice. */
        await Promise.all(accepted.map(id =>
          srv.call('PATCH', `/api/applications/${id}`, { status: 'rejected' }, organizer)
            .catch(err => ({ status: 0, body: { error: String(err?.message ?? err) } }))));

        const rows = await db.prepare(
          'SELECT user_id, status FROM applications WHERE slot_id = ?'
        ).all(slot.id);
        const nowAccepted = rows.filter(r => r.status === 'accepted');

        expect(
          nowAccepted.length,
          `promoted ${nowAccepted.length} into 2 released spots: ${rows.map(r => r.status).join(',')}`,
        ).toBeLessThanOrEqual(2);

        const distinct = new Set(nowAccepted.map(r => r.user_id));
        expect(distinct.size, 'the same person was promoted more than once').toBe(nowAccepted.length);

        /* The other bound. Promoting NOBODY satisfies "never more than two" and
           breaks the product — two spots were released and three people were
           waiting, so two must move up. Without this the test passes on a
           promotion path that silently does nothing. */
        expect(
          nowAccepted.length,
          `two spots were released with three people waiting, but ${nowAccepted.length} were promoted`,
        ).toBe(2);
      }
    }, 120_000);
  });

  /**
   * A check-in token is single-use by contract: it is how attendance is claimed,
   * and a token that can be redeemed twice is a double attendance record.
   */
  describe('check-in tokens', () => {
    it('lets exactly one of eight simultaneous redemptions succeed', async () => {
      const { issueCheckinToken, consumeCheckinToken } = await import('./checkinTokens.js');
      const application = await db.prepare(
        "SELECT * FROM applications WHERE status = 'accepted' LIMIT 1"
      ).get();
      expect(application?.id, 'fixture: no accepted application to check in').toBeTruthy();
      const actor = application.user_id;

      for (let round = 0; round < 3; round += 1) {
        await db.prepare('DELETE FROM attendance WHERE user_id = ?').run(application.user_id);
        const issued = await issueCheckinToken(db, { application });
        const tokenId = issued?.tokenId ?? issued?.id ?? issued?.token;
        expect(tokenId, 'fixture: no check-in token was issued').toBeTruthy();

        const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
          consumeCheckinToken(db, { tokenId, actorId: actor }).then(
            (r) => (r && r.ok !== false ? 'ok' : 'refused'),
            () => 'threw',
          )));

        expect(
          outcomes.filter(o => o === 'ok').length,
          `a single-use token was consumed more than once: ${outcomes.join(',')}`,
        ).toBe(1);
      }
    }, 60_000);
  });
});
