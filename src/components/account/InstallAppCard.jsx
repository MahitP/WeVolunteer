import React, { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import { detectIOS } from '../../ai/capability';
import { installState, subscribeInstall, promptInstall } from '../../utils/installPrompt';

/** Already opened from the home screen or as an installed window. */
function isStandalone() {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch { /* no matchMedia */ }
  return window.navigator?.standalone === true;
}

/**
 * "Add to Home Screen" (P2-05, ruling 9).
 *
 * The owner asked for one. He ruled: an install button where the browser
 * offers installation, short instructions on iPhone and iPad, where Safari has
 * no prompt — and no service worker, so nothing about how pages load or cache
 * changes. Installing gives WeVolunteer its own icon and window; it does not
 * make it work offline, and this card does not say it does.
 *
 * The button appears only once the browser has said the app can be installed.
 * One that appeared anyway would sometimes do nothing.
 *
 * @param {object} [props]
 * @param {Navigator} [props.nav]  injectable for tests; defaults to `navigator`
 */
export default function InstallAppCard({ nav = typeof navigator !== 'undefined' ? navigator : {} }) {
  const [state, setState] = useState(installState);
  useEffect(() => subscribeInstall(() => setState(installState())), []);

  const standalone = isStandalone();
  const ios = detectIOS(nav);

  if (!standalone && !state.installed && !state.prompt && !ios) return null;

  return (
    <div className="card card-pad stack-sm install-card">
      <h3>Install WeVolunteer</h3>
      {standalone || state.installed ? (
        <p className="dim small">
          {standalone
            ? 'You are using the installed app.'
            : 'WeVolunteer is installed. Open it from your home screen or apps.'}
        </p>
      ) : state.prompt ? (
        <>
          <p className="dim small">
            Open WeVolunteer from its own icon, in its own window. It still needs an internet
            connection, the same as in the browser.
          </p>
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => promptInstall()}>
              <Download size={15} aria-hidden="true" /> Install WeVolunteer
            </button>
          </div>
        </>
      ) : (
        <p className="dim small">
          On iPhone and iPad: tap <Share size={13} aria-label="Share" className="install-share-glyph" /> Share
          in Safari, then <span className="strong">Add to Home Screen</span>. WeVolunteer opens from its
          own icon after that; it still needs an internet connection.
        </p>
      )}
    </div>
  );
}
