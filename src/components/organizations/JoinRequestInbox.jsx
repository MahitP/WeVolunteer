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
 * directory search publishes. No grade, no school, no email address, and no
 * message — the request carries none, deliberately, because a free-text note
 * written by a minor and read by club managers is a disclosure this feature does
 * not need in order to work.
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
    <section className="card" aria-labelledby="org-requests-heading">
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
