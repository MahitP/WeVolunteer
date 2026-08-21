/**
 * Rewriting SQLite parameter placeholders into PostgreSQL's numbered form.
 *
 * SQLite takes `?` positionally and `@name`/`:name` by name. PostgreSQL takes `$1`,
 * `$2`, … only. Every one of the ~1,021 prepared statements in this codebase
 * therefore has to be rewritten before it can run, and the rewrite has to be
 * exactly right: a placeholder mapped to the wrong index does not fail, it binds
 * the wrong value.
 *
 * ── Why this is a scanner and not a regular expression ──
 *
 * The obvious `sql.replace(/\?/g, …)` corrupts any query containing a literal
 * question mark or at-sign inside a string. This schema has both — email
 * addresses in seeded values, punctuation in notification copy, and
 * `LIKE 'deleted\_%'` patterns. A replace that rewrote a `?` inside
 * `'Are you sure?'` would produce a statement that either fails to parse or,
 * worse, parses with the parameters shifted by one.
 *
 * So the string is walked once, tracking whether the cursor is inside a
 * single-quoted literal, a double-quoted identifier, a line comment or a block
 * comment. Placeholders are only recognised outside all of those.
 *
 * ── What it deliberately does NOT do ──
 *
 * It does not translate SQL dialect — `INSERT OR IGNORE`, `datetime('now')`,
 * `strftime`, `julianday` all pass through untouched. Those are per-query
 * semantic decisions that belong with the call sites being converted, not with a
 * mechanical placeholder pass. Translating them here would hide them from the
 * person converting the query, which is the opposite of useful.
 */

/**
 * @param {string} sql  a statement written for SQLite
 * @returns {{ text: string, params: Array<number|string> }}
 *   `text` is the PostgreSQL form. `params` describes how to build the argument
 *   array: each entry is either a zero-based index into the positional arguments
 *   or a string key to read from the bound object.
 */
export function translatePlaceholders(sql) {
  let out = '';
  let positional = 0;
  const params = [];
  /* Named parameters reuse their number when repeated: `@limit` twice is one
     value bound to one `$n`, which is also how SQLite treats it. Rebinding it as
     two parameters would silently require the caller to pass it twice. */
  const namedIndex = new Map();

  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    // ── skip a single-quoted literal, honouring SQL's '' escape ──
    if (c === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // ── skip a double-quoted identifier, honouring "" ──
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // ── skip a line comment ──
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      out += sql.slice(start, i);
      continue;
    }

    // ── skip a block comment ──
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out += sql.slice(start, i);
      continue;
    }

    // ── a positional placeholder ──
    if (c === '?') {
      params.push(positional);
      positional++;
      out += `$${params.length}`;
      i++;
      continue;
    }

    /**
     * ── a named placeholder: `@name` or `:name` ──
     *
     * SQLite accepts three sigils for named parameters — `@`, `:` and `$` — and
     * this codebase uses the first two. Only `@` was recognised, so
     * `evidenceHolds.js`, which writes `:eventId`, reached PostgreSQL untouched
     * and failed with `syntax error at or near ":"`. Fifteen placeholders across
     * the evidence-hold queries, which are what stop a reported event from being
     * deleted out from under a live report.
     *
     * `$` is deliberately NOT accepted: it is PostgreSQL's own positional sigil,
     * so treating `$1` as a name would rewrite already-translated SQL. Nothing
     * here uses it.
     *
     * ── The `::` collision ──
     *
     * PostgreSQL's cast operator is a DOUBLE colon, and the first version of
     * this read `col::timestamptz` as a parameter named `timestamptz`. Every
     * query using a cast — which is every one the dialect helpers emit for
     * PostgreSQL — then failed at bind time asking for an object of values.
     * Caught by `db.dialectSql.test.js`, which runs the same expression on both
     * engines. Neither neighbour of a placeholder colon may be a colon.
     */
    if ((c === '@' || (c === ':' && sql[i - 1] !== ':' && sql[i + 1] !== ':'))
        && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (namedIndex.has(name)) {
        out += `$${namedIndex.get(name)}`;
      } else {
        params.push(name);
        namedIndex.set(name, params.length);
        out += `$${params.length}`;
      }
      i = j;
      continue;
    }

    out += c;
    i++;
  }

  return { text: out, params };
}

/**
 * Turns the arguments a caller passed into the array PostgreSQL wants.
 *
 * SQLite accepts either spread positional values — `.get(a, b)` — or a single
 * object for named parameters — `.all({ limit, offset })`. Both spellings are in
 * use here, so both are supported, and mixing them in one statement is refused
 * rather than guessed at.
 *
 * ── The `undefined` rule ──
 *
 * A missing named parameter throws. `pg` would otherwise send SQL NULL for it,
 * turning `LIMIT @limit` with a typo'd key into "no limit at all" — a silent
 * behaviour change on a query whose whole job is to bound a result set. SQLite
 * throws in the same situation, so refusing is also the compatible answer.
 */
export function bindArguments(paramSpec, args) {
  const wantsNamed = paramSpec.some(p => typeof p === 'string');
  const wantsPositional = paramSpec.some(p => typeof p === 'number');

  if (wantsNamed && wantsPositional) {
    throw new Error(
      'This statement mixes positional (?) and named (@name / :name) placeholders. '
      + 'SQLite tolerates it; the binding is ambiguous, so it is refused here. '
      + 'Use one style per statement.'
    );
  }

  if (!wantsNamed) {
    /* Positional. `args` may arrive as a spread list, or as a single array —
       both appear in this codebase. */
    const flat = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
    return paramSpec.map(index => normalise(flat[index]));
  }

  const source = args[0];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(
      'This statement uses named (@name) placeholders and must be called with a '
      + `single object of values. Received: ${Array.isArray(source) ? 'an array' : typeof source}.`
    );
  }
  return paramSpec.map(name => {
    if (!(name in source)) {
      throw new Error(`Missing value for named parameter @${name}.`);
    }
    return normalise(source[name]);
  });
}

/**
 * SQLite accepts `undefined` in some positions and treats booleans as 0/1.
 *
 * `pg` sends `undefined` as NULL, which is the same thing SQLite does, so that
 * needs no special handling — but it is normalised explicitly so the behaviour
 * is stated rather than inherited from two libraries that happen to agree.
 *
 * Booleans are passed through as booleans: the generated schema declares the 20
 * flag columns as real `boolean`, so `pg` binds them correctly and converting to
 * 0/1 here would be the wrong direction.
 */
function normalise(value) {
  return value === undefined ? null : value;
}
