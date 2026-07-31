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
    .filter(p => p.enabled || showUnavailable);

  if (rows.length === 0) return null;

  return (
    <div className="auth-providers">
      {rows.map(p => {
        const Button = BUTTONS[p.id];
        if (!Button) return null;

        // Not configured (or not built): visible, clearly unavailable, inert.
        // "Coming soon" reads the same for Microsoft-not-configured and
        // Apple-not-implemented because the difference is ours, not the user's.
        if (!p.enabled) {
          return (
            <Button
              key={p.id}
              text={`${p.label} — coming soon`}
              disabled
              onClick={() => {}}
            />
          );
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
