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
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      setMissing(false);
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
      } catch (err) {
        /**
         * A username nobody has is not a failure to load.
         *
         * This used to catch everything into one string — "These achievements
         * could not be loaded" — so `/users/nobody/badges` read as though the
         * page had broken on the way to a real person's badges, and the reader's
         * sensible response was to try again. Both sibling pages,
         * `PublicCertificates` and `PublicServiceHistory`, already separated the
         * two and this one did not, so the same wrong address produced three
         * different answers depending on which tab you were on.
         *
         * Same test as theirs, deliberately: the status when the API gives one,
         * and the message when the throw came from the `subjectId` check above
         * rather than from a response.
         */
        if (cancelled) return;
        if (err?.status === 404 || /not found|no such/i.test(err?.message || '')) {
          setMissing(true);
        } else {
          setError('These achievements could not be loaded.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (isSelf ? currentUser?.id : username) load();
    /* No username in the URL and no signed-in account to fall back on: there is
       nobody to show, which is the missing case rather than a load failure. */
    else { setLoading(false); setMissing(true); }

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
        <h2 className="page-title">{whose}</h2>
        {!loading && !error && !missing && ordered.length > 0 && (
          <p className="dim small">
            {ordered.length} {ordered.length === 1 ? 'badge' : 'badges'}, newest kind first.
          </p>
        )}
      </div>

      {loading && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}

      {!loading && error && <p className="small dim" role="status">{error}</p>}

      {/* Before the empty state, not after it. "No badges yet" about somebody
          who does not exist is a confident answer to a question nobody asked,
          and it is what this page said for every unknown username. The wording
          matches PublicCertificates and PublicServiceHistory exactly, because a
          reader switching tabs on the same bad link should not have to work out
          whether three different sentences mean the same thing. */}
      {!loading && !error && missing && (
        <EmptyState notFound title="No such profile" message="We could not find that volunteer." />
      )}

      {!loading && !error && !missing && ordered.length === 0 && (
        <EmptyState
          title="No badges yet"
          message={isSelf
            ? 'They arrive as an organizer confirms the hours you have served.'
            : 'This volunteer has not earned a badge yet.'}
        />
      )}

      {!loading && !error && !missing && ordered.length > 0 && (
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
