/**
 * An async transaction for SQLite, so converted code can be written once.
 *
 * ── Why this exists, given SQLite is being retired ──
 *
 * The migration's target is PostgreSQL-native async code (owner decision D). A
 * function converted to `async` and `await`-ing its queries would, on the old
 * synchronous path, break every test that drives it — and 164 test files go
 * through `startTestServer`. Losing that coverage during the conversion costs
 * far more than it saves.
 *
 * So the difference is pushed into the adapter, where the decision explicitly
 * allows it: business logic is written **once**, async, and both engines satisfy
 * it. There is no second implementation of anything.
 *
 * This module is temporary by design and is removed in the SQLite retirement
 * phase along with the rest of that path.
 *
 * ── Why a transaction gets its OWN connection ──
 *
 * This is the whole point, and it is the hazard established in wave 2. SQLite
 * has one shared connection; `BEGIN` holds it until `COMMIT`. If a handler
 * yields with a transaction open on that connection, *another request's*
 * statements execute inside the transaction, and a rollback discards work that
 * request believed committed.
 *
 * Opening a separate connection for the transaction's lifetime removes that
 * exactly as PostgreSQL's pinned client does: the transaction owns its
 * connection, and everything else keeps using the main one. An `await` inside
 * the transaction becomes safe rather than merely unlikely to bite.
 *
 * ── `BEGIN IMMEDIATE`, not `BEGIN` ──
 *
 * With two connections on one file, a deferred `BEGIN` takes a read lock and
 * tries to upgrade at the first write — which fails with `SQLITE_BUSY` if the
 * other connection wrote in between, *after* the transaction has already done
 * work. `IMMEDIATE` acquires the write lock up front, so contention shows up as
 * a clean wait at the start (bounded by `busy_timeout`) instead of a failure
 * partway through.
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * Whether a second connection can be opened on this database.
 *
 * `:memory:` databases are private to their connection — a second one would open
 * a different, empty database, which is worse than sharing. `file:` locators may
 * or may not be shareable depending on `cache=shared`, and guessing wrong is the
 * same failure, so they are treated as unshareable too.
 */
function canOpenSecondConnection(dbPath) {
  return typeof dbPath === 'string'
    && dbPath !== ':memory:'
    && !dbPath.startsWith('file:');
}

/**
 * A transaction handle over a SQLite connection.
 *
 * Mirrors `PostgresTransaction`'s surface so callers cannot tell them apart:
 * `prepare`, `exec`, `commit`, `rollback`, and a `dialect`. The statements are
 * the driver's own synchronous ones — `await` on a plain value is a no-op, which
 * is what lets one async body serve both engines without the SQLite path paying
 * for promises it does not need.
 */
class SqliteTransaction {
  #connection;
  #owned;
  #release;
  #settled = false;

  constructor(connection, { owned, release }) {
    this.#connection = connection;
    this.#owned = owned;
    this.#release = release;
  }

