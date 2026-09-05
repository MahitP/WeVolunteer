import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Nothing may issue concurrent database calls inside a transaction.
 *
 * ── The defect this prevents ──
 *
 * A transaction is ONE checked-out `pg` client, for its whole duration. That is
 * the single thing `db/postgresConnection.js` exists to get right, and its
 * header says so: `pool.query('BEGIN')` followed by `pool.query('INSERT …')` may
 * borrow two different clients, so the INSERT runs outside the transaction the
 * caller believes it opened. `beginTransaction()` therefore binds every
 * statement to one client, and `withConnection` binds that handle into the async
 * context so the `db` proxy resolves to it.
 *
 * `Promise.all` breaks that from the other direction. A single `pg` Client is
 * NOT safe for concurrent queries — it multiplexes one connection with one
 * protocol stream — so issuing several statements on it at once is not "faster",
 * it is undefined. And because `withConnection` binds the handle for the whole
 * async context, a `Promise.all` of `db.prepare(...)` calls inside a transaction
 * lands every one of them on that same client.
 *
 * ── Why this is a guard and not a note ──
 *
 * The rest of this performance pass deliberately parallelises and consolidates
 * reads to remove serial round trips, which makes `Promise.all` around
 * `db.prepare` a shape that now appears in the codebase on purpose. Every one of
 * those is outside a transaction, and the difference between the safe version
 * and the corrupting one is a single enclosing function call — exactly the kind
 * of distinction that survives review once and not twice.
 *
 * Parallelism OUTSIDE a transaction is fine and is not flagged: those statements
 * each borrow their own pooled client.
 */
const SERVER = path.resolve(import.meta.dirname);

/** The functions that open a transaction and bind its handle to the context. */
const TRANSACTION_OPENERS = ['runInTransaction', 'runTransaction', 'inTransaction', 'transactionOn'];

/** Concurrency combinators that would issue several statements at once. */
const CONCURRENT = /\bPromise\s*\.\s*(all|allSettled|race|any)\s*\(/g;

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'scratch') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * Comments and string literals blanked, newlines preserved.
 *
 * Identical in purpose to `asyncShapes.test.js`'s `strip`, and identical in
 * necessity: line numbers must survive or every finding is reported in the wrong
 * place, and literals must go or this file's own prose about `Promise.all`
 * inside a transaction is reported as a violation of itself.
 */
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
  .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
  .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
  .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * The source span of one `opener(...)` call, found by balancing parentheses.
 *
 * A regex cannot do this: the callback body contains its own parentheses,
 * braces and arrow functions. Balancing from the opening paren is exact for
 * source with literals already blanked, which is what `strip` guarantees.
 *
 * Returns `[start, end)` or null when the parentheses never balance — a file
 * that would not parse, which `asyncShapes.test.js` already fails on separately.
 */
function callSpan(src, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return [openParenIndex, i + 1];
    }
  }
  return null;
}

const FILES = sourceFiles(SERVER).map(f => ({
  rel: path.relative(SERVER, f),
  src: strip(readFileSync(f, 'utf8')),
}));

function violations() {
  const found = [];
  const openerPattern = new RegExp(`\\b(${TRANSACTION_OPENERS.join('|')})\\s*\\(`, 'g');

  for (const { rel, src } of FILES) {
    for (const opener of src.matchAll(openerPattern)) {
      const parenIndex = opener.index + opener[0].length - 1;
      const span = callSpan(src, parenIndex);
      if (!span) continue;
      const body = src.slice(span[0], span[1]);

      for (const hit of body.matchAll(CONCURRENT)) {
        found.push(
          `${rel}:${lineOf(src, span[0] + hit.index)} — Promise.${hit[1]} inside ${opener[1]}(...)`
        );
      }
    }
  }
  return found;
}

describe('transactions issue one statement at a time', () => {
  it('finds the transaction openers it is meant to be scanning', () => {
    /* A guard that matches nothing passes for the wrong reason. This asserts the
       scan has real call sites to look at, so a rename of `runInTransaction`
       fails here rather than quietly disabling the check. */
    const openerPattern = new RegExp(`\\b(${TRANSACTION_OPENERS.join('|')})\\s*\\(`, 'g');
    const total = FILES.reduce((n, f) => n + [...f.src.matchAll(openerPattern)].length, 0);
    expect(total, 'no transaction openers found — has one been renamed?').toBeGreaterThan(20);
  });

  it('has no Promise.all (or race/any/allSettled) inside a transaction', () => {
    const found = violations();
    expect(
      found,
      'A transaction is one checked-out pg client, and a single client cannot serve\n'
      + 'concurrent queries. Await these in sequence, or move the parallel reads\n'
      + 'outside the transaction where each borrows its own pooled client.\n\n'
      + found.join('\n')
    ).toEqual([]);
  });

  it('does not flag concurrency outside a transaction', () => {
    /* The complement of the rule, asserted so the guard cannot be "fixed" by
       widening it into a ban on Promise.all everywhere — which would forbid the
       batching this performance pass exists to add. */
    const parallelOutside = FILES.some(f =>
      CONCURRENT.test(f.src) && !violations().some(v => v.startsWith(f.rel + ':'))
    );
    CONCURRENT.lastIndex = 0;
    expect(parallelOutside, 'expected some legitimate Promise.all outside a transaction').toBe(true);
  });
});
