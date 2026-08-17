import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  setDefaultConnection, createConnectionProxy, transactionOn, withConnection,
} from './db/connectionContext.js';

/**
 * "At most one live verification token per user" — the invariant, not the code.
 *
 * ── Why this test exists ──
 *
 * `issueVerificationToken` DELETEs any existing token and INSERTs a fresh one.
 * Its comment states the rule: "pressing resend three times should leave exactly
 * one working link, not three." Nothing in the schema enforces it —
 * `email_verification_tokens` is keyed on `token_hash` alone, with no unique
 * constraint on `user_id` — so the rule held only because those two statements
 * ran back to back in a synchronous handler.
 *
 * The migration removes that guarantee. These tests assert the invariant against
 * a real interleaving, so the transaction is proved to be what maintains it
 * rather than assumed to be.
 */
describe('the one-live-token-per-user invariant', () => {
  let conn, db;

  beforeEach(() => {
    conn = new DatabaseSync(':memory:');
    conn.exec(`
      CREATE TABLE email_verification_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    setDefaultConnection(conn);
    db = createConnectionProxy();
  });

  afterEach(() => { conn.close(); setDefaultConnection(null); });

  const liveTokensFor = (userId) =>
    conn.prepare('SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ?').get(userId).c;

  /** The production shape: DELETE then INSERT, as one unit. */
  const issue = (userId, tokenHash) => transactionOn(db, () => {
    db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, userId, '2099-01-01T00:00:00.000Z');
  });

  it('leaves exactly one token after a single issue', () => {
    issue('u1', 'hash-1');
    expect(liveTokensFor('u1')).toBe(1);
  });

  /**
   * The behaviour the comment promises, asserted rather than described: three
   * presses of resend leave one link, and it is the LAST one.
   */
  it('leaves exactly one token after three sequential issues, and it is the newest', () => {
    issue('u1', 'hash-1');
    issue('u1', 'hash-2');
    issue('u1', 'hash-3');

    expect(liveTokensFor('u1')).toBe(1);
    const row = conn.prepare('SELECT token_hash FROM email_verification_tokens WHERE user_id = ?').get('u1');
    expect(row.token_hash).toBe('hash-3');
  });

  it('does not disturb another user\'s token', () => {
    issue('u1', 'hash-1');
    issue('u2', 'hash-2');
    issue('u1', 'hash-3');

    expect(liveTokensFor('u1')).toBe(1);
    expect(liveTokensFor('u2')).toBe(1);
    expect(conn.prepare('SELECT COUNT(*) AS c FROM email_verification_tokens').get().c).toBe(2);
  });

  /**
   * The failure mode this guards, demonstrated on the unprotected shape.
   *
   * Without a transaction, an interleaved DELETE/INSERT pair produces two live
   * tokens. This is written out explicitly because a test that only shows the
   * fixed version passing does not establish that the fix does anything — it
   * would pass just as well if the invariant were being maintained by something
   * else entirely, or by nothing at all because the interleaving never happened.
   */
  it('DEMONSTRATES the bug: interleaved without a transaction, two tokens survive', () => {
    // A: delete
    conn.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run('u1');
    // B: delete (interleaved)
    conn.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run('u1');
    // A: insert
    conn.prepare('INSERT INTO email_verification_tokens VALUES (?, ?, ?)').run('a', 'u1', '2099-01-01');
    // B: insert
    conn.prepare('INSERT INTO email_verification_tokens VALUES (?, ?, ?)').run('b', 'u1', '2099-01-01');

    expect(
      liveTokensFor('u1'),
      'the unprotected sequence really does leave two live tokens — this is what the transaction prevents',
    ).toBe(2);
  });

  /**
   * The same interleaving, refused.
   *
   * A second transaction cannot begin while one is open on this context, so the
   * interleaved sequence above is not reachable through the production path. The
   * assertion is on the resulting STATE, not merely on the throw: after the
   * refused attempt the table still holds exactly one token, and it is the one
   * the completed transaction wrote.
   */
  it('refuses the interleaving that would produce two tokens, leaving one', () => {
    expect(() => {
      transactionOn(db, () => {
        db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run('u1');
        db.prepare('INSERT INTO email_verification_tokens VALUES (?, ?, ?)').run('a', 'u1', '2099-01-01');
        // a second issue attempting to interleave inside the first
        issue('u1', 'b');
      });
    }).toThrow(/Nested transactions are not supported/);

    expect(liveTokensFor('u1'), 'the refused attempt rolled back cleanly').toBe(0);

    issue('u1', 'after');
    expect(liveTokensFor('u1')).toBe(1);
  });

  /**
   * Repetition, because "it passed once" is not a concurrency result.
   *
   * 200 issues for the same user, with reads of the table between them. The
   * invariant must hold at every single step, not just at the end — a check only
   * at the end would pass even if the count had oscillated to 2 and back.
   */
  it('holds the invariant across 200 repeated issues, checked at every step', () => {
    for (let i = 0; i < 200; i++) {
      issue('u1', `hash-${i}`);
      const n = liveTokensFor('u1');
      if (n !== 1) throw new Error(`invariant broke at iteration ${i}: ${n} live tokens`);
    }
    expect(liveTokensFor('u1')).toBe(1);
    expect(conn.prepare('SELECT token_hash FROM email_verification_tokens WHERE user_id = ?').get('u1').token_hash)
      .toBe('hash-199');
  });

  it('holds across interleaved issues for many users', () => {
    const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
    for (let round = 0; round < 40; round++) {
      for (const u of users) issue(u, `${u}-r${round}`);
      for (const u of users) {
        expect(liveTokensFor(u), `user ${u} at round ${round}`).toBe(1);
      }
    }
    expect(conn.prepare('SELECT COUNT(*) AS c FROM email_verification_tokens').get().c).toBe(users.length);
  });
});

/**
 * The tests above prove the PATTERN is sound. This proves the SHIPPED CODE uses it.
 *
 * Everything above reconstructs the DELETE/INSERT shape locally, against an
 * in-memory table, because that is the only way to drive a genuine interleaving.
 * The gap is obvious once stated: delete `inTransaction` from
 * `services/verification.js` and every one of those tests still passes, because
 * none of them ever calls it. A suite that proves a technique works while the
 * product quietly stops using it is the exact failure this migration keeps
 * running into.
 *
 * Asserting on the source is the cheap, direct answer — the same approach
 * `db.accessSurface.test.js` takes for the transaction helpers, and for the same
 * reason: the property is structural, so check the structure.
 */
describe('the shipped issueVerificationToken actually uses a transaction', () => {
  const source = readFileSync(
    path.join(import.meta.dirname, 'services', 'verification.js'), 'utf8'
  );
  /**
   * Located by a regex that tolerates `async`, and — more importantly —
   * evaluated INSIDE the tests rather than at collection time.
   *
   * It used to be an IIFE at describe scope with the `expect` inside it. When
   * wave 13 made this function `async`, the literal `export function
   * issueVerificationToken` stopped matching and the tripwire threw during
   * collection, so vitest reported the whole file as **0 tests** rather than as
   * a failure. The guard was right and still lost its own coverage, along with
   * the eight other tests in this file.
   *
   * A guard that can erase itself is worse than no guard, because the suite
   * still looks green. Reading the source lazily keeps a miss as one failing
   * test.
   */
  const declaration = /export\s+(?:async\s+)?function\s+issueVerificationToken\b/;
  const fnBody = () => {
    const m = source.match(declaration);
    expect(m, 'issueVerificationToken not found — this guard is checking nothing').not.toBeNull();
    const body = source.slice(m.index);
    return body.slice(0, body.indexOf('\n}\n') + 3);
  };

  it('is found in the source at all, so the assertions below cannot pass vacuously', () => {
    expect(source).toMatch(declaration);
    expect(fnBody().length).toBeGreaterThan(50);
  });

  it('wraps its writes in a transaction', () => {
    expect(fnBody(), 'the DELETE+INSERT pair must run inside a transaction')
      .toMatch(/\b(?:runInTransaction|inTransaction)\(/);
  });

  it('has both statements inside that transaction, not just one', () => {
    const fn = fnBody();
    const opened = fn.search(/\b(?:runInTransaction|inTransaction)\(/);
    const del = fn.indexOf('DELETE FROM email_verification_tokens');
    const ins = fn.indexOf('INSERT INTO email_verification_tokens');

    expect(del, 'the DELETE must come after the transaction opens').toBeGreaterThan(opened);
    expect(ins, 'the INSERT must come after the transaction opens').toBeGreaterThan(opened);
    /* Both inside the same block: the closing `});` must follow the INSERT. */
    expect(fn.indexOf('});', ins), 'the transaction must close after the INSERT').toBeGreaterThan(ins);
  });

  it('still returns the plaintext token and files only the digest', () => {
    /* Preserving the existing behaviour is as much the point as the atomicity —
       the table must keep holding nothing anybody could sign in with. */
    const fn = fnBody();
    expect(fn).toMatch(/return token;/);
    expect(fn).toMatch(/tokenHash/);
    expect(fn, 'the plaintext must never be written').not.toMatch(/VALUES \(\?, \?, \?\)[\s\S]*run\(token,/);
  });
});

/**
 * `transactionOn` must refuse an async callback.
 *
 * It commits when the callback RETURNS. An async callback returns a pending
 * promise immediately, so COMMIT fires before any of the work runs and the
 * statements land outside the transaction — every write appearing to succeed,
 * the rollback path unreachable. This is the easiest mistake to make during the
 * async port, because adding `await` inside an existing `inTransaction` block
 * looks like progress.
 */
describe('transactionOn refuses async callbacks', () => {
  let conn, db;

  beforeEach(() => {
    conn = new DatabaseSync(':memory:');
    conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    setDefaultConnection(conn);
    db = createConnectionProxy();
  });
  afterEach(() => { conn.close(); setDefaultConnection(null); });

  const count = () => conn.prepare('SELECT COUNT(*) AS c FROM t').get().c;

  it('throws rather than committing early', () => {
    expect(() => transactionOn(db, async () => {
      db.prepare("INSERT INTO t (v) VALUES ('x')").run();
    })).toThrow(/async callback/);
  });

  it('rolls back, so the statements that did run are not left committed', () => {
    expect(() => transactionOn(db, async () => {
      db.prepare("INSERT INTO t (v) VALUES ('written-before-the-yield')").run();
      await Promise.resolve();
    })).toThrow(/async callback/);

    /* The synchronous part of an async function runs before the first await, so
       that INSERT really did execute. The point of the guard is that it does not
       survive: without the rollback it would be committed outside any
       transaction the caller believed it was in. */
    expect(count(), 'the early write must not survive').toBe(0);
  });

  it('says what to do about it', () => {
    let message = '';
    try { transactionOn(db, async () => {}); } catch (e) { message = e.message; }
    expect(message).toMatch(/Move the awaited work outside the transaction/);
    expect(message).toMatch(/nothing was committed/i);
  });

  it('still accepts a synchronous callback that returns a value', () => {
    const out = transactionOn(db, () => {
      db.prepare("INSERT INTO t (v) VALUES ('ok')").run();
      return 'returned';
    });
    expect(out).toBe('returned');
    expect(count()).toBe(1);
  });

  it('does not mistake a plain object with no then for a promise', () => {
    const out = transactionOn(db, () => ({ recorded: 1, already: false }));
    expect(out).toEqual({ recorded: 1, already: false });
  });

  /* `withConnection` is separately allowed to be async — it is the binding
     primitive, not the commit boundary, and the PostgreSQL transaction path in
     `postgresConnection.js` depends on that. Asserted so the guard above is not
     later "tidied" into the wrong function. */
  it('leaves withConnection able to bind across an await', async () => {
    const seen = await withConnection(conn, async () => {
      await Promise.resolve();
      return 'bound';
    });
    expect(seen).toBe('bound');
  });
});
