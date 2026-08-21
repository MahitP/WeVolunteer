import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A ratchet on the amount of code that reaches the database through the global.
 *
 * ── What it measures, and why that number and not another ──
 *
 * There are two ways a module in this codebase gets a database handle. It either
 * **receives** one as a parameter — every migration does, and most services —
 * or it **imports** the module-global `db` from `server/db.js`.
 *
 * The difference does not matter today. It matters entirely for the PostgreSQL
 * port, because a handle that arrives as a parameter can be given a pooled
 * client, and one that is imported cannot. When the audit was taken the split
 * was 744 call sites in 95 files that receive it, against **656 in 36 files that
 * import it**. The second number is the migration's real work surface.
 *
 * ── Why a ceiling rather than a ban ──
 *
 * Banning the import outright would fail the build on the 36 files that already
 * do it, which is not a guard, it is a stop-work order. The debt is legitimate;
 * it just must not grow while it is being paid down. So this asserts a ceiling
 * that can only be lowered — the same shape TD-15 says `UNCONVERTED_UX` should
 * have had and does not, written down here because that entry is the record of
 * what an unratcheted escape hatch costs.
 *
 * A file added during the port that imports the global instead of taking a
 * parameter is exactly the change this catches, and it is invisible in review:
 * `import { db } from '../db.js'` is what all 36 of its neighbours already say.
 *
 * ── How to change the numbers ──
 *
 * Down, freely — that is the point, and the test tells you the new figure.
 * **Up, only with a reason written here.** If a genuinely new subsystem needs the
 * global, say why it cannot take a parameter instead.
 */

const SERVER = path.resolve(import.meta.dirname);

/**
 * The ceilings, as measured by this scan on 2026-08-15. Lower them as the port
 * proceeds.
 *
 * These were first written as 36 / 656, taken from a shell count during the
 * audit, and the guard immediately failed at 42 / 653. Both numbers were right
 * about different things: 36 files *query* the global, but 42 *import* it — the
 * other six hold it for `db.close()` on shutdown, or to hand on to something
 * else. For this guard's purpose the import is what counts, because an import is
 * what cannot be given a pooled client, whether or not the module happens to run
 * a query today.
 *
 * Recorded because it is the second time in this project a hand count and a
 * committed scan have disagreed, and the scan has been right both times.
 */
const MAX_GLOBAL_IMPORT_FILES = 42;
/**
 * 653 → 518 after the phase 7 transaction waves (9–16).
 *
 * The drop is not modules being deleted; it is statements moving from the
 * ambient handle onto an explicit `tx` inside converted transactions, which is
 * exactly the direction this ratchet exists to encourage. The file count is
 * unchanged at 42, because a module keeps its import as long as one statement
 * still uses it.
 */
const MAX_GLOBAL_IMPORT_CALLSITES = 518;

/**
 * `db.js` and the context module are the boundary itself and are exempt.
 * `db.js` constructs the connection; `connectionContext.js` is what everything
 * else resolves through.
 */
const BOUNDARY = new Set(['db.js', path.join('db', 'connectionContext.js')]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.(js|mjs)$/.test(entry.name)) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(full);
  }
  return out;
}

