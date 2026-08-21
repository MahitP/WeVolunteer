import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  setDefaultConnection, currentConnection, withConnection,
  hasBoundConnection, createConnectionProxy, transactionOn,
} from './db/connectionContext.js';

/**
 * The seam that lets `inTransaction` survive a connection pool.
 *
 * ── Why this is tested rather than trusted ──
 *
 * On SQLite the whole mechanism is a no-op: one connection, no context ever
 * bound, and the proxy resolves to the same object every time. Which means the
 * 6,739-test suite passing proves the *SQLite* behaviour is unchanged — and
 * proves nothing at all about whether the context actually routes anywhere,
 * because nothing today has a second connection to route to.
 *
 * So these tests bind a genuinely different connection and check the writes land
 * in it. That is the property phase 6 depends on, and it is the property no
 * other test in this repository can currently observe.
 */
describe('the database connection context', () => {
  let primary, secondary, db;

  beforeEach(() => {
    primary = new DatabaseSync(':memory:');
    secondary = new DatabaseSync(':memory:');
    for (const c of [primary, secondary]) {
      c.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    }
    setDefaultConnection(primary);
    db = createConnectionProxy();
  });

  afterEach(() => {
    /* Restore before tearing the connection down, not after. A spy installed on
       the proxy is restored *through* the proxy, which has to resolve a
       connection to do it — and vitest's own end-of-file `restoreAllMocks` runs
       later than this hook, so leaving one installed here means it is unwound
       against a null default and throws outside any test. */
    vi.restoreAllMocks();
    primary.close();
    secondary.close();
    setDefaultConnection(null);
  });

  const count = (c) => c.prepare('SELECT COUNT(*) n FROM t').get().n;

  describe('the proxy behaves like the connection it stands for', () => {
    it('runs queries against the default connection', () => {
      db.prepare("INSERT INTO t (v) VALUES ('a')").run();
      expect(count(primary)).toBe(1);
      expect(db.prepare('SELECT v FROM t').get().v).toBe('a');
    });

    it('forwards exec as well as prepare', () => {
      db.exec("INSERT INTO t (v) VALUES ('b')");
      expect(count(primary)).toBe(1);
    });

    it('returns statement objects that stay usable after the call', () => {
      db.prepare("INSERT INTO t (v) VALUES ('keep')").run();
      const stmt = db.prepare('SELECT v FROM t WHERE v = ?');
      expect(stmt.get('keep').v).toBe('keep');
      expect(stmt.get('keep').v).toBe('keep');
    });

    /**
     * Four modules guard on exactly this shape before writing —
     * `auditLog.js`, `securityAudit.js`, `errorReporter.js`, `alerting.js` all
     * check `typeof db.prepare !== 'function'` and silently skip if it fails.
     * A proxy that broke the check would not crash; it would turn off audit
     * logging, which is the failure this phase exists to avoid.
     */
    it('satisfies the `typeof db.prepare === function` guard those modules use', () => {
      expect(typeof db.prepare).toBe('function');
      expect(db).toBeTruthy();
      expect('prepare' in db).toBe(true);
    });
  });

  describe('binding a connection redirects every query made inside it', () => {
    it('sends writes to the bound connection, not the default', () => {
      withConnection(secondary, () => {
        db.prepare("INSERT INTO t (v) VALUES ('inner')").run();
      });
      expect(count(secondary)).toBe(1);
      expect(count(primary)).toBe(0);
    });

    it('restores the default once the binding ends', () => {
      withConnection(secondary, () => {
        db.prepare("INSERT INTO t (v) VALUES ('inner')").run();
      });
      db.prepare("INSERT INTO t (v) VALUES ('outer')").run();
      expect(count(secondary)).toBe(1);
      expect(count(primary)).toBe(1);
    });

    it('reports whether a connection is bound', () => {
      expect(hasBoundConnection()).toBe(false);
      withConnection(secondary, () => expect(hasBoundConnection()).toBe(true));
      expect(hasBoundConnection()).toBe(false);
    });

    it('resolves the innermost binding when they nest', () => {
      withConnection(secondary, () => {
        withConnection(primary, () => {
          db.prepare("INSERT INTO t (v) VALUES ('innermost')").run();
        });
      });
      expect(count(primary)).toBe(1);
      expect(count(secondary)).toBe(0);
    });

    /**
     * The reason `AsyncLocalStorage` is the right primitive rather than a plain
     * module variable: it survives `await`. Every handler in this codebase is
     * synchronous today, so nothing exercises this — but the async port is the
     * entire point of building the seam, and a binding that evaporated at the
     * first `await` would route half a transaction to the wrong client.
     */
    it('survives an await, which is the case the async port depends on', async () => {
      await withConnection(secondary, async () => {
        db.prepare("INSERT INTO t (v) VALUES ('before')").run();
        await Promise.resolve();
        db.prepare("INSERT INTO t (v) VALUES ('after')").run();
      });
      expect(count(secondary)).toBe(2);
      expect(count(primary)).toBe(0);
    });

    it('unbinds correctly when the body throws', () => {
      expect(() => withConnection(secondary, () => { throw new Error('boom'); })).toThrow('boom');
      expect(hasBoundConnection()).toBe(false);
      db.prepare("INSERT INTO t (v) VALUES ('after-throw')").run();
      expect(count(primary)).toBe(1);
    });
  });

  /**
   * Monkey-patching has to reach the connection, not the proxy's inert target.
   *
   * This is a regression test for a fault that shipped in the first version of
   * the proxy and was caught only by the full suite. `get` and `set` were
   * trapped; `defineProperty` was not — and `vi.spyOn` does not assign, it
   * defines. So the spy was installed on an object nothing read, and six tests
   * in three files observed unmocked behaviour while reporting no error:
   * `authz.aal` counted zero queries where it expected one, and `health.test`
   * got HTTP 200 from a database it had explicitly broken.
   *
   * Twelve test files stub the handle this way. Without these cases, a future
   * change to the trap list would break them all again, and the symptom would
   * once more be assertions quietly measuring the wrong thing rather than a
   * crash.
   */
  describe('the proxy is transparent to test doubles', () => {
    it('lets vi.spyOn observe calls made through it', () => {
      const spy = vi.spyOn(db, 'prepare');
      db.prepare('SELECT 1').get();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('lets a mockImplementation actually take effect', () => {
      const spy = vi.spyOn(db, 'prepare').mockImplementation(() => {
        throw new Error('database is locked');
      });
      expect(() => db.prepare('SELECT 1')).toThrow('database is locked');
      spy.mockRestore();
    });

    it('restores the real method afterwards', () => {
      const spy = vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('stubbed'); });
      spy.mockRestore();
      expect(db.prepare('SELECT 1').get()).toBeTruthy();
    });

    it('stubs exec as well, which is what the health check patches', () => {
      const spy = vi.spyOn(db, 'exec').mockImplementation(() => { throw new Error('read-only'); });
      expect(() => db.exec('CREATE TABLE x (a)')).toThrow('read-only');
      spy.mockRestore();
      db.exec('CREATE TABLE x (a)');
      expect(() => db.exec('CREATE TABLE x (a)')).toThrow();
    });
  });

  /**
   * Passing the proxy to `transactionOn` must not bind the proxy to itself.
   *
   * A regression test for a stack overflow, not a hypothetical. Most callers of
   * `transactionOn` hand over the module-global `db`, which IS the proxy —
   * binding it makes `resolve()` return the proxy, so the `get` trap looks a
   * property up on itself forever. `RangeError: Maximum call stack size
   * exceeded`, a hundred identical frames, and it fired on the very first run
   * after the agreement modules started routing through the helper.
   *
   * `concreteConnection` unwraps at the choke point so the situation is
   * unrepresentable, and these cases keep it that way.
   */
  describe('a proxy handle is unwrapped rather than bound to itself', () => {
    it('runs a transaction when handed the proxy, without recursing', () => {
      const out = transactionOn(db, () => {
        db.prepare("INSERT INTO t (v) VALUES ('via-proxy-handle')").run();
        return 'done';
      });
      expect(out).toBe('done');
      expect(count(primary)).toBe(1);
    });

    it('binds the concrete connection, not the proxy', () => {
      transactionOn(db, () => {
        expect(currentConnection()).toBe(primary);
        expect(currentConnection()).not.toBe(db);
      });
    });

    it('rolls back correctly when handed the proxy', () => {
      expect(() => transactionOn(db, () => {
        db.prepare("INSERT INTO t (v) VALUES ('doomed')").run();
        expect(count(primary)).toBe(1);   // it really was written first
        throw new Error('undo');
      })).toThrow('undo');
      expect(count(primary)).toBe(0);
    });

    it('still accepts a concrete handle directly', () => {
      transactionOn(secondary, () => {
        db.prepare("INSERT INTO t (v) VALUES ('direct')").run();
      });
      expect(count(secondary)).toBe(1);
      expect(count(primary)).toBe(0);
    });
  });

  describe('nested transactions are refused', () => {
    /**
     * SQLite errors on a nested BEGIN; PostgreSQL warns and folds the inner
     * transaction into the outer, so an inner rollback would discard the outer
     * one's work. Refusing is the only behaviour that is the same on both.
     */
    it('refuses a transaction inside a transaction', () => {
      expect(() => transactionOn(db, () => {
        transactionOn(db, () => { /* unreachable */ });
      })).toThrow(/Nested transactions are not supported/);
    });

    it('leaves the outer transaction able to roll back cleanly', () => {
      expect(() => transactionOn(db, () => {
        db.prepare("INSERT INTO t (v) VALUES ('outer')").run();
        transactionOn(db, () => {});
      })).toThrow(/Nested transactions/);
      expect(count(primary)).toBe(0);
    });

    it('allows a second transaction after the first has finished', () => {
      transactionOn(db, () => db.prepare("INSERT INTO t (v) VALUES ('a')").run());
      transactionOn(db, () => db.prepare("INSERT INTO t (v) VALUES ('b')").run());
      expect(count(primary)).toBe(2);
    });
  });

  describe('failure modes are loud rather than silent', () => {
    it('refuses to answer at all before a connection is set', () => {
      setDefaultConnection(null);
      expect(() => db.prepare('SELECT 1')).toThrow(/before a connection was established/);
    });

    it('currentConnection prefers a binding over the default', () => {
      expect(currentConnection()).toBe(primary);
      withConnection(secondary, () => expect(currentConnection()).toBe(secondary));
    });
  });
});
