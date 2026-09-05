import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import GoogleButton from './GoogleButton';
import MicrosoftButton from './MicrosoftButton';
import AppleButton from './AppleButton';

const BUTTONS = {
  google: GoogleButton,
  microsoft: MicrosoftButton,
  apple: AppleButton
};

/**
 * The order the row is always rendered in, regardless of what each provider's
 * status is or what order the server happens to list them in.
 *
 * Order used to be a side effect of availability: the component rendered every
 * `enabled` provider and then every unavailable one, so a disabled provider
 * always sorted last and the sequence changed with the deployment's
 * configuration. Sign-in buttons are muscle memory — they need to be in the
 * same place for everyone.
 */
const PROVIDER_ORDER = ['google', 'microsoft', 'apple'];

/**
 * The "continue with…" row, driven by what the server can actually do.
 *
 * Both auth screens used to hard-code all three buttons. That produced two
 * distinct dead ends:
 *
 *   • Apple was wired to a provider stub whose getAuthUrl returned the string
 *     '#apple-not-yet-implemented', which the caller assigned to
 *     window.location — so on the signup screen the button appeared enabled
 *     and did nothing whatsoever when pressed. (On the login screen the same
 *     button was hard-disabled, so the two screens disagreed.)
 *   • A deployment with no Google credentials still showed a Google button,
 *     and the failure only surfaced after the user had left the site.
 *
 * /api/oauth/providers reports both `implemented` and `enabled`, so an
 * unavailable provider is either shown as explicitly unavailable or not shown
 * at all, and never as a working option that isn't one.
 */
export default function ProviderButtons({ onSelect, disabled, labelFor, showUnavailable = true }) {
  const [providers, setProviders] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchOAuthProviders()
      .then(list => { if (!cancelled) setProviders(list); })
      // A failed probe must not hide the email form behind a spinner forever.
      // An empty list degrades to "email only", which always works.
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, []);

  if (providers === null) {
    // Reserve the height so the email form below does not jump when the
    // buttons arrive — a layout shift under someone's thumb mid-tap.
    return <div className="auth-providers" style={{ minHeight: '132px' }} aria-hidden="true" />;
  }

  /**
   * One ordered pass over PROVIDER_ORDER, rather than an enabled group followed
   * by an unavailable group.
   *
   * The two-group version dropped any provider that was implemented but not
   * configured, because it matched neither `p.enabled` nor
   * `!p.enabled && p.implemented === false`. That is precisely Microsoft on a
   * deployment with no MICROSOFT_CLIENT_ID: the row rendered Google then Apple,
   * with the middle provider silently absent while a less-complete one was still
   * on screen.
   *
   * Availability now only decides how a button LOOKS, never whether it exists or
   * where it sits.
   */
  const rows = PROVIDER_ORDER
    .map(id => providers.find(p => p.id === id))
    .filter(Boolean)
    /**
     * ── `coming_soon` is not shown on a sign-in screen; `misconfigured` is ──
     *
     * The two unusable states are not the same kind of thing, and `showUnavailable`
     * alone could not tell them apart:
     *
     * The test is `implemented`, NOT `state === 'misconfigured'`. Keying on the
     * label was wrong and the suite caught it: `/api/oauth/providers` is public
     * and a cached bundle can outlive a deploy, so a server that predates the
     * `state` field sends `{enabled: false, implemented: true}` with no state at
     * all — and a predicate reading `state` would have hidden a Microsoft that
     * is one environment variable from working, which is the exact regression
     * this file was written for.
     *
     *   not implemented   nothing is built behind it (Apple). Nobody is waiting to
     *                  be told, there is nothing an operator could configure,
     *                  and a disabled button promising a date the product has
     *                  not committed to is a roadmap control in the most-viewed
     *                  screen in the application. A first-time visitor counted
     *                  four ways to sign in and found that two of them were
     *                  decoration.
     *   implemented     built, and THIS deployment has no credentials.
     *                  Kept visible deliberately — see the AADSTS900144 note
     *                  below. A school told "use your school account" needs to
     *                  learn the button is missing because the site is broken,
     *                  not because they misremembered; and the operator sees the
     *                  same screen as everybody else, so it is their only
     *                  signal too.
     *
     * `showUnavailable` still means what it meant: `false` hides every unusable
     * provider, which is what `VerifyIdentityModal` wants because that row is a
     * re-authentication choice rather than a sign-in one. The change is only to
     * what `true` admits.
     */
    .filter(p => p.enabled || (showUnavailable && p.implemented !== false));

  if (rows.length === 0) return null;

  return (
    <div className="auth-providers">
      {rows.map(p => {
        const Button = BUTTONS[p.id];
        if (!Button) return null;

        /**
         * Unusable: visible, clearly so, and inert.
         *
         * These used to share one "coming soon", on the reasoning that the
         * difference between "we have not built it" and "this site has not
         * configured it" is ours rather than the user's. The AADSTS900144
         * incident is the counter-example. "Coming soon" on a provider that is
         * one environment variable away reads as a roadmap item, so nobody
         * treats it as a fault — including the operator, who sees the same
         * screen as everybody else and has no other signal that their own
         * deployment is misconfigured.
         *
         * `not_set_up` says which it is without naming a variable or admitting
         * anything about the deployment a signed-out visitor should not know.
         * `ConnectedAccounts` has drawn the same distinction all along
         * ("Not set up on this site"); this brings the auth screens in line.
         */
        if (!p.enabled) {
          const text = p.state === 'misconfigured'
            ? `${p.label} — not set up on this site`
            : `${p.label} — coming soon`;

          return <Button key={p.id} text={text} disabled onClick={() => {}} />;
        }

        return (
          <Button
            key={p.id}
            text={labelFor ? labelFor(p.label) : undefined}
            disabled={disabled}
            onClick={() => onSelect(p.id)}
          />
        );
      })}
    </div>
  );
}
