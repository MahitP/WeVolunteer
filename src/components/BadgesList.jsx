/**
 * The badges somebody has been awarded, on their profile.
 *
 * ── Why the emoji is `aria-hidden` and the name is not ──
 *
 * Every badge's icon is an emoji rendered at 3rem, and a screen reader
 * announces an emoji by its Unicode name. So "🏆 Community Champion" was read
 * as "trophy, Community Champion" — the decoration announced as content,
 * immediately before the content it decorates. The icon carries no information
 * the name does not, so it is hidden and the name is left to speak.
 *
 * ── Why the description is rendered at all ──
 *
 * The route already selects it (`SELECT b.*`) and this component threw it away,
 * so every badge appeared as a name and a date with no statement of what it was
 * for. "Community Champion" does not tell a student — or the college admissions
 * reader looking at their profile — that it means fifty confirmed hours.
 *
 * ── Why there are no bespoke class names ──
 *
 * It shipped using five class names that had no CSS rule anywhere, which were
 * then added to `noDanglingClasses.test.js`'s allowlist rather than styled — so
 * the component rendered unstyled and the guard that exists to catch exactly
 * that was told to ignore it. It now uses the design system's own classes.
 */
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import LoadingSkeleton from './common/LoadingSkeleton';
import { orderBadges } from '../utils/badgeOrder';

/**
 * How many badges a profile shows before it stops.
 *
 * Twelve is two full rows at every width the badge grid uses, so the cap never
 * leaves a ragged half-row — and it is comfortably more than anybody has until
 * they have earned several tiers of both progressions.
 */
const VISIBLE_BADGES = 12;

export default function BadgesList({ userId, moreHref }) {
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchBadges = async () => {
      try {
        const res = await api.apiFetch(`/api/users/${userId}/badges`);
        if (!cancelled) setBadges(res.badges || []);
      } catch {
        if (!cancelled) setError('These achievements could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (userId) fetchBadges();
    /* Guards against setting state after the profile overlay is closed — this
       component mounts inside one, which a reader dismisses in less time than
       the request takes. */
    return () => { cancelled = true; };
  }, [userId]);

  /**
   * Ordered, and capped.
   *
   * A volunteer with 250 hours and a year's run has earned fourteen tiers. All
   * of them inline is the wall of medals this product is not supposed to
   * become, so the profile shows the most informative twelve and says how many
   * there are.
   */
  const ordered = orderBadges(badges);
  const visible = ordered.slice(0, VISIBLE_BADGES);
  const hidden = ordered.length - visible.length;

  if (loading) return <LoadingSkeleton heights={[120]} />;

  return (
    <section className="card card-pad stack-sm" aria-labelledby="badges-heading">
      {/* `h2`, matching every sibling section on the profile — "Coming up",
          "Service record", "Milestones", "Certificates". As an `h3` under the
          page's `h1` it both skipped a level and sat a level below its own
          peers. One caller, so there is no other context to keep in step. */}
      <h2 id="badges-heading">Badges</h2>

      {error && <p className="small dim" role="status">{error}</p>}

      {!error && badges.length === 0 && (
        <p className="small dim">
          No badges yet. They arrive as an organizer confirms the hours you have served.
        </p>
      )}

      {badges.length > 0 && (
        <ul className="badge-list">
          {/* Ordered here rather than by the server, because the arrangement is
              a presentation decision and the organizer's view of the same
              badges wants a different one. See utils/badgeOrder.js. */}
          {visible.map(b => (
            <li key={b.id} className="badge-award">
              <span className="badge-award-icon" aria-hidden="true">{b.icon}</span>
              <span className="badge-award-name">{b.name}</span>
              {b.description && <span className="badge-award-desc">{b.description}</span>}
              {/* The date is the record's value — an achievement with no date is
                  a claim rather than a record. `<time>` so it is machine
                  readable, with the ISO value intact for anything that parses. */}
              <time className="badge-award-date" dateTime={b.earned_at}>
                {new Date(b.earned_at).toLocaleDateString()}
              </time>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        /**
         * A real destination now, not a count.
         *
         * This used to be plain text — "and 4 more badges." — because there was
         * no fuller page to send anybody to. That told a volunteer about
         * achievements the product then refused to show them. An inline expander
         * would have recreated the wall of medals the cap exists to prevent, so
         * the overflow leaves the profile instead of growing it.
         */
        moreHref ? (
          <Link to={moreHref} className="btn btn-secondary btn-sm preview-more">
            See all {ordered.length} badges
          </Link>
        ) : (
          <p className="small dim">
            and {hidden} more {hidden === 1 ? 'badge' : 'badges'}.
          </p>
        )
      )}
    </section>
  );
}
