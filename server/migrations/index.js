/**
 * Ordered, versioned schema migrations.
 *
 * db.js keeps its `CREATE TABLE IF NOT EXISTS` + addColumnIfMissing() bootstrap
 * for the tables that predate this registry — rewriting that is risk with no
 * reward. Everything structural from v1.2 onward goes here instead, because the
 * next few changes are table REBUILDS (SQLite cannot alter a CHECK constraint)
 * and those need ordering, a record of what already ran, and a rollback story.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import authzRoles from './001_authz_roles.js';
import userCapabilities from './002_user_capabilities.js';
import reauthChallenges from './003_reauth_challenges.js';

export const MIGRATIONS = [authzRoles, userCapabilities, reauthChallenges];

const label = (m) => `${m.version}_${m.name}`;

/**
 * A migration's source reduced to the form the checksum actually cares about:
 * comments removed, whitespace collapsed.
 *
 * Hand-written rather than regex-based because a regex cannot tell a comment
 * from the characters `//` inside a string, and deleting real code would turn
 * the checksum's false-positive problem into a false-NEGATIVE one — two
 * different migrations hashing the same. This walks the source once, copying
 * string and template-literal contents verbatim and dropping only genuine
 * comments.
 *
 * Exported for its own tests: everything the migration guard promises rests on
 * this being right, so it is verified directly rather than only through the
 * hashes it feeds.
 */
