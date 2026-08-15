import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Reporting a problem with the platform.
 *
 * ── What this is guarding ──
 *
 * The route is authenticated but deliberately holds no capability gate: every
 * account may say a page is broken, and requiring one would mean the people
 * most likely to hit a permissions bug are the ones unable to report it. That
 * makes the OTHER controls the whole of the protection — the rate limit, the
 * validation, and the fact that reading reports back is a separate route behind
 * `report.resolve`.
 *
 * The security-category handling gets its own cases. A report describing a live
 * vulnerability must not travel in a notification email, and must not be
 * readable by an organizer.
 */

let srv, db;
let student, other, staff;
let studentId;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  const make = async (n) => {
    const { cookie, user } = await srv.signupConfirmed({
      name: `Issue Person ${n}`,
      email: `issue.person.${n}@example.org`,
      username: `issueperson${n}`,
      password: 'Password123',
      role: 'student',
      grade: '11',
    });
    return { cookie, id: user.id };
  };
  const a = await make(1); student = a.cookie; studentId = a.id;
  const b = await make(2); other = b.cookie;

  /* Somebody holding `report.resolve` — the capability that already means "may
     read what people have reported". */
  staff = await srv.login('admin@example.gov').catch(() => null);
});

afterAll(async () => { await srv.close(); });

const DESCRIPTION = 'The calendar export downloads an empty file when I pick a shift on Saturday.';

const file = (body, session = student) => srv.call('POST', '/api/issues', body, session);

/* ─────────────────────────── submission ─────────────────────────── */

