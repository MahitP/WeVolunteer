import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Building2, Lock, LogIn, UserPlus2 } from 'lucide-react';
import PublicOrganizationView, {
  PublicOrganizationTopbar,
} from '../components/organizations/PublicOrganizationView';
import SignInToJoinDialog from '../components/organizations/SignInToJoinDialog';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
/* The page frame — the centred topbar, the single column, the footer — as
   distinct from the masthead, which brings its own. */
import '../components/organizations/OrganizationExperience.css';
import { api } from '../utils/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { APP_NAME } from '../config';
import { useSession } from '../session/SessionProvider';
import { rememberPendingInvite } from '../utils/pendingInvite';
import { joinPolicySentence } from '../organizationPolicy';
import { organizationPath } from '../utils/organizationUrl';

/**
 * What an invitation link opens.
 *
 * ── One page, two readers, and a redirect for the second ──
 *
 * A visitor with no session gets this page: the club presented from
 * `publicOrganization` — the allowlisted projection, carrying no member, no
 * event location and no hours — with one action that explains it needs an
 * account.
 *
 * A reader who IS signed in is sent to `/organizations/<slug>` immediately,
 * because the real page is strictly better for them: it has the shell, the
 * navigation, their own service record, and the actual Join that their session
 * makes possible. The token is stashed first so the Join press carries it.
 * `replace` so the link does not sit in the history behind them.
 *
 * ── This is the only view in the application that renders outside the shell
 *    while a session might exist ──
 *
 * It is declared in `PUBLIC_ROUTES`, which App.jsx serves before the session
 * branches, so it owns its own `h1` and its own header. That is why it is in the
 * `STANDALONE` allowlist in `headingLevels.test.js`: there is no shell heading
 * above it to duplicate.
 */
export default function OrganizationInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { currentUser, isCheckingSession } = useSession();
  const [state, setState] = useState({ loading: true, organization: null, error: '' });
  const [asking, setAsking] = useState(false);
  /* Bumped by the retry control, which is the only way to re-run the fetch for a
     token that has not changed. */
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

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, organization: null, error: '' });
    api.fetchOrganizationInvite(token)
      .then(res => { if (!cancelled) setState({ loading: false, organization: res.organization, error: '' }); })
      .catch(err => {
        if (cancelled) return;
        /* Every failure the server has — no such token, replaced, switched off,
           archived — is the same 404 with the same body, so there is one message
           here too. Distinguishing them would be inventing information the
           endpoint deliberately does not give. */
        setState({
          loading: false,
          organization: null,
          error: err.status === 404 ? 'invalid' : err.message,
        });
      });
    return () => { cancelled = true; };
  }, [token, attempt]);

  /**
   * Signed in? Go to the real page.
   *
   * Waits for the session check, because acting on `currentUser === null` while
   * it is still resolving would bounce a signed-in reader onto the public page
   * for a frame and then move them, which reads as a flicker and loses their
   * scroll position.
   */
  const slug = state.organization?.slug;
  useEffect(() => {
    if (isCheckingSession || !currentUser || !slug) return;
    rememberPendingInvite({ slug, token, name: state.organization?.name });
    navigate(organizationPath(slug), { replace: true });
  }, [isCheckingSession, currentUser, slug, token, navigate, state.organization?.name]);

  if (state.loading || isCheckingSession) {
    return (
      <div className="invite-page">
        <LoadingSkeleton heights={[180, 120]} className="stack-lg" />
      </div>
    );
  }

  /**
   * "This link does not work" and "we could not reach the server" are different
   * facts, and conflating them is the mistake `ApiError.status` exists to
   * prevent.
   *
   * Telling somebody their invitation is dead when the wifi dropped sends them
   * back to whoever shared it for a link that was fine — and on this page that
   * person has no account and no other way in, so a wrong answer costs the
   * signup. A 404 is the link; anything else is the connection, and offers a
   * retry rather than a verdict.
   */
  if (state.error) {
    const invalid = state.error === 'invalid';
    return (
      <div className="invite-page">
        <PublicOrganizationTopbar sub="Invitation" />
        <main className="invite-main">
          <EmptyState
            /**
              * `headingLevel={1}`, because on this page the empty state IS the
              * page.
              *
              * Everywhere else an empty state sits under a section's own `h2`
              * and an `h3` is right, which is why that is the default. Here
              * there is no shell heading above it — the invitation page renders
              * outside the shell and owns its `h1` — so a default `h3` left the
              * page with no level-one heading at all. Caught by
              * `a11y/sweep.aria.spec.js`, which measures this route in exactly
              * this state: the demo seed has no invitation link, so the fixture
              * token always lands on the failure branch.
              */
            headingLevel={1}
            icon={invalid ? Lock : Building2}
            title={invalid ? 'This invitation link does not work' : 'Could not open this invitation'}
            message={invalid
              ? 'It may have been replaced or switched off. Ask whoever shared it for the current link.'
              : state.error}
            action={invalid
              ? <Link className="btn btn-secondary" to="/welcome">Go to {APP_NAME}</Link>
              : <button type="button" className="btn btn-secondary" onClick={() => setAttempt(a => a + 1)}>
                Try again
              </button>}
          />
        </main>
      </div>
    );
  }

  /* Signed in — the effect above is navigating. Rendering the skeleton rather
     than the public page avoids a frame of the wrong thing. */
  if (currentUser) {
    return (
      <div className="invite-page">
        <LoadingSkeleton heights={[180, 120]} className="stack-lg" />
      </div>
    );
  }

  const org = state.organization;
  const affordance = org.joinPolicy === 'request' ? 'request' : 'join';

  return (
    <div className="invite-page">
      {/**
        * A minimal header, so the page says whose product it is.
        *
        * Somebody arriving here has been sent a link by a person they know and
        * has never seen this application. The mark is how they find out what
        * they are looking at before deciding whether to make an account.
        */}
      <PublicOrganizationTopbar sub="Invitation" />

      <main className="invite-main stack-lg">
        {/**
          * The club as a stranger sees it — shared with the public handle page.
          *
          * Both render the same allowlisted projection, and sharing the
          * renderer is what keeps the ABSENT half honest: no member, no
          * founder, no hours, and no event location. Two copies would have been
          * two chances for one of them to grow a field.
          *
          * What is NOT shared is the action, because that is exactly where the
          * two pages differ. A handle grants nothing; this link is what makes a
          * Join press succeed at an invitation-only club, so the button is
          * offered here in a state where the handle page shows none.
          */}
        <PublicOrganizationView
          organization={org}
          headingLevel="h1"
          action={
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setAsking(true)}>
              {affordance === 'request'
                ? <><UserPlus2 size={17} aria-hidden="true" /> Request to join</>
                : <><LogIn size={17} aria-hidden="true" /> Join {org.name}</>}
            </button>
          }
          note={joinPolicySentence(affordance, {
            policy: org.joinPolicy,
            organizationName: org.name,
          })}
        />
      </main>

      {asking && (
        <SignInToJoinDialog
          organization={org}
          token={token}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
