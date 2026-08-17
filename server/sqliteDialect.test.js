/**
 * The SQLite-only SQL this codebase still speaks, counted and held.
 *
 * ── Why this file exists ──
 *
 * The async port is finished: every application query site awaits, and
 * `asyncShapes.test.js` keeps them that way. That was the loud half of the
 * PostgreSQL migration. This is the quiet half — SQL that parses under SQLite
 * and does not exist under PostgreSQL at all.
 *
 * Each construct below was executed against a real PostgreSQL 17 server rather
 * than assumed incompatible. Verbatim, on 2026-08-16:
 *
 *   datetime('now','-1 hour')  ERROR: function datetime(unknown, unknown) does not exist
 *   INSERT OR IGNORE …         ERROR: syntax error at or near "OR"
 *   … COLLATE NOCASE           ERROR: collation "nocase" for encoding "UTF8" does not exist
 *   strftime('%Y-%m', c)       ERROR: function strftime(unknown, text) does not exist
 *   julianday(c)               ERROR: function julianday(text) does not exist
 *   SELECT … sqlite_master     ERROR: relation "sqlite_master" does not exist
 *   SELECT rowid FROM …        ERROR: column "rowid" does not exist
 *   … WHERE 1                  ERROR: argument of WHERE must be type boolean, not type integer
 *
 * Not everything is a blocker. The same session put 29 of `db.js`'s 30
 * `CREATE TABLE` statements through PostgreSQL unchanged — `TEXT`, `REAL` and
 * `INTEGER` all exist there, so the tables themselves are close to portable. The
 * incompatibility is concentrated in the functions, the pragmas and the
 * conflict-handling syntax counted here.
 *
 * ── Why a ratchet rather than a fix ──
 *
 * Translating the 6 that remain in runtime queries is a phase of its own, and each one is a semantic
 * decision: `datetime('now')` is `now()` but also a timezone question,
 * `COLLATE NOCASE` is `citext` or `lower()` and therefore an index question,
 * `INSERT OR IGNORE` is `ON CONFLICT DO NOTHING` but only once you have named
 * the constraint it should conflict on. `sqlPlaceholders.js` deliberately does
 * not translate any of them, for the same reason.
 *
 * What must not happen meanwhile is the surface growing. A migration that
 * pauses and quietly gets larger is one that never finishes, so this fails the
 * build when a count goes up, and asks whoever lowered one to lower the number
 * with it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
/* The migration registry's comment stripper, reused rather than rewritten. It
   walks the source character by character precisely because a regex cannot tell
   a comment from `//` inside a string, and getting that wrong here would either
   count prose or miss real SQL. */
import { canonicalSource } from './migrations/index.js';

const SERVER = path.resolve(import.meta.dirname);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.js') && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * Counted inside SQL string literals only.
 *
 * A bare `/PRAGMA/` over the source also matches the word in the prose above
 * every one of these queries, and this codebase comments heavily — the naive
 * scan reported 127 PRAGMAs against 101 real ones. So: find the string
 * literals, keep the ones that look like SQL, and count within those.
 *
 * Comments are stripped FIRST, which is not the same thing. A comment saying
 * "`INSERT OR IGNORE` rather than a plain insert, because…" contains a
 * backtick-delimited span that a literal scanner reads as a template string
 * holding SQL. Seven of those were being counted as outstanding work after the
 * call sites they describe had already been converted — and worse, improving
 * one of those comments could have tripped the ratchet. The measurement has to
 * be of the code.
 */
