/**
 * Which connection is "the database", for the code currently running.
 *
 * ── The problem this exists to solve, which is not visible today ──
 *
 * `inTransaction(fn)` issues `BEGIN` and `COMMIT` against the module-global
 * connection exported by `db.js`. With one process and one SQLite connection
 * that is correct: every `db.prepare(...)` inside `fn` runs on the same
 * connection that opened the transaction, so it is inside it.
 *
 * Against a PostgreSQL connection **pool**, the same code is not merely slower
 * or racier — it stops being a transaction at all. `BEGIN` is issued on whichever
 * client the pool handed out, and the queries inside `fn` borrow *different*
 * clients, so they run outside the transaction the caller believes they are in.
 * A rollback then rolls back nothing that matters. Nothing errors; the writes
 * simply stop being atomic.
 *
 * There are 71 `inTransaction` call sites and 656 `db.prepare` calls in the 36
 * files that import the global handle. Threading a client parameter through all
 * of them by hand is the version of this migration that takes months and breaks
 * an invariant nobody notices.
 *
 * ── What this does instead ──
 *
 * `AsyncLocalStorage` binds a connection to the current async execution context.
 * `db` becomes a proxy that resolves, on every property access, to whatever
 * connection the surrounding context has bound — falling back to the default
 * when there is none. So `inTransaction` binds its connection once, and all 656
 * call sites participate in the enclosing transaction **without being edited**.
 *
 * ── Why it is safe to land this now, on SQLite ──
 *
 * Today there is exactly one connection, so `currentConnection()` returns the
 * same object whether or not a context is bound, and the proxy is a pass-through.
 * The behaviour is identical by construction; the 6,739-test suite is the
 * evidence. What changes is only that the seam now exists, and the eventual
 * PostgreSQL implementation has somewhere to put a pooled client.
 *
 * Measured cost of the indirection: **1.4%** over 200,000 `prepare().get()`
 * calls (378ms → 384ms), which is roughly 30 nanoseconds per call against a
 * statement that takes microseconds. Paid on every query, and worth it.
 *
 * ── What this deliberately does NOT do ──
 *
 * It does not make anything async, and it does not fix the ~180 synchronous
 * handlers whose atomicity rests on never awaiting between a read and its write.
 * That is phase 8 and no plumbing avoids it. This removes one specific obstacle —
 * the un-poolable transaction — and nothing else.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * The connection used when no context is bound.
 *
 * Set once by `db.js` at construction. Kept in a module variable rather than
 * imported from `db.js` because `db.js` imports *this* module — the dependency
 * has to point one way, and the proxy has to exist before the connection it
 * eventually resolves to.
 */
let defaultConnection = null;

export function setDefaultConnection(connection, path = null) {
  defaultConnection = connection;
  defaultConnectionPath = path;
}

/**
 * The connection the caller should be using.
 *
 * A bound context wins over the default. That ordering is the whole mechanism:
 * inside `inTransaction`, the transaction's connection is bound, so every query
 * lands on it; outside, the default is used.
 */
export function currentConnection() {
  return storage.getStore() ?? defaultConnection;
}

/** Whether a connection is bound — i.e. whether we are inside a transaction. */
export function hasBoundConnection() {
  return storage.getStore() !== undefined;
}

/**
 * Marks the proxy, so it can be told apart from a real connection.
 *
 * Answered by the `get` trap *before* it resolves anything, which is the whole
 * point: asking the proxy "are you a proxy" must not itself require resolving a
 * connection.
 */
const IS_CONNECTION_PROXY = Symbol('isConnectionProxy');

/**
 * The concrete connection behind a handle.
 *
 * ── The infinite loop this prevents ──
 *
 * Most callers of `transactionOn` pass the module-global `db`, which IS the
 * proxy. Binding a proxy as the current connection makes `resolve()` return the
 * proxy, so the `get` trap looks a property up on itself, which resolves to
 * itself, and the stack overflows — `RangeError: Maximum call stack size
 * exceeded`, with a hundred frames of the same trap.
 *
 * That is not hypothetical: it is what happened the moment the agreement modules
 * started routing through `transactionOn`, and the suite caught it on the first
 * run. Unwrapping here means a proxy can never be bound, so the trap always has
 * a real connection underneath it.
 *
 * At the moment this is called no transaction is open yet (`transactionOn`
 * refuses to nest), so `currentConnection()` returns the default — the real
 * connection — which is exactly what should be bound.
 */
export function concreteConnection(handle) {
  return handle?.[IS_CONNECTION_PROXY] ? currentConnection() : handle;
}

/**
 * Runs `fn` with `connection` bound as the current one.
 *
 * Synchronous today, because every caller is. `AsyncLocalStorage.run` propagates
 * across `await` as well, which is what makes this the right primitive to adopt
 * *before* the async port rather than after: the same call keeps working when
 * the body it wraps grows an `await`.
 *
 * The handle is unwrapped first: binding the proxy to itself is the stack
 * overflow described above, and it is cheaper to make that unrepresentable here
 * than to remember it at every call site.
 */
