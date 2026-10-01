import { useState, useEffect } from 'react';
import { ShieldOff, Clock, CalendarX2 } from 'lucide-react';
import { api } from '../../utils/api';
import { isFinal, MIN_STATEMENT_LENGTH } from '../../appeals';
import { APPEALS_EMAIL } from '../../config';

/**
 * The screen a suspended account sees instead of the application.
 *
 * ── Why this exists ──
 *
 * Until now a suspended account was refused a session outright, so the entire
 * product answer to "why can I not get in" was one sentence on the login form
 * pointing at an email address. Everything the person had actually been told
 * lived in a single notice sent at the moment they were suspended. Lose it,
 * never receive it, or read it a week later on a borrowed phone, and there was
 * nowhere to look it up. Most of the people this happens to are minors, and
 * being locked out with no durable statement of what happened — and no visible
 * way to contest it — is the part that failed them.
 *
 * So there is a session now, it reaches four routes (`suspendedAccess.js`), and
 * this is what it is for.
 *
 * ── This is not the security boundary ──
 *
 * The server refuses everything else regardless of what renders here. If this
 * component were deleted the account would still reach nothing; it would simply
 * be told nothing either. That ordering matters: a wall whose enforcement lives
 * in the client is decoration, and the suspension it is describing would be
 * bypassable by anyone who opened developer tools.
 *
 * ── Built from the same parts as VerifyEmailWall ──
 *
 * `.auth` / `.auth-form` / `.auth-icon` is the existing full-screen wall
 * language, and the danger variant of the icon already existed. Nothing here is
 * a new visual idea, which is deliberate: this is the worst moment a user has
 * with the product, and it should look like the product rather than like an
 * error somebody bolted on.
 */

const dateOf = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });
};

