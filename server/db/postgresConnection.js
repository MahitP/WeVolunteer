/**
 * The PostgreSQL side of the database seam.
 *
 * Exposes the parts of `node:sqlite`'s `DatabaseSync` this codebase actually
 * uses — `prepare(sql)` returning a statement with `.get()`, `.all()` and
 * `.run()`, plus `exec(sql)` and `close()` — backed by a `pg` connection pool.
 *
 * ── The one thing this file exists to get right ──
 *
 * A transaction must run every one of its statements on **one** pooled client.
 * `pool.query('BEGIN')` followed by `pool.query('INSERT …')` is the defining
 * mistake of this migration: the two calls may borrow different clients, so the
 * INSERT runs outside the transaction the caller believes it opened, and a
 * rollback discards nothing. It does not error. It is not slower. The writes
 * simply stop being atomic.
 *
 * So `beginTransaction()` checks out a client and returns a handle whose
 * `prepare`/`exec` are bound to **that client**. Phase 4's `withConnection`
 * binds that handle into the async context, and the `db` proxy resolves to it —
 * which is what lets the existing call sites join the transaction unedited.
 *
 * ── Everything here is async, and that is the unfinished part ──
 *
 * `DatabaseSync` is synchronous; `pg` cannot be. So this adapter is NOT a drop-in
 * for the SQLite handle and the application cannot be pointed at it yet. Making
 * the ~180 synchronous handlers await is phase 7, and re-establishing the
 * atomicity they currently get from never awaiting is phase 8. This file is the
 * thing those phases target, built and proved first so they are converting
 * against something known-correct.
 */
import pg from 'pg';

const { Pool, types } = pg;

/**
 * `bigint` and `numeric` come back as JavaScript strings by default.
 *
 * That default is right in general — a 64-bit integer does not fit in a double —
 * and wrong here. `COUNT(*)` returns `bigint`, and this codebase compares those
 * counts numerically in dozens of places (`if (count === 0)`, capacity checks,
 * the hours parity check). A string would make `0 === '0'` false and every one of
 * those comparisons wrong, silently.
 *
 * The generated schema has no `bigint` columns and no `numeric` columns —
 * `REAL` became `double precision` precisely so hours stay JS numbers — so the
 * only `bigint` values that can reach the application are aggregate results,
 * which are small. Parsing them as numbers is safe and matches what SQLite
 * returned.
 */
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

/**
 * A prepared statement bound to whichever executor created it.
 *
 * `executor` is either the pool or a single checked-out client. The statement
 * does not resolve it dynamically: a statement created inside a transaction
 * belongs to that transaction's client, and one created outside belongs to the
 * pool. Resolving at execution time instead would let a statement prepared
 * before a transaction silently run inside it.
 */
class PostgresStatement {
  #executor;
  #text;
  #params;
  #source;

  constructor(executor, sql, translate) {
    this.#executor = executor;
    this.#source = sql;
    const { text, params } = translate(sql);
    this.#text = text;
    this.#params = params;
  }