  get dialect() { return 'sqlite'; }
  get settled() { return this.#settled; }

  prepare(sql) { return this.#connection.prepare(sql); }
  exec(sql) { return this.#connection.exec(sql); }

  commit() {
    this.#finish();
    try {
      this.#connection.exec('COMMIT');
    } finally {
      this.#releaseConnection();
    }
  }

  rollback() {
    this.#finish();
    try {
      this.#connection.exec('ROLLBACK');
    } catch {
      /* Already rolled back, or the connection is gone. Either way the work is
         discarded and the useful action is to release, not to mask the original
         error with this one. */
    } finally {
      this.#releaseConnection();
    }
  }

  #finish() {
    if (this.#settled) {
      throw new Error('This transaction has already been committed or rolled back.');
    }
    this.#settled = true;
  }

  /**
   * Close the connection this transaction opened, then let the next one in.
   *
   * The order matters: the write lock is held until the connection is closed (or
   * at least until COMMIT lands), and admitting the next writer before that
   * reintroduces exactly the contention the gate exists to remove.
   */
  #releaseConnection() {
    if (this.#owned) {
      try { this.#connection.close(); } catch { /* already closed */ }
    }
    if (this.#release) {
      const release = this.#release;
      this.#release = null;
      release();
    }
  }
}

/**
 * One writer at a time, enforced in JavaScript rather than by `busy_timeout`.
 *
 * ── The deadlock this removes ──
 *
 * SQLite allows one write transaction per file, and `busy_timeout` is the
 * driver's answer to contention: block until the holder commits. That answer
 * requires a thread that can keep running while another releases the lock, and
 * `node:sqlite` is **synchronous** — the wait happens inside a C call on the one
 * thread Node has.
 *
 * So the holder can never commit. Its `COMMIT` is a JavaScript continuation
 * sitting on an event loop that a contending `BEGIN IMMEDIATE` has frozen, and
 * the contender waits the full timeout for a lock that nothing can release. The
 * wait is not merely slow; it cannot succeed.
 *
 * Measured, not reasoned about: eight concurrent second-factor submissions
 * produced one `BEGIN` at 0ms and seven failures at ~5,400ms each — the entire
 * process stalled for 37 seconds and every one of the seven lost its
 * transaction to `SQLITE_BUSY`. In production that is two students touching any
 * transactional endpoint in the same moment and freezing the server for five
 * seconds, so it is a denial of service against ourselves rather than a
 * test-only artefact.
 *
 * ── Why a queue is the fix and a longer timeout is not ──
 *
 * Raising `busy_timeout` lengthens the freeze. Lowering it converts the freeze
 * into instant failure. Neither can work, because the blocking is the bug: what
 * a contender must do is **yield the event loop** so the holder can reach its
 * `COMMIT`. Awaiting a promise does that; blocking in C does not.
 *
 * Serialising also matches what SQLite actually permits. One writer at a time is
 * the engine's rule, so a queue expresses the constraint directly instead of
 * discovering it through lock errors.
 *
 * ── Scope ──
 *
 * In-process only, and only for transactions that own their connection. A
 * second *process* writing the same file still contends, and `busy_timeout`
 * remains for that case — it is rare outside tests, and unlike this one it is
 * not a deadlock, because the other process can commit while we wait.
 *
 * Retires with the rest of this module: PostgreSQL has real concurrent writers
 * and needs none of it.
 */
let writeGate = Promise.resolve();

function acquireWriteGate() {
  const previous = writeGate;
  let release;
  writeGate = new Promise((resolve) => { release = resolve; });
  return previous.then(() => release);
}

/**
 * Opens a transaction on `dbPath`, on its own connection where that is possible.
 *
 * Async because a contended write now waits in the queue above rather than
 * blocking the event loop inside `BEGIN IMMEDIATE`.
 *
 * @param {string} dbPath      the database file this connection set is using
 * @param {object} fallback    the primary connection, used when a second cannot be opened
 */
export async function beginSqliteTransaction(dbPath, fallback) {
  const owned = canOpenSecondConnection(dbPath);

  /**
   * The `:memory:` fallback, and why it is acceptable rather than a hole.
   *
   * An in-memory database cannot be reached from a second connection, so a
   * transaction there runs on the shared one and the wave 2 hazard applies: an
   * `await` inside it could admit another caller's statements.
   *
   * That is tolerable *only* because of who uses `:memory:` — 29 unit-scale test
   * files, each single-threaded with no concurrent requests. It is never the
   * production path: production is PostgreSQL, and the file-backed development
   * and test-server databases both get their own connection.
   *
   * Stated here rather than left implicit, because "it works in the tests" is
   * exactly the reasoning that would make somebody reach for `:memory:` in a
   * context where it does not.
   */
  /* Taken BEFORE the connection is opened, so a queued writer holds no file
     handle while it waits. Only owned transactions contend: the `:memory:`
     fallback runs on the shared connection, where there is no second connection
     to take a lock against. */
  const release = owned ? await acquireWriteGate() : null;

  const connection = owned
    ? new DatabaseSync(dbPath, { enableForeignKeyConstraints: true })
    : fallback;

  if (owned) {
    /* Retained for an out-of-process writer, which the gate above cannot see.
       In-process contention no longer reaches this, because the queue admits one
       writer at a time. */
    connection.exec('PRAGMA busy_timeout = 5000');
  }

  try {
    connection.exec(owned ? 'BEGIN IMMEDIATE' : 'BEGIN');
  } catch (err) {
    if (owned) { try { connection.close(); } catch { /* nothing to close */ } }
    /* The gate must open even when the transaction never did, or one failed
       BEGIN stops every writer in the process for the lifetime of the run. */
    if (release) release();
    throw err;
  }

  return new SqliteTransaction(connection, { owned, release });
}
