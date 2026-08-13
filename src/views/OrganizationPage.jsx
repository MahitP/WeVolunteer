/**
 * One organization: what it is, who is in it, and what it is running.
 *
 * Deliberately modest. This is a club page, not a social network — no wall, no
 * posts, no following. Everything on it answers one of three questions a
 * student actually has: what is this, should I join, and what can I sign up
 * for?
 *
 * The member roster renders the same summary shape as directory search, which
 * comes from the same server-side serializer. An organization page listing its
 * members must not become the route by which somebody reads a field a profile
 * would have withheld.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Building2, Users, CalendarDays, UserRound, LogIn, LogOut, Settings2, Clock, UserMinus,
} from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import OrganizationAnnouncements from '../components/OrganizationAnnouncements';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { avatarColorValue } from '../utils/avatarColors';
import OrgAvatar from '../components/common/OrgAvatar';

export default function OrganizationPage({ addToast }) {
  const { key } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.fetchOrganization(key)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err.status === 404 ? 'not_found' : err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key]);

  useEffect(() => load(), [load]);

  const [removing, setRemoving] = useState(null);

  const removeMember = async (member) => {
    setBusy(true);
    try {
      await api.removeOrganizationMember(key, member.id);
      addToast(`${member.name} was removed from ${data.organization.name}.`, 'info');
      setRemoving(null);
      load();
    } catch (err) {
      /* Surfaced rather than swallowed: the most likely refusal is the
         last-manager guard, and a manager who does not learn why will simply
         press it again. */
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const membership = async (join) => {
    setBusy(true);
    try {
      await (join ? api.joinOrganization(key) : api.leaveOrganization(key));
      addToast?.(join ? `You joined ${data.organization.name}.` : `You left ${data.organization.name}.`, 'success');
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
      setLeaving(false);
    }
  };

  if (loading) return <LoadingSkeleton heights={[150, 90, 220]} className="stack-lg" />;

  if (error === 'not_found') {
    return (
      <div className="page">
        <EmptyState
          icon={Building2}
          title="No organization here"
          message="That organization does not exist, or its link has changed since it was shared."
          action={<Link className="btn btn-secondary" to="/directory">Browse organizations</Link>}
        />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="page">
        <EmptyState icon={Building2} title="Could not load this organization" message={error}
          action={<button type="button" className="btn btn-secondary" onClick={load}>Try again</button>} />
      </div>
    );
  }

  const { organization: org, members, events, viewer } = data;
  const upcoming = events.filter(e => e.startsAt && new Date(e.startsAt) >= new Date());
  const past = events.filter(e => !e.startsAt || new Date(e.startsAt) < new Date());

  return (
    <div className="page stack-lg">
      <section className="card card-pad">
        <div className="row-between org-header-top">
          <div className="row org-identity">
            {/* Upload, then emoji, then the building glyph — the same order
                `users` resolves an avatar in, so the two never disagree about
                which picture wins. `alt=""` because the name is right beside
                it: announcing the logo would be reading the name twice. */}
            {/* The same component every other surface uses. This page used to
                carry the only correct copy of the fallback chain, which is how
                the others drifted. */}
            <OrgAvatar organization={org} size={22} className="avatar-lg org-avatar" />
            <div className="stack-xs">
              <h1>{org.name}</h1>
              <p className="muted org-meta">
                <Users size={13} aria-hidden="true" /> {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                {org.eventCount > 0 && <> · <CalendarDays size={13} aria-hidden="true" /> {org.eventCount} {org.eventCount === 1 ? 'event' : 'events'}</>}
              </p>
            </div>
          </div>
          <div className="row org-actions">
            {viewer.canManage && (
              <Link className="btn btn-secondary" to={`/organizations/${org.slug}/edit`}>
                <Settings2 size={16} aria-hidden="true" /> Manage
              </Link>
            )}
            {viewer.isMember ? (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setLeaving(true)}>
                <LogOut size={16} aria-hidden="true" /> Leave
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => membership(true)}>
                <LogIn size={16} aria-hidden="true" /> Join
              </button>
            )}
          </div>
        </div>

        {org.description && <p className="org-description">{org.description}</p>}

        {org.tags?.length > 0 && (
          <ul className="chips">
            {org.tags.map(tag => <li key={tag} className="chip">{tag}</li>)}
          </ul>
        )}

        <p className="muted org-founder">
          Started by {org.createdBy.id
            ? <Link to={`/users/id/${org.createdBy.id}`}>{org.createdBy.name}</Link>
            : org.createdBy.name}
        </p>

        {!viewer.isMember && (
          <p className="muted org-joinnote">
            Members are told when this organization posts a new opportunity.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>Opportunities</h2></div>
        <div className="card-body">
          {upcoming.length === 0 && past.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="No events yet"
              message="When this organization posts an opportunity, it will appear here."
            />
          ) : (
            <>
              {upcoming.length > 0 && <EventList title="Coming up" events={upcoming} />}
              {past.length > 0 && <EventList title="Past" events={past} muted />}
            </>
          )}
        </div>
      </section>

      <OrganizationAnnouncements
        orgKey={key}
        canManage={viewer?.canManage === true}
        isMember={viewer?.isMember === true}
        repliesEnabled={org.allowReplies !== false}
        addToast={addToast}
      />

      <section className="card">
        <div className="card-head"><h2>Members</h2></div>
        <div className="card-body">
          {members.length === 0 ? (
            <p className="muted">No members yet.</p>
          ) : (
            <ul className="list org-members">
              {members.map(m => (
                <li key={m.id} className="list-row">
                  <Link
                    to={m.username ? `/users/@${m.username}` : `/users/id/${m.id}`}
                    className="card-link row org-member"
                  >
                    <span className="avatar" aria-hidden="true">
                      {m.profilePictureUrl
                        ? <img src={m.profilePictureUrl} alt="" className="avatar-img" />
                        : (m.avatar || <UserRound size={16} />)}
                    </span>
                    <span className="stack-xs org-member-body">
                      <span>{m.name}</span>
                      {m.username && <span className="muted org-member-handle">@{m.username}</span>}
                    </span>
                    {m.memberRole === 'manager' && <span className="tag tag-brand">Manager</span>}
                  </Link>
                  {/**
                    * Removal, for managers.
                    *
                    * The route has been implemented and tested since
                    * organizations shipped and nothing ever called it, so a
                    * manager could promote, demote and leave but not remove.
                    *
                    * Outside the `<Link>`, never inside it: a button nested in
                    * an anchor is invalid, and a mis-tap would navigate instead
                    * of removing — or worse, remove instead of navigating. The
                    * server refuses the last manager, so no guard is duplicated
                    * here; it reports what the server says.
                    */}
                  {viewer.canManage && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      disabled={busy}
                      onClick={() => setRemoving(m)}
                      title={`Remove ${m.name}`}
                      aria-label={`Remove ${m.name} from ${org.name}`}
                    >
                      <UserMinus size={15} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove"
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={() => removeMember(removing)}
        >
          {/* Says what removal does NOT do, because that is the thing a
              manager is actually worried about. Hours are service history and
              a membership change never touches them. */}
          <p>
            They will no longer be a member of {org.name}. The hours they have
            already served stay on their record.
          </p>
        </ConfirmDialog>
      )}

      {leaving && (
        <ConfirmDialog
          title={`Leave ${org.name}?`}
          confirmLabel="Leave"
          destructive
          busy={busy}
          onConfirm={() => membership(false)}
          onCancel={() => setLeaving(false)}
        >
          You will stop being told about this organization&rsquo;s new opportunities. Nothing you have
          already signed up for changes, and your hours are untouched. You can rejoin at any time.
        </ConfirmDialog>
      )}
    </div>
  );
}

function EventList({ title, events, muted = false }) {
  return (
    <div className="stack-sm org-eventgroup">
      <h3 className="stack-heading">{title}</h3>
      <ul className="list">
        {events.map(e => (
          <li key={e.id} className="list-row">
            {/* `/discover?event=<id>` — there is no route for a single event,
                and the catch-all is a real 404. This is the same form
                RedirectToEvent sends `/events/:id/edit` to. */}
            <Link to={`/discover?event=${e.id}`} className={muted ? 'card-link dim' : 'card-link'}>
              <span className="row-between org-event">
                <span>{e.title}</span>
                <span className="muted org-event-meta">
                  {/**
                    * `creditsHours: false` is a participation event. It shows
                    * "Participation" rather than a duration or a zero, because
                    * "0 hrs" beside somebody's volunteering reads as a failure
                    * when what it means is that this activity is not measured in
                    * hours at all.
                    */}
                  {!e.creditsHours && (
                    <span className="tag tag-accent">
                      <Clock size={12} aria-hidden="true" /> Participation
                    </span>
                  )}
                  {e.status === 'completed' && <span className="status status-muted">Completed</span>}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
