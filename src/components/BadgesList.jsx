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
import { api } from '../utils/api';
import LoadingSkeleton from './common/LoadingSkeleton';

export default function BadgesList({ userId }) {
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

  if (loading) return <LoadingSkeleton heights={[120]} />;

  return (
    <section className="card card-pad stack-sm" aria-labelledby="badges-heading">
      <h3 id="badges-heading">Achievements</h3>

      {error && <p className="small dim" role="status">{error}</p>}

      {!error && badges.length === 0 && (
        <p className="small dim">
          No achievements yet. They are awarded automatically as confirmed hours add up.
        </p>
      )}

      {badges.length > 0 && (
        <ul className="badge-list">
          {badges.map(b => (
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
    </section>
  );
}
