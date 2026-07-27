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
function oldCertificateCode(userId, eventId) {
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
  return `WEV-${block(h1)}-${block(h2)}`;
}

const CODE_FORMAT = /^WEV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

describe('certificates', () => {
  let srv, priyaToken;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ backfillCertificates } = await import('./certificates.js'));
    priyaToken = await srv.login('priya.patel.nhs@outlook.com');
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
    const oldCode = oldCertificateCode('user-student-2', 'event-pantry-past');

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
    db.prepare('UPDATE attendance SET present = 1 WHERE event_id = ? AND user_id = ?')
      .run('event-pantry-past', 'user-student-3');
    backfillCertificates(db);

    const ethanToken = await srv.login('emiller2027@gmail.com');
    const ethanCerts = await srv.call('GET', '/api/certificates', undefined, ethanToken);
    const priyaCerts = await srv.call('GET', '/api/certificates', undefined, priyaToken);

    const ethanCode = ethanCerts.body.find(c => c.eventId === 'event-pantry-past').code;
    const priyaCode = priyaCerts.body.find(c => c.eventId === 'event-pantry-past').code;

    expect(ethanCode).toMatch(CODE_FORMAT);
    expect(priyaCode).toMatch(CODE_FORMAT);
    expect(ethanCode).not.toBe(priyaCode);
  });

  it('getOrCreateCertificateCode backfill is idempotent — a second run inserts nothing', () => {
    const first = backfillCertificates(db);
    expect(first.inserted).toBe(0); // already backfilled at boot + by the previous test

    const second = backfillCertificates(db);
    expect(second.inserted).toBe(0);
  });
});
