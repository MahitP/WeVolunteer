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
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Flag, Scale, UserCheck, UserCog, Activity, Bug, TrendingUp, Sprout, Eye,
} from 'lucide-react';
import { can } from '../authz';
import { api } from '../utils/api';

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
    id: 'organizers',
    to: '/#organizer-requests',
    cap: 'organizer.approve',
    icon: UserCheck,
    title: 'Organizer requests',
    blurb: 'People asking to post events. Approving one lets them see the contact details of the students who apply.',
  },
  {
    id: 'roster',
    to: '/admin/roster',
    cap: 'admin.create',
    icon: UserCog,
    title: 'Administrators',
    blurb: 'Who holds administrative access, who has been invited, and how to grant or take it away.',
  },
  {
    id: 'audit',
    to: '/admin/audit-logs',
    cap: 'audit.read',
    icon: Activity,
    title: 'Audit trail',
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
    title: 'Community impact',
    blurb: 'What the programme has added up to — hours served, causes supported and who took part. '
      + 'Held by every administrator.',
  },
  /**
   * Platform Impact is a DIFFERENT page from the one above, and the two tiles
   * sit next to each other so the difference is legible rather than implied.
   *
   * Community impact is the programme's story, behind `analytics.impact`, which
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
    blurb: 'Programme-wide figures: hours, volunteers, events and how participation has moved over time.',
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
  { id: 'partner', label: 'Partner', blurb: 'Read-only participation view' },
];

export default function ModerationCenter({ currentUser, onPreviewStarted }) {
  const areas = AREAS.filter(a => can(currentUser, a.cap));
  const [persona, setPersona] = useState(PERSONAS[0].id);
  /* Named in the action so the button says what pressing it will do, rather than
     "Start preview" beside a selection the reader has to look back up at. */
  const selectedPersona = PERSONAS.find(p => p.id === persona) ?? PERSONAS[0];
  const [previewError, setPreviewError] = useState(null);
  const [starting, setStarting] = useState(false);

  const startPreview = async () => {
    setStarting(true);
    setPreviewError(null);
    try {
      await api.startPersonaPreview(persona);
      /* Refetch the session rather than patching state. The server has changed
         what this account may do, so every gated control on every page is now
         stale — including this one, which the owner is about to lose. */
      await onPreviewStarted?.();
    } catch (err) {
      setPreviewError(err?.data?.error || err?.message || 'Could not start the preview.');
      setStarting(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        {/* "Admin", matching the rail entry and PAGE_META — see the NAV table in
            src/App.jsx. Two names for one destination means two people cannot
            describe it to each other. */}
        <h2 className="page-title">Admin</h2>
        <p className="lead">
          The administrative areas this account can open. Each one re-checks your access when you get there.
        </p>
      </header>

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
    </div>
  );
}
