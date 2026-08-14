import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { orderBadges } from '../utils/badgeOrder';

/**
 * Every badge somebody has earned, uncapped.
 *
 * ── Why this page exists ──
 *
 * `BadgesList` shows twelve and then said "and 4 more badges." as plain text.
 * Its own comment admitted the reason: "There is no fuller page to send somebody
 * to yet." So a volunteer who had earned more than twelve was told a number and
 * given no way to see what it counted — the profile knew about achievements it
 * would not show them.
 *
 * This is that page. The cap on the profile is now a real destination rather
 * than a dead end, and nothing about the profile's summary had to change.
 *
 * ── Why one component serves two routes ──
 *
 * `/profile/badges` and `/users/:handle/badges` differ only in whose badges are
 * being read. Splitting them would mean two components that must agree about
 * ordering, empty states and the badge card — and the moment they disagree, a
 * student sees their own achievements presented differently from how anybody
 * else sees them.
 */
export default function BadgesPage({ currentUser }) {
  const { handle } = useParams();
  const username = String(handle || '').replace(/^@/, '');
  const isSelf = !username;

  const [subject, setSubject] = useState(null);
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        /* Resolved through the public profile, which is also what decides
           whether this reader may see the person at all. Reading badges from an
           id taken straight off the URL would skip that. */
        const person = isSelf
          ? { id: currentUser?.id, name: currentUser?.name, username: currentUser?.username }
          : (await api.fetchPublicProfile(username));

        const subjectId = person?.id ?? person?.profile?.id;
        if (!subjectId) throw new Error('not found');

        const res = await api.apiFetch(`/api/users/${subjectId}/badges`);
        if (cancelled) return;
        setSubject(person.profile ?? person);
        setBadges(res.badges || []);
      } catch {
        if (!cancelled) setError('These achievements could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (isSelf ? currentUser?.id : username) load();
    else { setLoading(false); setError('These achievements could not be loaded.'); }

    return () => { cancelled = true; };
  }, [username, isSelf, currentUser?.id, currentUser?.name, currentUser?.username]);

  const ordered = orderBadges(badges);
  const backHref = isSelf ? '/profile' : `/users/@${username}`;
  const whose = isSelf ? 'Your badges' : `${subject?.name || 'Their'} badges`;

  return (
    /* A `div`, not a `main`: this is a signed-in APP route and the shell
       already supplies the page's single `main` landmark. A second one is two
       main regions on one page, which is exactly the defect
       src/routes/publicLandmark.test.jsx exists to catch in the other
       direction. `LoggedHours` next door is the pattern. */
    <div className="page stack-lg">
      <div className="stack-xs">
        <Link to={backHref} className="btn btn-ghost btn-sm row" style={{ gap: 6, alignSelf: 'flex-start' }}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to profile
        </Link>
        <h1>{whose}</h1>
        {!loading && !error && ordered.length > 0 && (
          <p className="dim small">
            {ordered.length} {ordered.length === 1 ? 'badge' : 'badges'}, newest kind first.
          </p>
        )}
      </div>

      {loading && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}

      {!loading && error && <p className="small dim" role="status">{error}</p>}

      {!loading && !error && ordered.length === 0 && (
        <EmptyState
          title="No badges yet"
          message={isSelf
            ? 'They arrive as an organizer confirms the hours you have served.'
            : 'This volunteer has not earned a badge yet.'}
        />
      )}

      {!loading && !error && ordered.length > 0 && (
        <section className="card card-pad">
          <ul className="badge-list">
            {ordered.map(b => (
              <li key={b.id} className="badge-award">
                {/* Hidden for the same reason as on the profile: a screen reader
                    announces an emoji by its Unicode name, so the decoration
                    would be read out immediately before the content it decorates. */}
                <span className="badge-award-icon" aria-hidden="true">{b.icon}</span>
                <span className="badge-award-name">{b.name}</span>
                {b.description && <span className="badge-award-desc">{b.description}</span>}
                <time className="badge-award-date" dateTime={b.earned_at}>
                  {new Date(b.earned_at).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
