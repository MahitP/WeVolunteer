import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserRound, Check, X, Inbox } from 'lucide-react';
import EmptyState from '../common/EmptyState';
import LoadingSkeleton from '../common/LoadingSkeleton';
import { api } from '../../utils/api';
import { formatDay } from '../../utils/helpers';

/**
 * The queue of students waiting to be let into a club.
 *
 * ── Rendered only when there is something to answer ──
 *
 * A club whose policy is `open` or `invite` has no queue and never will, so the
 * card is absent rather than empty for it — a manager should not have to scroll
 * past a permanently empty inbox on every visit. A `request` club with nothing
 * waiting DOES show the empty state, because there emptiness is a real answer:
 * "nobody is waiting" is what a manager came to find out.
 *
 * ── Accept and Decline, both named, both one press ──
 *
 * No confirmation on either. Accepting is reversible (a manager can remove
 * somebody), and declining is reversible by the student simply asking again —
 * the partial unique index is scoped to `pending`, which is what makes that
 * possible. A confirmation on an action somebody will take twenty times in a row
 * is friction that teaches people to click through dialogs.
 *
 * ── What a request discloses ──
 *
 * Exactly what the roster does: `profileSummary`, the same strict subset
 * directory search publishes. No grade, no school and no email address.
 *
 * A request may carry a short note the student chose to write, and it is shown
 * here because deciding is what it is for. Rendered as TEXT in JSX, which React
 * escapes — there is no `dangerouslySetInnerHTML` anywhere near this, and the
 * server stores the note verbatim rather than "sanitising" it, which would
 * mangle a child's `<3` while providing no protection escaping does not already
 * give. It is read only by this club's managers: the queue is their route
 * alone, and the note reaches no roster, no notification and no email.
 */
export default function JoinRequestInbox({ orgKey, organizationName, policy, addToast, onDecided }) {
  const [state, setState] = useState({ loading: true, requests: [], error: '' });
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: '' }));
    api.fetchOrganizationJoinRequests(orgKey)
      .then(res => { if (!cancelled) setState({ loading: false, requests: res.requests ?? [], error: '' }); })
      .catch(err => { if (!cancelled) setState({ loading: false, requests: [], error: err.message }); });
    return () => { cancelled = true; };
  }, [orgKey]);

  useEffect(() => load(), [load]);

  const decide = async (request, decision) => {
    setBusy(request.requestId);
    try {
      await api.decideOrganizationJoinRequest(orgKey, request.requestId, decision);
      addToast?.(
        decision === 'accept'
          ? `${request.name} is now a member of ${organizationName}.`
          : `${request.name}'s request was declined.`,
        decision === 'accept' ? 'success' : 'info',
      );
      load();
      onDecided?.();
    } catch (err) {
      /**
       * Surfaced, never swallowed. The likeliest refusal is `already_decided` —
       * a co-manager answered it first — and a manager who is not told that will
       * press the button again and conclude the product is broken. Reloading
       * afterwards is what makes the message actionable: the row goes away.
       */
      addToast?.(err.message, 'error');
      load();
    } finally {
      setBusy(null);
    }
  };

  /* A club that does not approve members has no queue to show. Rendered as
     nothing rather than as an empty card — see the note above. */
  if (policy !== 'request' && state.requests.length === 0 && !state.loading) return null;

  return (
    /* `id` and `tabIndex` are the landing point for
       `/organizations/@slug#requests`, which is what the join-request
       notification's "Review the request" sends a manager to — see the hash
       effect in `views/OrganizationPage.jsx`. `tabIndex={-1}` is what lets
       focus move here, the same arrangement the policy headings use for
       `/legal/:slug#section`; it does not put the section in the tab order. */
    <section
      id="requests"
      tabIndex={-1}
      className="card"
      aria-labelledby="org-requests-heading"
    >
      <div className="card-head">
        <h3 id="org-requests-heading">Requests to join</h3>
        {state.requests.length > 0 && (
          <span className="tag tag-brand">{state.requests.length} waiting</span>
        )}
      </div>

      <div className="card-body">
        {state.loading && <LoadingSkeleton heights={[64, 64]} />}

        {!state.loading && state.error && (
          <p className="alert alert-danger" role="alert">{state.error}</p>
        )}

        {!state.loading && !state.error && state.requests.length === 0 && (
          <EmptyState
            icon={Inbox}
            title="Nobody is waiting"
            message={`When a student asks to join ${organizationName}, their request appears here for you to accept or decline.`}
          />
        )}

        {!state.loading && state.requests.length > 0 && (
          <ul className="list">
            {state.requests.map(request => (
              <li key={request.requestId} className="list-row org-request">
                <Link
                  to={request.username ? `/users/@${request.username}` : `/users/id/${request.id}`}
                  className="row org-request-who"
                >
                  <span className="avatar" aria-hidden="true">
                    {request.profilePictureUrl
                      ? <img src={request.profilePictureUrl} alt="" className="avatar-img" />
                      : (request.avatar || <UserRound size={16} />)}
                  </span>
                  <span className="stack-xs org-request-body">
                    <span className="org-request-name">{request.name}</span>
                    <span className="muted small">
                      {request.username && <>@{request.username} · </>}
                      asked {formatDay(request.submittedAt)}
                    </span>
                  </span>
                </Link>

                {/**
                  * The note, OUTSIDE the link.
                  *
                  * It used to sit inside it, so the link's accessible name was
                  * the person's name, their handle, the date AND up to 300
                  * characters of somebody's free text, read out as the name of
                  * a navigation control. That is the same run-together-name
                  * defect this feature fixed for the settings radios, in a
                  * worse place — and clicking the note, which is the only
                  * place the decision information lives, navigated away to a
                  * profile.
                  *
                  * `.org-request` already wraps and `.org-request-note` takes
                  * the full row, so the layout is unchanged. Text, never
                  * markup: React escapes it, and the server stores it verbatim
                  * rather than "sanitising" a child's `<3`.
                  */}
                {request.message && (
                  <p className="org-request-note">{request.message}</p>
                )}

                {/**
                  * Both verbs, both visible.
                  *
                  * A single "Review" button that opened something would be a
                  * second screen for a two-way decision, and a menu would hide
                  * Accept behind a press. `aria-label` names the person on each,
                  * because a screen-reader user tabbing through eight rows of
                  * "Accept / Decline" cannot tell which row they are on.
                  */}
                <span className="row org-request-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy === request.requestId}
                    aria-label={`Decline ${request.name}'s request to join`}
                    onClick={() => decide(request, 'reject')}
                  >
                    <X size={15} aria-hidden="true" /> Decline
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy === request.requestId}
                    aria-label={`Accept ${request.name} into ${organizationName}`}
                    onClick={() => decide(request, 'accept')}
                  >
                    <Check size={15} aria-hidden="true" /> Accept
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
