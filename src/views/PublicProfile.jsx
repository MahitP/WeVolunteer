/**
 * A member's public profile, at /users/@username.
 *
 * ── What this page is, and what it deliberately is not ──
 *
 * It is a volunteer profile: who somebody is, what they are interested in, and
 * how much they have served. It is not an information dump about an account,
 * and it is not a social network — there is no follower count, no feed, and no
 * like button, for the same reason VolunteerProfile has never had one.
 *
 * Everything on it is chosen by the person it describes (bio, hobbies, skills,
 * a general area) or is a count. The server decides which of those a given
 * viewer may see; this file renders what arrives and never re-derives a
 * permission. If a field is absent from the payload, it is absent because the
 * server withheld it, and the correct response is to not draw that section —
 * never to draw an empty one that implies the person left it blank.
 *
 * ── Counts, not a percentage ──
 *
 * "Signed up 2 · Attended 1" and never "50%". A rate reads as a verdict on a
 * person when the evidence behind it is one missed shift, and a reader cannot
 * un-see the number. `eventsAwaitingRecord` is drawn alongside so that a gap
 * between the two reads as "the organizer has not confirmed yet", which is
 * usually what it is.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  MoreHorizontal, UserPlus, UserCheck, UserX, BellOff, Bell, ShieldMinus,
  Flag, Link2, MapPin, CalendarDays, Clock, Users, Sparkles, Lock, Check, Ban,
} from 'lucide-react';
import { api } from '../utils/api';
import { can } from '../authz';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import ConfirmDialog from '../components/common/ConfirmDialog';
import ReportModal from '../components/ReportModal';

/** "March 2025" — a joined date needs no day, and a day is more than is asked. */
const monthYear = (iso) => (iso
  ? new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  : null);

const dayMonthYear = (iso) => (iso
  ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  : null);

/**
 * The three-dot menu.
 *
 * A `<menu>` of real buttons rather than a styled list, so keyboard and screen
 * reader users get the semantics for free. Escape and outside-click close it,
 * and focus returns to the trigger — the same contract `useModal` gives
 * dialogs, implemented here rather than reused because a popover that traps
 * focus would be wrong.
 */
function ActionsMenu({ label, items }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e) => { if (!e.target.closest('.profile-menu')) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  return (
    <div className="profile-menu">
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(v => !v)}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <menu className="profile-menu-list" role="menu">
          {items.map(item => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className={item.destructive ? 'profile-menu-item profile-menu-item-danger' : 'profile-menu-item'}
                onClick={() => { setOpen(false); item.onSelect(); }}
              >
                <item.icon size={15} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </menu>
      )}
    </div>
  );
}

