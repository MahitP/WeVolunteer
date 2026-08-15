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
  UserPlus2, UserMinus2, Ban,
} from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import OrganizationAnnouncements from '../components/OrganizationAnnouncements';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { avatarColorValue } from '../utils/avatarColors';
import OrgAvatar from '../components/common/OrgAvatar';
import RemoveMemberDialog from '../components/organizations/RemoveMemberDialog';
import AppealInbox from '../components/organizations/AppealInbox';
import { formatHours, formatDay } from '../utils/helpers';
import ActionsMenu from '../components/common/ActionsMenu';

export default function OrganizationPage({ addToast, currentUser }) {
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

  /**
   * Is this roster row the person reading it?
   *
   * The menu is hidden on your own row. Every action in it is either something
   * the server refuses for yourself — banning yourself is a 409, because it
   * would lock you out of an organization only you can unlock — or something
   * this page already offers better elsewhere: leaving is the `Leave` button in
   * the header, which names the consequence and confirms it.
   *
   * Offering "Remove Sarah Jenkins" on Sarah's own row was a second, worse door
   * to the same action, next to a third that the server would reject.
   */
  const isSelf = (m) => m.id === currentUser?.id;

  /**
   * The actions this manager may actually take on this member.
   *
   * Built here rather than inline so the rule is stated once: the menu offers
   * only what the SERVER will accept. A frontend that offers more is not a
   * security hole — the server is authoritative and independently refuses — but
   * it is a promise the product cannot keep, and the person finds out by being
   * told no.
   */
  const memberActions = (m) => {
    const actions = [];

    /* A manager's rank is not changed from here. The server refuses to demote
       the last manager, and demoting a peer is a different decision from
       managing a member — it belongs with a confirmation, not in a row menu. */
    if (m.memberRole !== 'manager') {
      const isOrganizer = m.memberRole === 'student_organizer';
      actions.push({
        id: 'role',
        icon: isOrganizer ? UserMinus2 : UserPlus2,
        /* The label states the destination, not the mechanism. "Demote to
           Student" and "Promote to Student Organizer" are different sentences,
           so the control cannot be misread as one button in two states. */
        label: isOrganizer ? 'Demote to Student' : 'Promote to Student Organizer',
        onSelect: () => setMemberRole(m, isOrganizer ? 'member' : 'student_organizer'),
      });
    }

    actions.push({
      id: 'kick',
      icon: UserMinus,
      label: 'Remove from organization',
      onSelect: () => setRemoving({ ...m, intent: 'kick' }),
    });

    actions.push({
      id: 'ban',
      icon: Ban,
      label: 'Ban from organization',
      destructive: true,
      onSelect: () => setRemoving({ ...m, intent: 'ban' }),
    });

    return actions;
  };

  const removeMember = async (member, { mode = 'kick', reason = '' } = {}) => {
    setBusy(true);
    try {
      await api.removeOrganizationMember(key, member.id, { mode, reason });
      addToast(
        mode === 'ban'
          ? `${member.name} was banned from ${data.organization.name}.`
          : `${member.name} was removed from ${data.organization.name}.`,
        'info',
      );
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

  /**
   * Handing out, or taking back, the Student Organizer rank.
   *
   * Offered only on rows that can actually take it — an ordinary member or
   * somebody who already holds it. A manager's row has no toggle: they can
   * already do everything the rank confers, so "make them a student organizer"
   * would be a demotion wearing the word promote, and demoting a manager is a
   * different decision that belongs with a different control.
   */
  const setMemberRole = async (member, memberRole) => {
    setBusy(true);
    try {
      await api.setOrganizationMemberRole(key, member.id, memberRole);
      addToast?.(
        memberRole === 'student_organizer'
          ? `${member.name} can now post and create events for ${data.organization.name}.`
          : `${member.name} is an ordinary member again.`,
        'success',
      );
      load();
    } catch (err) {
      /* Reported, not swallowed — the likely refusal is the last-manager guard,
         and a manager who does not learn why will simply press it again. */
      addToast?.(err.message, 'error');
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

  const { organization: org, members, events, viewer, totals } = data;
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
              <h2 className="page-title">{org.name}</h2>
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

      {/**
        * Hours, scoped to this organization.
        *
        * It sits directly under the identity card because it is the thing a
        * member came to this page to find out — "how much have I done for NHS"
        * — and above Opportunities because a record of what you have done is
        * the context for deciding what to do next.
        *
        * No new navigation entry anywhere. The organization already had a page;
        * the number belongs on it.
        */}
      <OrganizationService org={org} viewer={viewer} totals={totals} />

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

      {/* `canPost`, not `canManage` — a Student Organizer posts and a manager
          posts, and the server is the one that decides which is which. Passing
          `canManage` here would show the composer to exactly the people who no
          longer need to be the only ones with it. */}
      <OrganizationAnnouncements
        orgKey={key}
        canManage={viewer?.canPost === true}
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
                    {/* Which of the three ranks, said plainly. An ordinary
                        member gets no tag: "Member" on every row but two is
                        noise, and the absence already says it. */}
                    {m.memberRole === 'manager' && <span className="tag tag-brand">Manager</span>}
                    {m.memberRole === 'student_organizer' && (
                      <span className="tag">Student organizer</span>
                    )}
                    {/**
                      * Hours, for managers only — the server omits the field
                      * entirely for anybody else, so this cannot render for a
                      * member however the roster is reached.
                      *
                      * Hours WITH THIS ORGANIZATION, never the platform-wide
                      * total: what a student does for another club is not this
                      * one's business, and the query is scoped so there is no
                      * figure here that could be it.
                      */}
                    {typeof m.hours === 'number' && (
                      <span className="tnum muted org-member-hours">
                        {formatHours(m.hours)}
                      </span>
                    )}
                  </Link>
                  {/**
                    * One control, and a menu behind it.
                    *
                    * ── What was here before ──
                    *
                    * Two icon buttons sat side by side: a `UserCog` that toggled
                    * student organizer, and a `UserMinus` that opened the removal
                    * dialog. The cog reads as "manage this person" — a settings
                    * glyph next to somebody's name means "open their options" to
                    * almost everybody — but it was a switch, and pressing it
                    * promoted or demoted them immediately with no confirmation
                    * and no statement of what had happened.
                    *
                    * That is the worst kind of control: it looks like it opens
                    * something and instead it does something, and what it does is
                    * change a person's standing in their club.
                    *
                    * ── Why a menu fixes it rather than a better tooltip ──
                    *
                    * The problem is not that the icon was under-labelled; it is
                    * that a row of unlabelled glyphs makes the reader guess which
                    * of several similar-looking actions each one is. A menu names
                    * every action in words, in one place, and the promote item
                    * carries the CURRENT role in its label — so "Make Sam a
                    * student organizer" and "Remove Sam as a student organizer"
                    * are different sentences rather than the same button in a
                    * different state.
                    *
                    * Removal and banning are separate items for the same reason.
                    * They were one dialog with a mode chosen inside it, which
                    * meant a manager had to open the destructive dialog before
                    * discovering which destructive thing it offered.
                    */}
                  {viewer.canManage && !isSelf(m) && (
                    <ActionsMenu
                      icon={Settings2}
                      label={`Manage ${m.name}`}
                      disabled={busy}
                      items={memberActions(m)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* The bottom of the management area, below the roster — the rarest thing
          a manager does, and the one with the most text. It renders nothing at
          all when there is nothing to review. */}
      {viewer?.canManage && <AppealInbox orgKey={key} addToast={addToast} />}

      {removing && (
        <RemoveMemberDialog
          member={removing}
          organizationName={org.name}
          busy={busy}
          intent={removing.intent}
          onCancel={() => setRemoving(null)}
          onConfirm={opts => removeMember(removing, opts)}
        />
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

/**
 * What the viewer has done for this organization.
 *
 * ── Their own record, not a scoreboard ──
 *
 * The headline figure is the viewer's own. Per-member numbers arrive only for
 * managers, and are rendered on the roster rather than here, so this card reads
 * the same for everybody: it is about you.
 *
 * ── Why it is not a dashboard ──
 *
 * One number, one supporting count, and the events behind them. A club page for
 * fifteen-year-olds does not need a chart, and the hours here are already
 * summarised platform-wide on the profile — this is the same arithmetic scoped
 * to one organization, not a second accounting system.
 *
 * The history collapses past five. A member with thirty events should not push
 * the opportunities they could sign up for off the bottom of the page.
 */
function OrganizationService({ org, viewer, totals }) {
  const [expanded, setExpanded] = useState(false);
  const history = viewer?.history ?? [];
  const SHOWN = 5;
  const visible = expanded ? history : history.slice(0, SHOWN);

  return (
    <section className="card" aria-labelledby="org-service-heading">
      <div className="card-head">
        <h2 id="org-service-heading">Your service with {org.name}</h2>
      </div>
      <div className="card-body">
        {history.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No hours yet"
            message={`Hours you volunteer at ${org.name}'s events will be counted here once an organizer confirms you were there.`}
          />
        ) : (
          <>
            <div className="org-service-figures">
              <div>
                <p className="org-service-figure tnum">{formatHours(viewer.hours)}</p>
                <p className="muted small">confirmed with this organization</p>
              </div>
              <div>
                <p className="org-service-figure tnum">{viewer.events}</p>
                <p className="muted small">{viewer.events === 1 ? 'event' : 'events'}</p>
              </div>
            </div>

            <ul className="org-service-history">
              {visible.map(row => (
                <li key={row.eventId}>
                  <span className="org-service-event">{row.title}</span>
                  <span className="muted small">
                    {row.startsAt ? formatDay(row.startsAt) : 'Date unavailable'}
                    {row.shifts > 1 && <> · {row.shifts} shifts</>}
                  </span>
                  <span className="tnum org-service-row-hours">
                    {row.creditsHours ? formatHours(row.hours) : 'Participation'}
                  </span>
                </li>
              ))}
            </ul>

            {history.length > SHOWN && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
              >
                {expanded ? 'Show fewer' : `Show all ${history.length} events`}
              </button>
            )}
          </>
        )}

        {/* Managers get the collective figure. Members do not: with a small
            roster a total plus your own number is somebody else's number. */}
        {totals && (
          <p className="muted small org-service-total">
            Altogether, {totals.volunteers} {totals.volunteers === 1 ? 'person has' : 'people have'}{' '}
            volunteered {formatHours(totals.hours)} across {totals.events}{' '}
            {totals.events === 1 ? 'event' : 'events'} for {org.name}.
          </p>
        )}
      </div>
    </section>
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