const STRING_LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/**
 * A literal is SQL if it carries a statement verb — OR if it is a FRAGMENT.
 *
 * ── Why the verbs alone were not enough ──
 *
 * The verb test was the whole definition, and it is how `instr()` and the
 * scalar `min(1.0, …)` reached production. This codebase assembles its bigger
 * queries from pieces: `eventQuery.js` returns WHERE clauses, ORDER BY strings
 * and select expressions that the route concatenates into a statement. A piece
 * like
 *
 *     instr(lower(e.title), lower(@q)) > 0
 *
 * is SQL by any reading, contains no verb, and so was never scanned at all.
 * The guard reported zero runtime `instr` while the browse search box was
 * answering 500 on PostgreSQL. A ratchet that cannot see a third of the SQL is
 * not measuring what its name claims.
 *
 * ── What identifies a fragment ──
 *
 * Either a named bind parameter (`@q`, `@lat` — this codebase's convention for
 * assembled SQL, and the reason `sqlPlaceholders.js` exists), or a clause
 * keyword. Both are things prose and ordinary JS templates do not contain, which
 * matters because the alternative — scanning every string — counts
 * `Math.min(total, LIMIT)` inside a log line and `${member.rowid}` inside an
 * email-dedup template as dialect debt. Those were measured, not imagined: they
 * are the exact false positives this test produced before the rule was narrowed.
 *
 * ── What this still cannot see ──
 *
 * A fragment carrying neither a bind parameter nor a clause keyword — say a
 * bare `'lower(x) > 0'` concatenated in from somewhere — is still invisible.
 * That is a real remaining hole and not a theoretical one: it is the same shape
 * as the bug this rule was written for, minus the `@q` that happens to save it.
 * Closing it properly means recognising SQL structurally rather than by tokens,
 * which is a parser, not a regex. Until then the backstop is the one that
 * actually found these two: running the application suite against a real
 * PostgreSQL, where an untranslated construct raises rather than hides.
 */
const LOOKS_LIKE_SQL = new RegExp([
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA)\b/.source,
  /@[a-z_]\w*/.source,
  /\b(?:WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|JOIN|ON\s+CONFLICT|COLLATE)\b/.source,
].join('|'), 'i');

/**
 * Two files talk ABOUT the dialect rather than speaking it, and counting them
 * makes the ratchet self-defeating: `engine.js`'s refusal message lists the
 * constructs it is refusing over, and `sqlPlaceholders.js` explains which ones
 * it deliberately does not translate. Improving either explanation would fail
 * this file.
 */
const EXPLAINS_RATHER_THAN_EXECUTES = new Set([
  path.join('db', 'engine.js'),
  path.join('db', 'sqlPlaceholders.js'),
  /* Generated, and PostgreSQL-native by construction. Its three `COLLATE
     nocase` clauses name the ICU collation its own preamble defines, not
     SQLite's built-in keyword, and `db.postgresSchema.test.js` already asserts
     it carries no SQLite-only construct. Counting it here would ratchet the
     PostgreSQL schema as though it were SQLite debt. */
  path.join('db', 'postgresSchema.js'),
]);

const FILES = sourceFiles(SERVER)
  .map(f => ({
    rel: path.relative(SERVER, f),
    sql: (canonicalSource(readFileSync(f, 'utf8')).match(STRING_LITERAL) ?? [])
      .filter(lit => LOOKS_LIKE_SQL.test(lit)),
  }))
  .filter(f => !EXPLAINS_RATHER_THAN_EXECUTES.has(f.rel));

/** Boot-time SQL: the schema path, which cannot execute under PostgreSQL at all. */
const isBoot = rel => rel === 'db.js' || rel.startsWith('migrations/') || rel.endsWith('seed_badges.js');

/**
 * Counts the SCALAR overload of `min`/`max` — the two-argument form.
 *
 * The one-argument aggregate is correct on both engines and is everywhere in
 * this codebase (`MAX(at.present)`, `MIN(s.start_datetime)`, and forty more),
 * so the thing to find is specifically a comma at the top level of the call's
 * own parentheses. That cannot be a regex: the arguments nest, and the real
 * offender was
 *
 *     min(1.0, cos(radians(@lat)) * cos(radians(e.latitude)) * cos(…) + sin(…))
 *
 * where `[^()]*,` matches nothing and `.*,` matches far too much. Balancing the
 * parentheses is the only way to tell the two overloads apart, so the depth is
 * counted rather than guessed.
 */
