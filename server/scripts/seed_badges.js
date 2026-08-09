import crypto from 'crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The badge catalogue, and the reconciliation that keeps a database matching it.
 *
 * ── What was wrong ──
 *
 * This file used to be a seeder guarded on `existingCount === 0`. Migration
 * `024_features_expansion.js` already seeds seven badges at init, so the count
 * was never zero and this script was permanently inert: the "Silver Award" (25h)
 * and "Gold Award" (50h) rows it defined could not be created on any database,
 * ever. It was also wired into no npm script, so nothing ran it to find out.
 *
 * ── The Silver Award is a MILESTONE, not a badge, and that is the decision ──
 *
 * The 25-hour Silver Award is not defined here any more, and neither is any
 * other hours or events threshold. That is the boundary between this platform's
 * two achievement systems, and it is the whole point of this rewrite:
 *
 *   - MILESTONES (`MILESTONE_TIERS` in `server/milestones.js`) are derived from
 *     the attendance ledger on every read and never stored. They own every
 *     threshold that is a function of the service record — hours and distinct
 *     events. The district's 25-hour Silver Award lives there, and
 *     `SERVICE_HOUR_GOAL` is derived from that tier and served to the client, so
 *     the progress meter in `VolunteerDashboard.jsx` and `VolunteerProfile.jsx`
 *     is drawn against the same number the server judges the milestone by. Both
 *     views used to hold their own `const HOUR_GOAL = 25` instead.
 *
 *   - BADGES are conferred: stored, dated, attributable, revocable. They own
 *     what a milestone cannot honestly express — a reliability ratio, organizer
 *     work, when somebody joined — and anything an administrator grants by hand.
 *
 * Before this, both systems shipped hour thresholds and rendered on the same
 * profile page: a 25-hour "Silver Award" beside a 50-hour "Community Champion",
 * with a 10-hour milestone and a 10-hour "Helping Hand" badge saying the same
 * thing twice under two names. A student could not tell which was their real
 * record. `RETIRED_NAMES` below is how an existing database stops saying it.
 *
 * ── It runs itself; the CLI is for looking ──
 *
 * `initDatabase()` calls `reconcileBadgeCatalogue` on every boot, beside
 * `syncLegalDocuments` and for the same reason — see the note at that call site.
 * There is no manual step, and that is the point: this used to be a hand-run
 * script wired into no npm script, so the duplicate hour badges it exists to
 * retire were still live on every database nobody remembered to run it against,
 * which was all of them.
 *
 * The CLI remains because it PRINTS what changed, which a boot does not:
 *
 *     node server/scripts/seed_badges.js
 *
 * Idempotent, so running it after a boot correctly reports zero of everything
 * (`server/badges.test.js` asserts that, which is how it also asserts that boot
 * already did the work). It upserts by NAME rather than by id, because migration
 * 024 generates a fresh UUID per row per database, so a name is the only stable
 * handle across deployments.
 *
 * It never deletes a `user_badges` row. Retiring a definition sets `active = 0`,
 * which takes it out of `badgeService`'s evaluation in both directions and
 * freezes the awards already made under it. Somebody's earned badge is their
 * history, and a catalogue clean-up is not a reason to take it.
 */

/**
 * Every badge this product ships.
 *
 * Names match the rows migration 024 seeds, so reconciliation UPDATES them
 * rather than creating duplicates alongside them.
 */
export const CONFERRED_CATALOGUE = Object.freeze([
  {
    name: 'Early Supporter',
    description: 'One of the first 250 people to join WeVolunteer.',
    icon: '🌟',
    category: 'Participation',
    criteria_type: 'early_adopter',
    /**
     * The size of the early cohort, as a rank over registration order — see
     * `collectStats` in badgeService for why a rank and not a date.
     *
     * Migration 024 seeds this as 0, which the evaluator reads as "nobody".
     * That fail-closed default is deliberate, and this is the value that turns
     * the badge on.
     */
    criteria_value: 250,
  },
  {
    name: 'Reliable Volunteer',
    description: 'Turned up for at least 90% of the shifts you signed up for.',
    icon: '⭐',
    category: 'Participation',
    criteria_type: 'attendance_rate',
    criteria_value: 90,
  },
  {
    name: 'Organizer',
    description: 'Created a volunteering opportunity for other people.',
    icon: '📋',
    category: 'Leadership',
    criteria_type: 'events_created',
    criteria_value: 1,
  },
  {
    name: 'Community Builder',
    description: 'Created ten volunteering opportunities.',
    icon: '🏗️',
    category: 'Leadership',
    criteria_type: 'events_created',
    criteria_value: 10,
  },
]);

/**
 * Definitions this product used to ship and no longer does.
 *
 * The first four are migration 024's hour thresholds, every one of which
 * duplicates a milestone. The last two are the rows the old version of this
 * script tried and failed to create — listed so that a database seeded by an
 * older copy of it is reconciled too, rather than quietly keeping them.
 */
