/**
 * Draft-and-Confirm Lifecycle Manager for Welly mutations.
 *
 * ── Safety Invariants ──
 *
 * 1. No mutating tool executes immediately upon first request.
 * 2. Every consequential action creates an explicit, immutable Draft first.
 * 3. The user must explicitly confirm ("yes", "confirm", "do it") while the draft is active.
 * 4. Drafts are bound to the authenticated user's ID — a draft created by User A
 *    cannot be confirmed or executed if the session changes to User B.
 * 5. Stale confirmations or "yes" said in ordinary conversation without an active
 *    matching draft will never trigger any action.
 * 6. After confirmation, the draft is immediately consumed (single execution).
 * 7. A write tool runs through `runConfirmedDraft` and nothing else — `runTool`
 *    refuses one — and only with a draft object this module confirmed.
 */

import { clearEventDraft } from './eventDraft.js';
import { TOOLS } from './tools.js';
import { can } from '../authz.js';

const DRAFT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

let activeDraft = null;

/**
 * Drafts `confirmDraft` has handed out that have not run yet.
 *
 * By identity, so the proof of a confirmation is the object itself: a draft
 * still pending, or one described by hand with the right tool and arguments, is
 * not in here and does not run. Weak, so a confirmation nobody executes holds
 * nothing alive.
 */
const confirmedDrafts = new WeakSet();

/**
 * Deeply freezes an object and all nested properties.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Object.isFrozen(obj[key])) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

/**
 * Deep clone and freeze an object to prevent prototype tampering or parameter mutation.
 */
function safeCloneAndFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  try {
    const cloned = JSON.parse(JSON.stringify(obj));
    return deepFreeze(cloned);
  } catch {
    return deepFreeze({ ...obj });
  }
}

/**
 * Create a new pending draft. Replaces any previous unconfirmed draft.
 */
export function createDraft({
  tool,
  args = {},
  preview = '',
  summary = '',
  user = null,
  expiresInMs = DRAFT_EXPIRY_MS,
}) {
  if (!tool) throw new Error('createDraft requires a tool name');

  const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  activeDraft = Object.freeze({
    id,
    tool,
    args: safeCloneAndFreeze(args),
    preview: String(preview || ''),
    summary: String(summary || preview || ''),
    userId: user?.id ? String(user.id) : null,
    userRole: user?.role ? String(user.role) : null,
    createdAt: now,
    expiresAt: now + expiresInMs,
  });

  return activeDraft;
}

/**
 * Retrieve the current pending draft if still valid and user matches.
 */
export function getPendingDraft(draftId = null, { user = null } = {}) {
  if (!activeDraft) return null;

  if (Date.now() > activeDraft.expiresAt) {
    activeDraft = null;
    return null;
  }

  /* Reject session mismatch across account switches */
  if (user?.id && activeDraft.userId && String(user.id) !== activeDraft.userId) {
    return null;
  }

  if (draftId && activeDraft.id !== draftId) {
    return null;
  }

  return activeDraft;
}

/**
 * Update an existing active draft's arguments (e.g. conversational field corrections).
 */
export function updateActiveDraft(updatedArgs, { user = null, preview = null, summary = null } = {}) {
  const current = getPendingDraft(null, { user });
  if (!current) return null;

  const mergedArgs = { ...current.args, ...updatedArgs };
  const now = Date.now();

  activeDraft = Object.freeze({
    ...current,
    args: safeCloneAndFreeze(mergedArgs),
    preview: preview ? String(preview) : current.preview,
    summary: summary ? String(summary) : current.summary,
    expiresAt: now + DRAFT_EXPIRY_MS,
  });

  return activeDraft;
}

/**
 * Confirm and claim the pending draft for execution.
 */
export function confirmDraft(draftId = null, { user = null } = {}) {
  if (!activeDraft) {
    return { ok: false, reason: 'no_pending_draft' };
  }

  if (Date.now() > activeDraft.expiresAt) {
    activeDraft = null;
    return { ok: false, reason: 'draft_expired' };
  }

  /* Reject confirmation if the current signed-in user does not match the draft author */
  if (user?.id && activeDraft.userId && String(user.id) !== activeDraft.userId) {
    return { ok: false, reason: 'user_mismatch' };
  }

  if (draftId && activeDraft.id !== draftId) {
    return { ok: false, reason: 'draft_mismatch' };
  }

  const draft = activeDraft;
  activeDraft = null; // Atomically consume the draft
  confirmedDrafts.add(draft);
  return { ok: true, draft };
}

/**
 * Run the write a person has just confirmed.
 *
 * Takes the draft `confirmDraft` returned rather than a tool name and
 * arguments, because a name and arguments are something any caller can supply
 * and a confirmed draft is not. Runs it once: the second call with the same
 * draft is a second change nobody agreed to.
 *
 * The capability is checked again with the person confirming. A draft is a
 * record of what was asked for, not a permission, and the server checks a
 * third time. The two lines of that check repeat `runTool`'s on purpose —
 * sharing them would mean exporting a runner that skips the confirmation, which
 * is the thing this exists to remove.
 */
export async function runConfirmedDraft(draft, { user = null } = {}) {
  if (!draft || !confirmedDrafts.has(draft)) return { ok: false, reason: 'confirmation_required' };
  confirmedDrafts.delete(draft);

  /* Invariant 4, at the moment of execution as well as of confirmation. */
  if (user?.id && draft.userId && String(user.id) !== draft.userId) {
    return { ok: false, reason: 'confirmation_required' };
  }

  const tool = TOOLS[draft.tool];
  if (!tool) return { ok: false, reason: 'unknown_tool' };
  if (tool.capability && !can(user, tool.capability)) return { ok: false, reason: 'not_allowed' };

  return tool.run(draft.args, { user });
}

/**
 * Cancel the active draft.
 */
export function cancelDraft(draftId = null, { user = null } = {}) {
  if (!activeDraft) return { ok: false, reason: 'no_pending_draft' };

  if (user?.id && activeDraft.userId && String(user.id) !== activeDraft.userId) {
    return { ok: false, reason: 'user_mismatch' };
  }

  if (!draftId || activeDraft.id === draftId) {
    const cancelled = activeDraft;
    activeDraft = null;
    return { ok: true, draft: cancelled };
  }

  return { ok: false, reason: 'draft_mismatch' };
}

/**
 * Clear every piece of pending write state (used for test teardown).
 *
 * The half-finished event collection goes with it. The two are one lifecycle
 * seen at two stages — an event being gathered, then the finished payload
 * waiting for a yes — and a teardown that reset only the second would leave a
 * collection alive across tests, silently swallowing the next file's messages
 * as answers to a question nobody asked. Every existing caller of this function
 * already means "forget what Welly was in the middle of".
 */
export function clearDraft() {
  activeDraft = null;
  clearEventDraft();
}
