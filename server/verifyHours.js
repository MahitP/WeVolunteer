/**
 * Blocking parity check, for operators and CI.
 *
 * Boot logs a mismatch and carries on — the ledger is additive and taking the
 * platform down for every user over a reporting discrepancy would be a worse
 * outcome than the discrepancy. This script is the version that fails hard:
 * run it after a migration and before wiring any ledger writes.
 *
 *   node verifyHours.js            # exits 1 on mismatch
 *   node verifyHours.js other.db   # an explicit path wins over the environment
 *
 * Reads only. Writes nothing.
 *
 * ── Which database this opens ──
 *
 * WEV_DB_PATH first, exactly as server/db.js resolves it, so this tool and the
 * running application can never disagree about which file is live.
 *
 * It used to be `process.argv[2] || <server/wevolunteer.db>`, with no reference
 * to WEV_DB_PATH at all — and `npm run verify:hours` is
 * `node --env-file-if-exists=../.env verifyHours.js`, while the pilot's `.env`
 * sets `WEV_DB_PATH=../pilot.db`. So the command loaded the env file naming the
 * real database, ignored it, silently opened a stale `server/wevolunteer.db`
 * that happened to exist, and reported PASS. A verification tool that answers
 * confidently about the wrong file is worse than not having one, because it
 * converts "we have not checked" into "we have checked and it is fine".
 *
 * An explicit CLI argument still wins: it is a more specific instruction than an
 * ambient variable, and it is how an operator checks a backup or a copy.
 */
/**
 * ── Engine ──
 *
 * This opened `node:sqlite` directly and asked `sqlite_master` whether the
 * ledger existed. On the PostgreSQL deployment that is not merely unsupported,
 * it is actively misleading in the exact way the comment above warns about.
 *
 * `new DatabaseSync(path)` CREATES the file when it is missing, so running this
 * against a production deployment would have manufactured an empty SQLite
 * database and reported on it. And if `WEV_DB_PATH` still named a leftover
 * SQLite file that DID carry a ledger — a stale developer database, or
 * `pilot.db` — it would have run the parity check to completion against the
 * wrong database entirely and printed PASS.
 *
 * That is precisely "a verification tool that answers confidently about the
 * wrong file", one engine further along.
 *
 * So it now resolves the engine the same way the application does, through
 * `db.js`. On PostgreSQL that is `DATABASE_URL`; on SQLite it is `WEV_DB_PATH`,
 * unchanged. An explicit CLI argument still wins on SQLite, for checking a
 * backup or a copy.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyLedgerParity } from './hoursLedger.js';
import { tableExists } from './db/dialectSql.js';
import { resolveEngine, POSTGRES } from './db/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engine = resolveEngine();

/* An explicit path is a SQLite-only instruction: there is no equivalent for a
   connection string, and silently ignoring it would repeat the original defect
   in the other direction. */
if (process.argv[2] && engine === POSTGRES) {
  console.error(
    'A database path was given, but DATABASE_ENGINE=postgres.\n'
    + '  This tool checks the database the application is configured to use.\n'
    + '  To check a different PostgreSQL database, set DATABASE_URL instead.'
  );
  process.exit(1);
}
if (process.argv[2]) process.env.WEV_DB_PATH = path.resolve(process.argv[2]);

/* Imported after the argument is folded into the environment, because db.js
   resolves its target at import time. */
const { db } = await import('./db.js');

const target = engine === POSTGRES
  ? 'PostgreSQL (DATABASE_URL)'
  : (process.env.WEV_DB_PATH || path.join(__dirname, 'wevolunteer.db'));

if (!await tableExists(db, 'hours_ledger')) {
  console.error(`No hours_ledger table in ${target}. Start the server once to create and backfill it.`);
  process.exit(1);
}

const parity = await verifyLedgerParity(db);

/**
 * The credited-hours total, per student.
 *
 * HAVING repeats the aggregate instead of referencing the `hours` alias.
 * SQLite resolves a SELECT alias there; PostgreSQL evaluates HAVING before the
 * select list exists and answers: column "hours" does not exist. ORDER BY is
 * fine either way — both engines resolve aliases in ORDER BY.
 */
const totals = await db.prepare(`
  SELECT u.name, COALESCE(SUM(CASE WHEN a.present = 1 THEN a.hours_awarded END), 0) AS hours
  FROM users u
  LEFT JOIN attendance a ON a.user_id = u.id
  WHERE u.role = 'student'
  GROUP BY u.id
  HAVING COALESCE(SUM(CASE WHEN a.present = 1 THEN a.hours_awarded END), 0) > 0
  ORDER BY hours DESC, u.name ASC
`).all();

console.log(`Database: ${target}`);
console.log(`Ledger entries: ${(await db.prepare('SELECT COUNT(*) c FROM hours_ledger').get()).c}`);
console.log(`Attendance rows: ${(await db.prepare('SELECT COUNT(*) c FROM attendance').get()).c}`);
console.log('\nCredited hours (source of truth — attendance):');
for (const t of totals) console.log(`  ${t.name.padEnd(24)} ${t.hours}`);

if (parity.ok) {
  console.log(`\nPASS — ledger matches attendance for all ${parity.usersChecked} volunteer(s) with recorded hours.`);
  process.exit(0);
}

console.error('\nFAIL — ledger disagrees with attendance:');
for (const m of parity.mismatches) {
  console.error(`  ${m.userId}: ledger ${m.ledgerTotal} vs attendance ${m.attendanceTotal}`);
}
process.exit(1);
