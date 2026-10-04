/**
 * The Moderation Center — a way in, not a screen full of work.
 *
 * ── What it replaced, and why the name moved ──
 *
 * "Moderation Center" used to be the label on `/` for administrators, i.e. on
 * AdminDashboard: the reports queue, organizer approvals, platform totals,
 * participation charts and the all-events table, all on one page. That page has
 * not changed and has not lost anything — it is now called Dashboard, which is
 * what every other persona already calls `/`, and what it actually is.
 *
 * The name came here because this is what people were reaching for when they
 * asked for it: not another dashboard, but the answer to "what am I allowed to
 * open". Every administrative surface in the product is listed below with a
 * sentence saying what it is for.
 *
 * ── Why it is not a dashboard ──
 *
 * It deliberately fetches nothing. A hub that loads counts has a spinner, an
 * error state, a stale-data problem and a reason to be slow — and it would be
 * the third place in the product that reports how many reports are open. The
 * rail already carries the urgent count on the Dashboard entry. This page's
 * whole job is to be instant and to be complete.
 *
 * ── Why the tiles are capability-filtered AND still re-checked ──
 *
 * `can()` here is presentation, exactly as it is in the navigation rail: it
 * decides what is worth offering. It is not a control. Every destination is an
 * APP_ROUTES entry with its own `requiredCap`, refused by `deniedRoute` before
 * the shell is built, and every endpoint behind it re-checks server-side. A
 * reader who types one of these URLs is refused by the route, not by the
 * absence of a tile here.
 *
 * An administrator sees three tiles; the platform owner sees seven. That
 * difference is the authority boundary, drawn honestly.
 */
import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Flag, Scale, UserCheck, UserCog, Activity, Bug, TrendingUp, Sprout, Eye, FileSignature, Award, Gauge, LifeBuoy, UserMinus
} from 'lucide-react';
import { can } from '../authz';
import { api } from '../utils/api';
import { adminIsPaused } from '../utils/adminPaused';
import AdminPolicyGate from '../components/legal/AdminPolicyGate';

/**
 * Every administrative destination, with the capability that opens it.
 *
 * `to` values point at routes that already exist. Nothing here is a placeholder
 * for a screen somebody intends to build — a tile that leads nowhere is worse
 * than an absent tile, because it reads as a permission problem.
 *
 * Reports and organizer requests are SECTIONS of the Dashboard rather than
 * routes of their own, so they carry a fragment. AdminDashboard scrolls to it
 * once its data has arrived; see the `hash` effect there. They are still listed
 * separately because "review a report" and "approve an organizer" are two
 * different jobs, and collapsing them into one "go to the Dashboard" tile would
 * make this page a link rather than an index.
 */
/* Exported so App.navGroups.test.jsx can assert that the six pages taken off the
   rail are still offered HERE. Absence from the navigation is only safe if
   something still leads to them, and a test that reads this table is the only
   way to check both halves of that in one place. */