describe('filing a report', () => {
  it('stores it and returns a quotable reference', async () => {
    const res = await file({ category: 'bug', description: DESCRIPTION });
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^WV-[A-Z2-9]{8}$/);

    const row = db.prepare('SELECT * FROM issue_reports WHERE reference = ?').get(res.body.reference);
    expect(row.category).toBe('bug');
    expect(row.description).toBe(DESCRIPTION);
    expect(row.reporter_id).toBe(studentId);
    expect(row.status).toBe('open');
  });

  it('gives every report a distinct reference', async () => {
    /* Two reports sharing one is a support conversation about the wrong report. */
    const a = await file({ category: 'bug', description: DESCRIPTION });
    const b = await file({ category: 'bug', description: DESCRIPTION });
    expect(a.body.reference).not.toBe(b.body.reference);
  });

  it('refuses an unknown category', async () => {
    const res = await file({ category: 'not-a-category', description: DESCRIPTION });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('category');
  });

  it('refuses an empty description', async () => {
    const res = await file({ category: 'bug', description: '' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('description');
  });

  it('refuses a description that is only whitespace', async () => {
    /* Trimmed BEFORE it is measured, so a field of spaces is empty rather than
       long enough. */
    const res = await file({ category: 'bug', description: '        \n\n\t   ' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('description');
  });

  it('refuses a description that is too long', async () => {
    const res = await file({ category: 'bug', description: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('description');
  });

  it('refuses an unauthenticated caller', async () => {
    /* An anonymous endpoint that emails staff is a spam relay. */
    const res = await srv.call('POST', '/api/issues', { category: 'bug', description: DESCRIPTION });
    expect([401, 403]).toContain(res.status);
  });

  it('stores only the technical context it recognises', async () => {
    /**
     * An allowlist, not a filter — so a future client that starts attaching
     * something sensitive cannot widen what is stored by changing only its own
     * code.
     */
    const res = await file({
      category: 'bug',
      description: DESCRIPTION,
      context: {
        route: '/discover',
        viewport: '390x844',
        password: 'hunter2',
        sessionToken: 'abc.def.ghi',
        recoveryCodes: ['1111', '2222'],
      },
    });
    expect(res.status).toBe(201);

    const row = db.prepare('SELECT context FROM issue_reports WHERE reference = ?').get(res.body.reference);
    const stored = JSON.parse(row.context);
    expect(stored.route).toBe('/discover');
    expect(stored.viewport).toBe('390x844');
    expect(stored.password, 'a password was stored from the context blob').toBeUndefined();
    expect(stored.sessionToken).toBeUndefined();
    expect(stored.recoveryCodes).toBeUndefined();
    expect(row.context).not.toMatch(/hunter2|abc\.def\.ghi|1111/);
  });

  it('does not leak internal routing to the client', async () => {
    /* Which mailbox a category reaches is an internal decision. */
    const cats = await srv.call('GET', '/api/issues/categories', undefined, student);
    expect(cats.status).toBe(200);
    expect(cats.body.categories.length).toBeGreaterThan(5);
    expect(JSON.stringify(cats.body)).not.toMatch(/replyTo|@wevolunteers\.org/);
  });
});

/* ─────────────────────────── who may read them ─────────────────────────── */

describe('reports are not a feed', () => {
  it('refuses an ordinary student the list', async () => {
    const res = await srv.call('GET', '/api/issues', undefined, other);
    expect(res.status).toBe(403);
  });

  it('refuses somebody with no session', async () => {
    const res = await srv.call('GET', '/api/issues');
    expect([401, 403]).toContain(res.status);
  });

  it('does not let a reporter read even their own back through the list', async () => {
    /* The list is a staff surface, not a "my reports" page. Filing one does not
       grant a way to read the queue. */
    await file({ category: 'bug', description: DESCRIPTION });
    const res = await srv.call('GET', '/api/issues', undefined, student);
    expect(res.status).toBe(403);
  });

  it('shows them to staff who hold report.resolve', async () => {
    if (!staff) return;
    const res = await srv.call('GET', '/api/issues', undefined, staff);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });
});

/* ─────────────────────────── security reports ─────────────────────────── */

describe('a security report is handled more carefully', () => {
  /**
   * A fresh account per case.
   *
   * The shared `student` has spent most of its hourly allowance on the cases
   * above, and a silent 429 produces no email — which would fail these for a
   * reason that has nothing to do with what they test. Each case also asserts
   * the 201, so a future limit change surfaces as "the report was refused"
   * rather than "no mail arrived".
   */
  const freshReporter = async (n) => (await srv.signupConfirmed({
    name: `Mail Reporter ${n}`, email: `issue.mail.${n}@example.org`, username: `issuemail${n}`,
    password: 'Password123', role: 'student', grade: '11',
  })).cookie;

  it('is stored, and its contents stay out of the notification email', async () => {
    /**
     * The body may describe a live vulnerability. Email is the least controlled
     * place it could sit — forwarded, quoted, kept on a phone — so the
     * notification says one exists and where to read it.
     */
    const { installMailbox } = await import('./testMailbox.js');
    const mailbox = installMailbox();

    const secret = 'The certificate verify endpoint accepts any code beginning with AAAA.';
    const res = await file({ category: 'security', description: secret }, await freshReporter('sec'));
    expect(res.status).toBe(201);

    const mail = await mailbox.waitFor('security@wevolunteers.org').catch(() => null);
    mailbox.restore();

    expect(mail, 'no notification reached the security address').toBeTruthy();
    expect(mail.text).toContain(res.body.reference);
    expect(mail.text, 'the vulnerability travelled in an email').not.toContain(secret);

    /* But it IS stored, so somebody authorized can read it. */
    const row = db.prepare('SELECT description FROM issue_reports WHERE reference = ?').get(res.body.reference);
    expect(row.description).toBe(secret);
  });

  it('sends an ordinary report to support, contents included', async () => {
    const { installMailbox } = await import('./testMailbox.js');
    const mailbox = installMailbox();

    const res = await file({ category: 'bug', description: DESCRIPTION }, await freshReporter('sup'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const mail = await mailbox.waitFor('support@wevolunteers.org').catch(() => null);
    mailbox.restore();

    expect(mail).toBeTruthy();
    expect(mail.text).toContain(DESCRIPTION);
    expect(mail.subject).toContain(res.body.reference);
  });

  it('routes a privacy report to the privacy address', async () => {
    const { installMailbox } = await import('./testMailbox.js');
    const mailbox = installMailbox();
    const filed = await file(
      { category: 'privacy', description: 'My hours are visible even though I set them private.' },
      await freshReporter('priv')
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const mail = await mailbox.waitFor('privacy@wevolunteers.org').catch(() => null);
    mailbox.restore();
    expect(mail, 'a privacy report did not reach privacy@').toBeTruthy();
  });
});

/* ─────────────────────────── rate limiting ─────────────────────────── */

describe('rate limiting', () => {
  it('stops one account flooding the queue', async () => {
    const { cookie } = await srv.signupConfirmed({
      name: 'Flooder', email: 'issue.flood@example.org', username: 'issueflood',
      password: 'Password123', role: 'student', grade: '11',
    });

    let limited = false;
    for (let n = 0; n < 15; n++) {
      const res = await srv.call('POST', '/api/issues',
        { category: 'bug', description: `${DESCRIPTION} Attempt ${n}.` }, cookie);
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited, 'an account filed fifteen reports without being slowed').toBe(true);
  });
});