export default function PublicProfile({ currentUser, addToast }) {
  const { handle } = useParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [reporting, setReporting] = useState(false);

  /* The URL carries `@name`; the API takes the bare username. Normalising here
     means a pasted link with or without the `@` both resolve. */
  const username = String(handle || '').replace(/^@/, '');

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.fetchPublicProfile(username)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err.status === 404 ? 'not_found' : err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [username]);

  useEffect(() => load(), [load]);

  const act = async (fn, message) => {
    setBusy(true);
    try {
      const viewer = await fn();
      setData(prev => (prev ? { ...prev, viewer } : prev));
      if (message) addToast?.(message, 'success');
    } catch (err) {
      addToast?.(err.message || 'That did not work. Try again.', 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (loading) return <LoadingSkeleton heights={[160, 96, 220]} className="stack-lg" />;

  if (error === 'not_found') {
    return (
      <div className="page">
        <EmptyState
          icon={UserX}
          title="No profile here"
          message={`There is no member with the username @${username}. They may have changed it, or the link may be wrong.`}
          action={<Link className="btn btn-secondary" to="/directory">Search members</Link>}
        />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="page">
        <EmptyState
          icon={Lock}
          title="Profile unavailable"
          message={error || 'That profile could not be loaded right now.'}
          action={<button type="button" className="btn btn-secondary" onClick={load}>Try again</button>}
        />
      </div>
    );
  }

  const { profile, viewer } = data;
  const isSelf = profile.isSelf;
  const stats = profile.stats;
  const external = profile.externalService;
  const canBlock = can(currentUser, 'event.apply');

  /**
   * The four controls, ordered least to most severe, with Report last.
   *
   * Each is a distinct action, not a severity slider — see the header of
   * server/relationships.js for what each one actually does. The labels say
   * what will happen rather than naming a state, because "Mute" alone does not
   * tell a fifteen-year-old whether the other person finds out.
   */
  const menuItems = isSelf ? [] : [
    viewer.muted
      ? { id: 'unmute', icon: Bell, label: 'Unmute', onSelect: () => act(() => api.clearRelationship(profile.id, 'mute'), `Unmuted ${profile.name}.`) }
      : { id: 'mute', icon: BellOff, label: 'Mute — stop notifications about them', onSelect: () => act(() => api.setRelationship(profile.id, 'mute'), `You will not be notified about ${profile.name}.`) },
    viewer.restricted
      ? { id: 'unrestrict', icon: UserCheck, label: 'Remove restriction', onSelect: () => act(() => api.clearRelationship(profile.id, 'restrict'), `Restriction removed.`) }
      : {
        id: 'restrict',
        icon: ShieldMinus,
        label: 'Restrict — keep them out of your activity',
        onSelect: () => setConfirm({
          key: 'restrict',
          title: `Restrict ${profile.name}?`,
          body: 'They will not be able to send you a friend request, and your sign-ups will stop reaching them. They are not told, and nothing about volunteering together changes — you can still be on the same event.',
          confirmLabel: 'Restrict',
          run: () => api.setRelationship(profile.id, 'restrict'),
          done: `${profile.name} is restricted.`,
        }),
      },
    /**
     * Block is offered only to accounts that hold the capability, which by
     * design is students and not organizers. Rendering a button that the server
     * will refuse would be worse than not rendering it: a student reading an
     * organizer's profile would see a control that silently fails.
     */
    ...(canBlock ? [viewer.blocked
      ? { id: 'unblock', icon: UserCheck, label: 'Unblock', onSelect: () => act(() => api.unblockUser(profile.id).then(() => api.fetchPublicProfile(username).then(r => r.viewer)), 'Unblocked.') }
      : {
        id: 'block',
        icon: Ban,
        label: 'Block — stop them contacting you',
        destructive: true,
        onSelect: () => setConfirm({
          key: 'block',
          title: `Block ${profile.name}?`,
          body: 'They will not be able to message you. Blocking does NOT remove you from any event or affect your hours — if you are both signed up for something, you both stay signed up and your service record is untouched.',
          confirmLabel: 'Block',
          run: () => api.blockUser(profile.id).then(() => api.fetchPublicProfile(username).then(r => r.viewer)),
          done: `${profile.name} is blocked.`,
        }),
      }] : []),
    { id: 'report', icon: Flag, label: 'Report to a moderator', destructive: true, onSelect: () => setReporting(true) },
  ];

  return (
    <div className="page stack-lg">
      {/* ── Identity ── */}
      <section className="card card-pad profile-header">
        <div className="row-between profile-header-top">
          <div className="row profile-identity">
            <span className="avatar avatar-lg" aria-hidden="true">
              {profile.profilePictureUrl
                ? <img src={profile.profilePictureUrl} alt="" className="avatar-img" />
                : (profile.avatar || '🙂')}
            </span>
            <div className="stack-xs">
              <h1 className="profile-name">{profile.name}</h1>
              {profile.username && <p className="muted profile-handle">@{profile.username}</p>}
              {profile.location && (
                <p className="muted profile-meta">
                  <MapPin size={13} aria-hidden="true" /> {profile.location}
                </p>
              )}
            </div>
          </div>

          <div className="row profile-actions">
            {!isSelf && <FriendButton viewer={viewer} profile={profile} busy={busy} act={act} />}
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Copy a link to this profile"
              onClick={() => {
                const url = `${window.location.origin}/users/@${profile.username}`;
                navigator.clipboard?.writeText(url)
                  .then(() => addToast?.('Profile link copied.', 'success'))
                  .catch(() => addToast?.(url, 'info'));
              }}
            >
              <Link2 size={18} aria-hidden="true" />
            </button>
            {!isSelf && <ActionsMenu label={`More actions for ${profile.name}`} items={menuItems} />}
          </div>
        </div>

        {profile.bio && <p className="profile-bio">{profile.bio}</p>}

        {/**
          * The privacy notice is shown to the VIEWER, not as a warning about the
          * person. It explains why a section is missing rather than leaving a
          * reader to conclude the profile is empty.
          */}
        {profile.visibility !== 'public' && !isSelf && profile.bio === undefined && (
          <p className="muted profile-privacy-note">
            <Lock size={13} aria-hidden="true" /> This member keeps their school and year private.
          </p>
        )}

        {(profile.school || profile.grade) && (
          <p className="muted profile-meta">
            {profile.school}{profile.school && profile.grade ? ' · ' : ''}
            {profile.grade && profile.grade !== 'N/A' && (profile.grade === 'Adult' ? 'Adult' : `Grade ${profile.grade}`)}
          </p>
        )}
      </section>

      {/* ── Volunteering ── */}
      <section className="card">
        <div className="card-head"><h2>Volunteering</h2></div>
        <div className="card-body">
          <div className="stats profile-stats">
            <Stat icon={CalendarDays} label="Events signed up" value={stats.eventsSignedUp} />
            <Stat icon={Check} label="Events attended" value={stats.eventsAttended} />
            <Stat icon={Clock} label="Hours" value={stats.hours} />
          </div>
          {stats.eventsAwaitingRecord > 0 && (
            <p className="muted profile-awaiting">
              {stats.eventsAwaitingRecord === 1
                ? '1 event is waiting for the organizer to confirm attendance.'
                : `${stats.eventsAwaitingRecord} events are waiting for the organizer to confirm attendance.`}
            </p>
          )}
          <dl className="profile-facts">
            <div>
              <dt>Joined</dt>
              <dd>{monthYear(profile.joinedAt) || '—'}</dd>
            </div>
            <div>
              <dt>Last volunteered</dt>
              <dd>{dayMonthYear(profile.lastVolunteeredAt) || 'Not yet'}</dd>
            </div>
          </dl>
          {external?.verifiedHours > 0 && (
            <p className="muted profile-external">
              Plus {external.verifiedHours} verified hours volunteered outside WeVolunteer.
            </p>
          )}
        </div>
      </section>

      {/* ── Interests ── */}
      {(profile.hobbies?.length > 0 || profile.skills?.length > 0) && (
        <section className="card">
          <div className="card-head"><h2>Interests</h2></div>
          <div className="card-body stack-md">
            {profile.hobbies?.length > 0 && (
              <ChipRow title="Hobbies" items={profile.hobbies} icon={Sparkles} />
            )}
            {profile.skills?.length > 0 && (
              <ChipRow title="Skills" items={profile.skills} icon={Check} />
            )}
          </div>
        </section>
      )}

      {/* ── Organizations ── */}
      {profile.organizations?.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Organizations</h2></div>
          <div className="card-body">
            <ul className="list profile-orgs">
              {profile.organizations.map(org => (
                <li key={org.id} className="list-row">
                  <Link to={`/organizations/${org.slug}`} className="card-link row">
                    <Users size={15} aria-hidden="true" />
                    <span>{org.name}</span>
                    {org.memberRole === 'manager' && <span className="tag tag-brand">Manager</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {isSelf && (
        <p className="muted profile-selfnote">
          This is how your profile looks to other members.{' '}
          <Link to="/settings?section=privacy">Change what is visible</Link>.
        </p>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          destructive
          busy={busy}
          onConfirm={() => act(confirm.run, confirm.done)}
          onCancel={() => setConfirm(null)}
        >
          {confirm.body}
        </ConfirmDialog>
      )}

      {reporting && (
        <ReportModal
          targetType="user"
          targetId={profile.id}
          onClose={() => setReporting(false)}
          addToast={addToast}
        />
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="stat">
      <span className="stat-value">
        <Icon size={15} aria-hidden="true" /> {value}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function ChipRow({ title, items, icon: Icon }) {
  return (
    <div className="stack-xs">
      <h3 className="stack-heading">
        <Icon size={14} aria-hidden="true" /> {title}
      </h3>
      <ul className="chips">
        {items.map(item => <li key={item} className="chip">{item}</li>)}
      </ul>
    </div>
  );
}

/**
 * One button with four states, because to the person tapping it there is one
 * question — "are we friends?" — and its answer is currently one of four
 * things. Splitting it into Add / Accept / Cancel / Remove buttons would put
 * three of them on screen doing nothing.
 */
function FriendButton({ viewer, profile, busy, act }) {
  if (viewer.blocked || viewer.restrictedBy) return null;

  if (viewer.friendship === 'friends') {
    return (
      <button type="button" className="btn btn-secondary" disabled={busy}
        onClick={() => act(() => api.removeFriend(profile.id), `You and ${profile.name} are no longer friends.`)}>
        <UserCheck size={16} aria-hidden="true" /> Friends
      </button>
    );
  }
  if (viewer.friendship === 'incoming') {
    return (
      <button type="button" className="btn btn-primary" disabled={busy}
        onClick={() => act(() => api.acceptFriend(profile.id), `You and ${profile.name} are now friends.`)}>
        <UserPlus size={16} aria-hidden="true" /> Accept request
      </button>
    );
  }
  if (viewer.friendship === 'requested') {
    return (
      <button type="button" className="btn btn-secondary" disabled={busy}
        onClick={() => act(() => api.removeFriend(profile.id), 'Request withdrawn.')}>
        Requested
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-primary" disabled={busy}
      onClick={() => act(() => api.addFriend(profile.id), `Friend request sent to ${profile.name}.`)}>
      <UserPlus size={16} aria-hidden="true" /> Add friend
    </button>
  );
}