function scalarMinMax(lit) {
  let found = 0;
  for (const m of lit.matchAll(/\b(?:min|max)\s*\(/gi)) {
    let depth = 1;
    for (let i = m.index + m[0].length; i < lit.length && depth > 0; i += 1) {
      const ch = lit[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 1) { found += 1; break; }
    }
  }
  return found;
}

/**
 * Every construct, what PostgreSQL wants instead, and how many are left.
 *
 * `runtime` and `boot` are counted apart because they retire differently. The
 * runtime ones are ordinary per-query translations. The boot ones only matter
 * once there is a PostgreSQL schema path at all, and `PRAGMA` in particular is
 * mostly `foreign_keys`/`journal_mode`/`table_info` — configuration and
 * introspection with direct PostgreSQL equivalents, not queries to rewrite.
 */
const CONSTRUCTS = [
  { name: 'PRAGMA',          pattern: /\bPRAGMA\s+\w/gi,                    runtime: 4, boot: 82,
    postgres: 'session settings and information_schema; PRAGMA does not exist' },
  /**
   * Case-sensitive, and the case carries the meaning.
   *
   * `COLLATE NOCASE` is SQLite's built-in keyword and exists nowhere else.
   * `COLLATE nocase` is the ICU collation `postgresSchema.js` defines in its
   * preamble — and SQLite resolves collation names case-insensitively, so the
   * lower-case spelling reaches its built-in unchanged. One token therefore
   * satisfies both engines, and the 29 runtime sites were converted by writing
   * it, not by branching on the dialect.
   *
   * Verified on both before adopting it: equality and ORDER BY behave
   * identically. `LIKE` does not — PostgreSQL refuses a nondeterministic
   * collation there — and no site combines the two. `db.dialectSql.test.js`
   * pins the equality and ordering behaviour.
   *
   * The test below pins that no other spelling creeps in. Note what that is and
   * is not for: an earlier version of this comment claimed `COLLATE NoCase`
   * would fail on PostgreSQL, and that is simply untrue — PostgreSQL folds an
   * unquoted identifier to lower case, so every spelling resolves to the same
   * collation and all of them work. (Checked directly against the ICU collation
   * rather than reasoned about.) The rule is worth keeping anyway, because the
   * ratchet above distinguishes `NOCASE` from `nocase` BY CASE and a third
   * spelling would be counted as neither — but it is a counting rule, not a
   * correctness one, and stating it as correctness sends the next person
   * hunting for a bug that is not there.
   */
  { name: 'COLLATE NOCASE',  pattern: /COLLATE\s+NOCASE/g,                  runtime: 0, boot: 5,
    postgres: 'the shared `nocase` ICU collation — write it lower-case' },
  { name: 'sqlite_master',   pattern: /\bsqlite_master\b/gi,                runtime: 2, boot: 19,
    postgres: 'information_schema.tables / pg_indexes' },
  { name: 'INSERT OR …',     pattern: /INSERT\s+OR\s+(?:IGNORE|REPLACE)/gi, runtime: 0, boot: 2,
    postgres: 'ON CONFLICT (cols) DO NOTHING / DO UPDATE — needs the constraint named' },
  { name: 'datetime()',      pattern: /\bdatetime\s*\(/gi,                  runtime: 0, boot: 3,
    postgres: "now(), or now() - interval '1 hour' — and a timezone decision" },
  { name: 'strftime()',      pattern: /\bstrftime\s*\(/gi,                  runtime: 0, boot: 1,
    postgres: 'to_char() / date_trunc()' },
  { name: 'julianday()',     pattern: /\bjulianday\s*\(/gi,                 runtime: 0, boot: 0,
    postgres: 'timestamp subtraction yielding an interval' },
  { name: 'AUTOINCREMENT',   pattern: /\bAUTOINCREMENT\b/gi,                runtime: 0, boot: 1,
    postgres: 'GENERATED … AS IDENTITY, or bigserial' },
  /**
   * Both of the following were added AFTER they had already shipped as bugs,
   * which is the honest reason they are here.
   *
   * This list is a ratchet over constructs somebody thought of, not a way of
   * discovering new ones — so it reported the runtime column clean while the
   * browse endpoint answered 500 on PostgreSQL for every text search and every
   * distance sort. What found them was running the application suite against a
   * real PostgreSQL; what keeps them from coming back is counting them here.
   */
  { name: 'instr()',         pattern: /\binstr\s*\(/gi,                     runtime: 0, boot: 0,
    postgres: 'strpos(haystack, needle) — same argument order, same 1-based-or-0 result' },
  { name: 'scalar min/max',  count: scalarMinMax,                           runtime: 0, boot: 0,
    postgres: 'LEAST(…) / GREATEST(…) — PostgreSQL reads the 2-arg form as its aggregate and refuses' },
  /**
   * `AS userId` without quotes.
   *
   * PostgreSQL folds an unquoted identifier to lower case, so the column comes
   * back as `userid` and `row.userId` is `undefined`. SQLite preserves the case
   * either way, so this is invisible on the authoritative engine.
   *
   * The reason it is worth a ratchet rather than a one-time fix: it does not
   * throw. 36 of these were live across nine files, and every one of them would
   * have rendered a blank member count or an `undefined` hours figure instead of
   * failing. Quoting the alias is portable — SQLite keeps the case with or
   * without quotes — so the rule is simply "quote any alias that is not already
   * all-lower-case".
   */
  { name: 'unquoted camelCase alias', pattern: /\bAS\s+[a-z_]\w*[A-Z]\w*/g,  runtime: 0, boot: 0,
    postgres: 'AS "userId" — quote it, or PostgreSQL returns `userid` and the property read yields undefined' },
];

/* Rebuilt per call because `String.match` with a /g/ regex is stateful, and
   `flags` is carried over rather than hard-coded: the COLLATE pattern is
   deliberately case-SENSITIVE, and forcing `gi` here silently un-did that. */
const freshly = (pattern) => new RegExp(pattern.source, pattern.flags);

const tally = (predicate, pattern) => FILES
  .filter(f => predicate(f.rel))
  .reduce((n, f) => n + f.sql.reduce((m, lit) => m + (lit.match(pattern)?.length ?? 0), 0), 0);

/* A construct is counted either by a pattern or, when the shape needs balanced
   parentheses to recognise at all, by its own function. */
const tallyOf = (predicate, c) => (c.count
  ? FILES.filter(f => predicate(f.rel))
    .reduce((n, f) => n + f.sql.reduce((m, lit) => m + c.count(lit), 0), 0)
  : tally(predicate, freshly(c.pattern)));

describe('SQLite-only SQL still in the codebase', () => {
  it('finds SQL to count at all, so the ratchet is not vacuous', () => {
    const literals = FILES.reduce((n, f) => n + f.sql.length, 0);
    expect(literals, 'no SQL literals found — the scanner is broken, not the codebase clean')
      .toBeGreaterThan(400);
  });

  for (const c of CONSTRUCTS) {
    it(`${c.name} — at most ${c.runtime} runtime, ${c.boot} boot (PostgreSQL: ${c.postgres})`, () => {
      const runtime = tallyOf(rel => !isBoot(rel), c);
      const boot = tallyOf(isBoot, c);

      expect(
        runtime,
        `${c.name} grew in runtime code: ${runtime} sites, was ${c.runtime}. `
        + `PostgreSQL needs ${c.postgres}. Write the portable form, or raise this number `
        + 'deliberately and say why in POSTGRES_MIGRATION_STATUS.md.',
      ).toBeLessThanOrEqual(c.runtime);

      expect(
        boot,
        `${c.name} grew in the boot/schema path: ${boot} sites, was ${c.boot}.`,
      ).toBeLessThanOrEqual(c.boot);
    });
  }

  /**
   * The headline number, so the ratchet is visible as one figure rather than
   * eight. It is the thing to quote when asking "how far is PostgreSQL".
   */
  /**
   * Only one spelling of the shared collation, and it is the portable one.
   *
   * The ratchet above distinguishes `NOCASE` from `nocase` by case, so a third
   * spelling would be counted as neither and pass silently while failing under
   * PostgreSQL.
   */
  it('spells the shared collation exactly one way', () => {
    const wrong = [];
    for (const { rel, sql } of FILES) {
      if (isBoot(rel)) continue;
      for (const lit of sql) {
        for (const m of lit.matchAll(/COLLATE\s+(\w+)/g)) {
          if (m[1] !== 'nocase') wrong.push(`${rel} — COLLATE ${m[1]}`);
        }
      }
    }
    expect(wrong, 'the shared collation is `nocase`, lower-case: SQLite resolves collation '
      + 'names case-insensitively, PostgreSQL does not').toEqual([]);
  });

  /**
   * An alias that is quoted where it is defined must be quoted where it is used.
   *
   * Quoting only the definition is worse than quoting neither. `AS "startsAt"`
   * creates a column whose name really is mixed-case, and the `ORDER BY
   * startsAt` two lines below then folds to `startsat`, matches nothing, and
   * PostgreSQL answers `column "startsat" does not exist` — a 500 where before
   * there was merely a wrong value. Three of these were introduced by the commit
   * that quoted the definitions, and they are exactly what this catches.
   *
   * Scoped to one literal at a time: an alias is only in scope within its own
   * statement, and matching across a file would flag the JS property of the same
   * name that legitimately reads the result.
   */
  it('quotes an alias everywhere it is used, not only where it is defined', () => {
    const wrong = [];
    for (const { rel, sql } of FILES) {
      for (const lit of sql) {
        for (const m of lit.matchAll(/\bAS\s+"([a-z_]\w*[A-Z]\w*)"/g)) {
          const bare = new RegExp(`(?<!")\\b${m[1]}\\b(?!")`, 'g');
          /* The definition itself is `AS "name"`, already excluded by the
             look-arounds, so anything left is an unquoted use. */
          if (bare.test(lit)) wrong.push(`${rel} — ${m[1]}`);
        }
      }
    }
    expect(
      [...new Set(wrong)],
      'PostgreSQL folds the unquoted use to lower case and it stops matching the '
      + 'quoted alias, which is a 500 rather than a wrong value.',
    ).toEqual([]);
  });

  /**
   * `RUNNING_ON_POSTGRES` may only silence the SQLite migration mechanism.
   *
   * It is the one switch in the suite that makes a test not run on PostgreSQL,
   * which makes it the obvious place to put a failure somebody does not want to
   * fix. The bar is written in `testEngine.js`: the test's SUBJECT must not
   * exist on PostgreSQL, and today the only such subject is the migration
   * machinery — `initDatabase()` returns before running a single migration
   * there, applying the generated schema whole instead.
   *
   * So the files allowed to use it are the migration files, and this pins the
   * list. Fifteen of the nineteen migration suites need no exemption at all and
   * pass on PostgreSQL unchanged, which is the evidence that the exemption is
   * narrow rather than a blanket.
   *
   * Adding a file here is a claim that its subject does not exist on
   * PostgreSQL. If the honest reason is "it fails and I do not know why", that
   * is a failure, not an exemption.
   */
  it('confines the engine skip to the SQLite migration mechanism', () => {
    /* `FILES` deliberately excludes test files — it measures shipped SQL — so
       the test tree is read directly here. This file names the flag in order to
       police it and would otherwise appear in its own list. */
    const users = readdirSync(SERVER)
      .filter(n => n.includes('.test.') && n !== 'sqliteDialect.test.js')
      .filter(n => readFileSync(path.join(SERVER, n), 'utf8').includes('RUNNING_ON_POSTGRES'))
      .sort();
    expect(
      users,
      'RUNNING_ON_POSTGRES is for tests whose subject does not exist on PostgreSQL — '
      + 'today only the SQLite migration machinery. See server/testEngine.js.',
    ).toEqual([
      'migrations.authzRoles.test.js',
      'migrations.errorEvents.test.js',
      'migrations.graduationYear.test.js',
      'migrations.reauth.test.js',
      /* The email-dedupe pass is the same thing wearing a different name: it
         runs inside `initDatabase()`, after the PostgreSQL early return. Only
         its migration describe is exempt; the API describe beside it runs on
         both engines. */
      'routes.emailUniqueness.test.js',
    ]);
  });

  it('holds the total at 119 — 6 runtime, 113 boot', () => {
    const runtime = CONSTRUCTS.reduce((n, c) => n + tallyOf(rel => !isBoot(rel), c), 0);
    const boot = CONSTRUCTS.reduce((n, c) => n + tallyOf(isBoot, c), 0);

    expect(runtime, 'runtime SQLite-only SQL grew').toBeLessThanOrEqual(6);
    expect(boot, 'boot-path SQLite-only SQL grew').toBeLessThanOrEqual(113);
  });
});

/**
 * The engine gate must stay shut, and the reason it is shut must stay true.
 *
 * `POSTGRES_READY = false` is the one line that keeps a half-ported application
 * away from a real database. The risk is not that somebody flips it maliciously
 * — it is that the counters above reach zero, somebody reads the gate's comment
 * (which used to say the blocker was the synchronous call sites), sees that
 * those are done, and flips it. The call sites ARE done. The application still
 * cannot boot against PostgreSQL, for reasons that live somewhere else
 * entirely, and this pins them so the next person meets them here.
 */
describe('the PostgreSQL engine gate', () => {
  const dbSrc = readFileSync(path.join(SERVER, 'db.js'), 'utf8');
  const engineSrc = readFileSync(path.join(SERVER, 'db', 'engine.js'), 'utf8');

  it('is shut', async () => {
    const { POSTGRES_READY } = await import('./db/engine.js');
    expect(
      POSTGRES_READY,
      'opening this gate requires an engine-selecting db.js, a PostgreSQL schema path, '
      + 'and the 194 constructs above translated. See POSTGRES_MIGRATION_STATUS.md.',
    ).toBe(false);
  });

  /**
   * The first blocker, now closed, and pinned so it cannot silently reopen.
   *
   * `resolveEngine()` had no caller for the whole of phases 7 and 8 — it was
   * imported by its own test and nothing else, while `db.js` constructed a
   * `DatabaseSync` unconditionally. `DATABASE_ENGINE=postgres` therefore could
   * not have produced a PostgreSQL connection even with the gate open; it would
   * have produced a SQLite one, and a deployment that believed it had migrated.
   *
   * What this now asserts is the wiring, and the shape of it: one decision, at
   * module scope, feeding a factory that both engines go through. A later change
   * that quietly restores an unconditional `new DatabaseSync(dbPath)` at module
   * scope brings the original defect back, and fails here.
   */
  it('is wired: db.js selects its engine rather than assuming one', () => {
    expect(dbSrc, 'db.js must consult resolveEngine() — otherwise the engine flag decides nothing')
      .toMatch(/resolveEngine\(\)/);
    expect(dbSrc, 'both engines must be built through one factory').toMatch(/export function openConnection\(/);
    expect(
      /const connection = new DatabaseSync\(/.test(dbSrc),
      'db.js constructs SQLite directly again, bypassing the engine selection',
    ).toBe(false);
  });

  /**
   * The PostgreSQL boot path exists, and cannot silently create nothing.
   *
   * `initDatabase()` has to stay synchronous, so on PostgreSQL it defers the
   * schema instead of building it. A deferral that nobody completes is a server
   * running against an empty database, so the deferral is tracked and
   * `assertSchemaReady()` turns it into a named error.
   */
  it('cannot boot PostgreSQL without creating a schema', () => {
    expect(dbSrc, 'initDatabase must remain synchronous').toMatch(/export function initDatabase\(/);
    expect(dbSrc, 'the PostgreSQL schema must be applied by completeDatabaseInit')
      .toMatch(/applyPostgresSchema\(db\)/);
    expect(dbSrc, 'a deferred schema that is never applied must be an error, not a quiet empty database')
      .toMatch(/export function assertSchemaReady\(/);
  });

  /**
   * The second blocker. `initDatabase()` is synchronous and must stay that way
   * — some forty callers do not await it, and `asyncShapes.test.js` fails the
   * build if it changes. Every `CREATE TABLE`, every migration and the badge
   * catalogue run inside it. Under PostgreSQL each of those statements returns
   * a promise nobody can await, so the schema path cannot execute at all.
   *
   * This is why "every query site awaits" is not the same as "ready".
   */
  it('cannot create a schema: the whole DDL path is inside synchronous boot', () => {
    expect(dbSrc, 'initDatabase is no longer synchronous — see the guard in asyncShapes.test.js')
      .toMatch(/export function initDatabase\(/);
    const body = dbSrc.slice(dbSrc.indexOf('export function initDatabase('));
    expect(body, 'the migration runner still runs inside synchronous boot').toMatch(/runMigrations\(/);
  });

  it('says all of this where the next person will read it', () => {
    for (const phrase of ['POSTGRES_MIGRATION_STATUS.md', 'DATABASE_URL']) {
      expect(engineSrc, `engine.js should point at ${phrase}`).toContain(phrase);
    }
  });
});