export const AREAS = [
  {
    id: 'reports',
    to: '/#reports',
    cap: 'report.resolve',
    icon: Flag,
    title: 'Reports',
    blurb: 'Things people have reported, and the review history behind each one. '
      + 'Warning, suspending and messaging somebody is done from inside the report about them.',
  },
  {
    id: 'appeals',
    to: '/admin/appeals',
    cap: 'appeal.review',
    icon: Scale,
    title: 'Appeals',
    blurb: 'Suspended people asking to be heard, aged against the five-working-day reply this platform promises them.',
  },
  {
    id: 'issues',
    to: '/admin/issues',
    cap: 'report.resolve',
    icon: LifeBuoy,
    title: 'Reported problems',
    blurb: 'What people sent from Report an Issue, with their screenshots. Security and privacy reports are read here only.',
  },
  {
    id: 'organizers',
    to: '/#organizer-requests',
    cap: 'organizer.approve',
    icon: UserCheck,
    title: 'Organizer requests',
    blurb: 'People asking to post events. Approving one lets them see the contact details of the students who apply.',
  },
  {
    id: 'approvedOrganizers',
    to: '/admin/organizers',
    cap: 'organizer.approve',
    icon: UserMinus,
    title: 'Approved organizers',
    blurb: 'Who may post events, and taking that back. Their events and every volunteer\'s hours stay.',
  },
  {
    id: 'roster',
    to: '/admin/roster',
    cap: 'admin.create',
    icon: UserCog,
    title: 'Admin Roster',
    blurb: 'Who holds administrative access, who has been invited, and how to grant or take it away.',
  },
  {
    id: 'audit',
    to: '/admin/audit-logs',
    cap: 'audit.read',
    icon: Activity,
    title: 'Audit Explorer',
    blurb: 'Every administrative action, who took it, and when. Append-only.',
  },
  {
    id: 'errors',
    to: '/errors',
    cap: 'error.read',
    icon: Bug,
    title: 'Errors',
    blurb: 'Crashes and faults reported by browsers, the server and background jobs.',
  },
  {
    id: 'communityImpact',
    to: '/impact',
    cap: 'analytics.impact',
    icon: Sprout,
    title: 'Community Impact',
    blurb: 'What the program has added up to — hours served, causes supported and who took part. '
      + 'Held by every administrator.',
  },
  /**
   * Platform Impact is a DIFFERENT page from the one above, and the two tiles
   * sit next to each other so the difference is legible rather than implied.
   *
   * Community Impact is the programme's story, behind `analytics.impact`, which
   * every administrator holds. This one is behind `analytics.platform`, which is
   * SUPER_ONLY: it carries the month series and the figure definitions, and its
   * audience is the one account that can already read every user record. They
   * were once two rail entries differing by the case of one letter on the same
   * icon; here they can carry a sentence each.
   */
  {
    id: 'impact',
    to: '/admin/impact',
    cap: 'analytics.platform',
    icon: TrendingUp,
    title: 'Platform Impact',
    blurb: 'Program-wide figures: hours, volunteers, events and how participation has moved over time.',
  },
  /**
   * The Legal Center editor — the one administrative area that was missing.
   *
   * ── Why it was absent, and why absence was the wrong answer ──
   *
   * `/admin/legal` predates this hub. When the six administrative pages came
   * off the navigation rail they were all moved HERE, and
   * `App.navGroups.test.jsx` asserts that each of the six is still offered —
   * but it reads a list of the pages that MOVED, and this page never moved
   * because it was never on the rail. So the guard that exists to prove nothing
   * became unreachable could not see the one page nothing led to.
   *
   * The route's own comment says the `/admin/` prefix "puts it where the other
   * owner-only pages already are". That was true of the path and false of the
   * product: the only way in was Settings → Help → "Edit Legal Center", so an
   * owner asking "where do I administer this platform" found seven areas on
   * this page and the eighth filed under Help, beside About Us. This page's own
   * heading claims to list "the administrative areas this account can open",
   * and that claim was not true while this tile was missing.
   *
   * The Settings entry STAYS. It is not a duplicate to be consolidated away:
   * Settings is where somebody goes to change how the product behaves for
   * them, and the Legal Center is genuinely reachable from there as the
   * owner's version of "the documents that govern this". Two doors into one
   * room is normal; no door from the room that indexes every other room is
   * not.
   *
   * `legal.edit` is SUPER_ONLY, so this tile is invisible to every
   * administrator and cannot be reached by a capability grant —
   * `userCapabilities.js` refuses to store one naming it. Hiding the tile is
   * UX; `server/routes/legalAdminRoutes.js` is the boundary, and publishing
   * additionally re-proves identity through `legal.publish`.
   */
  /**
   * Badges — the surface four finished endpoints never had.
   *
   * Listed BEFORE the Legal Center because it is programme administration like
   * everything above it, and the Legal Center is the owner-only document
   * surface that closes the programme group.
   *
   * The Owner Center follows both, and is genuinely last: it is the only tile
   * that is not about a person at all.
   *
   * `event.moderate`, so an ordinary administrator sees it: defining what the
   * platform recognises and correcting a wrong award are the job, not a
   * privilege reserved for the owner.
   */
  {
    id: 'badges',
    to: '/admin/badges',
    cap: 'event.moderate',
    icon: Award,
    title: 'Badges',
    blurb: 'What the platform recognizes, who holds what, and how to award or take one back. '
      + 'Every change is recorded against your name.',
  },
  {
    id: 'legal',
    to: '/admin/legal',
    cap: 'legal.edit',
    icon: FileSignature,
    title: 'Legal Center',
    blurb: 'The documents everyone on this platform is held to. Editing is owner-only, and '
      + 'publishing a new version asks you to prove it is you.',
  },
  /**
   * The Owner Center, and the reason it is the last tile.
   *
   * Everything above is about the PROGRAMME — the people on it, what they did,
   * and the decisions administrators took about them. This one is about the
   * SERVICE: whether it is up, whether errors are climbing, whether Redis and
   * the vector index are answering, and how much of each free tier has been
   * spent. It is the only tile that is not about a person, which is why it sits
   * apart at the end rather than beside the two impact pages it superficially
   * resembles.
   *
   * `owner.console` is SUPER_ONLY, so this tile is invisible to every
   * administrator and ungrantable through `capability.grant`. Hiding it is UX;
   * `server/routes/ownerRoutes.js` is the boundary.
   */
  {
    id: 'owner',
    to: '/owner',
    cap: 'owner.console',
    icon: Gauge,
    title: 'Owner Center',
    blurb: 'Whether the platform is healthy: uptime, incidents, errors, analytics, '
      + 'and the infrastructure it runs on — with links out to each service.',
  },
];

