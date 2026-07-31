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
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyLedgerParity } from './hoursLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2]
  || process.env.WEV_DB_PATH
  || path.join(__dirname, 'wevolunteer.db');

const db = new DatabaseSync(dbPath);

const hasLedger = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hours_ledger'"
).get();

if (!hasLedger) {
  console.error(`No hours_ledger table in ${dbPath}. Start the server once to create and backfill it.`);
  process.exit(1);
}

const parity = verifyLedgerParity(db);

const totals = db.prepare(`
  SELECT u.name, COALESCE(SUM(CASE WHEN a.present = 1 THEN a.hours_awarded END), 0) AS hours
  FROM users u
  LEFT JOIN attendance a ON a.user_id = u.id
  WHERE u.role = 'student'
  GROUP BY u.id
  HAVING hours > 0
  ORDER BY hours DESC, u.name ASC
`).all();

console.log(`Database: ${dbPath}`);
console.log(`Ledger entries: ${db.prepare('SELECT COUNT(*) c FROM hours_ledger').get().c}`);
console.log(`Attendance rows: ${db.prepare('SELECT COUNT(*) c FROM attendance').get().c}`);
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
