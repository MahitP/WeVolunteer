import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Award, FileText } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import CertificateModal from '../components/CertificateModal';
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
export default function CertificatesPage({ currentUser, addToast }) {
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [certificate, setCertificate] = useState(null);

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
        {!loading && !error && certificates.length > 0 && (
          <p className="dim small">
            {certificates.length} {certificates.length === 1 ? 'certificate' : 'certificates'}.
            One for each event you have completed.
          </p>
        )}
      </div>

      {loading && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}

      {!loading && error && <p className="small dim" role="status">{error}</p>}

      {!loading && !error && certificates.length === 0 && (
        <EmptyState
          icon={FileText}
          title="No certificates yet"
          message="You earn one for each event you complete."
        />
      )}

      {!loading && !error && certificates.length > 0 && (
        <div className="list">
          {certificates.map(c => (
            <button
              key={c.eventId}
              className="list-row"
              style={{ width: '100%', textAlign: 'left' }}
              onClick={() => setCertificate(c)}
            >
              <span className="notif-icon tone-brand"><Award size={15} aria-hidden="true" /></span>
              <span className="truncate" style={{ flex: 1 }}>
                <span className="person-name truncate">{c.title}</span>
                <span className="person-meta truncate tnum">
                  {formatDay(c.endDatetime)} · {formatHours(c.hours)}
                </span>
              </span>
              <span className="small dim nowrap">View</span>
            </button>
          ))}
        </div>
      )}

      {certificate && (
        <CertificateModal
          certificate={certificate}
          volunteer={currentUser}
          onClose={() => setCertificate(null)}
          addToast={addToast}
        />
      )}
    </div>
  );
}