export default function SuspendedWall({ user, suspension, onSignOut }) {
  const [appeals, setAppeals] = useState(null);
  const [statement, setStatement] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.listMyAppeals()
      .then((r) => { if (alive) setAppeals(r.appeals ?? []); })
      /* An appeal list that will not load must not take the reason down with it.
         The explanation is the part of this screen that has to survive. */
      .catch(() => { if (alive) setAppeals([]); });
    return () => { alive = false; };
  }, []);

  const since = dateOf(suspension?.since);
  const until = dateOf(suspension?.until);
  /**
   * Finished vs still-open, using the server's own vocabulary.
   *
   * This compared against the string `'decided'`, which no appeal has ever had —
   * the server writes `open` → `reviewing` → `resolved`. So `open` matched every
   * appeal including finished ones, `decided` was permanently empty, and the
   * block below that shows the reviewer's answer was unreachable.
   *
   * A suspended student who appealed and WON read "Your appeal is with us… you do
   * not need to send another" indefinitely, with the re-file form suppressed
   * underneath. `isFinal` comes from `src/appeals.js`, which re-exports the
   * server's constants so the two cannot invent different words again.
   */
  const open = (appeals ?? []).find((a) => !isFinal(a.status));
  const decided = (appeals ?? []).filter((a) => isFinal(a.status));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      await api.submitAppeal({ subject: 'suspension', statement });
      const r = await api.listMyAppeals();
      setAppeals(r.appeals ?? []);
      setStatement('');
    } catch (err) {
      setError(err?.message || 'We could not send that. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="auth suspended-screen">
      {/**
        * The owner's "blurred background app" (FX-03, ruling 1), as a
        * silhouette rather than the app.
        *
        * The first attempt rendered the real shell under a blurred, inert
        * overlay and was reverted for the three reasons recorded in App.jsx:
        * the suspension check moved below the verification wall, `blur()` on
        * the shell broke every fixed-position toast and modal, and it mounted
        * the authenticated app for an account the server answers on four
        * routes. These are empty blocks shaped like the app — a rail, a bar,
        * some cards — blurred and decorative. They hold no data, no text and
        * no controls, and nothing in them is fixed-position.
        */}
      <div className="suspended-backdrop" aria-hidden="true">
        <div className="suspended-rail" />
        <div className="suspended-page">
          <div className="suspended-block" />
          <div className="suspended-block" />
          <div className="suspended-row">
            <div className="suspended-block" />
            <div className="suspended-block" />
            <div className="suspended-block" />
          </div>
          <div className="suspended-block" />
        </div>
      </div>
      {/* `.stack` on top of `.auth-form`: the form is a flex column with NO gap,
          so without it every section here butted straight into the next — the
          end-date line ran into the "Ask us to look again" heading with nothing
          between them. `.stack`'s var(--s4) is the same rhythm the rest of the
          product uses, rather than a margin invented for this screen. */}
      <main
        className="auth-form auth-form-wide stack suspended-card"
        aria-labelledby="suspended-heading"
      >
        <div className="auth-icon auth-icon-danger" aria-hidden="true">
          <ShieldOff size={26} />
        </div>

        <div>
          <h1 id="suspended-heading" className="auth-title">Your account is suspended</h1>
          <p className="auth-subtitle">
          You can still sign out from here, read why this happened, and ask us to look at it
          again. You cannot use the rest of WeVolunteer while the suspension is in force.
          </p>
        </div>

        {/* The reason, verbatim. An administrator had to write at least 24
            characters of it (MIN_SUSPENSION_REASON) precisely so this line is
            something a person can act on and contest, rather than a category. */}
        {suspension?.reason && (
          <div className="alert alert-danger alert-spaced" role="alert">
            <div>
              <span className="alert-title">Why</span>
              <p>{suspension.reason}</p>
            </div>
          </div>
        )}

        <ul className="auth-points" aria-label="Suspension details">
          {since && (
            <li className="auth-point">
              <CalendarX2 size={16} aria-hidden="true" />
              <span>Started <strong>{since}</strong></span>
            </li>
          )}
          <li className="auth-point">
            <Clock size={16} aria-hidden="true" />
            {/* `indefinite` is read as its own field rather than inferred from a
                missing date. "No end date" silently rendered as "ends soon" is
                the misreading this costs one boolean to avoid, and the person
                reading it has more riding on it than anybody. */}
            {suspension?.indefinite || !until
              ? <span>No end date — it stays until an administrator lifts it.</span>
              : <span>Ends on <strong>{until}</strong></span>}
          </li>
        </ul>

        {/* ── The appeal ──
            The Community Guidelines promise one, and an appeal the suspended
            person cannot actually reach is a promise made to nobody. It lives on
            this screen rather than behind a link because this screen is the only
            one they can open. */}
        <section aria-labelledby="appeal-heading" className="stack-sm">
          <h2 id="appeal-heading">Ask us to look again</h2>

          {appeals === null && <p className="muted">Checking whether you have appealed…</p>}

          {open && (
            <div className="alert alert-info" role="status">
              <div>
                <span className="alert-title">Your appeal is with us</span>
                <p>
                  We reply within five business days with the outcome and the reason.
                  You do not need to send another.
                </p>
              </div>
            </div>
          )}

          {!open && decided.map((a) => (
            <div key={a.id} className="alert alert-warn" role="status">
              <div>
                <span className="alert-title">
                  {a.decision === 'reversed'
                    ? 'We agreed with you'
                    : 'We reviewed your appeal and the decision stands'}
                  {a.reviewerName ? ` — ${a.reviewerName}` : ''}
                </span>
                {a.reasoning && <p>{a.reasoning}</p>}
                {/* An upheld appeal does not always lift the suspension in the same
                    moment — reinstatement is a separate administrative step. Saying
                    so is better than a person reading "we agreed with you" while
                    still locked out and concluding the page is lying to them. */}
                {a.decision === 'reversed' && (
                  <p className="small">
                    If you can still not sign in normally, the change may not have been
                    applied yet. Reply to the email we sent and somebody will finish it.
                  </p>
                )}
              </div>
            </div>
          ))}

          {appeals !== null && !open && (
            <form onSubmit={submit} className="stack-sm">
              <div className="field">
                <label htmlFor="appeal-statement">
                  Tell us what happened, in your own words
                </label>
                <textarea
                  id="appeal-statement"
                  className="input"
                  rows={4}
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                  placeholder="What you think we got wrong, and anything we may not know."
                />
                {/* The server's minimum, named. This said "a couple of sentences"
                    and disabled the button below 40 characters while the server
                    accepts 20 — so somebody who wrote a perfectly valid appeal got
                    a dead button and no explanation of why. */}
                <p className="muted">
                  A person reads this. At least {MIN_STATEMENT_LENGTH} characters
                  {statement.trim().length > 0 && statement.trim().length < MIN_STATEMENT_LENGTH
                    ? ` — ${MIN_STATEMENT_LENGTH - statement.trim().length} to go.`
                    : '.'}
                </p>
              </div>
              {error && <p className="text-danger" role="alert">{error}</p>}
              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={sending || statement.trim().length < MIN_STATEMENT_LENGTH}
              >
                {sending ? 'Sending…' : 'Send my appeal'}
              </button>
            </form>
          )}
        </section>

        <div className="auth-actions stack-sm">
          <button type="button" className="btn btn-secondary btn-block" onClick={onSignOut}>
            Sign out
          </button>
          <p className="muted">
            Signed in as {user?.email}. If you think this is a mistake and the appeal is not
            working, email {APPEALS_EMAIL}.
          </p>
        </div>
      </main>
    </div>
  );
}
