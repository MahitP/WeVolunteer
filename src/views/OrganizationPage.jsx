/**
 * One organization: what it is, whether you can join it, and what it is running.
 *
 * ── The information architecture, and why it is one architecture ──
 *
 * Five readers arrive here — a signed-out visitor with a link, a student who is
 * not a member, a member, somebody whose request is waiting, and a manager — and
 * they are NOT five pages. The skeleton is the same for all of them:
 *
 *     the plate        who this club is, and the one thing you can do about it
 *     the record       what you personally have done for it
 *     opportunities    what you could sign up for
 *     the noticeboard  what the club has said
 *     members          who is in it
 *     manage           the controls, visibly set apart
 *
 * What changes is which of those has content, and the plate's single action. The
 * server decides the action (`viewer.affordance`) and which sections the reader
 * is entitled to; this file renders that and computes no policy of its own.
 *
 * ── What was here before ──
 *
 * Five stacked cards in source order, a 22-pixel avatar beside an `h2`, and the
 * primary action as one of four ternaries inside the header row — with Leave, the
 * most destructive thing a member can do, in the position a newcomer's Join
 * occupies. The plate replaces the identity block and Leave moves into the
 * actions menu; the sections below are the same ones, given a hierarchy.
 *
 * The member roster renders the same summary shape as directory search, from the
 * same server-side serializer, and the server now sends it only to members,
 * managers and moderators — a club's list of children is not something every
 * account holder gets to read.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Building2, Users, CalendarDays, UserRound, LogOut, Settings2, Clock, UserMinus,
  FileText, Award, UserPlus2, UserMinus2, Ban, Share2, DoorOpen, Undo2, MailOpen, Check,
} from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import OrganizationAnnouncements from '../components/OrganizationAnnouncements';
import ConfirmDialog from '../components/common/ConfirmDialog';
import '../utils/avatarColors';
import RemoveMemberDialog from '../components/organizations/RemoveMemberDialog';
import AppealInbox from '../components/organizations/AppealInbox';
import BannedMembers from '../components/organizations/BannedMembers';
import OrganizationMasthead from '../components/organizations/OrganizationMasthead';
import JoinAction from '../components/organizations/JoinAction';
import ShareOrganizationDialog from '../components/organizations/ShareOrganizationDialog';
import JoinRequestInbox from '../components/organizations/JoinRequestInbox';
import InvitationManager from '../components/organizations/InvitationManager';
import RequestToJoinDialog from '../components/organizations/RequestToJoinDialog';
import '../components/organizations/OrganizationExperience.css';
import { joinPolicySentence, JOIN_POLICY_COPY } from '../organizationPolicy';
import { inviteTokenFor, clearPendingInvite } from '../utils/pendingInvite';
import { formatHours, formatDay } from '../utils/helpers';
import ActionsMenu from '../components/common/ActionsMenu';
import { organizationPath, organizationSubPath } from '../utils/organizationUrl';

export default function OrganizationPage({ addToast, currentUser }) {
  const { key } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [requesting, setRequesting] = useState(false);

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

  /**
   * Move to the canonical address once the club is known.
   *
   * `/organizations/:key` still resolves an id and a bare handle, because
   * notification rows, audit entries and links people saved were written before
   * `@handle` existed and must keep working. But the address a reader ends up
   * looking at — the one in the location bar, the one they copy, the one that
   * works when they send it to somebody with no account — should be the
   * canonical one.
   *
   * `replace`, so the non-canonical URL does not sit in the history behind
   * them: pressing Back would otherwise land on the same page and redirect
   * again, which is a trap rather than a navigation.
   */
  const canonical = data?.organization?.slug ? organizationPath(data.organization) : null;
  useEffect(() => {
    if (!canonical) return;
    if (decodeURIComponent(location.pathname) !== decodeURIComponent(canonical)) {
      navigate(canonical, { replace: true });
    }
  }, [canonical, location.pathname, navigate]);

  const [removing, setRemoving] = useState(null);

  /**
   * The invitation token this tab is holding for this club, if any.
   *
   * The server never sees it on a GET — a query parameter would put a live link
   * into browser history and into every proxy log — so a reader who arrived
   * through a link is told `invite_required` and this is what turns that back
   * into a Join. Safe because it grants nothing: the token travels with the
   * press and the server refuses it if it has since been replaced, at which
   * point the page reloads into the honest state.
   *
   * Keyed on the SLUG the server returned rather than on the route parameter,
   * because `/organizations/:key` accepts an id too and a token stored against
   * the slug must not be offered up for a different club.
   */
  const inviteToken = useMemo(
    () => (data?.organization?.slug ? inviteTokenFor(data.organization.slug) : null),
    [data?.organization?.slug],
  );

  /**
   * Is this roster row the person reading it?
   *
   * The menu is hidden on your own row. Every action in it is either something
   * the server refuses for yourself — banning yourself is a 409, because it
   * would lock you out of an organization only you can unlock — or something
   * this page already offers better elsewhere: leaving is in the plate's actions
   * menu, which names the consequence and confirms it.
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

  /**
   * Joining, with the invitation token when this tab is holding one.
   *
   * The token is cleared once it has done its work, so a tab does not carry a
   * spent invitation around for the rest of a session — and so a later visit to
   * the same club renders the state the server actually reports rather than an
   * optimistic Join.
   */
  const join = async () => {
    setBusy(true);
    try {
      await api.joinOrganizationWithInvite(key, inviteToken ?? undefined);
      addToast?.(`You joined ${data.organization.name}.`, 'success');
      clearPendingInvite();
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
      /* Reload on failure too. The likely refusal is a token that has been
         replaced since the link was shared, and the page must stop offering a
         Join that cannot work. */
      load();
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await api.leaveOrganization(key);
      addToast?.(`You left ${data.organization.name}.`, 'success');
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
      setLeaving(false);
    }
  };

  /**
   * Declining an invitation.
   *
   * No confirmation dialog. Declining removes nothing the reader had — they
   * were not a member — and the club's door is still open: they can join with a
   * link, or send a request if the club takes them. The toast says so, because
   * "you cannot be invited again" is the one consequence that is not obvious.
   */
  const declineInvitation = async () => {
    setBusy(true);
    try {
      await api.declineOrganizationInvitation(key);
      addToast?.(
        `You declined the invitation to ${data.organization.name}. `
        + 'You can still join with an invitation link if you change your mind.',
        'info',
      );
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
      load();
    } finally {
      setBusy(false);
    }
  };

  const requestToJoin = async (message) => {
    setBusy(true);
    try {
      const res = await api.requestToJoinOrganization(key, message);
      setRequesting(false);
      addToast?.(
        res.created
          ? `Your request to join ${data.organization.name} was sent.`
          : 'Your request is already waiting for a manager.',
        'success',
      );
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
      load();
    } finally {
      setBusy(false);
    }
  };

  const withdrawRequest = async () => {
    setBusy(true);
    try {
      await api.withdrawOrganizationJoinRequest(key);
      addToast?.('Your request was taken back.', 'info');
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
      setWithdrawing(false);
    }
  };

  if (loading) return <LoadingSkeleton heights={[190, 120, 220]} className="stack-lg" />;

  if (error === 'not_found') {
    return (
      <div className="page">
        {/**
          * `headingLevel={2}`, because this empty state is the whole page.
          *
          * The shell renders the `h1`; an empty state's default `h3` then skips
          * a level, and somebody navigating by heading — which is how a screen
          * reader user skims — is told a level exists that does not.
          * `a11y/sweep.aria.spec.js` logged exactly that on this route:
          * `h1 "Organization" -> h3 "No organization here"`. Everywhere the
          * default is right, an empty state sits under a card's own `h2`.
          */}
        <EmptyState
          headingLevel={2}
          icon={Building2}
          title="No organization here"
          message="That organization does not exist, or its link has changed since it was shared."
          action={<Link className="btn btn-secondary" to="/organizations">Browse organizations</Link>}
        />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="page">
        <EmptyState headingLevel={2} icon={Building2} title="Could not load this organization" message={error}
          action={<button type="button" className="btn btn-secondary" onClick={load}>Try again</button>} />
      </div>
    );
  }

  const { organization: org, members, events, viewer, totals } = data;
  const upcoming = events.filter(e => e.startsAt && new Date(e.startsAt) >= new Date());
  const past = events.filter(e => !e.startsAt || new Date(e.startsAt) < new Date());
  /**
   * The affordance the reader actually has, which is the server's answer plus
   * the one thing the server cannot know.
   *
   * The token is never sent to a GET — a query parameter would put a live link
   * into browser history and into every proxy log — so a reader who arrived
   * through a link is told `invite_required`. Turning that back into `join` HERE,
   * once, is what keeps the button and the sentence under it telling the same
   * story: computing it inside `JoinAction` alone left the control saying Join
   * while the line beneath it said to go and ask somebody for a link.
   *
   * Optimism is free because it grants nothing: the token travels with the press
   * and the server refuses it if it has since been replaced, at which point the
   * page reloads into the honest state.
   */
  const reported = viewer.affordance ?? (viewer.isMember ? 'member' : 'join');
  const affordance = reported === 'invite_required' && inviteToken ? 'join' : reported;
  /**
   * A direct invitation, which the server DOES decide.
   *
   * `viewer.invitation` is a row naming this reader, so unlike the share token
   * there is nothing to keep out of a URL and nothing for the client to
   * present — which is why `viewer.affordance` already reads `join` when one
   * exists. This is only for the banner that explains WHY the club is suddenly
   * joinable and offers the other answer.
   */
  const invitation = viewer.invitation ?? null;

  /**
   * The two secondary actions that are NOT buttons.
   *
   * Both are rare and both undo something: Leave ends a membership, and Withdraw
   * takes back a request somebody deliberately sent. Neither belongs beside the
   * primary action — Leave used to occupy the position a newcomer's Join
   * occupies, which made the loudest control on a member's page the one that
   * ends their membership.
   *
   * Share and Settings stay visible, because both are things a manager came here
   * to do rather than things they might undo.
   */
  const plateMenu = [];
  if (affordance === 'pending') {
    plateMenu.push({
      id: 'withdraw',
      icon: Undo2,
      label: 'Take back my request',
      onSelect: () => setWithdrawing(true),
    });
  }
  if (viewer.isMember) {
    plateMenu.push({
      id: 'leave',
      icon: LogOut,
      label: `Leave ${org.name}`,
      destructive: true,
      onSelect: () => setLeaving(true),
    });
  }

  return (
    <div className="page stack-lg">
      {/**
        * You have been invited.
        *
        * Above the plate, because it is the reason this page looks the way it
        * does to this reader: an invitation-only club showing a Join button
        * makes no sense until you know somebody asked you.
        *
        * The note is rendered as TEXT — `{invitation.message}` in JSX, which
        * React escapes — and never as markup. Who sent it is deliberately
        * absent: the club invites, not the individual member who pressed the
        * button, and naming them would make declining an answer to a classmate
        * rather than to a club.
        *
        * ── Why Accept appears twice on this page ──
        *
        * The plate also offers "Join <club>", because an invitation makes the
        * affordance `join` and the plate renders the affordance. Considered and
        * kept: giving the banner sole ownership would mean adding an `invited`
        * affordance to the server's vocabulary for a cosmetic reason, and
        * removing the plate's control would leave an invited reader's plate with
        * no primary action at all.
        *
        * The redundancy is harmless in a way worth being explicit about — both
        * controls do the same reversible thing, both are labelled
        * unambiguously, and neither can do anything the other cannot. What the
        * banner adds is the Decline, which has no other home, and the reason
        * the club is suddenly joinable.
        */}
      {invitation && !viewer.isMember && (
        <section className="org-invitation" aria-labelledby="org-invitation-heading">
          <div className="org-invitation-body stack-sm">
            <h2 id="org-invitation-heading" className="org-invitation-title">
              <MailOpen size={17} aria-hidden="true" /> You have been invited to join {org.name}
            </h2>
            {invitation.message && (
              <blockquote className="org-invitation-note">{invitation.message}</blockquote>
            )}
            <p className="muted small">
              {/* Always a date: `inviteUser` sets a fortnight's TTL on every
                  invitation, so the "no expiry" branch that used to be here was
                  unreachable — and a false promise one nullable column away
                  from being shown. */}
              This invitation is open until {formatDay(invitation.expiresAt)}.
            </p>
            {/**
              * What declining costs, BEFORE the press.
              *
              * A decline is final for the club: `inviteUser` refuses for ever
              * afterwards, so this organization can never invite this person
              * again. That was only said in the toast — after the fact — beside
              * a ghost button a thirteen-year-old can mis-tap next to Accept.
              *
              * A sentence rather than a confirmation dialog: the act is not
              * destructive to anything the reader has, and the door is still
              * open to them by link or by request. What they need is to know
              * that the asking stops.
              */}
            <p className="muted small">
              If you decline, {org.name} cannot invite you again — you would need one of its
              invitation links to join later.
            </p>
          </div>
          <div className="row row-wrap org-invitation-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={join}>
              <Check size={16} aria-hidden="true" /> Accept
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={declineInvitation}>
              Decline
            </button>
          </div>
        </section>
      )}

      <OrganizationMasthead
        organization={org}
        charterLead={org.createdAt ? `Since ${new Date(org.createdAt).getFullYear()}` : null}
        action={
          <div className="row row-wrap org-plate-controls">
            <JoinAction
              affordance={affordance}
              organization={org}
              request={viewer.joinRequest}
              ban={viewer.ban}
              busy={busy}
              onJoin={join}
              onRequest={() => setRequesting(true)}
            />

            {/* Share sits beside the primary action rather than in the menu:
                handing the club's address to somebody is the second most common
                thing anybody does here, and `viewer.canInvite` is the server's
                answer about whether this reader may. */}
            {viewer.canInvite && (
              <button type="button" className="btn btn-secondary" onClick={() => setSharing(true)}>
                <Share2 size={16} aria-hidden="true" /> Share
              </button>
            )}

            {/* Visible rather than in the menu: a manager arriving to change who
                can join should not have to open something to find where. It is
                also the one control on this row that a member never sees, which
                is what makes the separation legible. */}
            {viewer.canManage && (
              <Link className="btn btn-secondary" to={organizationSubPath(org, 'edit')}>
                <Settings2 size={16} aria-hidden="true" /> Settings
              </Link>
            )}

            {plateMenu.length > 0 && (
              <ActionsMenu label={`More actions for ${org.name}`} items={plateMenu} disabled={busy} />
            )}
          </div>
        }
        note={joinPolicySentence(affordance, {
          policy: viewer.joinPolicy ?? org.joinPolicy,
          organizationName: org.name,
        })}
      >
        {/**
          * Why the button says what it says.
          *
          * The reason is the student's to see — it is what any appeal is heard
          * against, and the schema makes it NOT NULL for that reason. Shown as
          * a plain notice rather than an error: nothing has just gone wrong, this
          * is a standing state of the page.
          */}
        {viewer.ban && (
          <div className="org-ban-notice" role="note">
            <p className="org-ban-title">
              <Ban size={15} aria-hidden="true" /> You are banned from {org.name}
            </p>
            <p className="muted">Reason: {viewer.ban.reason}</p>
            {viewer.ban.appeal?.pending
              ? <p className="muted small">Your appeal was sent on {formatDay(viewer.ban.appeal.submittedAt)}. A manager will look at it.</p>
              : <p className="muted small">You cannot rejoin while this is in place. If you think it is wrong, you can appeal.</p>}
          </div>
        )}
      </OrganizationMasthead>

      {/**
        * Two columns on a wide screen, one on a narrow one.
        *
        * The left column is what the club is DOING — opportunities, then its
        * noticeboard, then who is in it. The right rail is what the reader's own
        * relationship with it is: their hours, and the founding detail. That
        * split is why the page reads differently for a member and a stranger
        * without being a different page: for a stranger the rail is one card and
        * the left column is the whole story.
        */}
      <div className="org-columns">
        <div className="org-column-main stack-lg">
          <section className="card" aria-labelledby="org-opportunities-heading">
            <div className="card-head"><h2 id="org-opportunities-heading">Opportunities</h2></div>
            <div className="card-body">
              {upcoming.length === 0 && past.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  title="No events yet"
                  message={
                    viewer.canPost
                      ? 'Post an opportunity and it will appear here for everybody who can see this organization.'
                      : 'When this organization posts an opportunity, it will appear here.'
                  }
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
              posts, and the server is the one that decides which is which. */}
          <OrganizationAnnouncements
            orgKey={key}
            canManage={viewer?.canPost === true}
            isMember={viewer?.isMember === true}
            repliesEnabled={org.allowReplies !== false}
            addToast={addToast}
          />

          <MemberRoster
            org={org}
            members={members}
            viewer={viewer}
            busy={busy}
            isSelf={isSelf}
            memberActions={memberActions}
          />
        </div>

        <aside className="org-column-rail stack-lg">
          <OrganizationService org={org} viewer={viewer} totals={totals} />
          <AboutOrganization org={org} policy={viewer.joinPolicy ?? org.joinPolicy} />
        </aside>
      </div>

      {/**
        * The management area, set apart rather than mixed in.
        *
        * Its own heading and its own surface, below everything a member reads, so
        * a manager can tell at a glance which controls act on other people. The
        * request inbox comes first — it is the only one that somebody is waiting
        * on — then the bans, then the appeals against them, which is the rarest
        * thing a manager does.
        */}
      {viewer?.canManage && (
        <section className="org-manage" aria-labelledby="org-manage-heading">
          <div className="org-manage-head">
            <h2 id="org-manage-heading">Manage {org.name}</h2>
            <p className="muted small">
              Only managers of this organization see this section.
            </p>
          </div>

          <div className="stack-lg">
            {/* Invitations first: sending one is something a manager came here
                to do, and the queue below is something they answer. */}
            <InvitationManager
              orgKey={key}
              organizationName={org.name}
              addToast={addToast}
              onChanged={load}
            />
            <JoinRequestInbox
              orgKey={key}
              organizationName={org.name}
              policy={viewer.joinPolicy ?? org.joinPolicy}
              addToast={addToast}
              onDecided={load}
            />
            <BannedMembers orgKey={key} organizationName={org.name} addToast={addToast} />
            <AppealInbox orgKey={key} addToast={addToast} />
          </div>
        </section>
      )}

      {sharing && (
        <ShareOrganizationDialog
          orgKey={key}
          organization={org}
          policy={viewer.joinPolicy ?? org.joinPolicy}
          addToast={addToast}
          onClose={() => setSharing(false)}
          onChanged={load}
        />
      )}

      {requesting && (
        <RequestToJoinDialog
          organization={org}
          busy={busy}
          onSubmit={message => requestToJoin(message)}
          onClose={() => setRequesting(false)}
        />
      )}

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
          onConfirm={leave}
          onCancel={() => setLeaving(false)}
        >
          {/* Real paragraphs: `.confirm-text` is a flex column, so a bare text
              node becomes a row of its own and a sentence split across two of
              them reads as two unrelated lines. */}
          <p>
            You will stop being told about this organization&rsquo;s new opportunities. Nothing
            you have already signed up for changes, and your hours are untouched.
          </p>
          <p>
            {(viewer.joinPolicy ?? org.joinPolicy) === 'invite'
              ? 'This organization admits members by invitation, so you would need its link to come back.'
              : (viewer.joinPolicy ?? org.joinPolicy) === 'request'
                ? 'This organization approves its members, so you would need to ask again to come back.'
                : 'You can rejoin at any time.'}
          </p>
        </ConfirmDialog>
      )}

      {withdrawing && (
        <ConfirmDialog
          title="Take back your request?"
          confirmLabel="Take it back"
          busy={busy}
          onConfirm={withdrawRequest}
          onCancel={() => setWithdrawing(false)}
        >
          <p>
            A manager of {org.name} will no longer see your request. You can ask again
            whenever you like.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * What this club is, beyond its name.
 *
 * A short card in the rail rather than a section in the main column, because it
 * is reference rather than activity: somebody reads it once when deciding
 * whether this is the right club, and never again.
 *
 * The founder's name is a deliberate disclosure — a club records who started it,
 * and it survives that account being deleted through the snapshot — and it is
 * NOT in the public projection an invitation link opens. Naming a person to an
 * unauthenticated reader is a different thing from naming them to a member.
 */
function AboutOrganization({ org, policy }) {
  return (
    <section className="card" aria-labelledby="org-about-heading">
      <div className="card-head"><h2 id="org-about-heading">About</h2></div>
      <div className="card-body stack-sm">
        <p className="muted small org-about-line">
          <Users size={13} aria-hidden="true" />{' '}
          Started by {org.createdBy.id
            ? <Link to={`/users/id/${org.createdBy.id}`}>{org.createdBy.name}</Link>
            : org.createdBy.name}
          {org.createdAt && <> in {new Date(org.createdAt).getFullYear()}</>}
        </p>

        {/**
          * How this club admits people, as a fact ABOUT the club.
          *
          * The plate's sentence says what the reader may do — for a member it
          * says they will hear about new opportunities, which conveys nothing
          * about the door. This is the other half, and a member is exactly the
          * person who needs it: it is what tells them whether a friend can
          * simply join or needs the link.
          *
          * The `allowReplies` line that used to sit here has gone: the
          * announcements card two feet away already says the same thing, where
          * it is about to matter.
          */}
        <p className="muted small org-about-line">
          <DoorOpen size={13} aria-hidden="true" />{' '}
          {JOIN_POLICY_COPY[policy]?.consequence ?? JOIN_POLICY_COPY.invite.consequence}
        </p>

        {org.status === 'archived' && (
          <p className="tag">Archived</p>
        )}
      </div>
    </section>
  );
}

/**
 * Who is in the club.
 *
 * ── Why a non-member sees a count and not a list ──
 *
 * The server sends `members: []` to anybody who is not in the organization, so
 * this cannot render a name it was not given. The card stays, saying how many
 * there are, because a page that simply omitted the section would leave a reader
 * unable to tell a club of forty from a club of nobody — which is precisely what
 * they are trying to work out before pressing Join.
 */
function MemberRoster({ org, members, viewer, busy, isSelf, memberActions }) {
  const hidden = members.length === 0 && org.memberCount > 0;

  return (
    <section className="card" aria-labelledby="org-members-heading">
      <div className="card-head">
        <h2 id="org-members-heading">Members</h2>
        <span className="muted small tnum">{org.memberCount}</span>
      </div>
      <div className="card-body">
        {hidden ? (
          /* The COUNT is in the card head, where it is for every reader. Saying
             it again as the title of the empty state was the same number twice
             in one card, so the title says the rule and the head says the fact. */
          <EmptyState
            icon={Users}
            title="The roster is private"
            message="Who is in this organization is shown to its members. Join to see it."
          />
        ) : members.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No members yet"
            message="Whoever joins first will appear here."
          />
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
                  * A row of unlabelled glyphs makes the reader guess which of
                  * several similar-looking actions each one is. A menu names
                  * every action in words, and the promote item carries the
                  * CURRENT role in its label — so "Make Sam a student organizer"
                  * and "Remove Sam as a student organizer" are different
                  * sentences rather than the same button in a different state.
                  *
                  * Removal and banning are separate items for the same reason:
                  * they used to be one dialog with a mode chosen inside it, which
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
        <h2 id="org-service-heading">Your service here</h2>
      </div>
      <div className="card-body">
        {history.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No hours yet"
            message={`Hours you volunteer at ${org.name}'s events are counted here once an organizer confirms you were there.`}
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

            <div className="row row-wrap org-service-actions">
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

              {/**
                * The organization transcript, and the certificates earned here.
                *
                * Both are LINKS into systems that already exist, carrying an
                * organization filter — not new pages. `/portfolio` is the
                * printable record of verified service and `/certificates` is the
                * certificate list; each already knows how to render itself, and a
                * second copy scoped to one club would be two things to keep in
                * step about the same student's hours.
                */}
              <Link className="btn btn-ghost btn-sm" to={`/portfolio?organization=${encodeURIComponent(org.slug)}`}>
                <FileText size={15} aria-hidden="true" />
                Transcript
              </Link>
              <Link className="btn btn-ghost btn-sm" to={`/certificates?organization=${encodeURIComponent(org.slug)}`}>
                <Award size={15} aria-hidden="true" />
                Certificates
              </Link>
            </div>
          </>
        )}

        {/**
          * Managers get the collective figure. Members do not: with a small
          * roster a total plus your own number is somebody else's number.
          *
          * And not when it is all zeros. "Altogether, 0 people have volunteered
          * 0 hrs across 0 events" is a sentence that says nothing, and putting it
          * on a brand-new club's page makes the club look like it failed at
          * something rather than like it has not started yet. The empty state
          * above already says there are no hours.
          */}
        {totals && totals.events > 0 && (
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
