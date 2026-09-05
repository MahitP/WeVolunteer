/**
 * The dialect fragments, run on both engines and compared.
 *
 * ── Why comparing is the only useful test here ──
 *
 * Each function in `db/dialectSql.js` returns two different SQL strings that are
 * supposed to compute the same thing. Asserting that each *runs* proves almost
 * nothing: `julianday` arithmetic and `EXTRACT(EPOCH …)` both run, both return a
 * number, and they disagreed by 3.7e-9 hours before the rounding was matched.
 * That difference is invisible in a single-engine test and fatal at cutover,
 * because the hours ledger's parity check recomputes stored totals and compares
 * them exactly.
 *
 * So each fragment is executed against SQLite and against PostgreSQL with the
 * same inputs, and the two answers are required to be equal.
 *
 * Without `TEST_POSTGRES_URL` the PostgreSQL half is skipped and the SQLite half
 * still runs, so the fragments are at least exercised everywhere.
 *
 *   TEST_POSTGRES_URL=postgres://…/db npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import {
  isPostgres, hoursBetween, greatest, monthOf, tableExists, probeWritable,
  substringContains, substringPosition, escapeLikeLiteral,
} from './db/dialectSql.js';

const URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(URL);
const NAMESPACE = 'wev_dialect_sql';

/** Two shifts and their true durations, including one that is not a whole hour. */
const SHIFTS = [
  { start: '2026-08-16T09:30:00.000Z', end: '2026-08-16T12:00:00.000Z', hours: 2.5 },
  { start: '2026-08-16T09:00:00.000Z', end: '2026-08-16T09:20:00.000Z', hours: 0.33 },
  { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', hours: 24 },
];

/**
 * Text chosen for the characters that used to be the reason this codebase would
 * not use `LIKE` at all: the two wildcards, the escape, and a null.
 */
const HAYSTACKS = [
  'Chess Club #7',
  'Discount 100% off everything',
  'a_b regression fixture',
  'back\\slash in the title',
  'Caf\u00e9 Solidario',
  'CAF\u00c9 SOLIDARIO',
  'Beach Cleanup',
  "O'Brien Memorial Park",
  null,
];

/** Needles, including every one that would be pattern syntax if unescaped. */
const NEEDLES = [
  'chess', 'CHESS', 'Chess Club', 'club #7',
  '100%', '%', '_', 'a_b', '%off%', '\\', 'back\\slash',
  '', 'zzz-nothing-matches-zzz', "o'brien",
];

/** The subset whose case folding is the same on both engines. */
const ASCII_NEEDLES = NEEDLES;

let sqlite;
let pg;

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE shifts (id integer primary key, start_datetime TEXT, end_datetime TEXT)');
  for (const [i, s] of SHIFTS.entries()) {
    sqlite.prepare('INSERT INTO shifts VALUES (?, ?, ?)').run(i, s.start, s.end);
  }
  sqlite.exec('CREATE TABLE haystacks (id integer primary key, body TEXT)');
  for (const [i, body] of HAYSTACKS.entries()) {
    sqlite.prepare('INSERT INTO haystacks VALUES (?, ?)').run(i, body);
  }

  if (!live) return;
  const admin = new PostgresDatabase({ connectionString: URL, max: 1, translate: translatePlaceholders });
  await admin.exec(`DROP SCHEMA IF EXISTS ${NAMESPACE} CASCADE; CREATE SCHEMA ${NAMESPACE};`);
  await admin.close();

  /* The namespace goes in the connection string, not a `SET`: the pool hands out
     several sessions and a `SET` reaches only one of them. */
  const url = new global.URL(URL);
  url.searchParams.set('options', `-c search_path=${NAMESPACE},public`);
  pg = new PostgresDatabase({ connectionString: url.toString(), max: 2, translate: translatePlaceholders });
  await pg.exec('CREATE TABLE shifts (id integer primary key, start_datetime TEXT, end_datetime TEXT)');
  for (const [i, s] of SHIFTS.entries()) {
    await pg.prepare('INSERT INTO shifts VALUES (?, ?, ?)').run(i, s.start, s.end);
  }
  await pg.exec('CREATE TABLE haystacks (id integer primary key, body TEXT)');
  for (const [i, body] of HAYSTACKS.entries()) {
    await pg.prepare('INSERT INTO haystacks VALUES (?, ?)').run(i, body);
  }
}, 60000);

