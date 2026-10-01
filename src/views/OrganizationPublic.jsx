import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Building2, Lock, LogIn, UserPlus2, WifiOff, Clock } from 'lucide-react';
import PublicOrganizationView, {
  PublicOrganizationTopbar,
} from '../components/organizations/PublicOrganizationView';
import SignInToJoinDialog from '../components/organizations/SignInToJoinDialog';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import '../components/organizations/OrganizationExperience.css';
import { api } from '../utils/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { APP_NAME } from '../config';
import { joinPolicySentence } from '../organizationPolicy';
import { usePageMeta } from '../hooks/usePageMeta';

/**
 * An organization at its canonical public address, `/organizations/@robotics`.
 *
 * ── Only the `@` form is a public address ──
 *
 * The bare legacy path `/organizations/robotics` reaches this view too — the
 * route pattern is the same one the shell uses, separated by session rather
 * than by path — and this view deliberately does NOT look it up. It says the
 * page needs an account and offers a way to get one.
 *
 * That asymmetry is the design, not an oversight. The handle is an address a
 * club chose to publish; the bare path is the authenticated page it has always
 * been, linked to from inside the product and printed in notifications written
 * before handles existed. Looking the bare form up would quietly make every
 * club's page public, including the ones that never chose to be.
 *
 * Not looking it up also means this view is not an oracle: signed out, both a
 * real club and a made-up one at the bare path get the identical
 * "needs an account" answer, with no request sent at all.
 *
 * ── An unlisted club and a club that does not exist are the same answer ──
 *
 * The server answers one 404 for both, because handles are guessable — they are
 * the club's name — and a distinguishable refusal would turn this into a
 * directory of every club that chose not to be listed, including which schools
 * have one. This page must not invent the distinction back.
 *
 * ── This renders outside the shell ──
 *
 * Declared in `PUBLIC_ROUTES`, so it owns its own `h1` and its own header,
 * which is why it belongs in the `STANDALONE` allowlist in
 * `headingLevels.test.js`: there is no shell heading above it to duplicate.
 */
