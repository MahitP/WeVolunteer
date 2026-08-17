/**
 * The four ways an `await` gets written wrongly during this port.
 *
 * ── Why a guard and not just care ──
 *
 * Phase 8 converts hundreds of call sites, and inserting `await` in front of a
 * call is only correct when nothing is done to the result on the same
 * expression. Each of the shapes below was written during waves 1–3, and every
 * one of them was found by a *failing test elsewhere* rather than by reading the
 * diff — which means the next one might not be found at all, because not every
 * call site has a test that would notice.
 *
 * They are all silent-ish: none is a syntax error, and three of the four still
 * behave correctly on SQLite, where the value was never a promise.
 *
 * The scan is deliberately restricted to functions this codebase actually
 * declares `async`, so it cannot fire on `await fetch(url).then(…)` or any other
 * legitimately-thenable third-party call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { unportedChains } from './testing/fixtureDebt.js';

const SERVER = path.resolve(import.meta.dirname);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'scratch') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Comments and string literals go, newlines stay.
 *
 * Line numbers must survive, or every offender is reported at the wrong place —
 * the first run of this guard blamed `auditLog.test.js:194` for something on
 * line 236. And string literals must go, or a guard that *scans source text*
 * for `await canRunEvent(` is reported as containing the very thing it looks
 * for; `canRunEvent.guard.test.js` does exactly that.
 */
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
  .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
  .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
  .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));

const FILES = sourceFiles(SERVER).map(f => ({
  rel: path.relative(SERVER, f),
  src: strip(readFileSync(f, 'utf8')),
}));

/**
 * The line a match starts on.
 *
 * The property scans below run against the WHOLE file rather than line by
 * line, so they need this. That is not a stylistic choice: the line-oriented
 * version of this guard missed **50 real bugs**, every one of them of the form
 *
 *     const total = (await db.prepare(`
 *       SELECT COUNT(*) AS c …
 *     `).get(eventId)).c;
 *
 * where the `await` and the `.c` are three lines apart. `strip()` blanks
 * template-literal contents while preserving newlines, so by the time a scan
 * sees this the SQL is whitespace and the expression matches cleanly across
 * lines.
 */
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Every function this codebase declares async — the only names worth scanning. */
const asyncNames = (() => {
  const names = new Set();
  for (const { rel, src } of FILES) {
    if (rel.includes('.test.')) continue;
    for (const m of src.matchAll(/(?:export\s+)?async\s+function\s+(\w+)/g)) names.add(m[1]);
  }
  return names;
})();

const NAMES = () => [...asyncNames].join('|');

/**
 * The subset of async names that no file also declares synchronously.
 *
 * The scans above all match a *shape* around the name — `!f(x)`, `...f(x)`,
 * `(await f(x)).p` — so a collision costs nothing: nobody writes `!makeUser(…)`.
 * The last scan matches a plain assignment, which every test helper in the
 * codebase looks like, so a collision there is 249 false positives from names
 * such as `makeUser`, `run`, `login` and `openDb` — each an async export in one
 * module and a synchronous local helper in another.
 *
 * Dropping the ambiguous names is the cheap answer, and it is a genuine hole:
 * an unawaited `commitGrant(…)` assignment would not be flagged, because some
 * test file declares its own sync `commitGrant`. Guard 8 and the shape scans
 * above still cover the security-critical names, and the alternative — resolving
 * each identifier to its import — is a type checker, not a regex.
 */
const unambiguousAsyncNames = (() => {
  const sync = new Set();
  for (const { src } of FILES) {
    for (const m of src.matchAll(/(?<!async\s)\bfunction\s+(\w+)\s*\(/g)) sync.add(m[1]);
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?!async\b)\(?[\w,\s]*\)?\s*=>/g)) sync.add(m[1]);
  }
  return [...asyncNames].filter(n => !sync.has(n));
})();

/**
 * Every source file parses.
 *
 * This exists because a syntax error does NOT show up as a failure. Vitest
 * cannot load a file whose imports fail to parse, so it reports every test in
 * it as *skipped* — the suite gets quieter and the failure count improves.
 * Twice in this migration a stray backtick inside a SQL template literal (the
 * comment above the SQL closed the string) took a whole file out of the run
 * that way, and both times the numbers looked better for it.
 *
 * A parse error should be loud. This makes it a failure with a filename.
 */
describe('the source parses', () => {
  it('has no file that vitest would silently skip', async () => {
    const { parseAst } = await import('vite');
    const broken = [];
    for (const f of sourceFiles(SERVER)) {
      try { parseAst(readFileSync(f, 'utf8')); }
      catch (err) {
        broken.push(`${path.relative(SERVER, f)}: ${String(err.message).split('\n')[1] ?? err.message}`);
      }
    }
    expect(
      broken,
      'a file that does not parse is reported as SKIPPED, not failed — the suite '
      + 'goes quiet instead of red.',
    ).toEqual([]);
  });
});

