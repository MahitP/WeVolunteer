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
import React from 'react';
import { Link } from 'react-router-dom';
import {
  Flag, Scale, UserCheck, UserCog, Activity, Bug, TrendingUp, Sprout,
} from 'lucide-react';
import { can } from '../authz';

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

export default function ModerationCenter({ currentUser }) {
  const areas = AREAS.filter(a => can(currentUser, a.cap));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Moderation Center</h1>
        <p className="lead">
          The administrative areas this account can open. Each one re-checks your access when you get there.
        </p>
      </header>

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
