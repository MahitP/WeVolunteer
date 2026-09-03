import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserRound, UserPlus2, X, Search, Loader2, MailPlus } from 'lucide-react';
import EmptyState from '../common/EmptyState';
import LoadingSkeleton from '../common/LoadingSkeleton';
import { api } from '../../utils/api';
import { formatDay } from '../../utils/helpers';
/* The bound the server enforces, imported rather than restated — see the note
   on it in `organizationPolicy.js`. */
import { NOTE_MAX } from '../../organizationPolicy';

/**
 * Inviting named people, and the invitations that are still outstanding.
 *
 * ── You search for a PERSON, never type an address ──
 *
 * The field is a directory search over names and usernames — the same search
 * every member of this platform may already run. There is deliberately no email
 * field, and `organizationInvitations.js` on the server carries the argument in
 * full. The short version: `email` is a privileged field that directory search
 * cannot even match on, so a form that took an address and answered anything at
 * all would be the first place on this platform where a club manager could act
 * on an address they were never shown — and the platform's users are minors.
 *
 * ── What an invitation is worth ──
 *
 * Nothing on its own. There is no token: the row names a user, and the only
 * thing that can accept it is a session belonging to that user. So an
 * invitation cannot be forwarded, intercepted, or read off a screen and used.
 *
 * ── Withdraw, and what it does not do ──
 *
 * Withdrawing an invitation notifies nobody. An invitation somebody has not
 * opened, withdrawn, is a non-event, and telling them would mean a student's
 * first news of a club is that it changed its mind about them.
 */
