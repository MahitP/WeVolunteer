/**
 * The rules an external-hours entry has to satisfy, with no dependencies.
 *
 * ── Why this is its own module ──
 *
 * These rules were inside `routes/externalHoursRoutes.js`, which imports the
 * database. That put them out of reach of anything in `src/` —
 * `serverModuleBoundary.test.js` refuses a client import of a server module
 * that touches the database, and rightly so.
 *
 * Certificate import needs them. It reads a date and an hours figure out of a
 * document and has to decide, before showing anything to a student, whether
 * what it found is usable — and the answer must be the same answer the server
 * will give on submit. The alternative was copying `24`, `200` and the date
 * pattern into the client, which this repository forbids for the reason
 * `src/organizationTags.js` records: a copied rule silently stops matching the
 * original, and the bug surfaces as data being quietly refused or quietly
 * accepted.
 *
 * So the rules move here, unchanged, and both sides import them. The route
 * re-exports `validateExternalHours` so its own callers and tests are
 * unaffected, and `src/externalHoursRules.js` re-exports it for the client.
 *
 * Nothing was altered in the move. The existing suite is the evidence.
 */

export const ACTIVITY_MAX = 200;
export const ORGANIZATION_MAX = 200;
export const DESCRIPTION_MAX = 2000;

/**
 * The ceiling on a single entry.
 *
 * Not a guess: a day has 24 hours, and one external record describes one
 * activity on one date. The bound exists because an unbounded REAL from a form
 * is how a volunteer log ends up claiming 100000 hours — which would be
 * obviously wrong to a person and completely invisible to a SUM.
 */
export const HOURS_MAX = 24;

export function validateExternalHours(payload, { partial = false } = {}) {
  const out = {};
  const need = (key) => !partial || payload[key] !== undefined;

  if (need('organizationName')) {
    if (typeof payload.organizationName !== 'string' || !payload.organizationName.trim()) {
      return { ok: false, field: 'organizationName', error: 'Who did you volunteer with?' };
    }
    if (payload.organizationName.length > ORGANIZATION_MAX) {
      return { ok: false, field: 'organizationName', error: `That must be ${ORGANIZATION_MAX} characters or fewer.` };
    }
    out.organizationName = payload.organizationName.trim();
  }

  if (need('activityName')) {
    if (typeof payload.activityName !== 'string' || !payload.activityName.trim()) {
      return { ok: false, field: 'activityName', error: 'Give the activity a name.' };
    }
    if (payload.activityName.length > ACTIVITY_MAX) {
      return { ok: false, field: 'activityName', error: `That must be ${ACTIVITY_MAX} characters or fewer.` };
    }
    out.activityName = payload.activityName.trim();
  }

  if (payload.description !== undefined) {
    if (payload.description !== null && typeof payload.description !== 'string') {
      return { ok: false, field: 'description', error: 'The description must be text.' };
    }
    const d = payload.description ?? '';
    if (d.length > DESCRIPTION_MAX) {
      return { ok: false, field: 'description', error: `The description must be ${DESCRIPTION_MAX} characters or fewer.` };
    }
    out.description = d;
  }

  if (need('occurredOn')) {
    const raw = payload.occurredOn;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
      return { ok: false, field: 'occurredOn', error: 'Pick the date you volunteered.' };
    }
    /**
     * A future date is refused.
     *
     * An external record is a report of something that already happened. A date
     * in the future is either a typo or a claim about work not yet done, and
     * both are better caught at the form than discovered in a service record.
     * Compared as date strings against today's, so a shift earlier today is
     * still accepted regardless of the server's clock time.
     */
    if (raw > new Date().toISOString().slice(0, 10)) {
      return { ok: false, field: 'occurredOn', error: 'That date is in the future.' };
    }
    out.occurredOn = raw;
  }

  if (need('hours')) {
    const h = Number(payload.hours);
    if (!Number.isFinite(h) || h <= 0) {
      return { ok: false, field: 'hours', error: 'Enter how many hours you volunteered.' };
    }
    if (h > HOURS_MAX) {
      return { ok: false, field: 'hours', error: `A single entry cannot be more than ${HOURS_MAX} hours. Split it across the days you worked.` };
    }
    out.hours = Number(h.toFixed(2));
  }

  return { ok: true, value: out };
}
