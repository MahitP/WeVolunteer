/**
 * Is administration paused on this account?
 *
 * ── Why this is a shared function and not two `includes` calls ──
 *
 * Two parts of the same screen answer this question: `ModerationCenter` decides
 * whether to render the acceptance gate or the tiles, and `pageMetaFor` decides
 * what the topbar says above them. They were written separately, and the bug
 * that produced this file is what happened when only one of them knew: the
 * topbar read "Every administrative area you can open" over a page saying
 * administration is paused.
 *
 * Fixing that by adding a second copy of the derivation would have rebuilt the
 * same failure — two independent answers to one question, correct only for as
 * long as nobody edits one of them. So there is one answer, here.
 *
 * ── Why `report.resolve` ──
 *
 * The Admin Responsibilities Policy withholds fourteen capabilities. This is the
 * one the Admin route and rail entry are gated on, so its presence in `withheld`
 * is precisely the question "is this account's administration switched off" —
 * any of the other thirteen would answer a narrower question.
 *
 * ── What this is not ──
 *
 * A layout signal, never an authorization one. `withheld` arrives from
 * `/api/auth/me` and is as trustworthy as anything else the client holds, which
 * is to say not at all: the server withholds the capability itself and refuses
 * these routes regardless of what this returns. Reading it here only decides
 * what to draw, and drawing the wrong thing is a cosmetic bug, not a breach.
 */
export function adminIsPaused(user) {
  return (user?.withheld ?? []).includes('report.resolve');
}
