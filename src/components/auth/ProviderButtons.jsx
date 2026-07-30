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

  const usable = providers.filter(p => p.enabled);
  const unavailable = showUnavailable ? providers.filter(p => !p.enabled && p.implemented === false) : [];

  if (usable.length === 0 && unavailable.length === 0) return null;

  return (
    <div className="auth-providers">
      {usable.map(p => {
        const Button = BUTTONS[p.id];
        if (!Button) return null;
        return (
          <Button
            key={p.id}
            text={labelFor ? labelFor(p.label) : undefined}
            disabled={disabled}
            onClick={() => onSelect(p.id)}
          />
        );
      })}

      {unavailable.map(p => {
        const Button = BUTTONS[p.id];
        if (!Button) return null;
        return (
          <Button
            key={p.id}
            text={`${p.label} — coming soon`}
            disabled
            onClick={() => {}}
          />
        );
      })}
    </div>
  );
}