/**
 * Roles the owner can preview as.
 *
 * Hard-coded here rather than derived from `ROLES`, because this is a list of
 * things a person picks from and it needs a readable label each — and because
 * `super_admin` must not appear: previewing as your own role is resolved to no
 * preview at all server-side, so offering it would be a button that does nothing.
 * The server validates the choice regardless; this list decides what is offered,
 * never what is allowed.
 */
const PERSONAS = [
  { id: 'student', label: 'Student', blurb: 'Browse, apply, log hours' },
  { id: 'organizer', label: 'Organizer', blurb: 'Post events, pick volunteers' },
  { id: 'admin', label: 'Administrator', blurb: 'Reports, appeals, approvals' },
  /**
   * ── Partner is NOT offered, because there is nothing to preview ──
   *
   * It was here, described as a "Read-only participation view". No such view
   * exists. `partner` is a LATENT role: `ROLE.PARTNER` is defined and
   * `server/authz.js` gives it four capabilities, but nothing in the product
   * assigns it — there is no signup path, no administrative action and no CLI
   * that can produce a partner account, so no account holds it and none can be
   * created.
   *
   * What an owner actually got by selecting it was `analytics.public`,
   * `event.view`, `geocode.use` and `persona.preview.exit`: a rail of Discover
   * and nothing else, no Dashboard entry (`partner` is deliberately absent from
   * `DASHBOARD_NAV`), and `/` reading "Partner accounts do not have a dashboard
   * yet". `authz.js` says the same thing about the capability itself —
   * `analytics.public` "stays registered and still reads nothing: it is the name
   * for figures chosen FOR an outside reader, and that surface has not been
   * designed."
   *
   * So the product was honest in its comments and in the page a partner lands
   * on, and dishonest in exactly one place: this list, which promised a view by
   * name. Removing the entry is the honest half of that; the capabilities and
   * the role stay untouched, ready for the surface when it is designed.
   *
   * The SERVER's `PREVIEWABLE` in `server/routes/personaRoutes.js` is
   * deliberately not narrowed to match. It is derived from `ROLES` so that a
   * role added to the kernel becomes previewable without a second list going
   * stale, and that property is worth more than symmetry with a menu.
   */
];