afterAll(async () => {
  try { sqlite?.close(); } catch { /* already closed */ }
  if (!live) return;
  await pg?.close();
  const admin = new PostgresDatabase({ connectionString: URL, max: 1, translate: translatePlaceholders });
  await admin.exec(`DROP SCHEMA IF EXISTS ${NAMESPACE} CASCADE`);
  await admin.close();
});

describe('the dialect marker', () => {
  it('reads an unknown handle as SQLite, which is the safe direction', () => {
    expect(isPostgres(undefined)).toBe(false);
    expect(isPostgres({})).toBe(false);
    expect(isPostgres(new DatabaseSync(':memory:'))).toBe(false);
    expect(isPostgres({ dialect: 'postgres' })).toBe(true);
  });
});

describe('hoursBetween', () => {
  const rows = (db) => db
    .prepare(`SELECT id, ${hoursBetween(db, 'start_datetime', 'end_datetime')} AS h FROM shifts ORDER BY id`)
    .all();

  it('gives SQLite the right answer for every shift', () => {
    const got = rows(sqlite).map(r => Number(r.h));
    expect(got).toEqual(SHIFTS.map(s => s.hours));
  });

  it.skipIf(!live)('gives PostgreSQL the identical answer, to the last digit', async () => {
    const here = rows(sqlite).map(r => Number(r.h));
    const there = (await rows(pg)).map(r => Number(r.h));

    /* Strict equality, not `toBeCloseTo`. The ledger's parity check compares
       recomputed hours against stored ones exactly, so "close" is the failure
       this test exists to catch — the unrounded forms differ by 3.7e-9. */
    expect(there, 'the two engines disagree about how long a shift is').toEqual(here);
  });
});

describe('greatest', () => {
  it('is the scalar maximum on SQLite, not the aggregate', () => {
    const { g } = sqlite.prepare(`SELECT ${greatest(sqlite, '0.1', '2.5')} AS g`).get();
    expect(Number(g)).toBe(2.5);
  });

  it.skipIf(!live)('is the same scalar maximum on PostgreSQL', async () => {
    const { g } = await pg.prepare(`SELECT ${greatest(pg, '0.1', '2.5')} AS g`).get();
    expect(Number(g)).toBe(2.5);
  });

  /**
   * The floor is what the expression is for: a shift shorter than six minutes
   * still credits 0.1 hours rather than rounding to nothing.
   */
  it.skipIf(!live)('applies the same floor to a very short shift on both engines', async () => {
    const expr = (db) => `${greatest(db, '0.1', hoursBetween(db, "'2026-01-01T00:00:00.000Z'", "'2026-01-01T00:01:00.000Z'"))}`;
    const here = Number(sqlite.prepare(`SELECT ${expr(sqlite)} AS h`).get().h);
    const there = Number((await pg.prepare(`SELECT ${expr(pg)} AS h`).get()).h);
    expect(here).toBe(0.1);
    expect(there).toBe(here);
  });
});

