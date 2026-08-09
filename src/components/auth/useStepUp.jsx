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
 * ── Three entry points, because there are genuinely three shapes ──
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
 *   `verifyOnceFor([{ action, params }, …])` — verify ONCE, act more than once.
 *     For an operation the server splits into several gated actions that the
 *     person performing it experiences as one. Enrolling an authenticator is
 *     the case it was written for: `2fa.generate` produces the QR code and
 *     `2fa.enable` confirms the first code from the app, and asking for the
 *     password twice put the second prompt AFTER a 30-second TOTP code had been
 *     typed — so the code expired while the user found their password, and
 *     enrolment failed on a code that was correct when it was entered.
 *
 * Every one of them resolves to `undefined`/`null` when the user dismisses the
 * dialog. That is not an error and callers must not toast it: the person
 * declined, which is an outcome the feature is supposed to have.
 */
export function useStepUp() {
  /**
   * What the dialog is currently asking for: one open challenge to answer, plus
   * any further open challenges the same answer should also grant.
   *
   * One piece of state rather than two, because the pair is only ever set and
   * cleared together and two `useState`s would let a re-render observe a
   * challenge with the previous prompt's extras attached to it.
   */
  const [prompt, setPrompt] = useState(null);

  /**
   * The pending `verify` promise's resolver.
   *
   * A ref rather than state because resolving it must not depend on a re-render
   * having happened, and because writing it during an event handler and reading
   * it in another is exactly what a ref is for.
   */
  const resolverRef = useRef(null);

  const settle = useCallback((challengeId, extras = {}) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    resolve?.({ challengeId, extras });
  }, []);

  /**
   * Shows the dialog for an already-open challenge and waits for the outcome.
   *
   * Resolves `{ challengeId, extras }` — always the same shape, so a caller
   * cannot forget which entry point returns which. `challengeId` is null when
   * the user dismissed it.
   */
  const promptFor = useCallback((opened, alsoGrant = [], spec = null) => new Promise((resolve) => {
    // A second request while one is already up would orphan the first promise.
    // Resolving it as a dismissal keeps the caller from hanging.
    resolverRef.current?.({ challengeId: null, extras: {} });
    resolverRef.current = resolve;
    setPrompt({ challenge: opened, alsoGrant, spec });
  }), []);

  /** The single-challenge shape `withStepUp` and `verifyFirst` expect. */
  const present = useCallback(
    async (opened, spec = null) => (await promptFor(opened, [], spec)).challengeId,
    [promptFor]
  );

  /**
   * `withStepUp` hands `present` the opened challenge and nothing else, so the
   * action and params it used are re-attached here. The dialog needs them to
   * reopen an expired challenge without showing the user a deadline — see the
   * header in VerifyIdentityModal.jsx.
   */
  const run = useCallback(
    (action, params, attempt) => withStepUp(
      action,
      params,
      attempt,
      opened => present(opened, { action, params })
    ),
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
    return present(opened, { action, params });
  }, [present]);

  /**
   * One verification covering several actions.
   *
   * @param {{action: string, params?: object}[]} specs - in the order the
   *   requests will be made. The FIRST is the challenge the dialog is presented
   *   for, so its label is the sentence the user reads; put the action that
   *   describes the whole operation first.
   * @returns {Promise<Record<string,string>|null>} a map of action → challenge
   *   id for every grant obtained, or null if the user dismissed the dialog.
   *
   * A map, not an array, because the caller reads it back by action name and a
   * positional result is the kind of thing that silently survives reordering
   * the specs.
   *
   * The map may be missing an action. Only the primary challenge is answered by
   * the provider leg (a redirect can only return to one), and an extra can
   * expire independently — so a caller must treat a missing entry as "verify
   * again for this one", which `run` does on its own if the request is simply
   * attempted without a grant.
   */
  const verifyOnceFor = useCallback(async (specs) => {
    const grants = {};
    const needed = [];

    for (const spec of specs) {
      // A grant already earned at a provider moments ago, on the other side of
      // a redirect. Spending it is the difference between "press the button
      // again" and "prove who you are again for the same thing you just proved".
      const ready = takeReadyGrant(spec.action);
      if (ready) grants[spec.action] = ready;
      else needed.push(spec);
    }

    if (needed.length === 0) return grants;

    /**
     * Every challenge is opened BEFORE the dialog goes up.
     *
     * The dialog has to know the full set when it renders, because it grants
     * them from one submit handler. Opening them lazily afterwards would mean
     * the second one is created while the password is in flight, and a grant is
     * only valid for five minutes from creation — so the later it is opened the
     * longer the user has, which is the wrong way round: the extras are the ones
     * spent last.
     */
    const opened = [];
    for (const spec of needed) {
      opened.push({ action: spec.action, challenge: await openChallenge(spec.action, spec.params ?? {}) });
    }

    const [primary, ...extras] = opened;
    const primarySpec = needed.find(n => n.action === primary.action);
    const { challengeId, extras: granted } = await promptFor(
      primary.challenge,
      extras.map(e => ({ action: e.action, challengeId: e.challenge.challengeId })),
      { action: primary.action, params: primarySpec?.params ?? {} }
    );

    // Dismissed. The caller returns to what it was showing; nothing was spent.
    if (!challengeId) return null;

    grants[primary.action] = challengeId;
    for (const extra of extras) {
      if (granted[extra.action]) grants[extra.action] = granted[extra.action];
    }
    return grants;
  }, [promptFor]);

  /**
   * Opens a replacement challenge for the SAME action and arguments.
   *
   * Handed to the dialog so that a grant which expired while the user was finding
   * their password is replaced silently rather than reported. It cannot broaden
   * anything: the action and params are the ones this hook was called with, the
   * server re-derives the account's methods, and the new challenge is bound to the
   * same session like any other.
   */
  const reopen = useCallback(async () => {
    if (!prompt?.spec?.action) return null;
    return openChallenge(prompt.spec.action, prompt.spec.params ?? {});
  }, [prompt]);

  const modal = prompt
    ? (
      <VerifyIdentityModal
        challenge={prompt.challenge}
        alsoGrant={prompt.alsoGrant}
        onGranted={settle}
        onCancel={() => settle(null)}
        onReopen={reopen}
      />
    )
    : null;

  return { run, verifyFirst, verifyOnceFor, modal, isVerifying: prompt !== null };
}