export function withConnection(connection, fn) {
  return storage.run(concreteConnection(connection), fn);
}

/**
 * A transaction on a specific handle.
 *
 * ── Why the primitive lives here and not in `utils.js` ──
 *
 * `utils.js` is where `inTransaction` has always been, and it is the wrong home
 * for the parameterised version. `utils.js` imports `organizerAgreement.js` for
 * `withheldCapabilitiesFor`, and `organizerAgreement.js` is one of the modules
 * that needs this helper — its own comment warns that "importing it back would
 * be a cycle". This module imports nothing but `node:async_hooks`, so everything
 * can depend on it and nothing can create a loop through it.
 *
 * `inTransaction(fn)` in `utils.js` is now a one-line delegation to this with the
 * ambient connection, so the ~71 existing callers are unaffected.
 *
 * ── Why callers pass a handle at all ──
 *
 * `organizerAgreement.js` and `studentOrganizerAgreement.js` take their database
 * handle as a parameter on purpose: it is how they are driven against a throwaway
 * database in tests. Before this existed their only option was `db.exec('BEGIN')`
 * on that handle — correct on SQLite, and silently wrong against a pool, where
 * BEGIN lands on one borrowed client and the writes inside land on others.
 *
 * ── Nesting is refused rather than silently flattened ──
 *
 * SQLite answers a nested BEGIN with "cannot start a transaction within a
 * transaction". PostgreSQL is worse: it warns and *joins* the outer transaction,
 * so an inner rollback would discard the outer one's work. Neither behaviour
 * should be inherited by accident. No caller nests today — verified across all
 * five entry points — and if one ever needs to, savepoints are the deliberate
 * answer this refusal will send them to.
 */
