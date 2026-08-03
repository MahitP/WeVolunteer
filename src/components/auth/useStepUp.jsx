import React, { useCallback, useRef, useState } from 'react';
import VerifyIdentityModal from './VerifyIdentityModal';
import { openChallenge, withStepUp, takeReadyGrant } from '../../utils/stepUp';

/**
 * Wires a sensitive action to the verification dialog.
 *
 * ── What it hides ──
 *
 * The dialog is a component and the flow is a promise, and joining those two is
 * the whole job. A caller wants to write "do this thing, verifying if asked",
 * not to hold a challenge in state, render a modal conditionally, and thread a
 * resolver through a callback. Every one of the five gated actions would
 * otherwise re-implement that, and the one that got it slightly wrong would leak
 * a resolver and hang the second attempt for ever.
 *
 * ── Two entry points, because there are genuinely two shapes ──
 *
 *   `run(action, params, attempt)` — try, and verify only if the server asks.
 *     Right for the four actions whose request can simply be retried. Trying
 *     first matters: an export that is refused because one is already running,
 *     or a password that fails validation, should say so without first making
 *     the user prove who they are for nothing. The gates are ordered
 *     server-side to allow this — `POST /api/privacy/export` deliberately checks
 *     assurance before its rate limiter so an unverified first attempt does not
 *     spend the allowance.
 *
 *   `verifyFirst(action, params)` — verify, then act.
 *     Required for `oauth.link`, whose grant is spent inside an OAuth callback
 *     arriving mid-redirect. There is no request to retry and no moment to
 *     interrupt, so the proof has to exist before the redirect starts.
 *
 * Both resolve to `undefined`/`null` when the user dismisses the dialog. That is
 * not an error and callers must not toast it: the person declined, which is an
 * outcome the feature is supposed to have.
 */
export function useStepUp() {
  const [challenge, setChallenge] = useState(null);

  /**
   * The pending `verify` promise's resolver.
   *
   * A ref rather than state because resolving it must not depend on a re-render
   * having happened, and because writing it during an event handler and reading
   * it in another is exactly what a ref is for.
   */
  const resolverRef = useRef(null);

  const settle = useCallback((challengeId) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setChallenge(null);
    resolve?.(challengeId);
  }, []);

  /** Shows the dialog for an already-open challenge and waits for the outcome. */
  const present = useCallback((opened) => new Promise((resolve) => {
    // A second request while one is already up would orphan the first promise.
    // Resolving it as a dismissal keeps the caller from hanging.
    resolverRef.current?.(null);
    resolverRef.current = resolve;
    setChallenge(opened);
  }), []);

  const run = useCallback(
    (action, params, attempt) => withStepUp(action, params, attempt, present),
    [present]
  );

  const verifyFirst = useCallback(async (action, params) => {
    // Returning from provider re-consent for this same action: the user has
    // already proved who they are and is pressing the button a second time
    // because that is what the callback asked them to do. Asking again here
    // would be an unbreakable loop for any account whose only method is OAuth.
    const ready = takeReadyGrant(action);
    if (ready) return ready;

    const opened = await openChallenge(action, params);
    return present(opened);
  }, [present]);

  const modal = challenge
    ? (
      <VerifyIdentityModal
        challenge={challenge}
        onGranted={settle}
        onCancel={() => settle(null)}
      />
    )
    : null;

  return { run, verifyFirst, modal, isVerifying: challenge !== null };
}
