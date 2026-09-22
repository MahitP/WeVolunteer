import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

// `db` and `backfillCertificates` are imported dynamically inside beforeAll,
// AFTER startTestServer() has set WEV_DB_PATH and imported db.js itself.
// A static top-level import here would run before that env var is set and
// would open server/wevolunteer.db (the real database) instead of the
// throwaway test file — exactly what the harness's dynamic-import pattern in
// testServer.js exists to avoid. Because ESM caches modules by specifier,
// this dynamic import resolves to the very same already-initialized `db`
// singleton the running server is using.
let db, backfillCertificates;

/**
 * The old, now-removed deterministic algorithm, reimplemented here (not
 * imported — it no longer exists in server/utils.js) purely so a test can
 * prove a code computed the old way no longer verifies.
 */
async function oldCertificateCode(userId, eventId) {
  const source = `wev::${userId}::${eventId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < source.length; i++) {
    h1 = Math.imul(h1 ^ source.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + source.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0;
  }
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
  const block = (n) => Array.from({ length: 4 }, (_, i) =>
    alphabet[(n >>> (i * 5)) % alphabet.length]).join('');
  return `WEV-${await block(h1)}-${await block(h2)}`;
}

const CODE_FORMAT = /^WEV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

describe('certificates', () => {
  let srv, priyaToken;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ backfillCertificates } = await import('./certificates.js'));
    priyaToken = await srv.login('priya.patel@example.com');
  });
  afterAll(async () => { await srv.close(); });

  it('issues a certificate for a completed, credited event', async () => {
    const res = await srv.call('GET', '/api/certificates', undefined, priyaToken);
    expect(res.status).toBe(200);
    const cert = res.body.find(c => c.eventId === 'event-pantry-past');
    expect(cert).toBeTruthy();
    expect(cert.code).toMatch(CODE_FORMAT);
  });

  it('returns the SAME code on a second call (stable, stored)', async () => {
    const first = await srv.call('GET', '/api/certificates', undefined, priyaToken);
    const second = await srv.call('GET', '/api/certificates', undefined, priyaToken);
    const c1 = first.body.find(c => c.eventId === 'event-pantry-past').code;
    const c2 = second.body.find(c => c.eventId === 'event-pantry-past').code;
    expect(c1).toBe(c2);
  });

  it('verifies a real code and returns the volunteer, event and hours, with no grade field', async () => {
    const certs = await srv.call('GET', '/api/certificates', undefined, priyaToken);
    const code = certs.body.find(c => c.eventId === 'event-pantry-past').code;

    const res = await srv.call('GET', `/api/certificates/verify/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.volunteerName).toBe('Priya Patel');
    expect(res.body.eventTitle).toBeTruthy();
    expect(res.body.organizerName).toBeTruthy();
    expect(res.body.hours).toBe(3);
    expect(res.body.completedAt).toBeTruthy();
    expect(res.body).not.toHaveProperty('grade');
  });

  it('rejects a code computed by the old deterministic algorithm', async () => {
    const oldCode = await oldCertificateCode('user-student-2', 'event-pantry-past');

    const res = await srv.call('GET', `/api/certificates/verify/${oldCode}`);
    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
  });

  it('404s an unknown/garbage code', async () => {
    const res = await srv.call('GET', '/api/certificates/verify/WEV-ZZZZ-ZZZZ');
    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
  });

  it('gives two different certificates different, correctly formatted codes', async () => {
    // Give Ethan (user-student-3) a credited attendance record for the same
    // past event directly via the DB, then backfill so he gets a certificate
    // distinct from Priya's.
    await db.prepare('UPDATE attendance SET present = 1 WHERE event_id = ? AND user_id = ?')
      .run('event-pantry-past', 'user-student-3');
    await backfillCertificates(db);

    const ethanToken = await srv.login('ethan.miller@example.com');
    const ethanCerts = await srv.call('GET', '/api/certificates', undefined, ethanToken);
    const priyaCerts = await srv.call('GET', '/api/certificates', undefined, priyaToken);

    const ethanCode = ethanCerts.body.find(c => c.eventId === 'event-pantry-past').code;
    const priyaCode = priyaCerts.body.find(c => c.eventId === 'event-pantry-past').code;

    expect(ethanCode).toMatch(CODE_FORMAT);
    expect(priyaCode).toMatch(CODE_FORMAT);
    expect(ethanCode).not.toBe(priyaCode);
  });

  it('getOrCreateCertificateCode backfill is idempotent — a second run inserts nothing', async () => {
    const first = await backfillCertificates(db);
    expect(first.inserted).toBe(0); // already backfilled at boot + by the previous test

    const second = await backfillCertificates(db);
    expect(second.inserted).toBe(0);
  });

  /**
   * A certificate list lists CERTIFICATES.
   *
   * ── The two faults, which are the same fault ──
   *
   * `GET /api/certificates` excluded a cancelled event outright, so a student
   * holding a certificate issued before the organizer called the event off
   * could not see it in their own list — while `GET /api/users/:id/certificates`
   * showed it to anybody who opened their profile, and
   * `/api/certificates/verify/:code` answered `valid: true` to a college. The
   * owner was the one person the product hid the document from.
   *
   * The public list had the mirror fault. It is an aggregate over `attendance`,
   * not over `certificates`, so it listed a cancelled event that never had a
   * certificate at all — `getOrCreateCertificateCode` refuses to mint one — and
   * called it a certificate.
   *
   * ── The model ──
   *
   * Both lists enumerate certificates that exist. A cancelled event appears
   * only if its certificate was issued before the cancellation, and it is
   * flagged so both surfaces can carry the sentence `CertificateView` already
   * carries: the document stays valid, and its hours are not in the totals.
   * The service RECORD is a different thing with its own surfaces — `/hours`
   * and the portfolio — and it still excludes the event entirely.
   *
   * Decided during the 2026-09-21 audit (owner decision 2).
   */
  describe('a certificate whose event was cancelled afterwards', () => {
    const EVENT = 'event-cert-then-cancelled';
    let priyaId;

    beforeAll(async () => {
      priyaId = (await db.prepare('SELECT id FROM users WHERE email = ?')
        .get('priya.patel@example.com')).id;

      /* Credited attendance at an event that is still open, so a certificate
         can legitimately be minted — cancelling is refused once an event is
         `completed`, which is exactly how this state is reached in production:
         one volunteer finalised, others outstanding, status still open. */
      await db.prepare(`
        INSERT INTO events (id, title, description, category, location,
                            application_deadline, organizer_id, status, created_at)
        VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'open', ?)
      `).run(EVENT, 'Winter Coat Drive', 'Synthetic fixture.', 'Springfield',
        '2026-07-20T00:00:00.000Z', priyaId, '2026-07-01T00:00:00.000Z');
      await db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 5)
      `).run('slot-cert-then-cancelled', EVENT,
        '2026-07-23T13:00:00.000Z', '2026-07-23T17:00:00.000Z');
      await db.prepare(`
        INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
        VALUES (?, ?, ?, 1, 4)
      `).run(EVENT, 'slot-cert-then-cancelled', priyaId);

      /* Viewing the list mints the code. Then the organizer calls it off. */
      await srv.call('GET', '/api/certificates', undefined, priyaToken);
      await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(EVENT);
    });

    it('was actually issued before the cancellation', async () => {
      const row = await db.prepare(
        'SELECT code FROM certificates WHERE user_id = ? AND event_id = ?'
      ).get(priyaId, EVENT);
      expect(row?.code, 'the fixture never minted a certificate; the cases below would prove nothing')
        .toMatch(CODE_FORMAT);
    });

    it('stays in the owner\u2019s own list, flagged', async () => {
      const res = await srv.call('GET', '/api/certificates', undefined, priyaToken);
      const cert = res.body.find(c => c.eventId === EVENT);
      expect(cert, 'the student cannot see a certificate that verifies to a college').toBeTruthy();
      expect(cert.eventCancelled).toBe(true);
      expect(cert.code).toMatch(CODE_FORMAT);
    });

    it('leaves every other row unflagged', async () => {
      const res = await srv.call('GET', '/api/certificates', undefined, priyaToken);
      const live = res.body.find(c => c.eventId === 'event-pantry-past');
      expect(live.eventCancelled).toBe(false);
    });

    it('is flagged on the public list too', async () => {
      const res = await srv.call('GET', `/api/users/${priyaId}/certificates`, undefined, priyaToken);
      const cert = res.body.certificates.find(c => c.eventId === EVENT);
      expect(cert).toBeTruthy();
      expect(cert.eventCancelled).toBe(true);
    });

    it('does not put a cancelled event with no certificate on the public list', async () => {
      /* The mirror fault: the public list aggregates attendance, so it named a
         document that was never issued and can never be issued. */
      const PHANTOM = 'event-cancelled-no-cert';
      await db.prepare(`
        INSERT INTO events (id, title, description, category, location,
                            application_deadline, organizer_id, status, created_at)
        VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'cancelled', ?)
      `).run(PHANTOM, 'Never issued', 'Synthetic fixture.', 'Springfield',
        '2026-07-20T00:00:00.000Z', priyaId, '2026-07-01T00:00:00.000Z');
      await db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 5)
      `).run('slot-phantom', PHANTOM, '2026-07-24T13:00:00.000Z', '2026-07-24T17:00:00.000Z');
      await db.prepare(`
        INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
        VALUES (?, ?, ?, 1, 4)
      `).run(PHANTOM, 'slot-phantom', priyaId);

      expect(await db.prepare('SELECT 1 AS x FROM certificates WHERE user_id = ? AND event_id = ?')
        .get(priyaId, PHANTOM)).toBeFalsy();

      const pub = await srv.call('GET', `/api/users/${priyaId}/certificates`, undefined, priyaToken);
      expect(pub.body.certificates.some(c => c.eventId === PHANTOM)).toBe(false);

      const own = await srv.call('GET', '/api/certificates', undefined, priyaToken);
      expect(own.body.some(c => c.eventId === PHANTOM)).toBe(false);
    });

    it('still keeps the hours out of the credited total', async () => {
      /* The record and the document are different things, and this is the half
         that must not move: `/api/auth/me` is `creditedHoursFor`. */
      const me = (await srv.call('GET', '/api/auth/me', undefined, priyaToken)).body;
      const fromCancelled = await db.prepare(`
        SELECT COALESCE(SUM(a.hours_awarded), 0) AS h
        FROM attendance a JOIN events e ON e.id = a.event_id
        WHERE a.user_id = ? AND a.present = 1 AND e.status = 'cancelled'
      `).get(me.id);
      expect(Number(fromCancelled.h)).toBeGreaterThan(0);

      const credited = await db.prepare(`
        SELECT COALESCE(SUM(a.hours_awarded), 0) AS h
        FROM attendance a JOIN events e ON e.id = a.event_id
        WHERE a.user_id = ? AND a.present = 1 AND e.status <> 'cancelled'
      `).get(me.id);
      expect(Number(me.volunteeredHours)).toBe(Number(credited.h));
    });
  });
});