export default function InvitationManager({ orgKey, organizationName, addToast, onChanged }) {
  const [state, setState] = useState({ loading: true, invitations: [], error: '' });
  const [busy, setBusy] = useState(null);
  const [composing, setComposing] = useState(false);
  /**
   * The "Invite somebody" button, so focus can come back to it.
   *
   * The composer replaces that button, and closing it — by Cancel, or by a
   * successful invitation — unmounted the focused element and dropped focus to
   * the document. A keyboard user then had to tab from the top of the page to
   * get back to where they were.
   */
  const openerRef = useRef(null);
  const [returnFocus, setReturnFocus] = useState(false);

  useEffect(() => {
    if (!composing && returnFocus) {
      openerRef.current?.focus();
      setReturnFocus(false);
    }
  }, [composing, returnFocus]);

  const closeComposer = () => { setReturnFocus(true); setComposing(false); };

  const load = useCallback(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: '' }));
    api.fetchOrganizationInvitations(orgKey)
      .then(res => { if (!cancelled) setState({ loading: false, invitations: res.invitations ?? [], error: '' }); })
      .catch(err => { if (!cancelled) setState({ loading: false, invitations: [], error: err.message }); });
    return () => { cancelled = true; };
  }, [orgKey]);

  useEffect(() => load(), [load]);

  const withdraw = async (invitation) => {
    setBusy(invitation.invitationId);
    try {
      await api.revokeOrganizationInvitation(orgKey, invitation.invitationId);
      addToast?.(`The invitation to ${invitation.name} was withdrawn.`, 'info');
      load();
      onChanged?.();
    } catch (err) {
      /* Surfaced, never swallowed. The likeliest refusal is that the person
         accepted or declined a moment ago, and a manager who is not told will
         press again and conclude the product is broken. Reloading makes the
         message actionable: the row goes away. */
      addToast?.(err.message, 'error');
      load();
    } finally {
      setBusy(null);
    }
  };

  const invite = async (person, note) => {
    setBusy('new');
    try {
      await api.inviteToOrganization(orgKey, person.id, note);
      addToast?.(`${person.name} was invited to ${organizationName}.`, 'success');
      closeComposer();
      load();
      onChanged?.();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-labelledby="org-invitations-heading">
      <div className="card-head">
        <h3 id="org-invitations-heading">Invitations</h3>
        {state.invitations.length > 0 && (
          <span className="tag">{state.invitations.length} waiting</span>
        )}
      </div>

      <div className="card-body stack-md">
        {state.loading && <LoadingSkeleton heights={[64, 64]} />}

        {!state.loading && state.error && (
          <p className="alert alert-danger" role="alert">{state.error}</p>
        )}

        {!state.loading && !state.error && state.invitations.length === 0 && (
          <EmptyState
            icon={MailPlus}
            title="Nobody is waiting on an invitation"
            message={`Invite somebody by name and they will see it next time they open ${organizationName}.`}
          />
        )}

        {!state.loading && state.invitations.length > 0 && (
          <ul className="list">
            {state.invitations.map(invitation => (
              <li key={invitation.invitationId} className="list-row org-request">
                <Link
                  to={invitation.username ? `/users/@${invitation.username}` : `/users/id/${invitation.id}`}
                  className="row org-request-who"
                >
                  <span className="avatar" aria-hidden="true">
                    {invitation.profilePictureUrl
                      ? <img src={invitation.profilePictureUrl} alt="" className="avatar-img" />
                      : (invitation.avatar || <UserRound size={16} />)}
                  </span>
                  <span className="stack-xs org-request-body">
                    <span className="org-request-name">{invitation.name}</span>
                    <span className="muted small">
                      {invitation.username && <>@{invitation.username} · </>}
                      invited {formatDay(invitation.createdAt)}
                      {invitation.expiresAt && <> · open until {formatDay(invitation.expiresAt)}</>}
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
                {invitation.message && (
                  <p className="org-request-note">{invitation.message}</p>
                )}

                <span className="row org-request-actions">
                  {/* Named per person, because a screen-reader user tabbing
                      through eight rows of "Withdraw" cannot tell which row
                      they are on. */}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy === invitation.invitationId}
                    aria-label={`Withdraw the invitation to ${invitation.name}`}
                    onClick={() => withdraw(invitation)}
                  >
                    <X size={15} aria-hidden="true" /> Withdraw
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {composing ? (
          <InviteComposer
            organizationName={organizationName}
            /* So the results can say who is already waiting on one. See the
               note in the composer for why this is the slice worth doing. */
            invited={state.invitations}
            busy={busy === 'new'}
            onInvite={invite}
            onCancel={closeComposer}
          />
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            ref={openerRef}
            onClick={() => setComposing(true)}
          >
            <UserPlus2 size={15} aria-hidden="true" /> Invite somebody
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The search-and-send form.
 *
 * ── Debounced, aborted, and never a keystroke-per-request ──
 *
 * `searchDirectory` takes an `AbortSignal` for exactly this: a manager typing
 * "alex" would otherwise leave four requests racing, and the one that answers
 * last wins regardless of which query it belonged to. The previous request is
 * aborted on every keystroke and the query waits 250ms for the typing to stop.
 *
 * ── Why the result list is a radio group ──
 *
 * Inviting is a decision about one named person, and a list of buttons that
 * each send immediately makes a mis-click an invitation. Choosing, then
 * writing an optional note, then pressing Send is three deliberate steps for an
 * action that reaches into somebody else's notifications.
 *
 * ── Why the already-invited are marked and not filtered ──
 *
 * `searchDirectory` is a platform-wide search with no membership filter, so the
 * results legitimately include people the server will refuse: existing members,
 * the caller, banned people, and — most confusingly — somebody whose invitation
 * is listed one row above in this very card. Every one of those was a
 * select-then-press-then-error round trip, which is the failure `joinAffordance`
 * exists to prevent everywhere else in this feature.
 *
 * The outstanding list is the half this component already holds, so that is the
 * half it fixes: those rows say "already invited" and cannot be chosen. The
 * others still refuse on the server with a sentence naming the person, because
 * fixing them properly means a membership flag on the directory result and that
 * is a change to an endpoint six other callers share.
 */
function InviteComposer({ organizationName, invited = [], busy, onInvite, onCancel }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(null);
  const [note, setNote] = useState('');
  const abortRef = useRef(null);

  useEffect(() => {
    const term = query.trim();
    /* Two characters, matching what the directory endpoint will answer for —
       a one-letter search returns most of the school. */
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    setError('');
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      /* `type: 'users'` and `res.users` — the names the directory endpoint
         actually uses. It answers `{ query, intent, users, organizations }`,
         and asking for people alone keeps a club that happens to match the
         name out of a list of people to invite. */
      api.searchDirectory(term, { type: 'users', limit: 8, signal: controller.signal })
        .then(res => {
          setResults(res.users ?? []);
          setSearching(false);
        })
        .catch(err => {
          /* An aborted request is the expected outcome of typing, not a
             failure worth reporting. */
          if (err?.name === 'AbortError') return;
          /* Anything else is reported. Swallowing it left `results` holding its
             previous value and the UI rendering "Nobody matched that." — so a
             manager on a flaky school network was told the student they were
             looking for does not exist. */
          setResults([]);
          setError(err?.message || 'Could not search just now.');
          setSearching(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const over = note.length > NOTE_MAX;
  /**
   * What the status region says, in one expression.
   *
   * An empty string when there is nothing to report, which is what keeps the
   * element mounted and silent rather than mounted and repeating itself.
   */
  const searchStatus = error
    ? error
    : (searching
      ? 'Searching…'
      : (query.trim().length >= 2 && results.length === 0 ? 'Nobody matched that.' : ''));

  return (
    <form
      className="org-invite-composer stack-sm"
      onSubmit={(e) => { e.preventDefault(); if (chosen && !over) onInvite(chosen, note.trim() || undefined); }}
    >
      <label className="label" htmlFor="org-invite-search">
        Who would you like to invite?
      </label>
      <div className="org-invite-search">
        <Search size={15} aria-hidden="true" />
        <input
          id="org-invite-search"
          className="input"
          type="search"
          value={query}
          onChange={e => { setQuery(e.target.value); setChosen(null); }}
          placeholder="Search by name or username"
          autoComplete="off"
          aria-describedby="org-invite-hint"
        />
      </div>
      <p id="org-invite-hint" className="muted small">
        Search for somebody already on this platform. There is no way to invite an email
        address, on purpose. An invitation stays open for two weeks, and you can withdraw it
        at any time.
      </p>

      {/**
        * One region, always mounted.
        *
        * These used to be two elements created and destroyed with their own
        * text, and a live region has to EXIST before its contents change for
        * the change to be announced — so in most screen readers neither ever
        * announced. A student typed a name, heard nothing, and had no way to
        * know whether a search had happened.
        *
        * `role="status"` rather than `aria-live="polite"` on a `<p>`: same
        * politeness, and it says what the element is.
        */}
      <p className="muted small" role="status">{searchStatus}</p>

      {results.length > 0 && (
        <fieldset className="org-invite-results">
          <legend className="sr-only">Choose somebody to invite</legend>
          {results.map(person => {
            const pending = invited.some(i => i.id === person.id);
            return (
            <label
              key={person.id}
              className="org-invite-result"
              /* `data-` rather than a second class: the state is one thing the
                 stylesheet dims, not a variant with its own rules. */
              data-unavailable={pending ? 'true' : undefined}
            >
              <input
                type="radio"
                name="org-invite-person"
                value={person.id}
                checked={chosen?.id === person.id}
                disabled={pending}
                onChange={() => setChosen(person)}
              />
              <span className="avatar" aria-hidden="true">
                {person.profilePictureUrl
                  ? <img src={person.profilePictureUrl} alt="" className="avatar-img" />
                  : (person.avatar || <UserRound size={15} />)}
              </span>
              <span className="stack-xs">
                <span className="org-request-name">{person.name}</span>
                <span className="muted small">
                  {person.username && <>@{person.username}</>}
                  {pending && <>{person.username ? ' · ' : ''}already invited</>}
                </span>
              </span>
            </label>
            );
          })}
        </fieldset>
      )}

      {chosen && (
        <>
          <label className="label" htmlFor="org-invite-note">
            A note for {chosen.name} <span className="muted">(optional)</span>
          </label>
          <textarea
            id="org-invite-note"
            className="input"
            rows={3}
            value={note}
            maxLength={NOTE_MAX * 2}
            onChange={e => setNote(e.target.value)}
            placeholder={`For example: what ${organizationName} does, or why you thought of them.`}
            aria-describedby="org-invite-count"
          />
          <p id="org-invite-count" className={`small ${over ? 'field-error' : 'muted'}`} aria-live="polite">
            {over
              ? `${note.length - NOTE_MAX} characters too many.`
              : `${NOTE_MAX - note.length} characters left.`}
          </p>
        </>
      )}

      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!chosen || busy || over}>
          {busy
            ? <Loader2 size={15} className="spin" aria-hidden="true" />
            : <UserPlus2 size={15} aria-hidden="true" />}
          {chosen ? `Invite ${chosen.name}` : 'Invite'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