export default function OrganizationPublic() {
  const { key } = useParams();
  /* The `@` is punctuation the URL carries; the API takes the bare handle. The
     same normalisation `PublicProfile` does for `/users/@name`, and for the
     same reason: one stored spelling, two written ones. */
  const handle = String(key ?? '');
  const isHandle = handle.startsWith('@');

  const [state, setState] = useState({ loading: isHandle, organization: null, error: '' });
  const [asking, setAsking] = useState(false);
  /* Bumped by the retry control — the only way to re-run a fetch for a handle
     that has not changed. */
  const [attempt, setAttempt] = useState(0);

  /**
   * The club's name in the tab.
   *
   * These pages render outside the shell, so `PAGE_META` — which is keyed by
   * route — cannot name them, and every tab said just "WeVolunteer". That is
   * worst precisely here: this is a page somebody was SENT, and it is the tab
   * they leave open among a dozen while deciding whether to make an account.
   *
   * Falsy while loading and on the failure branches, which the hook reads as
   * "nothing better to say than the route already does" and leaves the tab
   * alone rather than flashing a name in and out.
   */
  useDocumentTitle(state.organization?.name);
  /* A club of students: shareable by link, never listed by a search engine
     (FE-02). */
  usePageMeta({ noindex: true });

  useEffect(() => {
    if (!isHandle) return undefined;
    let cancelled = false;
    setState({ loading: true, organization: null, error: '' });
    api.fetchPublicOrganization(handle.slice(1))
      .then(res => { if (!cancelled) setState({ loading: false, organization: res.organization, error: '' }); })
      .catch(err => {
        if (cancelled) return;
        setState({
          loading: false,
          organization: null,
          /* A 404 is "there is no public club at that address" — which covers a
             club that is unlisted, archived or absent, all of which the server
             answers identically. Anything else is the connection or the rate
             limit, and `status` is what tells those two apart. */
          error: err.status === 404 ? 'missing' : err.message,
          status: err.status ?? 0,
        });
      });
    return () => { cancelled = true; };
  }, [handle, isHandle, attempt]);

  /**
   * The bare path, signed out. No lookup, no verdict about whether the club
   * exists — just the honest reason the page is not showing.
   */
  if (!isHandle) {
    return (
      <div className="invite-page">
        <PublicOrganizationTopbar sub="Organizations" />
        <main className="invite-main">
          <EmptyState
            headingLevel={1}
            icon={Lock}
            title="This page needs an account"
            /* Not "open the link you were sent instead" — they DID open the
               link they were sent. What they need is the shape of the address
               that works, so they can ask for the right thing. */
            message={`Organizations on ${APP_NAME} are shown to signed-in members at this address. `
              + 'A club can also have a public address, which looks like /organizations/@name — '
              + 'ask whoever shared this for that, or for an invitation link.'}
            /**
              * Both doors, and signing up is the primary one.
              *
              * This is the page whose whole reason for existing is turning a
              * stranger into an account, and it offered only Log in — which is
              * the wrong door for somebody who has never been here.
              * `SignInToJoinDialog` already gets this ordering right.
              */
            action={(
              <span className="row row-wrap">
                <Link className="btn btn-primary" to="/signup">Create an account</Link>
                <Link className="btn btn-secondary" to="/login">Log in</Link>
              </span>
            )}
          />
        </main>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="invite-page">
        {/**
          * The topbar and the centred column, which this branch used to omit.
          *
          * `.invite-main` is what applies `max-width: 45rem; margin: 0 auto`,
          * so without it a stranger on a wide screen saw full-width skeletons
          * with no branding, then the brand bar appeared and the content
          * collapsed to a centred column — two layout shifts on the one page
          * whose job is a first impression.
          */}
        <PublicOrganizationTopbar sub="Organizations" />
        <main className="invite-main stack-lg" role="status" aria-label="Loading this organization">
          <LoadingSkeleton heights={[180, 120]} />
        </main>
      </div>
    );
  }

  /**
   * "No such public club" and "we could not reach the server" are different
   * facts, and conflating them is the mistake `ApiError.status` exists to
   * prevent. A wrong answer here sends somebody back to whoever shared the
   * address for a link that was fine.
   */
  if (state.error) {
    const missing = state.error === 'missing';
    /**
      * A rate limit is its own answer, and it must not offer a retry.
      *
      * `/api/public/organizations/*` is bounded per device — a handle is
      * guessable, so the ceiling is what stops an enumeration. The realistic
      * way to meet it is legitimate: one school, one address, a class opening
      * the club link off an assembly slide. Offering Try again there re-fires
      * immediately and re-429s, which teaches the reader the page is broken.
      */
    const throttled = state.status === 429;
    return (
      <div className="invite-page">
        <PublicOrganizationTopbar sub="Organizations" />
        <main className="invite-main">
          <EmptyState
            /* Only the `missing` arm. The other two are a connection fault and
               the rate-limit ceiling — our end, not a wrong address — and
               marking them would tell the sweep to discard a page that
               rendered. */
            notFound={missing}
            /* `headingLevel={1}`: on this page the empty state IS the page.
               Everywhere else it sits under a section's `h2` and an `h3` is
               right, which is why that is the default — and why the invitation
               page had no level-one heading at all until the a11y sweep
               measured it. */
            headingLevel={1}
            /* A padlock says "you are not allowed in", which is true of neither
               of the other two branches. `missing` is a club that is not there;
               anything else is the connection or the ceiling. The invitation
               page uses the same mapping, so the two pages that share a
               renderer no longer give one failure two different icons. */
            icon={missing ? Building2 : (throttled ? Clock : WifiOff)}
            title={missing
              ? 'We could not find that organization'
              : (throttled ? 'Too many tries just now' : 'Could not reach the server')}
            message={missing
              ? 'There may be no organization at that address, or it may not have a public page. '
                + 'Check the address, or ask whoever shared it for an invitation link.'
              : state.error}
            action={missing
              ? <Link className="btn btn-secondary" to="/welcome">Go to {APP_NAME}</Link>
              : (throttled
                ? <Link className="btn btn-secondary" to="/welcome">Go to {APP_NAME}</Link>
                : (
                  <button type="button" className="btn btn-secondary" onClick={() => setAttempt(a => a + 1)}>
                    Try again
                  </button>
                ))}
          />
        </main>
      </div>
    );
  }

  const org = state.organization;
  /**
   * What pressing the button will do — from `joinPolicy` ALONE.
   *
   * A handle confers no authority, so an invitation-only club shows neither
   * Join nor Request: it shows what is true, which is that the way in is a link
   * somebody has to give you. Offering a Join the server would refuse is the
   * exact failure this whole affordance mechanism exists to prevent, and it
   * would be worse here than anywhere else — the reader has no account yet, so
   * the refusal would arrive after they made one.
   */
  const affordance = org.joinPolicy === 'invite'
    ? 'invite_required'
    : (org.joinPolicy === 'request' ? 'request' : 'join');

  return (
    <div className="invite-page">
      <PublicOrganizationTopbar sub="Organizations" />

      <main className="invite-main stack-lg">
        <PublicOrganizationView
          organization={org}
          headingLevel="h1"
          action={affordance === 'invite_required' ? null : (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setAsking(true)}>
              {affordance === 'request'
                ? <><UserPlus2 size={17} aria-hidden="true" /> Request to join</>
                : <><LogIn size={17} aria-hidden="true" /> Join {org.name}</>}
            </button>
          )}
          note={joinPolicySentence(affordance, {
            policy: org.joinPolicy,
            organizationName: org.name,
          })}
        />
      </main>

      {asking && (
        <SignInToJoinDialog
          organization={org}
          /* No token: a handle is not one. `SignInToJoinDialog` remembers the
             club so signing up lands back here, and the Join press that follows
             is judged by `join_policy` with no invitation in hand. */
          token={null}
          /* So a request-policy club does not offer "Request to join" and then
             open a dialog headed "Join Chess Club". */
          affordance={affordance}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