describe('monthOf', () => {
  it('is the same expression on both engines, and the right one', () => {
    const { m } = sqlite.prepare(`SELECT ${monthOf("'2026-08-16T17:53:04.120Z'")} AS m`).get();
    expect(m).toBe('2026-08');
    expect(monthOf('x'), 'no branch is needed — substr is portable').toBe('substr(x, 1, 7)');
  });

  it('agrees with the strftime it replaced, for every shift', () => {
    const both = sqlite.prepare(
      `SELECT strftime('%Y-%m', end_datetime) AS was, ${monthOf('end_datetime')} AS now FROM shifts`
    ).all();
    for (const row of both) expect(row.now, 'substr and strftime disagree').toBe(row.was);
  });

  it.skipIf(!live)('returns the same month on PostgreSQL', async () => {
    const there = (await pg.prepare(`SELECT ${monthOf('end_datetime')} AS m FROM shifts ORDER BY id`).all())
      .map(r => r.m);
    const here = sqlite.prepare(`SELECT ${monthOf('end_datetime')} AS m FROM shifts ORDER BY id`).all()
      .map(r => r.m);
    expect(there).toEqual(here);
  });
});

describe('tableExists', () => {
  it('answers yes and no on SQLite', async () => {
    expect(await tableExists(sqlite, 'shifts')).toBe(true);
    expect(await tableExists(sqlite, 'no_such_table')).toBe(false);
  });

  it.skipIf(!live)('answers yes and no on PostgreSQL', async () => {
    expect(await tableExists(pg, 'shifts')).toBe(true);
    expect(await tableExists(pg, 'no_such_table')).toBe(false);
  });

  /**
   * The reason `information_schema` was chosen over `to_regclass`: a table in
   * another visible schema must not count. `shifts` exists in this namespace, so
   * the check is made from a handle whose search_path does NOT include it.
   */
  it.skipIf(!live)('does not see a table in another schema', async () => {
    const other = new PostgresDatabase({ connectionString: URL, max: 1, translate: translatePlaceholders });
    try {
      expect(
        await tableExists(other, 'shifts'),
        'the existence check is resolving through the search_path, not the current schema',
      ).toBe(false);
    } finally {
      await other.close();
    }
  });
});

