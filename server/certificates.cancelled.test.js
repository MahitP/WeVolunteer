import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createCertificatesTable, getOrCreateCertificateCode, backfillCertificates } from './certificates.js';

/**
 * Certificates and cancelled events.
 *
 * ── The two halves, which point in opposite directions ──
 *
 * ISSUING one for a called-off event is wrong. `PATCH /api/events/:id/status`
 * notifies every confirmed volunteer with `EVENT_CANCELLED` because "they may
 * have arranged a ride around it" — cancelling means the event is not
 * happening, not that it is being archived. The platform now counts such an
 * event as zero hours and keeps it off the transcript, so minting a
 * verification code a college can check would be the platform contradicting
 * itself in the one artifact that leaves it.
 *
 * REVOKING one already issued is also wrong, and that is not a judgement call:
 * `06-certificate-verification-policy.md` states "There is no option to void a
 * certificate", holds the drafted voiding text behind a `[[NOT YET BUILT]]`
 * marker that blocks publication, and couples it to the Data Deletion Policy
 * and the Privacy Policy. Revoking here would make three published documents
 * false.
 *
 * So: never issue, never revoke. These cases pin both, because a future reader
 * fixing one is liable to break the other.
 */

let db;

const PAST = '2026-01-05T10:00:00.000Z';

function event(id, status) {
  db.prepare(`
    INSERT INTO events (id, title, status) VALUES (?, ?, ?)
  `).run(id, `Event ${id}`, status);
}

function attended(userId, eventId, hours = 3) {
  db.prepare('INSERT INTO attendance VALUES (?, ?, ?, 1, ?)').run(eventId, `${eventId}-slot`, userId, hours);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  createCertificatesTable(db);
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, status TEXT);
    CREATE TABLE attendance (event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL);
  `);
});

describe('a certificate is never issued for a called-off event', () => {
  it('mints nothing on the boot backfill', async () => {
    /**
     * The behaviour that prompted this, verified against the real code before
     * the guard existed: a cancelled event with credited attendance produced a
     * brand-new certificate on the next start. Not a survivor of cancellation —
     * a fresh issuance, days or weeks after the event was called off.
     */
    event('ev-cancelled', 'cancelled');
    attended('u1', 'ev-cancelled');

    await backfillCertificates(db);

    const n = db.prepare('SELECT COUNT(*) AS n FROM certificates WHERE event_id = ?').get('ev-cancelled').n;
    expect(n, 'a cancelled event minted a certificate').toBe(0);
  });

  it('returns null rather than throwing when asked directly', async () => {
    /* The callers are a boot task and a list endpoint. Neither should fail
       because one row turned out to be ineligible. */
    event('ev-cancelled', 'cancelled');
    attended('u1', 'ev-cancelled');

    expect(await getOrCreateCertificateCode(db, 'u1', 'ev-cancelled')).toBeNull();
  });

  it('still issues for every other status', async () => {
    /* The control. Without it this file would pass just as happily against a
       certificate system that had stopped working altogether. */
    for (const status of ['completed', 'open', 'closed']) {
      const id = `ev-${status}`;
      event(id, status);
      attended('u1', id);
      expect(await getOrCreateCertificateCode(db, 'u1', id), `${status} was refused a certificate`).toMatch(/^WEV-/);
    }
  });

  it('issues for an event whose row has vanished', async () => {
    /**
     * `certificates` has no foreign key to `events`, so a certificate can
     * outlive its event. Refusing when the event cannot be found would make a
     * missing row behave like a cancellation — silently withholding a
     * credential on the strength of an absence rather than a decision.
     */
    attended('u1', 'ev-gone');
    expect(await getOrCreateCertificateCode(db, 'u1', 'ev-gone')).toMatch(/^WEV-/);
  });
});

describe('a certificate already issued is never taken away', () => {
  it('survives its event being cancelled afterwards', async () => {
    /**
     * THE case the published policy governs. A student earned it, printed it,
     * and may have sent it to a college. "There is no option to void a
     * certificate" is a sentence in a hash-pinned document.
     */
    event('ev-later-cancelled', 'completed');
    attended('u1', 'ev-later-cancelled');
    const code = await getOrCreateCertificateCode(db, 'u1', 'ev-later-cancelled');
    expect(code).toMatch(/^WEV-/);

    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run('ev-later-cancelled');

    expect(
      await getOrCreateCertificateCode(db, 'u1', 'ev-later-cancelled'),
      'an issued certificate was revoked when its event was cancelled'
    ).toBe(code);
    expect(db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n).toBe(1);
  });

  it('keeps returning the same code, so a printout keeps verifying', async () => {
    event('ev1', 'completed');
    attended('u1', 'ev1');
    const first = await getOrCreateCertificateCode(db, 'u1', 'ev1');
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run('ev1');

    expect(await getOrCreateCertificateCode(db, 'u1', 'ev1')).toBe(first);
    expect(await getOrCreateCertificateCode(db, 'u1', 'ev1')).toBe(first);
  });

  it('is not deleted by a later backfill', async () => {
    /* The backfill runs on every boot. It must not become a sweeper. */
    event('ev1', 'completed');
    attended('u1', 'ev1');
    await backfillCertificates(db);
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run('ev1');

    await backfillCertificates(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM certificates WHERE event_id = ?').get('ev1').n).toBe(1);
  });
});
