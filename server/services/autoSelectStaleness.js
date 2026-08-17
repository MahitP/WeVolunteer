/**
 * Whether a recorded Auto Select run can still be applied exactly as drawn.
 *
 * ── The problem ──
 *
 * A draw reads capacity, picks a set, and files it. Confirmation happens later —
 * possibly much later, and always after the organizer has looked at the list.
 * Between those two moments the world can move: somebody is accepted by hand,
 * somebody withdraws, a slot fills up. Until this existed, `applyRun` accepted
 * the recorded ids regardless, which could push a slot past `max_spots`.
 *
 * ── The decision this implements (owner, 2026-08-16) ──
 *
 * Refuse a stale run. Do not truncate it, and do not over-allocate.
 *
 * The organizer pressed confirm on a specific reviewed list. Accepting a smaller
 * subset silently breaks the thing they were shown; accepting all of it breaks
 * the capacity promise the event makes to itself. Refusing preserves both and
 * asks for a fresh draw, which is cheap — a draw is a pure read.
 *
 * ── Why this is a pure function ──
 *
 * The rule is engine-independent; only the gathering differs. PostgreSQL needs a
 * row lock and returns promises, SQLite needs neither. Keeping the decision
 * separate from the fetching means **the rule is written and tested once**, and
 * the PostgreSQL concurrency tests exercise the same code the product runs
 * rather than a re-implementation of it that might disagree.
 */

/**
 * Machine-readable outcomes. The UI turns `stale_run` into "this draw is out of
 * date; please run Auto Select again", so the code is part of the contract and
 * is asserted in tests rather than matched on a message.
 */
export const RUN_STALE = 'stale_run';

/** Why a run went stale. Reported so the message can be specific about it. */
export const STALE_REASONS = Object.freeze({
  CAPACITY_CONSUMED: 'capacity_consumed',
  APPLICANT_UNAVAILABLE: 'applicant_unavailable',
  SLOT_MISSING: 'slot_missing',
});

/**
 * @param {object} state
 * @param {Array<{id: string, slotId: string|null, status: string|null}>} state.selections
 *   One entry per id in the run's `selected_ids`, as they exist NOW. A selection
 *   whose application has vanished arrives with `status: null`.
 * @param {Map<string, {maxSpots: number, acceptedNow: number}>} state.slots
 *   Current capacity state for every slot the selection touches.
 * @returns {{ok: true} | {ok: false, code: string, reason: string, detail: object}}
 */
export function verifyRunStillApplies({ selections, slots }) {
  /**
   * An empty selection is honourable, not stale.
   *
   * A draw where every applicant was waitlisted selects nobody, and confirming
   * it is a real action — it moves those applicants into `waitlisted` with their
   * queue positions. Treating "nothing to accept" as a failure would make that
   * run unconfirmable for ever.
   */
  if (selections.length === 0) return { ok: true };

  /**
   * Every selected application must still be pending.
   *
   * Checked before capacity, deliberately. If somebody withdrew, the honest
   * answer is "your list is out of date", not "the slot is full" — and a
   * withdrawn applicant must never be resurrected into `accepted` by a run that
   * happens to still fit.
   */
  for (const sel of selections) {
    if (sel.status !== 'pending') {
      return {
        ok: false,
        code: RUN_STALE,
        reason: STALE_REASONS.APPLICANT_UNAVAILABLE,
        detail: {
          applicationId: sel.id,
          /* `null` means the row is gone entirely — a deleted event or a purged
             account. Reported as-is rather than flattened to a string, so the
             caller can tell "withdrawn" from "no longer exists". */
          currentStatus: sel.status,
        },
      };
    }
  }

  /** How many of the selection land in each slot. */
  const wanted = new Map();
  for (const sel of selections) {
    wanted.set(sel.slotId, (wanted.get(sel.slotId) ?? 0) + 1);
  }

  for (const [slotId, count] of wanted) {
    const slot = slots.get(slotId);

    /* A slot that has disappeared cannot be checked against, and accepting into
       it would be accepting into nothing. */
    if (!slot) {
      return {
        ok: false, code: RUN_STALE, reason: STALE_REASONS.SLOT_MISSING,
        detail: { slotId },
      };
    }

    /**
     * The capacity rule, stated once.
     *
     * `acceptedNow` is read at confirmation time under the row lock, so it
     * already includes anybody accepted since the draw. If the recorded
     * selection no longer fits beside them, the run cannot be honoured exactly.
     */
    if (slot.acceptedNow + count > slot.maxSpots) {
      return {
        ok: false,
        code: RUN_STALE,
        reason: STALE_REASONS.CAPACITY_CONSUMED,
        detail: {
          slotId,
          maxSpots: slot.maxSpots,
          acceptedNow: slot.acceptedNow,
          selected: count,
          /* What the organizer would have to lose for the run to fit. Included
             so the message can say how far out of date the draw is. */
          overBy: (slot.acceptedNow + count) - slot.maxSpots,
        },
      };
    }
  }

  return { ok: true };
}

/**
 * The human-facing sentence for a verdict, kept beside the codes so the two
 * cannot drift. The UI is expected to use `code`; this is the fallback text and
 * what appears in a server log.
 */
export function staleRunMessage(verdict) {
  switch (verdict.reason) {
    case STALE_REASONS.CAPACITY_CONSUMED:
      return 'Spots were filled after this draw was made, so it no longer fits. '
        + 'Run Auto Select again to draw against the current openings.';
    case STALE_REASONS.APPLICANT_UNAVAILABLE:
      return 'One of the selected volunteers is no longer available for this draw. '
        + 'Run Auto Select again to draw from the current applicants.';
    case STALE_REASONS.SLOT_MISSING:
      return 'A shift in this draw no longer exists. Run Auto Select again.';
    default:
      return 'This draw is out of date. Run Auto Select again.';
  }
}