describe('await is written where the value is, not where the call is', () => {
  it('knows which functions are async, so every scan below has something to find', () => {
    expect(asyncNames.size, 'no async declarations found — these guards would all pass vacuously')
      .toBeGreaterThan(50);
    for (const anchor of ['recordAudit', 'canRunEvent', 'withheldCapabilitiesFor']) {
      expect(asyncNames.has(anchor), `${anchor} should be async by now`).toBe(true);
    }
  });

  /**
   * `(await f(x)).ok` is `await (f(x).ok)` — the property is read off the promise,
   * yields `undefined`, and `await undefined` is `undefined`. Every guard
   * written as `expect((await verifyLedgerParity(db)).ok).toBe(true)` silently
   * asserted `undefined === true` and failed only because it happened to be a
   * `toBe(true)`. A `toBeFalsy()` would have passed.
   */
  it('never reads a property off an unresolved call', () => {
    /* `.then`, `.catch` and `.finally` belong to the promise and are correct
       here — `await p.catch(h)` is a deliberate idiom, not a mistake. */
    const re = new RegExp(
      `await\\s+(?:\\w+\\.)?(${NAMES()})\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\??\\.\\s*(?!then\\b|catch\\b|finally\\b)[a-zA-Z_]`,
      'gs',
    );
    const bad = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(re)) {
        bad.push(`${rel}:${lineOf(src, m.index)} — ${m[0].replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(bad, 'Write `(await f(x)).prop`: `(await f(x)).prop` awaits the PROPERTY, not the call.')
      .toEqual([]);
  });

  /**
   * The same mistake on a raw statement chain:
   * `await db.prepare(sql).get(id).count` reads `.count` off the PROMISE, gets
   * `undefined`, and `await undefined` is `undefined`.
   *
   * ── Why this is balanced rather than matched ──
   *
   * This was a regex, and the regex allowed exactly ONE level of parentheses
   * inside the argument list: `(?:[^()]|\([^()]*\))*`. That is enough for
   * `.get(id)` and for `.get(fp, new Date(x).toISOString())`, and NOT enough for
   *
   *     .get(fp, new Date(Date.now() - 3600_000).toISOString()).c
   *
   * where `Date.now()` sits inside `Date(…)`. One real defect lived behind that
   * gap in `errorReporter.js`: `recentEvents` was `undefined`, `undefined < 100`
   * is false, and so **no error event was ever persisted on PostgreSQL** — the
   * per-hour cap read as permanently exceeded. SQLite returned a plain object
   * and was correct, which is why nothing noticed.
   *
   * Argument lists nest arbitrarily, so the depth has to be counted rather than
   * enumerated. Guard 15 below already does this for `prepare()`; this is the
   * same technique applied to the execution call.
   */
  it('never reads a property off an unresolved prepare() chain', () => {
    const START = /await\s+\w+(?:\.\w+)*\.prepare\s*\(/g;
    /** From the index of an open paren, the index just past its match. */
    const closeOf = (src, open) => {
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') { depth -= 1; if (depth === 0) return i + 1; }
      }
      return -1;
    };

    const bad = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(START)) {
        const afterPrepare = closeOf(src, m.index + m[0].length - 1);
        if (afterPrepare < 0) continue;
        const exec = /^\s*\.\s*(?:get|all|run|iterate)\s*\(/.exec(src.slice(afterPrepare));
        if (!exec) continue;
        const execOpen = afterPrepare + exec[0].length - 1;
        const afterExec = closeOf(src, execOpen);
        if (afterExec < 0) continue;
        /* A property read straight off the awaited chain — but `.then`,
           `.catch` and `.finally` belong to the promise and are deliberate. */
        if (/^\s*\??\.\s*(?!then\b|catch\b|finally\b)[a-zA-Z_]/.test(src.slice(afterExec))) {
          bad.push(`${rel}:${lineOf(src, m.index)} — ${src.slice(m.index, afterExec + 12).replace(/\s+/g, ' ').trim().slice(0, 90)}`);
        }
      }
    }
    expect(bad, 'Write `(await db.prepare(sql).get(id)).prop` — the property is on the ROW.')
      .toEqual([]);
  });

  /**
   * `await expect(f()).rejects` — the inner await throws before `expect`
   * ever sees the promise, so the rejection escapes the assertion and fails the
   * test with the raw error instead of the intended message.
   */
  it('never awaits inside an expect() that is testing the promise', () => {
    /* Whole-file, not per line: a bulk pass produced this across a line break
       in `auditLog.test.js`, where `await expect(` ended one line and `await
       await recordAudit(` began the next. The per-line version could not see it. */
    const re = /await\s+expect\(\s*await\s/gs;
    const bad = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(re)) {
        bad.push(`${rel}:${lineOf(src, m.index)} — ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad, 'Write `await expect(f()).rejects…`: awaiting inside expect() throws first.')
      .toEqual([]);
  });

  /**
   * `Array.filter`/`some`/`every` never await, so an async predicate is read as
   * a truthy promise and the answer is ignored for every element. This is the
   * fail-open shape that would have let `messageRoutes` return strangers as
   * friends. `map` is excluded — `Promise.all(rows.map(async …))` is the correct
   * idiom and is common here.
   */
  it('never gives filter/some/every an async predicate', () => {
    const re = new RegExp(`\\.\\s*(filter|some|every)\\s*\\(\\s*(?:async\\s*)?\\(?\\s*\\w+\\s*\\)?\\s*=>[^\\n]*?\\b(${NAMES()})\\s*\\(`, 'g');
    const bad = [];
    for (const { rel, src } of FILES) {
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(re)) bad.push(`${rel}:${i + 1} — ${m[0].trim()}`);
      });
    }
    expect(bad, 'filter/some/every do not await. Use a for-loop, or Promise.all + map.')
      .toEqual([]);
  });

  /**
   * `...f(x)` where `f` is async spreads a PROMISE, and a promise has no own
   * enumerable properties — so the spread contributes **nothing** and the
   * surrounding object is silently missing every field it was supposed to get.
   *
   * `selfUserResponse` did this with `formatUserResponse`, so the signed-in
   * user object lost its `id`; the next query bound `undefined` and 940 tests
   * failed with "Provided value cannot be bound to SQLite parameter". Nothing
   * about the expression looks wrong, which is why it is scanned for.
   */
  it('never spreads an unresolved call', () => {
    const re = new RegExp(`\\.\\.\\.\\s*(?!await\\b)(?:\\w+\\.)?(${NAMES()})\\s*\\(`, 'g');
    const bad = [];
    for (const { rel, src } of FILES) {
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(re)) bad.push(`${rel}:${i + 1} — ${m[0].trim()}`);
      });
    }
    expect(bad, 'Write `...(await f(x))`: spreading a promise contributes no properties.')
      .toEqual([]);
  });

  /**
   * `!f(x)` where `f` is async negates a PROMISE, which is always truthy — so
   * `!f(x)` is always `false` and the branch never runs. When that branch is a
   * refusal, the refusal silently stops happening.
   *
   * `reportService.js` had exactly this: `if (!canReporterSee(...)) return 404`
   * became unreachable, so a reporter could file against a target they cannot
   * see and learn from the 200 that it exists — an enumeration oracle the test
   * suite calls "answers identically for a real-but-invisible target".
   *
   * Guard 8 in `authz.completeness.test.js` polices the *exported* authorization
   * predicates by name. This catches the same shape for module-private helpers,
   * which is where that one hid.
   */
  it('never negates an unresolved call', () => {
    const re = new RegExp(`(?<![!=<>])!\\s*(?!await\\b)(?:\\w+\\.)?(${NAMES()})\\s*\\(`, 'g');
    const bad = [];
    for (const { rel, src } of FILES) {
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(re)) bad.push(`${rel}:${i + 1} — ${m[0].trim()}`);
      });
    }
    expect(bad, '`!f(x)` on a promise is always false — the branch never runs. Write `!await f(x)`.')
      .toEqual([]);
  });

  /**
   * `const x = f(…)` where `f` is async and `x` is never awaited.
   *
   * The scans above all catch the promise being *used* wrongly at the point of
   * the call. This catches it being parked in a variable first, which is the
   * same defect one line later and reads as completely ordinary code.
   *
   * It cost every second-factor sign-in in the suite. `verifyTotpOnce` became
   * async and its one caller kept:
   *
   *     const totpResult = verifyTotpOnce(db, userRow, tokenValue);
   *     if (totpResult === 'unavailable') return res.status(503)…
   *     isValid = totpResult === true;
   *
   * A promise equals neither, so `isValid` stayed `false` for a *correct* code
   * and the flow answered `401 Invalid code.` — the exact "right code fails"
   * confusion the comment directly above it was written to prevent. Three authz
   * suites failed at login and not one of them named the cause.
   *
   * Writing this guard found five more of the same shape, all silent:
   * `alerting.js` compared a promise to a timestamp so alert throttling never
   * engaged; `app.js` health-checked `!writable` on a promise so a read-only
   * database reported healthy; `autoSelectScheduler.js` read `.length` off one
   * so the sweep threw instead of running; and two tests asserted against
   * `[object Promise]`, passing for the wrong reason.
   *
   * A variable is considered handled if the rest of the file awaits it, chains
   * `.then`/`.catch` off it, returns it, or hands it to `Promise.all` — the
   * scheduler's deliberate fire-and-forget `startupSweep` is the reason the
   * `.catch` arm is there.
   */
  it('never parks an unresolved call in a variable', () => {
    const re = new RegExp(
      `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?!await\\b)(?<!\\.)\\b(?:${unambiguousAsyncNames.join('|')})\\s*\\(`,
      'g');
    const bad = [];
    for (const { rel, src } of FILES) {
      /* This file quotes the defect verbatim in the comment above, and strip()
         only blanks template literals. */
      if (rel === 'asyncShapes.test.js') continue;
      for (const m of src.matchAll(re)) {
        const name = m[1];
        const rest = src.slice(m.index + m[0].length);
        /* `.catch()` chained onto the call itself, before the value is ever
           named — the scheduler's deliberate fire-and-forget startup sweep. */
        if (/^[^\n]*\.\s*(?:then|catch)\s*\(/.test(rest)) continue;
        const used = new RegExp(
          `await\\s+${name}\\b|\\b${name}\\s*\\.\\s*(?:then|catch|finally)\\b`
          + `|(?:return|Promise\\.(?:all|allSettled|race|any))\\b[^\\n]*\\b${name}\\b`,
        ).test(rest);
        if (used) continue;
        bad.push(`${rel}:${lineOf(src, m.index)} — ${m[0].replace(/\s+/g, ' ').trim()}…)`);
      }
    }
    expect(
      bad,
      'this variable holds a promise, not a value. Everything downstream of it — a '
      + 'comparison, a `.length`, a negation — is reading the wrapper. Write `await`.',
    ).toEqual([]);
  });

  /**
   * `const { a } = f(…)` — destructuring an unresolved call.
   *
   * The scan below catches `const x = f(…)`, and this is the same defect wearing
   * a different hat: destructuring a promise binds every name to `undefined`,
   * because a promise has none of those properties. No error, no rejection, just
   * `undefined` flowing onward.
   *
   * `impact.test.js` did this thirteen times — `const { community } =
   * buildImpact(db)` — and every assertion downstream read a property of
   * `undefined`, so the failure surfaced as a TypeError in the test body rather
   * than anywhere near the missing `await`.
   */
  it('never destructures an unresolved call', () => {
    const re = new RegExp(
      `(?:const|let|var)\\s*[{\\[][^}\\]]*[}\\]]\\s*=\\s*(?!await\\b)(?<!\\.)\\b(?:${unambiguousAsyncNames.join('|')})\\s*\\(`,
      'g');
    const bad = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(re)) {
        bad.push(`${rel}:${lineOf(src, m.index)} — ${m[0].replace(/\s+/g, ' ').trim()}…)`);
      }
    }
    expect(
      bad,
      'destructuring a promise binds every name to undefined — a promise has no '
      + 'such properties. Write `const { a } = await f(…)`.',
    ).toEqual([]);
  });

  /**
   * A bare call at statement position, whose result nobody looks at.
   *
   * This is the shape with no downstream symptom at all: the value is discarded,
   * so nothing reads `undefined` and nothing throws. What actually happens
   * depends on what the function does — and in this codebase two of them own a
   * transaction, so an unawaited call leaves a `BEGIN` open on a second
   * connection. `routes.organizationAppeals.test.js` abandoned three that way
   * and the next ordinary write failed with `database is locked`, in a different
   * file, with nothing pointing at the cause.
   *
   * Guard 11 above catches the `f(tx, …)` form. This is the rest: any
   * unambiguous async name called for effect and not awaited.
   *
   * Fire-and-forget is still expressible, and two places use it deliberately —
   * `utils.js` sends its alerts without waiting, and `autoSelectScheduler`
   * starts its catch-up sweep. Both chain `.then`/`.catch`, which is what marks
   * the intent, and what this checks for.
   */
  it('never calls an async function for effect without awaiting it', () => {
    const re = new RegExp(
      `^[^\\S\\n]*(?!await\\b|return\\b|void\\b|yield\\b)((?:\\w+\\.)?(?:${unambiguousAsyncNames.join('|')})\\s*\\()`,
      'gm');
    const bad = [];
    for (const { rel, src } of FILES) {
      if (rel === 'asyncShapes.test.js') continue;
      for (const m of src.matchAll(re)) {
        /* `.then`/`.catch` chained onto the call marks deliberate
           fire-and-forget. Checked across the whole statement, not one line:
           the alert calls in utils.js put the chain three lines down. */
        const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 600);
        const end = rest.indexOf(';');
        if (/\.\s*(?:then|catch)\s*\(/.test(end === -1 ? rest : rest.slice(0, end))) continue;
        /* Not a statement after all: an arrow body (`() =>` on the line above)
           or an argument (`expect(` / `Promise.all(`) returns the promise to
           somebody who does await it. Both begin a line the same way, so what
           distinguishes them is what precedes. */
        const before = src.slice(Math.max(0, m.index - 120), m.index).trimEnd();
        if (/(?:=>|\(|,|\[|&&|\|\||\?|:)$/.test(before)) continue;
        bad.push(`${rel}:${lineOf(src, m.index)} — ${m[1].trim()}…)`);
      }
    }
    expect(
      bad,
      'this call is started and abandoned. If it owns a transaction, the BEGIN '
      + 'outlives it. Write `await`, or chain `.catch()` to say it is deliberate.',
    ).toEqual([]);
  });

  /**
   * A statement hoisted out of a loop must still have its executions awaited.
   *
   * `db.prepare(sql)` is synchronous on both engines — it builds a statement
   * object, it does not talk to the server. Only `.get/.all/.run` are async
   * under PostgreSQL. So the loop idiom
   *
   *     const insert = db.prepare('INSERT …');
   *     for (const row of rows) insert.run(row.a, row.b);
   *
   * is correct under SQLite and loses every write under PostgreSQL: each `run`
   * returns an unawaited promise, the enclosing transaction commits, and the
   * rows resume against a connection that has been returned to the pool.
   *
   * Fifty-nine of these were live when this guard was written, in the paths that
   * can least afford a silent write loss — attendance check-in, certificate
   * issue, consent records, recovery-code generation, waitlist promotion, Auto
   * Select's accept and waitlist statements, and the notification and export
   * workers' status updates. Nothing failed under SQLite, so nothing in the
   * suite was red.
   *
   * `server/db.js`, `server/migrations/**` and `server/scripts/seed_badges.js`
   * are excluded, and that exclusion is a finding rather than an exemption:
   * they run inside the synchronous `initDatabase()`, cannot await anything,
   * and therefore cannot execute under PostgreSQL at all. The boot path is the
   * subject of its own wave; see POSTGRES_MIGRATION_STATUS.md. Test files that
   * hold a raw `DatabaseSync` are excluded for the opposite reason — those
   * handles really are synchronous.
   */
  it('awaits every execution of a hoisted prepared statement', () => {
    const decl = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?\w+\s*\.\s*prepare\s*\(/g;
    const bad = [];
    for (const { rel, src } of FILES) {
      if (rel === 'db.js' || rel.startsWith('migrations/') || rel === 'scripts/seed_badges.js') continue;
      if (/new DatabaseSync\(/.test(src)) continue;
      for (const m of src.matchAll(decl)) {
        const use = new RegExp(`(?<!await )\\b${m[1]}\\s*\\.\\s*(?:get|all|run|iterate)\\s*\\(`, 'g');
        for (const u of src.slice(m.index).matchAll(use)) {
          bad.push(`${rel}:${lineOf(src, m.index + u.index)} — ${u[0].trim()}…)`);
        }
      }
    }
    expect(
      bad,
      'the statement is prepared once and executed many times — each execution is '
      + 'the async part. Unawaited, the write is lost under PostgreSQL.',
    ).toEqual([]);
  });

  /**
   * A promise must not outlive the transaction it was started in.
   *
   * `f(tx, …)` with no `await` starts work against the transaction's own
   * connection and returns immediately. `runInTransaction` then commits and
   * closes that connection, and the abandoned promise resumes against a handle
   * that no longer exists. `node:sqlite` answers `statement has been finalized`,
   * as an **unhandled rejection** — the request has already returned 200 by
   * then, so the caller is told the write succeeded.
   *
   * `eventRoutes.js` did this at both of its tag-writing sites: every edit that
   * touched an event's tags reported success and saved nothing, and thirteen
   * tests failed with an error that named `eventTags.js` rather than either
   * caller.
   *
   * Statement position only — an unawaited call whose value is used is already
   * covered by the scans above, and this shape is specifically the one where
   * nobody is looking at the result at all. `return f(tx, …)` is fine: the
   * caller's `await` keeps the transaction open.
   */
  it('never lets an async call escape the transaction that owns its handle', () => {
    const re = new RegExp(`^[^\\S\\n]*(?!await\\b|return\\b)(?:\\w+\\.)?(?:${NAMES()})\\s*\\(\\s*tx\\b`, 'gm');
    const bad = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(re)) {
        /* `expect(f(tx, …)).rejects.toThrow(…)` is the correct way to assert
           that a call rejects, and the promise is deliberately unawaited there
           — `expect` is what awaits it. The call still begins a line, so the
           scan above sees it; this checks what precedes it. */
        if (/expect\(\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
        bad.push(`${rel}:${lineOf(src, m.index)} — ${m[0].trim()}…)`);
      }
    }
    expect(
      bad,
      'this promise resumes after the transaction has committed and closed its '
      + 'connection. The write is lost and the rejection is unhandled. Write `await`.',
    ).toEqual([]);
  });

  /**
   * `initDatabase()` must stay synchronous.
   *
   * It is called synchronously from `server.js`, `testServer.js`, four `bin/`
   * scripts and some forty test files. Nothing forces those to await it, so the
   * moment it becomes `async` every one of them returns before the schema
   * exists — and the failure surfaces far away, as "no such table" from
   * whatever runs next. That is exactly what happened: a batch conversion made
   * `backfillCertificates` async, which made `initCertificates` async, which
   * made `initDatabase` async, and **193 test files** failed to start.
   *
   * The rule this encodes: anything in boot that reads or writes ROWS belongs
   * in `completeDatabaseInit()`; `initDatabase` keeps only DDL and the
   * synchronous column backfills. Both halves of the ledger and certificate
   * setup are already split that way.
   */
  it('keeps initDatabase synchronous, because ~40 callers do not await it', () => {
    const dbSrc = FILES.find(f => f.rel === 'db.js');
    expect(dbSrc, 'db.js not found — this guard is checking nothing').toBeDefined();

    expect(dbSrc.src, 'initDatabase must be declared, or this guard is vacuous')
      .toMatch(/export\s+(?:async\s+)?function\s+initDatabase\b/);
    expect(
      dbSrc.src,
      'initDatabase became async. Move whatever forced that into completeDatabaseInit(): '
      + 'its ~40 callers are synchronous and will run before the schema exists.',
    ).not.toMatch(/export\s+async\s+function\s+initDatabase\b/);

    /* And the async half must still exist to move that work into. */
    expect(dbSrc.src, 'completeDatabaseInit must remain the async half of boot')
      .toMatch(/export\s+async\s+function\s+completeDatabaseInit\b/);
  });

  /**
   * Vitest does not await a `describe` callback. An async one runs its setup
   * after the tests have already been collected — and, in the case that
   * prompted this, after they had run.
   */
  it('never declares an async describe callback', () => {
    const bad = [];
    for (const { rel, src } of FILES) {
      src.split('\n').forEach((line, i) => {
        if (/\bdescribe\s*(?:\.\w+)?\s*\([^)]*,\s*async\s*(\(|function)/.test(line)) {
          bad.push(`${rel}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(bad, 'vitest does not await describe(); move setup into beforeAll/beforeEach.')
      .toEqual([]);
  });
});

/**
 * `(await h.prepare(sql)).get(id)` — the await group closes too early.
 *
 * This is the inverse of guard 3, and it survives every check that catches
 * that one. The `await` IS present, so nothing looks missing; it is simply
 * wrapped around `prepare()` instead of around the execution. `prepare()` is
 * synchronous on both engines, so awaiting it is harmless and silent — and
 * `.get()` then returns a promise that nobody awaits.
 *
 * Four of these were live in application code, found only by running the
 * retention worker against PostgreSQL:
 *
 *   retentionWorker.js  the deleted-account purge — `.all(cutoff).map(…)` threw
 *                       `(intermediate value).all(...).map is not a function`,
 *                       so the purge could not run at all
 *   contentRoutes.js    an organizer's total credited hours, twice
 *   userRoutes.js       the same figure on the profile route
 *
 * On SQLite all four returned the right answer, because `.get()`/`.all()` hand
 * back the value directly. On PostgreSQL the two hours figures would have been
 * `undefined` — a volunteer's credited hours silently blank on their profile.
 *
 * The fix is to move one parenthesis: `(await h.prepare(sql).get(id))`.
 */
describe('the await group closes after the execution, not before it', () => {
  it('never awaits prepare() alone and then executes outside the await', () => {
    const START = /\(await\s+\w+(?:\.\w+)*\.prepare\s*\(/g;
    const bad = [];
    for (const { rel, src } of FILES) {
      if (rel === 'asyncShapes.test.js') continue;
      for (const m of src.matchAll(START)) {
        /* Balance prepare's own parentheses — the SQL may contain any number,
           and `strip()` has already blanked template bodies so nested quotes
           cannot confuse the count. */
        let i = m.index + m[0].length - 1;
        let depth = 0;
        while (i < src.length) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') {
            depth -= 1;
            if (depth === 0) { i += 1; break; }
          }
          i += 1;
        }
        if (/^\s*\)\s*\.\s*(?:get|all|run|iterate)\s*\(/.test(src.slice(i))) {
          bad.push(`${rel}:${lineOf(src, m.index)}`);
        }
      }
    }
    expect(
      bad,
      'the await closes before the execution, so the row is a promise. '
      + 'Move the paren: `(await h.prepare(sql).get(id))`.',
    ).toEqual([]);
  });
});

/**
 * The remaining fixture debt, counted and held.
 *
 * ── Why this one is a ceiling and not zero ──
 *
 * Every guard above asserts zero, because every shape above is always wrong.
 * This one is different: a test file that holds the connection proxy and calls
 * `db.prepare(…).get(…)` without awaiting is correct under SQLite — the value
 * arrives synchronously — and broken under PostgreSQL, where it yields a
 * promise. Both engines are in use, so the shape is not yet a defect
 * everywhere; it is unported work.
 *
 * There are 22 of them, and that is the honest size of what stands between the
 * PostgreSQL application suite and green. Asserting zero would break the build
 * for everybody until the whole port lands; asserting a ceiling makes the
 * number visible, stops it growing, and turns each batch of ported files into a
 * smaller number that has to be written down.
 *
 * ── How 1,084 became 63 ──
 *
 * 824 sat inside functions that were *already* `async`, so the fix was one
 * inserted keyword with no cascade: nothing became async that was not, and no
 * caller changed.
 *
 * The remaining ~250 were the cascade — a sync helper holding an unawaited
 * `.run()` is what produced the foreign-key storm, since the INSERT is a
 * promise nobody waits for and the id it should have returned is `undefined`.
 * Making the helper async forces its callers to await it, and that makes the
 * callers async in turn, so the async set was computed as a fixpoint over each
 * whole file before anything was written.
 *
 * Both passes were AST transformations, with offsets from a real parse and a
 * re-parse before each write. Three things they had to get right, each of which
 * the migration notes record a regex pass getting wrong:
 *   · `(await f()).prop` — awaiting the call, not the property read
 *   · `f().then/.catch/.finally` left alone — the chain handles the promise
 *     already, and `(await f()).catch` reads the method off the resolved value
 *   · whole-file atomicity — 14 files were refused outright rather than half
 *     converted, because a partly-awaited file is the state that produces a
 *     fail-open
 *
 * What is left is those 14 refused files: helpers passed as bare callbacks to
 * `map`/`filter`, and anonymous non-hook functions whose callers cannot be found
 * by name. They are hand work, and they are listed by running the porting script
 * in dry-run mode.
 *
 * ── What it costs when it is missed ──
 *
 * The three that were fixed to make `appeals.lifecycle` and `appealsRoutes`
 * pass on PostgreSQL were all of the form
 * `expect(db.prepare(sql).get(id).c).toBe(1)`. No guard caught them: guard 3
 * finds `await chain.prop` (the await is in the wrong place) and guard 12 finds
 * a hoisted statement whose executions are unawaited, but neither sees a chain
 * with no `await` anywhere. On SQLite it passes. On PostgreSQL it reads a
 * property off a promise and compares `undefined`.
 *
 * Files holding a raw `DatabaseSync` are excluded: those handles really are
 * synchronous, and awaiting them would be noise.
 */
describe('the unported fixture surface', () => {
  const PROXY_HANDLES = /(?<!await )\b(?:db|tx|conn|connection|dbHandle|database|handle|seeded|live)\s*\.\s*prepare\s*\(/g;

  /**
   * Detected on the STRIPPED source, not the raw file.
   *
   * The exclusion used to read the original text, on the reasoning that `strip()`
   * blanks things the check needs. It is the other way round: `strip()` blanks
   * comments and string BODIES, and a real handle is neither — it is code, so it
   * survives. Reading the raw file only adds the ability for PROSE to trip it.
   *
   * That is not hypothetical. Porting a file off its raw handle means writing a
   * comment saying so, and the moment that comment named the constructor the file
   * dropped out of this count entirely — silently, while its chains were still
   * unported. A measurement that a comment can switch off is worse than no
   * measurement, because the number keeps looking right.
   */
  const holdsRawHandle = (stripped) => /\bnew\s+DatabaseSync\s*\(/.test(stripped);

  /**
   * No test may open a raw handle on the APPLICATION's database file.
   *
   * `new DatabaseSync(process.env.WEV_DB_PATH)` is a second, private connection
   * to the file the application is using — but only when the application is on
   * SQLite. Under the PostgreSQL harness the application is on PostgreSQL and
   * that file is empty, so the test writes through the API and then reads an
   * empty database, reporting `no such table: users`.
   *
   * Eleven files did this, and the shape hid a whole class of work: because
   * files holding a raw handle are excluded from the ratchet above, none of
   * their unawaited chains were ever counted. The measurement tracking the port
   * had a blind spot exactly where the least-ported files were.
   *
   * 182 tests came back when they were moved onto the application's own handle —
   * covering evidence preservation, account deletion, identity change, OAuth,
   * organizer agreements, sessions and 2FA. None of that is engine-specific.
   *
   * A raw handle on a THROWAWAY database is still fine and is not matched here:
   * `:memory:` and per-test temp files are how the migration, schema and backup
   * tests legitimately drive SQLite directly.
   */
  /**
   * A camelCase alias must be quoted in TEST SQL too.
   *
   * `sqliteDialect.test.js` ratchets this for shipped code, but its scanner
   * deliberately skips test files — it measures the SQL the product runs. So
   * `SELECT user_id AS userId` survived in fixtures, and PostgreSQL folded it to
   * `userid`: `row.userId` was `undefined`, `isMember()` answered false for
   * everybody, and six authorization tests in `routes.organizationMembers`
   * failed looking exactly like a broken permission check.
   *
   * That is the expensive shape — not a crash, but a fixture quietly reporting
   * that an authorized member is not a member. Quoting is a no-op on SQLite,
   * which preserves the case either way.
   *
   * Files holding a raw handle are exempt: those really are SQLite, and one of
   * them pins this very behaviour as executable documentation.
   */
  it('quotes camelCase column aliases in test SQL', () => {
    /**
     * Read from the RAW file with only comments removed — not from `strip()`.
     *
     * `strip()` blanks string literals, and a test's SQL lives inside one, so
     * scanning the stripped source finds nothing at all. The first version of
     * this guard did exactly that and passed against a deliberate mutation,
     * which is the only reason the hole was noticed.
     */
    const commentsOnly = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));

    const bad = [];
    for (const { rel, src } of FILES) {
      if (!rel.includes('.test.') || holdsRawHandle(src)) continue;
      const raw = commentsOnly(readFileSync(path.join(SERVER, rel), 'utf8'));
      for (const m of raw.matchAll(/\bAS\s+([a-z_]\w*[A-Z]\w*)/g)) {
        bad.push(`${rel}:${lineOf(raw, m.index)} — AS ${m[1]}`);
      }
    }
    expect(
      bad,
      'PostgreSQL folds an unquoted identifier to lower case, so the property read '
      + 'yields undefined and the assertion fails for a reason that is not the one under test. '
      + 'Write AS "userId".',
    ).toEqual([]);
  });

  it('never opens a raw SQLite handle on the application database', () => {
    const offenders = [];
    for (const { rel, src } of FILES) {
      if (!rel.includes('.test.')) continue;
      if (/new\s+DatabaseSync\s*\(\s*process\.env\.WEV_DB_PATH/.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      'this opens a second connection to the SQLite file the application may not be using. '
      + "Take the application's handle instead: `const { db } = await import('./db.js')`, and do "
      + 'not close it — it is shared. A throwaway `:memory:` or temp-file handle is fine.',
    ).toEqual([]);
  });

  /** Lowered only by porting files, never raised to accommodate new ones. */
  const CEILING = 130;

  it(`has at most ${CEILING} unawaited prepare() chains in proxy-holding test files`, () => {
    const offenders = new Map();
    for (const { rel, src } of FILES) {
      if (!rel.includes('.test.')) continue;
      const hits = unportedChains(readFileSync(path.join(SERVER, rel), 'utf8')).length;
      if (hits) offenders.set(rel, hits);
    }

    const total = [...offenders.values()].reduce((a, b) => a + b, 0);
    const worst = [...offenders].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([f, n]) => `${f} (${n})`).join(', ');

    expect(
      total,
      `${total} unawaited prepare() chains across ${offenders.size} files — up from ${CEILING}. `
      + 'Each one is correct on SQLite and broken on PostgreSQL, so adding more deepens the '
      + `port rather than failing today. Worst: ${worst}.`,
    ).toBeLessThanOrEqual(CEILING);
  });

  /**
   * The ceiling must equal the count EXACTLY, or the ratchet stops working.
   *
   * It was first set ten above the real figure, "for slack". A mutation that
   * added one more unawaited chain then passed, which is precisely the thing
   * the ratchet exists to catch — slack is permission to add debt. Porting a
   * batch of files now requires lowering this number in the same commit, which
   * is the point.
   */
  it('pins the ceiling to the real count exactly', () => {
    const total = FILES
      .filter(f => f.rel.includes('.test.'))
      .reduce((n, f) => n + unportedChains(readFileSync(path.join(SERVER, f.rel), 'utf8')).length, 0);

    expect(
      CEILING,
      `the real count is ${total}. Set CEILING to exactly that — any slack is `
      + 'permission to add debt, and a mutation adding one chain passed while there was.',
    ).toBe(total);
  });
});
