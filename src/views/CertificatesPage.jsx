import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Award, FileText } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { formatDay, formatHours } from '../utils/helpers';

/**
 * Every certificate you have earned.
 *
 * ── Why the profile needed somewhere to point ──
 *
 * The certificates section on the profile rendered the whole list, uncapped —
 * the same defect the service record had already been fixed for. A volunteer
 * with forty completed events got forty rows in a sidebar column, so the two
 * columns of the profile ended at wildly different heights and everything below
 * the shorter one was empty space.
 *
 * The profile now shows five, exactly as the service record does, and links
 * here. Five in both columns is also what makes them line up, which is the
 * visible half of the fix.
 *
 * ── Why this is your own certificates only ──
 *
 * A certificate carries a full name, an organization, dates and a verification
 * code. Somebody else's is theirs to show, not yours to browse.
 */
export default function CertificatesPage() {
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();

  /**
   * An optional organization filter, as `?organization=<slug>`.
   *
   * Reached from the "Your service with …" block on an organization's page, so
   * a student looking at one club can see the certificates that came from it
   * without a certificate system scoped to organizations. Certificates stay
   * exactly what they were; this is a view of them.
   *
   * A display filter over the caller's OWN certificates — this endpoint has
   * never returned anybody else's — so narrowing it can only show less.
   */
  const organizationSlug = searchParams.get('organization');
  const shown = organizationSlug
    ? certificates.filter(c => c.organizationSlug === organizationSlug)
    : certificates;
  /* From the rows, so a slug matching nothing yields no name and the empty
     state below can say so rather than naming a club that is not there. */
  const organizationName = organizationSlug
    ? certificates.find(c => c.organizationSlug === organizationSlug)?.organizationName ?? null
    : null;

  useEffect(() => {
    let cancelled = false;
    api.fetchCertificates()
      .then(res => { if (!cancelled) setCertificates(res || []); })
      .catch(() => { if (!cancelled) setError('Your certificates could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    /* A `div`, not a `main`: this is a signed-in APP route and the shell
       already supplies the page's single `main` landmark. A second one is two
       main regions on one page, which is exactly the defect
       src/routes/publicLandmark.test.jsx exists to catch in the other
       direction. `LoggedHours` next door is the pattern. */
    <div className="page stack-lg">
      <div className="stack-xs">
        <Link to="/profile" className="btn btn-ghost btn-sm row" style={{ gap: 6, alignSelf: 'flex-start' }}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to profile
        </Link>
        <h2 className="row page-title" style={{ gap: 8 }}>
          <Award size={20} style={{ color: 'var(--brand)' }} aria-hidden="true" /> Your certificates
        </h2>
        {organizationSlug && (
          <p className="dim small">
            {organizationName
              ? `Earned with ${organizationName}.`
              : 'Filtered to one organization.'}{' '}
            <Link to="/certificates">Show all certificates</Link>
          </p>
        )}
        {!loading && !error && shown.length > 0 && (
          <p className="dim small">
            {shown.length} {shown.length === 1 ? 'certificate' : 'certificates'}.
            One for each event you have completed.
          </p>
        )}
      </div>

      {loading && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}

      {!loading && error && <p className="small dim" role="status">{error}</p>}

      {!loading && !error && shown.length === 0 && (
        <EmptyState
          icon={FileText}
          title={organizationSlug ? 'No certificates from this organization' : 'No certificates yet'}
          message={organizationSlug
            ? 'You earn one for each event you complete with them.'
            : 'You earn one for each event you complete.'}
          action={organizationSlug
            ? <Link className="btn btn-secondary" to="/certificates">Show all certificates</Link>
            : undefined}
        />
      )}

      {!loading && !error && shown.length > 0 && (
        <div className="list">
          {shown.map(c => (
            /**
              * A LINK, not a button that opened a dialog.
              *
              * The certificate now has an address of its own, which is what
              * makes it shareable, bookmarkable and reachable with the back
              * button — see the header of `CertificateView.jsx`. A row that
              * navigates has to be an anchor: middle-click, ⌘-click and "open
              * in new tab" all work on one and none of them work on a button
              * with an onClick, and a keyboard user is told "link" rather than
              * "button", which is what actually happens next.
              */
            <Link
              key={c.eventId}
              to={`/certificates/${encodeURIComponent(c.code)}`}
              className="list-row"
              style={{ width: '100%', textAlign: 'left' }}
            >
              <span className="notif-icon tone-brand"><Award size={15} aria-hidden="true" /></span>
              <span className="truncate" style={{ flex: 1 }}>
                <span className="person-name truncate">{c.title}</span>
                <span className="person-meta truncate tnum">
                  {formatDay(c.endDatetime)} · {formatHours(c.hours)}
                </span>
              </span>
              <span className="small dim nowrap">View</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
