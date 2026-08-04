import React from 'react';
import { Link } from 'react-router-dom';
import { SearchX, ShieldOff, AlertTriangle, RotateCw } from 'lucide-react';

/**
 * The 404, 403 and 500 pages — one component, three kinds.
 *
 * ── Why one component ──
 *
 * Three near-identical files drift. The differences between these pages are a
 * heading, a sentence and two links; everything else — the card, the spacing,
 * the tone — is shared, and the moment they are separate files only one of them
 * gets updated.
 *
 * ── Why these replaced redirects ──
 *
 * All three states previously rendered `<Navigate to="/" replace />`. A redirect
 * is the worst possible answer to each of them, for the same reason: it destroys
 * the information the person needed.
 *
 *   - A typo'd or dead link silently became the dashboard, so nobody could tell
 *     a broken link from a working one.
 *   - A denied route bounced to the dashboard with no explanation, which is
 *     precisely why "nothing happens when I click it" reports exist — the click
 *     DID do something, it just refused to say so.
 *
 * ── No error id, deliberately ──
 *
 * A code the reader cannot use is noise, and asking a fourteen-year-old to quote
 * a UUID is not a support process. The server already has the fingerprint; the
 * person needs a way forward, not a reference number.
 *
 * ── Styling ──
 *
 * Existing classes only (`card`, `stack-sm`, `lead`, `row`, `btn`), with spacing
 * and colour from design tokens through inline styles — the same shape
 * `ErrorBoundary` already uses. No new class is introduced, which is deliberate:
 * `noDanglingClasses.test.js` fails in BOTH directions, so a new class needs a
 * rule in `src/index.css` and a rule needs a reference, and none of that is
 * worth it for three pages that reuse the card the rest of the app uses.
 * `noHardcodedColors.test.js` forbids colour literals, not `var()`.
 */

const KINDS = {
  404: {
    Icon: SearchX,
    tone: 'var(--ink-2)',
    title: 'We could not find that page',
    body: 'The link may be out of date, or the page may have moved. Nothing is wrong with your account.',
  },
  403: {
    Icon: ShieldOff,
    tone: 'var(--warn)',
    title: 'You do not have access to that page',
    // Says what to do, because the previous behaviour said nothing at all.
    body: 'This page is limited to certain accounts. If you think you should be able to see it, ask your school administrator.',
  },
  500: {
    Icon: AlertTriangle,
    tone: 'var(--danger)',
    // Same register as the ErrorBoundary copy: reassure first, because the
    // question a student actually has is whether they have lost their work.
    title: 'Something went wrong',
    body: 'This page failed to load. Your data is safe — nothing was changed. Try again in a moment.',
  },
};

/**
 * @param {'404'|'403'|'500'} kind
 * @param {boolean} signedIn  Whether to offer in-app links. A signed-out visitor
 *   sent to `/events` is bounced straight back to `/welcome`, which would make
 *   the page look broken in exactly the moment it is trying to help.
 */
export default function ErrorPage({ kind = '404', signedIn = true }) {
  const { Icon, tone, title, body } = KINDS[kind] ?? KINDS[404];

  return (
    <div
      className="card"
      role="alert"
      style={{ maxWidth: 520, margin: 'var(--s6) auto', padding: 'var(--s6)' }}
    >
      <div className="stack-sm" style={{ alignItems: 'flex-start' }}>
        <span style={{ color: tone }} aria-hidden="true"><Icon size={28} /></span>

        {/* A heading, so a screen-reader user lands on what happened rather than
            on a link list. The icon above is decorative and hidden from them. */}
        <h1 style={{ fontSize: '1.25rem' }}>{title}</h1>
        <p className="lead">{body}</p>

        <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
          {kind === '500' && (
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              <RotateCw size={15} /> Reload the page
            </button>
          )}

          {signedIn ? (
            <>
              <Link className="btn btn-primary" to="/">Go to my dashboard</Link>
              {kind === '404' && (
                <Link className="btn btn-secondary" to="/events">Find an event</Link>
              )}
            </>
          ) : (
            <Link className="btn btn-primary" to="/welcome">Go to the start page</Link>
          )}
        </div>
      </div>
    </div>
  );
}