export function transactionOn(handle, fn) {
  if (hasBoundConnection()) {
    throw new Error(
      'A transaction is already open on this async context. Nested transactions are '
      + 'not supported: SQLite refuses them outright, and PostgreSQL silently folds '
      + 'the inner one into the outer, so an inner rollback would discard the outer '
      + "transaction's work. Restructure the call, or add savepoint support deliberately."
    );
  }

  /* Unwrapped once, up front, so BEGIN/COMMIT/ROLLBACK and every statement
     inside `fn` all go to the same concrete connection. Passing the proxy is the
     normal case — most callers hand over the module-global `db`. */
  const connection = concreteConnection(handle);

  connection.exec('BEGIN');
  try {
    const result = withConnection(connection, fn);

    /**
     * An async callback is refused, not awaited.
     *
     * ── The silent failure this replaces ──
     *
     * This function commits as soon as `fn` *returns*. Hand it an `async`
     * function and it returns a pending promise immediately, so COMMIT fires
     * before any of the work has happened — and the statements then execute
     * outside the transaction they were written to be inside. Every write
     * appears to succeed. The rollback path can never fire, because by the time
     * anything throws, the transaction is already closed.
     *
     * That is the single easiest mistake to make during the async port: adding
     * `await` inside an existing `inTransaction` block looks like progress and
     * quietly removes the atomicity the block existed to provide.
     *
     * ── Why it throws instead of awaiting ──
     *
     * Awaiting would be worse while SQLite is the engine. There is one
     * connection, and `BEGIN` holds it until `COMMIT` — so a handler that yields
     * with a transaction open lets *another* request's statements run on that
     * same connection, inside this transaction, where a rollback would discard
     * work that request believed committed. Making the helper async would turn a
     * loud error into that.
     *
     * The correct fix at the call site is to move the awaited work outside the
     * transaction, which is what every existing caller already does. When the
     * engine switch lands, PostgreSQL's pinned client makes an async transaction
     * safe and this guard is replaced by an awaiting implementation — one
     * change, made deliberately, rather than discovered.
     */
    if (result && typeof result.then === 'function') {
      try { connection.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw new Error(
        'transactionOn/inTransaction was given an async callback. The transaction '
        + 'commits when the callback RETURNS, so an async one commits before its work '
        + 'has run and the statements land outside the transaction — silently. '
        + 'Move the awaited work outside the transaction, or keep the callback '
        + 'synchronous. (Rolled back; nothing was committed.)'
      );
    }

    connection.exec('COMMIT');
    return result;
  } catch (err) {
    try { connection.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * The file behind the default connection, when there is one.
 *
 * ── Why this is bound to the connection rather than kept as its own global ──
 *
 * It was a standalone module variable for about ten minutes, and the tests found
 * the flaw immediately. `db.js` sets it at import to the real database file; a
 * test then calls `setDefaultConnection()` with its own `:memory:` connection and
 * never touches the path. An async transaction would then open a second
 * connection to the **file** — a different database entirely from the one the
 * test was using — and every statement inside the transaction hit
 * "no such table".
 *
 * Pairing them makes the disagreement unrepresentable: a connection supplied
 * without a path simply has no path, and the transaction shares it instead of
 * opening a second connection to somewhere else.
 */
let defaultConnectionPath = null;

/**
 * An **async** transaction, on either engine. This is the form converted code uses.
 *
 * ── Why one function serves both engines without duplicating logic ──
 *
 * The body is written once, `async`, awaiting its queries. On PostgreSQL those
 * awaits resolve promises from a pinned pooled client. On SQLite they await
 * plain values, which is a no-op — so the same body runs on both, and there is
 * no second implementation of any business rule.
 *
 * The engine difference lives entirely here: PostgreSQL checks out a pooled
 * client, SQLite opens its own connection (see `sqliteTransaction.js` for why
 * that is what makes an `await` inside a SQLite transaction safe).
 *
 * ── Why this is separate from `transactionOn` rather than replacing it ──
 *
 * `transactionOn` is synchronous and refuses an async callback, deliberately —
 * committing when an async callback *returns* would commit before its work ran.
 * The 71 unconverted call sites still use it and are still correct. This is the
 * target form; both exist while phase 7 is in progress, and the synchronous one
 * goes away with the SQLite retirement.
 *
 * ── The binding is what makes it work at all ──
 *
 * `withConnection` puts the transaction handle in the async context for the
 * duration, so every `db.prepare(...)` reached from inside — including call
 * sites nobody has edited — resolves to this transaction rather than to the pool
 * or the shared connection. `AsyncLocalStorage` carries that across `await`,
 * which is the property phase 4 was built for.
 */
export async function runInTransaction(handle, fn) {
  if (hasBoundConnection()) {
    throw new Error(
      'A transaction is already open on this async context. Nested transactions are '
      + 'not supported: SQLite refuses them outright, and PostgreSQL silently folds '
      + 'the inner one into the outer, so an inner rollback would discard the outer '
      + "transaction's work. Restructure the call, or add savepoint support deliberately."
    );
  }

  const target = concreteConnection(handle);
  /* A path only travels with the connection it belongs to. When the caller gave
     none — every test that supplies its own `:memory:` handle — the transaction
     shares that connection rather than opening one somewhere else. */
  const sqlitePath = target === defaultConnection ? defaultConnectionPath : null;

  const tx = typeof target.beginTransaction === 'function'
    ? await target.beginTransaction()
    : await (await import('./sqliteTransaction.js')).beginSqliteTransaction(sqlitePath, target);

  try {
    const result = await withConnection(tx, () => fn(tx));
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * A stand-in for the database handle that always resolves to the current one.
 *
 * Methods are bound to the resolved connection before being handed back, because
 * `DatabaseSync`'s methods are prototype methods that need their receiver — an
 * unbound `db.prepare` would throw on an illegal invocation.
 *
 * `has` and `getPrototypeOf` are forwarded so that `typeof db.prepare ===
 * 'function'`, `'prepare' in db` and instance checks keep answering what they
 * answered before. Several modules guard on exactly that shape
 * (`auditLog.js`, `errorReporter.js`, `securityAudit.js`, `alerting.js`), and a
 * proxy that quietly failed those guards would disable audit logging rather than
 * crash — the silent failure mode this whole phase is trying to avoid.
 */
export function createConnectionProxy() {
  const resolve = () => {
    const conn = currentConnection();
    if (!conn) {
      throw new Error(
        'Database accessed before a connection was established. '
        + 'server/db.js must call setDefaultConnection() before anything queries.'
      );
    }
    return conn;
  };

  return new Proxy(Object.create(null), {
    get(_target, prop) {
      /* Answered before resolving anything: `concreteConnection` asks this to
         avoid binding the proxy to itself, and resolving in order to answer it
         would defeat the purpose. */
      if (prop === IS_CONNECTION_PROXY) return true;
      const conn = resolve();
      const value = conn[prop];
      return typeof value === 'function' ? value.bind(conn) : value;
    },
    set(_target, prop, value) {
      resolve()[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in resolve();
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(resolve());
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(resolve(), prop);
      /* A proxy may not report a non-configurable property that its target does
         not have. Reporting it configurable is the standard accommodation and is
         invisible to every caller here, none of which redefines a method. */
      return d ? { ...d, configurable: true } : undefined;
    },

    /**
     * `defineProperty` and `deleteProperty` forward to the connection, and they
     * are not optional.
     *
     * The first version of this proxy trapped reads and writes but not property
     * *definition*, which quietly broke six tests across three files. `vi.spyOn`
     * does not assign — it reads a descriptor and calls `defineProperty`. With no
     * trap, the spy was installed on the proxy's inert target object while `get`
     * went on resolving to the real connection, so the stub was written somewhere
     * nothing ever read. The tests did not error; they simply observed zero calls
     * and unmocked behaviour: `authz.aal` counted 0 queries where it expected 1,
     * and `health` returned 200 from a database it had been told to make fail.
     *
     * That failure mode is worth naming, because it is the same one this whole
     * phase exists to prevent — an abstraction that looks transparent, is not,
     * and reports success while the thing underneath is untouched. A proxy
     * standing in for an object has to forward every trap that object's callers
     * use, and monkey-patching in tests is one of those uses.
     */
    defineProperty(_target, prop, descriptor) {
      return Reflect.defineProperty(resolve(), prop, descriptor);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(resolve(), prop);
    },
  });
}