export const RETIRED_NAMES = Object.freeze([
  'First Step',          // hours ≥ 1   → milestone `first-shift`
  'Helping Hand',        // hours ≥ 10  → milestone `ten-hours`
  'Community Champion',  // hours ≥ 50  → milestone `fifty-hours`
  'Volunteer Legend',    // hours ≥ 100 → milestone `century`
  'Silver Award',        // hours ≥ 25  → milestone `silver`
  'Gold Award',          // hours ≥ 50  → milestone `fifty-hours`
]);

/**
 * Brings one database's `badges` table into line with the catalogue above.
 *
 * @param {object} database an open database handle
 * @returns {{created: number, updated: number, retired: number}}
 */
export function reconcileBadgeCatalogue(database) {
  const summary = { created: 0, updated: 0, retired: 0 };

  const find = database.prepare('SELECT * FROM badges WHERE name = ?');
  const insert = database.prepare(`
    INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const update = database.prepare(`
    UPDATE badges SET description = ?, icon = ?, category = ?,
                      criteria_type = ?, criteria_value = ?, active = 1
    WHERE id = ?
  `);
  const retire = database.prepare('UPDATE badges SET active = 0 WHERE name = ? AND active = 1');

  for (const badge of CONFERRED_CATALOGUE) {
    const existing = find.get(badge.name);
    if (!existing) {
      insert.run(
        `badge-${crypto.randomUUID()}`,
        badge.name, badge.description, badge.icon, badge.category,
        badge.criteria_type, badge.criteria_value, new Date().toISOString()
      );
      summary.created += 1;
      continue;
    }

    /* Only write when something actually differs, so the counts mean "this run
       changed something" — which is what makes the idempotency assertion in
       badges.test.js a real check rather than a tautology. */
    const same = existing.description === badge.description
      && existing.icon === badge.icon
      && existing.category === badge.category
      && existing.criteria_type === badge.criteria_type
      && Number(existing.criteria_value) === badge.criteria_value
      && existing.active === 1;
    if (same) continue;

    update.run(
      badge.description, badge.icon, badge.category,
      badge.criteria_type, badge.criteria_value, existing.id
    );
    summary.updated += 1;
  }

  for (const name of RETIRED_NAMES) {
    summary.retired += retire.run(name).changes;
  }

  return summary;
}

/**
 * CLI entry point.
 *
 * The db import is inside the guard on purpose: `db.js` opens its connection at
 * module scope, so importing it at the top of this file would bind a connection
 * — to whatever `WEV_DB_PATH` happened to say — merely because a test imported
 * `CONFERRED_CATALOGUE`. That is the exact hazard `testServer.js`'s
 * `PRAGMA database_list` assertion exists to catch.
 */
/**
 * ── Why this is not `import.meta.url === \`file://${process.argv[1]}\`` ──
 *
 * That is the idiom, and it silently fails on any path containing a space.
 * `import.meta.url` is a URL, so it percent-encodes: this repository lives under
 * `.../Important Coding Files/New Projects/SBVolunteers App/`, which arrives as
 * `%20` in one string and a literal space in the other. The comparison was
 * therefore always false here — `node server/scripts/seed_badges.js` printed
 * nothing and exited 0, which is the same "looks like it ran" failure that made
 * the original version of this script inert.
 *
 * `fileURLToPath` decodes, and `path.resolve` normalises the argv side, so the
 * two are compared as filesystem paths rather than as one path and one URL.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  /**
   * Wrapped in an async IIFE rather than using top-level `await`.
   *
   * `db.js` imports `reconcileBadgeCatalogue` from this file, so this file is in
   * `db.js`'s module graph — and a graph containing top-level await is an
   * ASYNCHRONOUS module, which `require()` refuses with
   * `ERR_REQUIRE_ASYNC_MODULE`. Node's `require(esm)` support is what lets
   * `ownershipBootstrap.test.js` initialise a throwaway database with
   * `require('./server/db.js')` in a spawned child, and adding the import turned
   * every one of its nine cases into "no such table: users" — the child died
   * before creating anything, and nothing was checking that it had not.
   *
   * The IIFE keeps the deferred import (which is the point: importing `db.js` at
   * the top of this file would open a connection to whatever `WEV_DB_PATH`
   * happened to say, merely because a test wanted `CONFERRED_CATALOGUE`) while
   * leaving this module synchronous to its importers.
   */
  (async () => {
    const { db, initDatabase } = await import('../db.js');
    initDatabase();
    const summary = reconcileBadgeCatalogue(db);
    console.log(
      `Badge catalogue reconciled: ${summary.created} created, `
      + `${summary.updated} updated, ${summary.retired} retired.`
    );
  })();
}
