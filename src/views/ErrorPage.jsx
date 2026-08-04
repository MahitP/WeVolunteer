import React from 'react';
import { Link } from 'react-router-dom';
import { RotateCw, Lock, ArrowLeft } from 'lucide-react';
import { APP_NAME } from '../config';

/**
 * The full-screen error experiences: 404, 403 and 500.
 *
 * ── The concept: the board ──
 *
 * Every other product answers a 404 with a map, a compass or a sad robot. This
 * app already has a better artifact of its own: an event has SLOTS, and students
 * claim SPOTS. The signup board is the thing a volunteer actually looks at.
 *
 * So the centrepiece is a board of shift tiles, and in each of the three states
 * exactly one tile is wrong:
 *
 *   404 — one tile is an empty outline, drifting a little off the grid.
 *         The opportunity is not on the board.
 *   403 — one tile is locked. The board is fine; this spot is not yours.
 *   500 — every tile is mid-refresh. The board is being rebuilt.
 *
 * One primitive, three meanings, and each one is literally true about what
 * happened. The community around the anomaly stays filled and calm in all three,
 * which is the reassurance the copy is also making: the thing that failed is
 * small and specific, and everything else is still there.
 *
 * ── Restraint ──
 *
 * The board is the one bold element. Everything around it — type, spacing,
 * buttons — is the app's existing vocabulary, unchanged. A 500 in particular
 * gets the quietest copy in the set: warmth is right for a dead link, and
 * anything approaching a joke while somebody's work may be at risk spends trust
 * that error screens exist to keep.
 *
 * ── Constraints this lives inside ──
 *
 * No new dependency, no image asset. The board is a CSS grid of divs, so it
 * themes from tokens automatically, scales responsively and costs nothing to
 * load. Colour lives in `index.css` because `noHardcodedColors.test.js` allows
 * literals nowhere else, and every class here has a rule there.
 *
 * "Full screen" means full-bleed within its region, not `100vh`: the
 * authenticated catch-all renders inside the app shell, and a viewport-height
 * block there would push the chrome off the screen.
 */

/** Which tile in the twelve is the anomaly. Off-centre, so the grid reads as a real board. */
const ANOMALY = 6;
const TILES = 12;

const KINDS = {
  404: {
    eyebrow: 'Nothing here',
    title: 'This opportunity isn’t on the board',
    body: 'The link may be out of date, or the shift may have already been filled. Nothing is wrong with your account.',
    anomaly: 'gap',
  },
  403: {
    eyebrow: 'Different badge needed',
    title: 'This spot isn’t yours to open',
    body: 'That page is limited to certain accounts. If you think you should have access, your school administrator can sort it out.',
    anomaly: 'locked',
  },
  500: {
    eyebrow: 'Our side',
    // Deliberately the plainest headline of the three. See the note above.
    title: 'The board is being rebuilt',
    body: 'Something on our side stopped working. Your data is safe — nothing was changed. Try again in a moment.',
    anomaly: 'sync',
  },
};

/**
 * @param {'404'|'403'|'500'} kind
 * @param {boolean} signedIn  A signed-out visitor sent to `/events` is bounced
 *   straight back to `/welcome`, which would make this page look broken in the
 *   moment it is trying to help. They get the start page instead.
 */
export default function ErrorPage({ kind = '404', signedIn = true }) {
  const { eyebrow, title, body, anomaly } = KINDS[kind] ?? KINDS[404];

  return (
    <section className="errb" role="alert" aria-labelledby="errb-title">
      {/* Branding, because this is a landing moment and often the only thing on
          screen. Quiet: the board is what should be remembered. */}
      <p className="errb-mark">{APP_NAME}</p>

      <div className={`errb-art errb-art-${anomaly}`} aria-hidden="true">
        {Array.from({ length: TILES }, (_, i) => {
          const isAnomaly = i === ANOMALY;
          return (
            <div
              key={i}
              className={`errb-tile${isAnomaly ? ` errb-tile-${anomaly}` : ''}`}
              /* Staggered by index so the board assembles rather than appearing,
                 which is what makes it read as a board being filled in. */
              style={{ '--errb-i': i }}
            >
              {isAnomaly && anomaly === 'locked' && <Lock size={14} strokeWidth={2.5} />}
              {!isAnomaly && <span className="errb-dot" />}
            </div>
          );
        })}
      </div>

      <p className="errb-eyebrow">{eyebrow}</p>
      <h1 className="errb-title" id="errb-title">{title}</h1>
      <p className="errb-body">{body}</p>

      <div className="errb-actions">
        {kind === '500' && (
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            <RotateCw size={15} /> Try again
          </button>
        )}

        {signedIn ? (
          <>
            <Link className={`btn ${kind === '500' ? 'btn-secondary' : 'btn-primary'}`} to="/">
              <ArrowLeft size={15} /> Back to my dashboard
            </Link>
            {kind === '404' && (
              <Link className="btn btn-secondary" to="/events">Browse open shifts</Link>
            )}
          </>
        ) : (
          <Link className="btn btn-primary" to="/welcome">Go to the start page</Link>
        )}
      </div>
    </section>
  );
}