export default function ModerationCenter({ currentUser, addToast, onPreviewStarted }) {
  const areas = AREAS.filter(a => can(currentUser, a.cap));
  const [persona, setPersona] = useState(PERSONAS[0].id);
  /* Named in the action so the button says what pressing it will do, rather than
     "Start preview" beside a selection the reader has to look back up at. */
  const selectedPersona = PERSONAS.find(p => p.id === persona) ?? PERSONAS[0];
  const [previewError, setPreviewError] = useState(null);
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  const startPreview = async () => {
    setStarting(true);
    setPreviewError(null);
    try {
      await api.startPersonaPreview(persona);
      /* Refetch the session rather than patching state. The server has changed
         what this account may do, so every gated control on every page is now
         stale — including this one, which the owner is about to lose. */
      await onPreviewStarted?.();
      /**
       * Leave before the page re-renders without the right to be here.
       *
       * This is the Admin page, and the personas previewed from it — student,
       * organizer — cannot open it. Staying put re-rendered the admin route
       * under the previewed role and the next request answered 401, which is
       * the server being right: the whole point of the preview is that this
       * account no longer has admin rights. The reader saw an error for doing
       * exactly what the button offered.
       *
       * The dashboard is where a preview should begin anyway — it is the first
       * thing the previewed person sees when they sign in, which is the
       * question the preview exists to answer. `replace` so the back button
       * does not return to the admin page that is now forbidden.
       *
       * Ending the preview needs no equivalent: it restores rights rather than
       * dropping them, so wherever the reader is standing stays legible.
       */
      navigate('/', { replace: true });
    } catch (err) {
      setPreviewError(err?.data?.error || err?.message || 'Could not start the preview.');
      setStarting(false);
    }
  };

  /**
   * Whether administration is paused on this account — the gate, or the tiles.
   *
   * Read from `currentUser.withheld`, which `/api/auth/me` already carries, so it
   * is known at first render. An earlier version asked the server on mount and
   * rendered neither the gate nor the tiles until the answer came back — correct,
   * but it made the page's whole content depend on a round trip, and a page that
   * is briefly empty for everyone is a worse trade than the flash it avoided.
   *
   * Shared with the shell, which captions the topbar from the same answer; see
   * src/utils/adminPaused.js for which capability it reads and why, and for why
   * a client-side read is a layout decision and never an authorization one. The
   * gate below re-reads the real status from the server before offering anything.
   */
  const adminPaused = adminIsPaused(currentUser);

  return (
    <div className="page">
      <header className="page-head">
        {/* "Admin", matching the rail entry and PAGE_META — see the NAV table in
            src/App.jsx. Two names for one destination means two people cannot
            describe it to each other. */}
        <h2 className="page-title">Admin</h2>
        <p className="lead">
          {adminPaused
            ? 'Administration is paused on this account until the Admin Responsibilities Policy is accepted.'
            : 'The administrative areas this account can open. Each one re-checks your access when you get there.'}
        </p>
      </header>

      {/**
        * The gate replaces everything below it rather than sitting beside it.
        *
        * Every tile leads somewhere that would answer 403, and a page offering a
        * door it knows is locked teaches the reader the product is broken rather
        * than that they have something to do.
        */}
      {adminPaused && (
        <AdminPolicyGate
          currentUser={currentUser}
          addToast={addToast}
          /* Refetching the session is the whole of it: `withheld` comes back
             empty, `adminPaused` recomputes false on the next render, and the
             tiles replace the gate. No local flag to fall out of step with
             the server — the same reason `startPreview` refetches rather
             than patching state. */
          onAccepted={onPreviewStarted}
        />
      )}

      {!adminPaused && (
        <>

      {/*
        * ── Previewing as somebody else ──
        *
        * Offered only to an account that holds `persona.preview`, which is
        * SUPER_ONLY and ungrantable. Hiding it is UX: the endpoint re-checks the
        * capability, and the kernel makes a preview incapable of granting
        * anything in any case — it intersects the previewed role with the real
        * one, so the worst a forged request achieves is less access for whoever
        * sent it.
        *
        * ── Why this is a card of radios rather than a select ──
        *
        * It was `<label>See WeVolunteer as</label><select>…</select><button>`,
        * three controls loose in a flex row above the tiles. Two things were
        * wrong with it beyond the plainness.
        *
        * It read as a filter. A bare select sitting above a list of tiles is,
        * everywhere else in this product and most others, a control that narrows
        * the list — and this one drops the owner's own capabilities for fifteen
        * minutes. The consequence has to be legible BEFORE the click, which is
        * what the sentence under the heading is for: "Your own access is reduced"
        * is the whole reason the control needs explaining, and a `<label>` reading
        * "See WeVolunteer as" said none of it.
        *
        * And a collapsed select hides the options. There are four, they are short,
        * and which one somebody wants depends on what each role can do — so
        * showing all four with a line about each costs one card and removes a
        * click plus a guess. Native `<input type="radio">` in a `radiogroup`, so
        * arrow keys move between them and a screen reader announces "2 of 4"
        * without any ARIA of our own.
        */}
      {can(currentUser, 'persona.preview') && (
        <section className="persona-preview card card-pad" aria-labelledby="persona-preview-heading">
          <div className="persona-preview-head">
            <span className="persona-preview-icon" aria-hidden="true"><Eye size={18} /></span>
            <div>
              <h2 id="persona-preview-heading" className="persona-preview-title">
                Preview as another role
              </h2>
              <p className="persona-preview-lead">
                See exactly what someone else sees. Your role does not change — your
                own access is <strong>reduced</strong> for fifteen minutes, or until
                you stop.
              </p>
            </div>
          </div>

          <div className="persona-options" role="radiogroup" aria-labelledby="persona-preview-heading">
            {PERSONAS.map(p => (
              <label
                key={p.id}
                className={`persona-option${persona === p.id ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="persona-preview"
                  value={p.id}
                  checked={persona === p.id}
                  onChange={() => setPersona(p.id)}
                  disabled={starting}
                />
                <span className="persona-option-text">
                  <span className="persona-option-label">{p.label}</span>
                  <span className="persona-option-blurb">{p.blurb}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="persona-preview-foot">
            <button type="button" className="btn btn-secondary" onClick={startPreview} disabled={starting}>
              <Eye size={16} aria-hidden="true" />
              {starting ? 'Starting…' : `Preview as ${selectedPersona.label.toLowerCase()}`}
            </button>
            {previewError && (
              <span className="persona-banner-error" role="alert">{previewError}</span>
            )}
          </div>
        </section>
      )}

      {/* A list, because it is one — `list-style: none` in CSS, so the semantics
          are there for a screen reader without the bullets being there for
          anybody else. The count is announced by the list itself. */}
      <ul className="mod-areas" aria-label="Administrative areas">
        {areas.map(({ id, to, icon: Icon, title, blurb }) => (
          <li key={id}>
            {/* The whole tile is one link. Two links to the same place (an icon
                and a title) would be two tab stops and two identical
                announcements. */}
            <Link className="mod-area" to={to}>
              <span className="mod-area-icon" aria-hidden="true"><Icon size={20} /></span>
              <span className="mod-area-text">
                <span className="mod-area-title">{title}</span>
                <span className="mod-area-blurb">{blurb}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
        </>
      )}
    </div>
  );
}