describe('probeWritable', () => {
  it('succeeds on a writable SQLite database', async () => {
    expect(await probeWritable(sqlite)).toBe(true);
  });

  it.skipIf(!live)('succeeds on a writable PostgreSQL database', async () => {
    expect(await probeWritable(pg)).toBe(true);
  });

  /**
   * The point of the probe, on the engine where it is newest. A read-only
   * transaction refuses to allocate a transaction id, which is exactly the
   * condition `SELECT 1` would sail through — and sailing through is what made
   * /health report a read-only database as healthy in the first place.
   */
  it.skipIf(!live)('fails inside a read-only transaction, where SELECT 1 would not', async () => {
    const tx = await pg.beginTransaction();
    try {
      await tx.exec('SET TRANSACTION READ ONLY');
      await expect(
        tx.prepare('SELECT 1 AS ok').get(),
        'a plain read must still work — otherwise this proves nothing about writability',
      ).resolves.toBeTruthy();
      await expect(
        probeWritable(tx),
        'the probe passed on a read-only transaction; it is not testing writability',
      ).rejects.toThrow(/read-only/i);
    } finally {
      await tx.rollback();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * substringContains — the predicate the search box runs
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Migration 064 replaced a position test with an escaped `LIKE` on PostgreSQL,
 * so that a trigram index could answer it. The whole change rests on the claim
 * that the two forms select exactly the same rows for every possible needle,
 * including the ones made entirely of pattern syntax.
 *
 * That claim is asserted here rather than argued: for each needle, the rows
 * matched by the shipped predicate must equal the rows matched by the form it
 * replaced — on the same engine, with the same data.
 */
describe('substringContains', () => {
  /** Ids matched by the shipped predicate. The needle is escaped for LIKE. */
  const contains = (db, needle) => db
    .prepare(`SELECT id FROM haystacks WHERE ${substringContains(db, 'lower(body)', 'lower(?)')} ORDER BY id`)
    .all(isPostgres(db) ? escapeLikeLiteral(needle) : needle);

  /** Ids matched by the pre-064 predicate, which takes the needle verbatim. */
  const position = (db, needle) => db
    .prepare(`SELECT id FROM haystacks WHERE ${substringPosition(db, 'lower(body)', 'lower(?)')} ORDER BY id`)
    .all(needle);

  const ids = (rows) => rows.map((r) => Number(r.id));

  it.each(NEEDLES)('matches exactly what the position test matched on SQLite: %j', (needle) => {
    expect(ids(contains(sqlite, needle))).toEqual(ids(position(sqlite, needle)));
  });

  it.skipIf(!live).each(NEEDLES)(
    'matches exactly what the position test matched on PostgreSQL: %j',
    async (needle) => {
      expect(ids(await contains(pg, needle))).toEqual(ids(await position(pg, needle)));
    },
  );

  it.skipIf(!live).each(ASCII_NEEDLES)('selects the same rows on both engines: %j', async (needle) => {
    expect(ids(await contains(pg, needle))).toEqual(ids(contains(sqlite, needle)));
  });

  /**
   * The characters that are the entire reason the position test was chosen
   * originally, stated as behaviour rather than left to the table above.
   */
  it('does not let a typed % match everything', () => {
    const all = ids(contains(sqlite, ''));
    const percent = ids(contains(sqlite, '%'));
    expect(percent.length).toBeGreaterThan(0);
    expect(percent).not.toEqual(all);
    expect(percent).toEqual(ids(position(sqlite, '%')));
  });

  it('does not let a typed _ match any single character', () => {
    expect(ids(contains(sqlite, '_'))).toEqual(ids(position(sqlite, '_')));
    /* 'a_b regression fixture' is the only row with a literal underscore. */
    expect(ids(contains(sqlite, '_')).length).toBe(1);
  });

  it('treats NULL text as no match rather than as a match', () => {
    /* The corpus carries a null body; every needle above must skip it. */
    expect(ids(contains(sqlite, ''))).not.toContain(HAYSTACKS.indexOf(null));
  });

  it.skipIf(!live)('is answered by a trigram index when one exists', async () => {
    await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await pg.exec('CREATE INDEX IF NOT EXISTS haystacks_body_trgm ON haystacks USING gin (lower(body) gin_trgm_ops)');
    /* Small tables are scanned whatever indexes exist, so this asserts the
       index is USABLE — the planner accepts the operator and the expression —
       rather than that it is chosen at three rows. */
    const rows = await pg.prepare(`
      EXPLAIN (FORMAT JSON) SELECT id FROM haystacks
       WHERE ${substringContains(pg, 'lower(body)', 'lower(?)')}
    `).all(escapeLikeLiteral('chess'));
    expect(JSON.stringify(rows[0])).toBeTruthy();

    await pg.exec('SET enable_seqscan = off');
    const planned = await pg.prepare(`
      EXPLAIN (FORMAT JSON) SELECT id FROM haystacks
       WHERE ${substringContains(pg, 'lower(body)', 'lower(?)')}
    `).all(escapeLikeLiteral('chess'));
    await pg.exec('SET enable_seqscan = on');
    expect(JSON.stringify(planned)).toMatch(/Bitmap Index Scan|Index Scan/);
  });
});

describe('escapeLikeLiteral', () => {
  it('escapes the three characters LIKE treats as syntax, and nothing else', () => {
    expect(escapeLikeLiteral('100%')).toBe('100\\%');
    expect(escapeLikeLiteral('a_b')).toBe('a\\_b');
    expect(escapeLikeLiteral('c:\\path')).toBe('c:\\\\path');
    expect(escapeLikeLiteral('plain words')).toBe('plain words');
    expect(escapeLikeLiteral("O'Brien")).toBe("O'Brien");
  });

  it('escapes the backslash first, so its own escapes are not re-escaped', () => {
    /* '\\%' is a backslash then a percent: two literal characters, which must
       become an escaped backslash then an escaped percent. */
    expect(escapeLikeLiteral('\\%')).toBe('\\\\\\%');
  });

  it('survives a non-string without throwing', () => {
    expect(escapeLikeLiteral(null)).toBe('');
    expect(escapeLikeLiteral(undefined)).toBe('');
    expect(escapeLikeLiteral(42)).toBe('42');
  });
});
