import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The warning for DEMO_MODE over a database that already has accounts.
 *
 * ── The gap this closes ──
 *
 * `db.js` has always warned, very loudly, when DEMO_MODE seeds an EMPTY
 * database. The dangerous case is the opposite one and it was silent: a real
 * database, populated weeks earlier, served by somebody running `npm run dev`
 * because that is the command they remember. It printed "Database already
 * initialized." and nothing else.
 *
 * DEMO_MODE is not cosmetic — it exempts `admin@example.gov` from the two-factor
 * policy, and that account's password is published in the README. So a pilot
 * database served in demo mode has an administrator behind a known password and
 * no second factor, with nothing on the console saying so.
 *
 * ── Why a subprocess ──
 *
 * `db.js` opens its database and runs this branch at MODULE SCOPE, so the
 * behaviour cannot be observed by importing it twice with different environments
 * in one process. Each case below boots a real Node process against a throwaway
 * file and reads what it printed — the same technique `ownershipBootstrap` and
 * `config.oauthRedirect` use, and for the same reason.
 */

/** Boots db.js once against `dbPath` with the given environment. */
function boot(dbPath, env) {
  /* Both halves of the boot, explicitly: importing db.js opens the connection
     but runs neither. `initDatabase()` is where the warning under test lives;
     `completeDatabaseInit()` is where the demo seed lives, and the fixture below
     needs a seeded database to have something for the second boot to warn
     about. (The seed moved there when PostgreSQL arrived — it writes rows, and
     rows cannot be written from a synchronous function on an async engine.)
     `server.js` is what normally calls both, and booting the whole server here
     would drag in a listener, the workers and the instance lock for a console
     assertion. */
  const res = spawnSync(process.execPath, ['-e', `
    import('./server/db.js').then(async (m) => {
      m.initDatabase();
      await m.completeDatabaseInit();
      process.exit(0);
    }).catch(e => {
      console.error('IMPORT_FAILED: ' + e.message);
      process.exit(1);
    });
  `], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, WEV_DB_PATH: dbPath, NODE_ENV: 'development', ...env },
  });
  return `${res.stdout}\n${res.stderr}`;
}

/**
 * Seeds a throwaway database, then boots it a second time.
 *
 * The first boot is what makes the second one the case under test: a database
 * that already has accounts. Returns the SECOND boot's output.
 */
function secondBootOutput(env) {
  const dir = mkdtempSync(join(tmpdir(), 'wev-demo-warn-'));
  const dbPath = join(dir, 'test.db');
  try {
    const first = boot(dbPath, { DEMO_MODE: 'true' });
    expect(first, 'fixture: the first boot did not seed').toContain('Seeding complete.');
    return boot(dbPath, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('DEMO_MODE over a database that already has accounts', () => {
  it('warns, and names the exempt administrator', () => {
    const out = secondBootOutput({ DEMO_MODE: 'true' });

    expect(out, 'the second boot did not report the database as already initialized')
      .toContain('Database already initialized.');
    /* Matched on a phrase that fits inside one line of the box. The message
       wraps, so an assertion spanning the wrap would break on any rewording of
       the copy rather than on the warning disappearing — which is what this is
       actually testing. */
    expect(out, 'DEMO_MODE over existing accounts produced no warning')
      .toMatch(/DEMO_MODE is ON over a database/);
    /* Naming the account is the point — "demo relaxations apply" is not
       actionable, "admin@example.gov is exempt and its password is published" is. */
    expect(out).toContain('admin@example.gov');
    /* `EXEMPT` alone, and `2FA policy` alone. The box wraps its text at a fixed
       width, so "EXEMPT from the 2FA policy" straddles a newline — a regex
       written across the wrap fails whenever the copy is reflowed, which is not
       what this test is for. Both fragments would have to disappear for the
       warning to have stopped saying what it must say. */
    expect(out).toMatch(/is EXEMPT from the/);
    expect(out).toMatch(/2FA policy while DEMO_MODE is set/);
  });

  /**
   * Silent without DEMO_MODE, which is the ordinary production boot.
   *
   * A warning that fires either way is one an operator stops reading, and this
   * one has to be readable on the day it matters.
   */
  it('says nothing when DEMO_MODE is off', () => {
    const out = secondBootOutput({ DEMO_MODE: 'false' });

    expect(out).toContain('Database already initialized.');
    expect(out).not.toMatch(/DEMO_MODE is ON over a database/);
    /* The SAME fragment the positive case asserts, not the unwrapped sentence.
       `/EXEMPT from the 2FA/` straddles the box's line break and therefore never
       matches anything — as a negative assertion it would pass whether or not
       the warning printed, which is the quietest way for a test to stop testing. */
    expect(out).not.toMatch(/is EXEMPT from the/);
  });

  /**
   * It does not replace the seeding warning, which covers the other case.
   *
   * Two warnings for two different situations: this one is about accounts that
   * were already there, that one about accounts being created now.
   */
  it('leaves the empty-database seeding warning alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wev-demo-seed-'));
    try {
      const out = boot(join(dir, 'fresh.db'), { DEMO_MODE: 'true' });
      expect(out).toMatch(/seeding demo accounts into an empty database/i);
      expect(out).not.toMatch(/DEMO_MODE is ON over a database/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