  /** The rewritten SQL, for diagnostics and tests. */
  get text() { return this.#text; }
  get source() { return this.#source; }

  async #run(args) {
    const { bindArguments } = await import('./sqlPlaceholders.js');
    const values = bindArguments(this.#params, args);
    try {
      return await this.#executor.query(this.#text, values);
    } catch (err) {
      /* The rewritten SQL is what actually failed, and without it the message
         names `$3` against a statement the author wrote with `?`. The original
         is included too so the call site is findable. */
      err.message = `${err.message}\n  statement: ${this.#text}\n  written as: ${this.#source}`;
      throw err;
    }
  }

  /** First row, or `undefined` — matching `DatabaseSync.get()` on a miss. */
  async get(...args) {
    const res = await this.#run(args);
    return res.rows.length ? res.rows[0] : undefined;
  }

  /** All rows, always an array. */
  async all(...args) {
    const res = await this.#run(args);
    return res.rows;
  }

  /**
   * `{ changes }`, matching `DatabaseSync.run()`.
   *
   * `changes` is load-bearing: 31 call sites branch on it to decide who won a
   * race — "did my conditional UPDATE actually claim the row?". `pg` calls the
   * same number `rowCount`, so it is renamed rather than passed through, and a
   * statement that affected nothing must report `0` and not `null`.
   *
   * `lastInsertRowid` is deliberately absent rather than faked. Nothing in this
   * codebase reads it (verified: zero occurrences), every table's key is
   * application-generated, and returning a plausible-looking wrong number would
   * be worse than the property not existing.
   */
  async run(...args) {
    const res = await this.#run(args);
    return { changes: res.rowCount ?? 0 };
  }
}

/** Shared implementation for the pool-backed handle and a transaction handle. */
class PostgresExecutorBase {
  constructor(executor, translate) {
    this._executor = executor;
    this._translate = translate;
  }

  /**
   * Which SQL dialect this handle speaks.
   *
   * Read by the few call sites that must emit engine-specific SQL — currently
   * only `FOR UPDATE` in Auto Select's capacity check, which PostgreSQL needs
   * and SQLite has no syntax for. `DatabaseSync` has no such property, so an
   * absent value reads as SQLite and the clause is omitted.
   *
   * Deliberately a capability marker rather than a general "which engine am I"
   * switch: every additional branch on this is a place the two paths can drift,
   * so it is expected to stay small enough to enumerate.
   */
  get dialect() { return 'postgres'; }

  /**
   * Asked before every statement. The pool-backed handle is always usable, so
   * the default does nothing; a transaction overrides it once it has settled.
   */
  _assertUsable() { /* the pool handle is always usable */ }

  prepare(sql) {
    this._assertUsable();
    return new PostgresStatement(this._executor, sql, this._translate);
  }

  /** Multi-statement DDL and the like. No parameters, matching `DatabaseSync.exec`. */
  async exec(sql) {
    this._assertUsable();
    await this._executor.query(sql);
  }
}

/**
 * A transaction: one client, checked out for the duration, returned afterwards.
 *
 * Created by `PostgresDatabase.beginTransaction()` and finished by exactly one
 * of `commit()` or `rollback()`. Both release the client, and releasing twice is
 * refused — a client returned to the pool twice is handed to two callers at
 * once, which is worse than leaking it.
 */
export class PostgresTransaction extends PostgresExecutorBase {
  #client;
  #settled = false;

  constructor(client, translate) {
    super(client, translate);
    this.#client = client;
  }

  get settled() { return this.#settled; }

  async commit() {
    this.#finish();
    try {
      await this.#client.query('COMMIT');
    } finally {
      this.#client.release();
    }
  }

  async rollback() {
    this.#finish();
    try {
      await this.#client.query('ROLLBACK');
    } catch {
      /* A rollback can fail if the connection died mid-transaction. The server
         has already discarded the work in that case, so the useful action is to
         return the client, not to mask the original error with this one. */
    } finally {
      this.#client.release();
    }
  }

  /**
   * A settled transaction is not a database handle any more.
   *
   * `commit()` and `rollback()` both RELEASE the client back to the pool. Until
   * this existed, `tx.prepare(…)` afterwards still held that client and happily
   * ran the statement on it — by then very likely checked out to a different
   * request. So a stray write after commit did not merely land outside its
   * transaction (bad enough, and the silent shape this whole phase exists to
   * prevent); it could land in the middle of somebody else's.
   *
   * Measured before the fix: a statement issued on a committed handle returned
   * `{ changes: 1 }`.
   *
   * Refusing is safe for correct callers, because a correct caller has no reason
   * to touch the handle after the block it was given for has ended.
   */
  _assertUsable() {
    if (this.#settled) {
      throw new Error(
        'This transaction has already been committed or rolled back, so its client '
        + 'has been returned to the pool. Running a statement on it now would execute '
        + 'on a connection another request may hold. Use the pool handle instead.'
      );
    }
  }

  #finish() {
    if (this.#settled) {
      throw new Error('This transaction has already been committed or rolled back.');
    }
    this.#settled = true;
  }
}

/**
 * The pool-backed database handle.
 *
 * ── Pool sizing ──
 *
 * `max` defaults to 25, and the number is measured rather than argued. It was 10,
 * on the reasoning that PostgreSQL gains nothing from more concurrent
 * connections than it has cores — which is right for CPU-bound queries and wrong
 * here, because over a network a pooled client spends most of its life waiting
 * on a round trip. `db/engine.js` carries the full sweep; the short version is
 * that at a 3ms round trip and 20 concurrent requests, raising the pool from 10
 * to 25 took throughput from 127 to 487 req/s and p95 from 481ms to 73ms, while
 * the same sweep on loopback is flat noise.
 *
 * It is still per process, and the provider's ceiling is real: Supabase's entry
 * sizes allow 60 direct connections and 200 through Supavisor.
 *
 * ── Statement caching is left off ──
 *
 * `pg` supports named prepared statements, which are per-connection server-side
 * objects. Under a transaction-mode pooler the connection under a client can
 * change between checkouts, and a named statement prepared on one backend does
 * not exist on another. Unnamed statements are re-planned each time and are
 * correct everywhere; at 548 rows the planning cost is not the constraint.
 */
export class PostgresDatabase extends PostgresExecutorBase {
  #pool;

  constructor({ connectionString, max = 25, ssl, translate, idleTimeoutMillis = 30_000, connectionTimeoutMillis = 10_000 } = {}) {
    if (!translate) throw new Error('PostgresDatabase requires a placeholder translator.');
    const pool = new Pool({ connectionString, max, ssl, idleTimeoutMillis, connectionTimeoutMillis });

    /* An idle client that errors — a server restart, a pooler timeout — emits on
       the pool. Unhandled, that is an uncaught exception that takes the process
       down. The pool discards the client itself; this only keeps it from being
       fatal, and says so rather than swallowing it. */
    pool.on('error', (err) => {
      console.error('[db] idle PostgreSQL client error (client discarded):', err.message);
    });

    super(pool, translate);
    this.#pool = pool;
  }

  /** Pool statistics, for the health endpoint and the leak tests. */
  get stats() {
    return { total: this.#pool.totalCount, idle: this.#pool.idleCount, waiting: this.#pool.waitingCount };
  }

  /**
   * Checks out a client and issues BEGIN on it.
   *
   * The caller owns the returned handle and must settle it. `runTransaction`
   * below is the shape every caller should actually use; this is exposed for the
   * tests that need to hold two transactions open at once to prove they cannot
   * see each other.
   */
  async beginTransaction() {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
    } catch (err) {
      client.release();
      throw err;
    }
    return new PostgresTransaction(client, this._translate);
  }

  async close() {
    await this.#pool.end();
  }
}

/**
 * Runs `fn` inside a transaction, with the transaction handle bound to the async
 * context so the existing `db` proxy resolves to it.
 *
 * This is the PostgreSQL counterpart of `inTransaction` in `server/utils.js`, and
 * the reason phase 4 was done first: `withConnection` is what makes the ~653
 * unedited call sites in the route layer land on this transaction's client
 * rather than on an arbitrary one from the pool.
 *
 * The client is released on every path — commit, rollback, or a throw inside the
 * rollback — because a leaked client is a slot the pool never gets back, and ten
 * of those is a permanently hung server.
 */
export async function runTransaction(database, fn) {
  const { withConnection } = await import('./connectionContext.js');
  const tx = await database.beginTransaction();
  try {
    const result = await withConnection(tx, () => fn(tx));
    await tx.commit();
    return result;
  } catch (err) {
    if (!tx.settled) {
      try { await tx.rollback(); } catch {}
    }
    throw err;
  }
}