export function canonicalSource(source) {
  // After one of these, a '/' starts a regex literal rather than being
  // division. Migration files have no regexes today, but misreading one would
  // let a '//' inside it eat the rest of the line — the false negative above.
  const REGEX_MAY_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

  let out = '';
  let prev = '';           // last non-whitespace character of real code
  let i = 0;

  const copyDelimited = (open, close) => {
    const start = i;
    i++;                                        // opening delimiter
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }    // escape: skip the pair
      // `${ ... }` may itself contain a backtick, so track nesting rather than
      // stopping at the first one.
      if (open === '`' && ch === '$' && source[i + 1] === '{') { depth++; i += 2; continue; }
      if (open === '`' && depth > 0 && ch === '}') { depth--; i++; continue; }
      if (depth === 0 && ch === close) { i++; break; }
      i++;
    }
    out += source.slice(start, i);
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {            // line comment
      while (i < source.length && source[i] !== '\n') i++;
      continue;                                 // the newline collapses below
    }
    if (c === '/' && next === '*') {            // block comment
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';                               // a comment still separates tokens
      continue;
    }
    if (c === "'" || c === '"') { copyDelimited(c, c); prev = c; continue; }
    if (c === '`') { copyDelimited('`', '`'); prev = '`'; continue; }
    if (c === '/' && REGEX_MAY_FOLLOW.has(prev)) {
      // A regex literal: copy it whole. Character classes may contain an
      // unescaped '/', so track them.
      const start = i;
      i++;
      let inClass = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i++; break; }
        else if (ch === '\n') break;            // not a regex after all
        i++;
      }
      out += source.slice(start, i);
      prev = '/';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * What the checksum is computed over.
 *
 * Two failure modes drove this away from `String(m.up)`:
 *
 *   - FALSE POSITIVE. `Function.prototype.toString` includes the comments and
 *     whitespace inside `up`, and 001's `up` is ~120 lines of heavily commented
 *     code. Reflowing a sentence in a comment caused a hard boot failure that
 *     could only be cleared with manual SQL — training operators to reach for
 *     the override, which is the last habit this guard wants to encourage.
 *   - FALSE NEGATIVE, and the more dangerous one. `String(m.up)` covers only
 *     the function body, so a migration's module-level dependencies were
 *     invisible to it: 001's `countCascadingChildren()` and
 *     `EXPECTED_USER_COLUMNS` could be rewritten with no change to the hash at
 *     all — and those are precisely what changes when a users column is added.
 *
 * Hashing the whole module file, canonicalised, covers the dependencies and
 * ignores the cosmetics. `fileUrl` is the module's own `import.meta.url`, so
 * the path never depends on the process working directory. Inline migrations
 * (the registry's own tests) carry no file and fall back to their `up` source;
 * `migrations.registry.test.js` asserts every real migration declares a
 * fileUrl, so that fallback cannot silently become the production path.
 */
function hashBasis(m) {
  if (m.fileUrl) return canonicalSource(readFileSync(new URL(m.fileUrl), 'utf8'));
  return canonicalSource(String(m.up));
}

const checksumOf = (m) => createHash('sha256').update(hashBasis(m)).digest('hex');

/**
 * The checksum a given migration would record today.
 *
 * Exported so `bin/migration-checksums.mjs` can print the backfill values an
 * operator needs after a checksum-scheme change, without that script
 * reimplementing (and drifting from) the hash this module actually enforces.
 */
export const checksumFor = checksumOf;

function ensureBookkeeping(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // checksum is nullable and added via ALTER TABLE, not part of the CREATE
  // TABLE above, because databases that ran before this guard existed already
  // have rows with no checksum — see the NULL-checksum handling in
  // runMigrations() for why those rows must throw rather than be backfilled.
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all();
  if (!columns.some(c => c.name === 'checksum')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  }
}

export function appliedVersions(db) {
  ensureBookkeeping(db);
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
}

/**
 * Builds the "what happened, what to do" text shared by both checksum-failure
 * cases. Whoever hits this is at boot, with no other context, so the message
 * carries the full remedy rather than pointing at documentation.
 */
function checksumErrorMessage(m, reason) {
  return (
    `Migration ${label(m)} is recorded as applied, but its stored checksum ${reason}. `
    + "This means the migration's code may not match what actually ran against this "
    + 'database — running it now could silently do nothing or duplicate work. '
    + `Verify by hand whether ${label(m)}'s schema change is already present. `
    + `If it is NOT present: delete the row WHERE version = ${m.version} from `
    + 'schema_migrations and restart, so the migration runs for real. '
    + 'If the change IS already present: do NOT delete the row — that would re-run '
    + 'the migration against a database it has already changed. Backfill the row '
    + `instead, with UPDATE schema_migrations SET checksum = '<current>' WHERE `
    + `version = ${m.version}; the correct value is printed by `
    + 'bin/migration-checksums.mjs. This is also the expected one-time step after a '
    + 'change to the checksum SCHEME itself (v1.2a rebased checksums from the `up` '
    + 'function source onto the whole migration file), which invalidates every '
    + 'previously recorded checksum at once. '
    + 'Full procedure: docs/ENGINEERING_GUIDE.md section 8.5, "Migration checksum failures".'
  );
}

/**
 * Applies every migration not yet recorded, lowest version first.
 *
 * Each migration runs inside its own transaction so a failure leaves the
 * database exactly as it was — including the schema_migrations row, which is
 * written inside the same transaction as the DDL it describes. A migration that
 * manages its own transaction (the table rebuilds must, because
 * `PRAGMA foreign_keys` cannot change inside one) sets `ownTransaction = true`.
 */
export function runMigrations(db, migrations = MIGRATIONS) {
  ensureBookkeeping(db);

  const seenVersions = new Set();
  for (const m of migrations) {
    if (seenVersions.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seenVersions.add(m.version);
  }

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const alreadyRows = db.prepare('SELECT version, checksum FROM schema_migrations').all();
  const already = new Map(alreadyRows.map(r => [r.version, r.checksum]));
  const applied = [], skipped = [];

  for (const m of ordered) {
    if (already.has(m.version)) {
      const stored = already.get(m.version);
      if (stored === null) {
        throw new Error(checksumErrorMessage(m, 'is missing (NULL)'));
      }
      if (stored !== checksumOf(m)) {
        throw new Error(checksumErrorMessage(m, "does not match the migration's current source"));
      }
      skipped.push(label(m));
      continue;
    }

    const record = () => db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)'
    ).run(m.version, m.name, new Date().toISOString(), checksumOf(m));

    try {
      if (m.ownTransaction) {
        m.up(db);
        record();
      } else {
        db.exec('BEGIN');
        try { m.up(db); record(); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
      }
      console.log(`Migration applied: ${label(m)}`);
      applied.push(label(m));
    } catch (err) {
      throw new Error(`Migration ${label(m)} failed: ${err.message}`, { cause: err });
    }
  }

  return { applied, skipped };
}
