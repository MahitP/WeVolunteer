import { MILESTONE_TIERS } from './milestones.js';

/**
 * The founder's demonstration showcase (ruling 19, 2026-10-04).
 *
 * The owner asked for "every badge, achievement, hour and streak" on his real
 * account, so the page shows what the platform can award. Planned first as
 * real attendance rows carrying a marker; the owner chose this instead, drawn
 * on the profile and nowhere else:
 *
 *   • it is DEFINITIONS — every active badge and every milestone tier — and no
 *     award. Nothing goes into `attendance` or `user_badges`, so the transcript,
 *     certificates, /verify, the impact figures and every other reader of the
 *     record need no exclusion: there is nothing for them to exclude. The
 *     marker would have had to be remembered in 26 files, and in every query
 *     written after them.
 *   • there is no `earned_at` and no hours figure. A date is a claim that
 *     something was earned on it, and a number of hours under a person's name
 *     is the thing the transcript exists to make trustworthy.
 *
 * Who gets it is `distinction.showcase`, set for the founder alone
 * (`OWNER_IDENTITIES`, profileSerializer.js). The client labels it a
 * demonstration wherever it renders it.
 *
 * Takes the handle rather than importing db.js, so the serializer and the
 * profile route can share it (db.accessSurface).
 */
export async function demonstrationShowcase(db) {
  const badges = await db.prepare(`
    SELECT id, name, description, icon, category, criteria_type, criteria_value
      FROM badges
     WHERE active = 1
     ORDER BY category, criteria_value, name
  `).all();
  return {
    badges,
    milestones: MILESTONE_TIERS.map(({ id, label, hint, metric, threshold }) => ({
      id, label, hint, metric, threshold,
    })),
  };
}
