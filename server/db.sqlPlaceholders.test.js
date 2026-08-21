import { describe, it, expect } from 'vitest';
import { translatePlaceholders, bindArguments } from './db/sqlPlaceholders.js';

/**
 * Placeholder rewriting, which every one of ~1,021 prepared statements depends on.
 *
 * The failure mode this guards is not a crash. A `?` recognised inside a string
 * literal shifts every subsequent parameter by one, and the resulting statement
 * usually still parses — it just binds the wrong values to the wrong columns.
 * On a query like `UPDATE users SET role = ? WHERE id = ?` that is not a bug,
 * it is a security incident.
 *
 * So the cases below are mostly about what must NOT be treated as a placeholder.
 */
describe('translating SQLite placeholders to PostgreSQL', () => {
  const t = (sql) => translatePlaceholders(sql);

  describe('positional parameters', () => {
    it('numbers them in order', () => {
      const { text, params } = t('SELECT * FROM users WHERE id = ? AND role = ?');
      expect(text).toBe('SELECT * FROM users WHERE id = $1 AND role = $2');
      expect(params).toEqual([0, 1]);
    });

    it('leaves a statement with no parameters alone', () => {
      const { text, params } = t('SELECT COUNT(*) FROM users');
      expect(text).toBe('SELECT COUNT(*) FROM users');
      expect(params).toEqual([]);
    });
  });

  describe('named parameters', () => {
    it('maps @name to a number and records the key', () => {
      const { text, params } = t('SELECT * FROM events LIMIT @limit OFFSET @offset');
      expect(text).toBe('SELECT * FROM events LIMIT $1 OFFSET $2');
      expect(params).toEqual(['limit', 'offset']);
    });

    it('reuses one number when a name repeats, as SQLite does', () => {
      const { text, params } = t('SELECT * FROM t WHERE a = @x OR b = @x');
      expect(text).toBe('SELECT * FROM t WHERE a = $1 OR b = $1');
      expect(params).toEqual(['x']);
    });

    it('does not treat a bare @ as a parameter', () => {
      const { text, params } = t("SELECT 'a@b' AS v, x FROM t WHERE y = ?");
      expect(text).toBe("SELECT 'a@b' AS v, x FROM t WHERE y = $1");
      expect(params).toEqual([0]);
    });
  });

  /**
   * The cases that matter. Every one of these, mis-handled, produces a statement
   * that runs and is wrong.
   */
  describe('placeholders inside literals and comments are not placeholders', () => {
    it('ignores a ? inside a single-quoted string', () => {
      const { text, params } = t("SELECT * FROM t WHERE msg = 'Are you sure?' AND id = ?");
      expect(text).toBe("SELECT * FROM t WHERE msg = 'Are you sure?' AND id = $1");
      expect(params).toEqual([0]);
    });

    it('ignores an @ inside a single-quoted string', () => {
      const { text, params } = t("SELECT * FROM users WHERE email = 'admin@example.gov' OR id = ?");
      expect(text).toBe("SELECT * FROM users WHERE email = 'admin@example.gov' OR id = $1");
      expect(params).toEqual([0]);
    });

    it("handles SQL's doubled-quote escape without losing the rest of the string", () => {
      const { text, params } = t("SELECT 'it''s a ? here' AS v WHERE id = ?");
      expect(text).toBe("SELECT 'it''s a ? here' AS v WHERE id = $1");
      expect(params).toEqual([0]);
    });

    it('ignores a ? inside a double-quoted identifier', () => {
      const { text, params } = t('SELECT "weird?col" FROM t WHERE id = ?');
      expect(text).toBe('SELECT "weird?col" FROM t WHERE id = $1');
      expect(params).toEqual([0]);
    });

    it('ignores a ? inside a line comment', () => {
      const { text, params } = t('SELECT *\n-- why not ? here\nFROM t WHERE id = ?');
      expect(text).toContain('-- why not ? here');
      expect(params).toEqual([0]);
      expect(text).toContain('id = $1');
    });

    it('ignores a ? inside a block comment', () => {
      const { text, params } = t('SELECT * /* a ? and an @x */ FROM t WHERE id = ?');
      expect(text).toContain('/* a ? and an @x */');
      expect(params).toEqual([0]);
      expect(text).toContain('id = $1');
    });

    it('keeps counting correctly after a literal containing a question mark', () => {
      const { text, params } = t("UPDATE users SET note = ?, flag = 'huh?' WHERE id = ? AND role = ?");
      expect(text).toBe("UPDATE users SET note = $1, flag = 'huh?' WHERE id = $2 AND role = $3");
      expect(params).toEqual([0, 1, 2]);
    });
  });

  describe('a real statement from this codebase', () => {
    it('rewrites the events query that uses named parameters', () => {
      const { text, params } = t(
        'SELECT e.id FROM events e WHERE e.status <> \'cancelled\' ORDER BY e.start_datetime LIMIT @limit OFFSET @offset'
      );
      expect(text).toMatch(/LIMIT \$1 OFFSET \$2$/);
      expect(text).toContain("<> 'cancelled'");
      expect(params).toEqual(['limit', 'offset']);
    });

    it('rewrites a conditional write whose changes count decides a race', () => {
      const { text, params } = t(
        'UPDATE organization_bans SET lifted_at = ?, lifted_by = ? '
        + 'WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL'
      );
      expect(text).toBe(
        'UPDATE organization_bans SET lifted_at = $1, lifted_by = $2 '
        + 'WHERE organization_id = $3 AND user_id = $4 AND lifted_at IS NULL'
      );
      expect(params).toEqual([0, 1, 2, 3]);
    });
  });
});