/** Files that import the module-global handle, and how often each queries it. */
function globalImporters() {
  const found = [];
  for (const file of sourceFiles(SERVER)) {
    const rel = path.relative(SERVER, file);
    if (BOUNDARY.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    /* The named import specifically. A module that imports `initDatabase` alone
       is not reaching for the handle. */
    if (!/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"][^'"]*db\.js['"]/.test(src)) continue;
    const calls = (src.match(/\bdb\.(prepare|exec)\s*\(/g) || []).length;
    found.push({ file: rel, calls });
  }
  return found.sort((a, b) => b.calls - a.calls);
}

describe('the database access surface', () => {
  const importers = globalImporters();
  const total = importers.reduce((n, f) => n + f.calls, 0);

  it('finds the importers at all, so the ceilings cannot pass vacuously', () => {
    /* If the import shape changes — a re-export, a rename, a barrel file — this
       scan would quietly match nothing and both ceilings below would pass while
       measuring an empty set. The same trap `auditLabelCoverage` guards against
       with its own tripwire. */
    expect(importers.length).toBeGreaterThan(10);
    expect(total).toBeGreaterThan(100);
    expect(importers.map(f => f.file)).toContain(path.join('routes', 'eventRoutes.js'));
  });

  it('does not add files that reach the database through the global', () => {
    expect(
      importers.length,
      `${importers.length} files import the global db handle; the ceiling is ${MAX_GLOBAL_IMPORT_FILES}.\n`
      + 'A new module should RECEIVE a database handle as a parameter rather than importing it —\n'
      + 'a parameter can be given a pooled client during the PostgreSQL port, an import cannot.\n'
      + 'If this number went DOWN, lower MAX_GLOBAL_IMPORT_FILES to match; that is the point.\n'
      + `Files: ${importers.map(f => f.file).join(', ')}`,
    ).toBeLessThanOrEqual(MAX_GLOBAL_IMPORT_FILES);
  });

  it('does not add call sites that reach the database through the global', () => {
    expect(
      total,
      `${total} db.prepare/db.exec calls go through the global handle; the ceiling is ${MAX_GLOBAL_IMPORT_CALLSITES}.\n`
      + 'Every one of these has to keep working when a transaction owns a pooled client.\n'
      + 'They do, via the async-context proxy in server/db/connectionContext.js — but the\n'
      + 'set should shrink as modules are converted to take a handle, never grow.\n'
      + `Worst offenders: ${importers.slice(0, 5).map(f => `${f.file} (${f.calls})`).join(', ')}`,
    ).toBeLessThanOrEqual(MAX_GLOBAL_IMPORT_CALLSITES);
  });

  /**
   * No application module may open a transaction by hand.
   *
   * ── What this catches, and why the previous guard could not ──
   *
   * The test below asserts that `inTransaction` resolves through the context.
   * Three modules were opening transactions without ever calling
   * `inTransaction` — `organizerAgreement.js`, `studentOrganizerAgreement.js`
   * and `workers/retentionWorker.js` all issued `exec('BEGIN')` directly on a
   * handle — so that assertion was true and irrelevant, and the surface it was
   * meant to protect had three holes in it.
   *
   * On SQLite all three were correct: one connection, so BEGIN and the writes
   * that follow are necessarily on it. Against a pool each is the defining
   * failure of this migration — BEGIN on one borrowed client, writes on others,
   * no atomicity and a rollback that discards nothing, with no error raised.
   *
   * This is the third time in this project a guard has checked one spelling of a
   * thing while the codebase used two (TD-12, TD-23). The lesson each time is
   * that a guard's *scan* has to be at least as wide as the behaviour it
   * polices, so this looks for the behaviour — a raw BEGIN — rather than for the
   * absence of a helper.
   *
   * ── What is exempt, enumerated rather than pattern-matched ──
   *
   * Boot and migration code runs single-threaded before the server accepts a
   * request, and the standalone scripts have no pool at all. Those are listed by
   * path so a new exemption has to be added deliberately, with a reason.
   */
  const RAW_TRANSACTION_EXEMPT = new Set([
    /* Runs during boot, before the listener is attached: schema rebuilds and
       the seed path. No concurrency, and no pool. */
    'db.js',
    /* The migration runner and the migrations themselves — same reason, and
       several must own their transaction to do a table rebuild at all. */
    'migrations/index.js',
    /* A standalone one-shot script, run by hand against a chosen database. */
    'migrate_usernames.js',
    /* The context module: this is where BEGIN legitimately lives. */
    path.join('db', 'connectionContext.js'),
    /* And the SQLite transaction adapter, which IS the primitive for that
       engine — it opens the connection the transaction owns and issues the
       BEGIN on it. Exempt for the same reason as the context module, and it
       leaves with the SQLite retirement phase. */
    path.join('db', 'sqliteTransaction.js'),
  ]);

  it('has no application module opening a transaction by hand', () => {
    const offenders = [];
    for (const file of sourceFiles(SERVER)) {
      const rel = path.relative(SERVER, file);
      if (RAW_TRANSACTION_EXEMPT.has(rel)) continue;
      if (rel.startsWith(`migrations${path.sep}`)) continue;

      const code = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      if (/\.exec\(\s*['"`]\s*(BEGIN|COMMIT|ROLLBACK)/i.test(code)) offenders.push(rel);
    }

    expect(
      offenders,
      'These open a transaction with a raw BEGIN instead of transactionOn()/inTransaction().\n'
      + 'On SQLite that is correct. Against a connection pool, BEGIN lands on one borrowed\n'
      + 'client while the writes inside land on others — the work is not atomic and the\n'
      + 'rollback discards nothing, with no error raised.\n'
      + 'Use transactionOn(handle, fn) when the handle is a parameter, inTransaction(fn)\n'
      + 'when it is ambient.',
    ).toEqual([]);
  });

  it('still detects a raw BEGIN, so the exemption list cannot hide everything', () => {
    /* The scan strips comments, and every one of the three converted modules now
       *describes* `exec('BEGIN')` in prose explaining why it no longer does it.
       Without this, a stripping bug would turn the guard above into a test that
       inspects nothing and passes. */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const pattern = /\.exec\(\s*['"`]\s*(BEGIN|COMMIT|ROLLBACK)/i;

    expect(pattern.test(strip("db.exec('BEGIN');")), 'a real BEGIN must be caught').toBe(true);
    expect(pattern.test(strip('/* we no longer call db.exec("BEGIN") here */\nconst x = 1;')),
      'a BEGIN described in a comment must not count').toBe(false);
  });

  /**
   * The transaction primitive binds its connection.
   *
   * This is what makes the proxy worth having: without the binding, the ~653
   * unedited call sites inside a transaction resolve to the pool instead of to
   * the transaction's client, and the work silently stops being atomic while the
   * SQLite suite stays green.
   *
   * The assertion moved when `transactionOn` was extracted into
   * `connectionContext.js` — `inTransaction` is now a delegation, so checking it
   * for `withConnection` would check the wrong function and pass for the wrong
   * reason. Both halves are asserted here instead.
   */
  const sourceOf = (file, decl) => {
    const src = fs.readFileSync(path.join(SERVER, file), 'utf8');
    const from = src.indexOf(decl);
    expect(from, `${decl} not found in ${file} — this guard is checking nothing`).toBeGreaterThan(-1);
    const body = src.slice(from);
    return body.slice(0, body.indexOf('\n}\n') + 3);
  };

  it('routes the ambient transaction helper through the context', () => {
    const fn = sourceOf('utils.js', 'export function inTransaction');
    expect(fn, 'inTransaction must resolve the ambient connection').toMatch(/currentConnection\(\)/);
    expect(fn, 'inTransaction must delegate to the shared primitive').toMatch(/transactionOn\(/);
    expect(fn, 'inTransaction must not issue BEGIN itself').not.toMatch(/\.exec\(\s*['"]BEGIN/);
  });

  it('makes the transaction primitive bind, unwrap and refuse to nest', () => {
    const fn = sourceOf(path.join('db', 'connectionContext.js'), 'export function transactionOn');

    expect(fn, 'transactionOn must bind the connection for the callback').toMatch(/withConnection\(/);
    /* Binding the proxy to itself makes the get trap resolve to itself — a stack
       overflow, which is what happened the first time this shipped. */
    expect(fn, 'transactionOn must unwrap a proxy handle before binding').toMatch(/concreteConnection\(/);
    expect(fn, 'transactionOn must refuse to nest').toMatch(/hasBoundConnection\(\)/);
    expect(fn, 'transactionOn must issue COMMIT on the resolved connection').toMatch(/connection\.exec\('COMMIT'\)/);
  });
});
