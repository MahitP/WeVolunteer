import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A ceiling on how often one person may open a new appeal.
 *
 * ── The gap this closes ──
 *
 * `POST /api/appeals` already refused a SECOND LIVE appeal about the same
 * subject, and that is a different thing. What nothing stopped was the loop:
 * file an appeal, receive a decision, file another one the next morning, and
 * again. Every one of those is a genuinely new case by the duplicate guard's
 * definition, so every one of them landed in a manager's inbox.
 *
 * On this platform that manager is frequently a student running a club. An
 * inbox that fills up with the same person is an inbox that stops being read,
 * and the appeal that actually deserved attention is the one underneath it.
 *
 * ── Why the fixture decides each appeal ──
 *
 * Because that is the shape of the abuse. Five appeals that are all still open
 * is a case the duplicate guard already handles; five appeals that have each
 * been answered is the one it does not, and the only way to reach the sixth is
 * to close the five before it.
 */

let srv, db;
/**
 * Imported AFTER the server boots, not at the top of the file.
 *
 * `appealsRoutes.js` imports `db.js`, and `db.js` resolves WEV_DB_PATH once at
 * module load. A static import here would therefore open the real database
 * before `startTestServer` had pointed the variable at a throwaway one — which
 * the harness detects and refuses, correctly.
 */
let APPEAL_WINDOW_MAX, APPEAL_WINDOW_MS;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;
  ({ APPEAL_WINDOW_MAX, APPEAL_WINDOW_MS } = await import('./routes/appealsRoutes.js'));
});
afterAll(async () => { await srv.close(); });

/** Closes every live appeal for a user, as a reviewer deciding them would. */
function decideAllFor(userId) {
  /* `resolved`, not `rejected` — the status CHECK is
     ('open','reviewing','resolved') and the DECISION lives in its own column. */
  db.prepare(
    "UPDATE appeals SET status = 'resolved' WHERE user_id = ? AND status IN ('open', 'reviewing')"
  ).run(userId);
}

const STATEMENT = 'I believe this decision was made without the full picture, and here is why.';

let seq = 0;
async function freshUser() {
  seq += 1;
  const { cookie, user } = await srv.signupConfirmed({
    name: `Appeal Limit ${seq}`,
    email: `appeal.limit.${seq}@example.org`,
    /* Unique per fixture: usernames are unique platform-wide, so reusing one
       would make every user after the first fail to sign up. */
    username: `appeallimit${seq}`,
    password: 'Password123',
    role: 'student',
    grade: '11',
  });
  return { cookie, userId: user.id };
}

const fileAppeal = (cookie) =>
  srv.call('POST', '/api/appeals', { statement: STATEMENT, subject: 'report_outcome' }, cookie);

describe('a person cannot open unlimited appeals', () => {
  it('accepts up to the ceiling, then refuses with 429', async () => {
    const { cookie, userId } = await freshUser();

    for (let n = 1; n <= APPEAL_WINDOW_MAX; n++) {
      const res = await fileAppeal(cookie);
      expect(res.status, `appeal ${n} of ${APPEAL_WINDOW_MAX} was refused`).toBe(201);
      expect(res.body.duplicate, `appeal ${n} collapsed into the previous one`).toBeFalsy();
      /* Decided, so the next one is a genuinely new case rather than a duplicate
         — which is precisely how the loop this guards against works. */
      decideAllFor(userId);
    }

    const over = await fileAppeal(cookie);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('appeal_rate_limited');
  });

  it('tells them when they can appeal again, rather than just saying no', async () => {
    /* "Try again later" is what makes somebody send five more. */
    const { cookie, userId } = await freshUser();
    for (let n = 0; n < APPEAL_WINDOW_MAX; n++) {
      await fileAppeal(cookie);
      decideAllFor(userId);
    }

    const over = await fileAppeal(cookie);
    expect(over.body.retryAfter, 'no date was given').toBeTruthy();
    expect(Number.isNaN(Date.parse(over.body.retryAfter))).toBe(false);
    expect(over.body.error).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('counts only the last 30 days, so old appeals do not block a new one', async () => {
    /**
     * The aged rows are INSERTED at their old date rather than back-dated
     * afterwards, because migration 015 makes a filed appeal immutable — an
     * `UPDATE appeals SET created_at` is refused by a trigger with "what an
     * appeal contests is a record: only the review workflow may change". That
     * is the database defending the appellant's account of events, and the
     * fixture works with it rather than around it.
     *
     * A fixed calendar month would let somebody file five on the 30th and five
     * more on the 1st. A rolling window means the limit means the same thing on
     * every day of the month, and this is the case that tells them apart.
     */
    const { cookie, userId } = await freshUser();
    const old = new Date(Date.now() - APPEAL_WINDOW_MS - 60_000).toISOString();

    const insert = db.prepare(
      "INSERT INTO appeals (id, user_id, subject, status, statement, created_at, updated_at) "
      + "VALUES (?, ?, 'report_outcome', 'resolved', ?, ?, ?)"
    );
    for (let n = 0; n < APPEAL_WINDOW_MAX + 3; n++) {
      insert.run(`aged-${userId}-${n}`, userId, STATEMENT, old, old);
    }

    const after = await fileAppeal(cookie);
    expect(after.status, 'appeals older than the window still counted').toBe(201);
  });

  it('does count appeals inside the window, wherever they came from', async () => {
    /* The mirror of the case above. Without it, that one would pass just as
       happily against a limiter that counts nothing at all. */
    const { cookie, userId } = await freshUser();
    const now = new Date().toISOString();

    const insert = db.prepare(
      "INSERT INTO appeals (id, user_id, subject, status, statement, created_at, updated_at) "
      + "VALUES (?, ?, 'report_outcome', 'resolved', ?, ?, ?)"
    );
    for (let n = 0; n < APPEAL_WINDOW_MAX; n++) {
      insert.run(`recent-${userId}-${n}`, userId, STATEMENT, now, now);
    }

    const blocked = await fileAppeal(cookie);
    expect(blocked.status).toBe(429);
  });

  it('does not let one person exhaust another person\'s allowance', async () => {
    /* The count is keyed on the appellant. If it were global, the first five
       appeals of the month would silence everybody else. */
    const a = await freshUser();
    for (let n = 0; n < APPEAL_WINDOW_MAX; n++) {
      await fileAppeal(a.cookie);
      decideAllFor(a.userId);
    }
    expect((await fileAppeal(a.cookie)).status).toBe(429);

    const b = await freshUser();
    expect((await fileAppeal(b.cookie)).status, 'an unrelated person was blocked').toBe(201);
  });

  it('still collapses a duplicate rather than spending an attempt on it', async () => {
    /* The pre-existing guard has to keep working, and it has to run FIRST —
       otherwise pressing submit twice costs somebody two of their five. */
    const { cookie } = await freshUser();

    const first = await fileAppeal(cookie);
    expect(first.status, 'a new appeal is created, so 201').toBe(201);
    const second = await fileAppeal(cookie);
    expect(second.status, 'the duplicate is reported back, so 200').toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.appealId).toBe(first.body.appealId);
  });
});