describe('binding arguments', () => {
  const spec = (sql) => translatePlaceholders(sql).params;

  it('maps spread positional arguments in order', () => {
    const s = spec('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(bindArguments(s, ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('accepts a single array of positional arguments', () => {
    const s = spec('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(bindArguments(s, [['x', 'y']])).toEqual(['x', 'y']);
  });

  it('reads named parameters out of the bound object', () => {
    const s = spec('SELECT * FROM t LIMIT @limit OFFSET @offset');
    expect(bindArguments(s, [{ limit: 10, offset: 20 }])).toEqual([10, 20]);
  });

  it('ignores extra keys the statement does not use', () => {
    const s = spec('SELECT * FROM t LIMIT @limit');
    expect(bindArguments(s, [{ limit: 5, unused: 'x' }])).toEqual([5]);
  });

  /**
   * A typo'd key must not become "no limit". `pg` would send NULL, and
   * `LIMIT NULL` in PostgreSQL means unlimited — so a misspelled parameter would
   * turn a bounded query into a full table scan returning everything, silently.
   * SQLite throws here too, so refusing is both safer and compatible.
   */
  it('refuses a missing named parameter rather than binding NULL', () => {
    const s = spec('SELECT * FROM t LIMIT @limit OFFSET @offset');
    expect(() => bindArguments(s, [{ limit: 10 }])).toThrow(/Missing value for named parameter @offset/);
  });

  it('refuses named placeholders called with positional arguments', () => {
    const s = spec('SELECT * FROM t LIMIT @limit');
    expect(() => bindArguments(s, [10])).toThrow(/must be called with a single object/);
  });

  it('refuses a statement that mixes both styles', () => {
    const s = spec('SELECT * FROM t WHERE a = ? LIMIT @limit');
    expect(() => bindArguments(s, [{ limit: 1 }])).toThrow(/mixes positional/);
  });

  it('passes undefined through as NULL, matching SQLite', () => {
    const s = spec('SELECT * FROM t WHERE a = ?');
    expect(bindArguments(s, [undefined])).toEqual([null]);
  });

  it('passes booleans through unchanged, because the columns are real booleans', () => {
    const s = spec('UPDATE users SET verified = ? WHERE id = ?');
    expect(bindArguments(s, [true, 'u1'])).toEqual([true, 'u1']);
  });
});

/**
 * Named parameters with a colon, and the operator they collide with.
 *
 * SQLite accepts `@name`, `:name` and `$name` for the same thing. Only `@` was
 * recognised here, so `evidenceHolds.js` — which writes `:eventId` — reached
 * PostgreSQL with its colons intact and failed with `syntax error at or near
 * ":"`. Those fifteen placeholders are the queries that stop a reported event
 * from being deleted out from under a live report, so the failure was not
 * cosmetic.
 *
 * Adding `:` immediately created a worse bug: PostgreSQL's cast operator is a
 * DOUBLE colon, so `col::timestamptz` parsed as a parameter named
 * `timestamptz`. Every query the dialect helpers emit for PostgreSQL uses a
 * cast, and each one began failing at bind time — the translator asking for a
 * value nobody could supply. `db.dialectSql.test.js` caught it by running the
 * same expression on both engines.
 */
describe('colon-named parameters, and the cast operator', () => {
  it('translates :name the same way it translates @name', () => {
    expect(translatePlaceholders('SELECT 1 WHERE a = :eventId AND b = :eventId'))
      .toEqual({ text: 'SELECT 1 WHERE a = $1 AND b = $1', params: ['eventId'] });
  });

  it('mixes the two spellings of the same name onto one parameter', () => {
    const { text, params } = translatePlaceholders('SELECT 1 WHERE a = :x OR b = @x');
    expect(text).toBe('SELECT 1 WHERE a = $1 OR b = $1');
    expect(params).toEqual(['x']);
  });

  /**
   * The regression. A cast is not a parameter, and treating it as one is
   * invisible until bind time — the SQL still looks reasonable.
   */
  it('leaves a :: cast alone', () => {
    const sql = "SELECT EXTRACT(EPOCH FROM (b::timestamptz - a::timestamptz)) FROM t WHERE id = ?";
    const { text, params } = translatePlaceholders(sql);
    expect(text, 'the cast was rewritten as a placeholder').toContain('b::timestamptz');
    expect(text).toContain('a::timestamptz');
    expect(params, 'only the ? is a parameter').toEqual([0]);
  });

  it('handles a cast and a colon-named parameter in the same statement', () => {
    const { text, params } = translatePlaceholders('SELECT x::int FROM t WHERE id = :who');
    expect(text).toBe('SELECT x::int FROM t WHERE id = $1');
    expect(params).toEqual(['who']);
  });

  it('does not read a colon inside a string literal as a parameter', () => {
    const { text, params } = translatePlaceholders("SELECT 'a:b' AS s WHERE id = :who");
    expect(text).toBe("SELECT 'a:b' AS s WHERE id = $1");
    expect(params).toEqual(['who']);
  });
});
