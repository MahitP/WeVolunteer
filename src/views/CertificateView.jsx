import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileText, Printer, Share2, ShieldCheck, Info } from 'lucide-react';
import { ApiError, api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import ActionsMenu from '../components/common/ActionsMenu';
import CertificateDocument from '../components/CertificateDocument';
import CertificateShareDialog from '../components/CertificateShareDialog';
import { formatDay, formatHours } from '../utils/helpers';
import { trackAmplitudeEvent } from '../utils/analytics';
import { EVENT } from '../../server/analyticsEvents.js';

/**
 * One certificate, at its own address.
 *
 * ── Why this replaced the dialog ──
 *
 * A certificate used to open in a modal over whichever page you happened to be
 * on, and three things followed from that which no amount of polish inside the
 * dialog could fix.
 *
 * It had no URL. Sharing a certificate is the single most common thing anybody
 * wants to do with one, and there was nothing to share, nothing to bookmark,
 * and no way back to it — the browser's Back button closed the whole page
 * behind the dialog rather than the dialog.
 *
 * It had no room. A certificate is a landscape document with two signature
 * blocks and a verification block, inside a dialog inside a page, on a phone.
 *
 * And it stole the page. `useModal` locks body scrolling and traps focus, which
 * is right for a decision somebody has to make and wrong for a document they
 * want to read, zoom into and print.
 *
 * ── What is deliberately NOT here ──
 *
 * The browser's PDF viewer. Downloading fetches the file and saves it (see
 * `api.downloadCertificatePdf`) rather than navigating to the endpoint, so the
 * certificate a reader looks at is always this page — the browser's own PDF
 * chrome never becomes the viewing experience.
 */
export default function CertificateView({ currentUser, addToast }) {
  const { code } = useParams();
  const [certificate, setCertificate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.fetchCertificate(code)
      .then((data) => {
        if (cancelled) return;
        setCertificate(data);
        /* Fired here rather than on mount, so a 404 is not counted as a view.
           No properties: see `server/analyticsEvents.js` on why every event in
           the registry is a bare verb. */
        trackAmplitudeEvent(EVENT.VIEWED_CERTIFICATE);
      })
      .catch((err) => {
        if (cancelled) return;
        /* 404 means "not yours, or not real" — the server answers both
           identically on purpose, so this page must not guess between them. */
        setError(err instanceof ApiError && err.status === 404 ? 'not_found' : 'failed');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code]);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await api.downloadCertificatePdf(code);
      /* The object URL is revoked immediately after the click. Left alive it
         pins the whole PDF in memory for the life of the document, and a reader
         who downloads several certificates in one sitting keeps all of them. */
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `wevolunteer-certificate-${code}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      trackAmplitudeEvent(EVENT.DOWNLOADED_CERTIFICATE);
    } catch {
      addToast?.('That certificate could not be downloaded. Please try again.', 'error');
    } finally {
      setDownloading(false);
    }
  }, [code, downloading, addToast]);

  const print = useCallback(() => {
    /* The print stylesheet isolates `#printable-certificate` and hides the rest
       of the shell — see the `@media print` block in src/index.css, and the
       note there about a certificate printing the whole dashboard behind it. */
    trackAmplitudeEvent(EVENT.DOWNLOADED_CERTIFICATE);
    window.print();
  }, []);

  if (loading) {
    return (
      <div className="page stack-lg">
        <BackLink />
        <LoadingSkeleton heights={[64, 420]} className="stack-lg" />
      </div>
    );
  }

  if (error) {
    return (
      /**
       * `data-error-kind` on a page that is not an `ErrorExperience`.
       *
       * The a11y sweep reads this attribute to answer "did I measure the page
       * this route names, or an error panel standing in for it?" — a question
       * HTTP status cannot answer, because React Router serves the shell for any
       * path and a missing fixture still lands on 200.
       *
       * The harness resolves a real, current code now — `a11y/harness/fixtures.mjs`
       * asks `/api/certificates`, because codes are `crypto.randomBytes` (see
       * `generateCode`) and no literal survives a reseed. That fixed
       * `/verify/:code`, which is public. It does NOT make this route
       * measurable, and the reason is ownership rather than fixtures:
       * `getCertificateForOwner` reads by `user_id`, the seeded certificate
       * belongs to `user-student-2`, and the sweep signs in as `user-student-1`.
       * The 404 it sees here is the product correctly refusing it.
       *
       * So the marker makes the sweep report this route as unmeasured rather
       * than claim a page it never saw — `routes.mjs`'s `SWEEP_CANNOT_MEASURE`
       * records that as an expected gap, with a guard that fails if it ever
       * stops being true. The page itself is audited by
       * `a11y/workflows/certificate.spec.js`, which signs in as the holder.
       */
      <div className="page stack-lg" data-error-kind={error === 'not_found' ? '404' : 'unknown'}>
        <BackLink />
        <EmptyState
          icon={FileText}
          /* The only thing on the page, so it sits directly under the shell's
             `h1` — `headingLevel` exists for exactly this, and the default `3`
             would announce a level that is not there. See EmptyState. */
          headingLevel={2}
          title={error === 'not_found' ? 'No certificate matches that code' : 'That certificate could not be loaded'}
          message={error === 'not_found'
            ? 'Certificates can only be opened by the volunteer who earned them. Check the code, or open one from your list.'
            : 'Something went wrong on our side. Please try again in a moment.'}
          action={<Link className="btn btn-secondary" to="/certificates">Your certificates</Link>}
        />
      </div>
    );
  }

  const hoursLabel = formatHours(certificate.hours);

  return (
    <div className="page stack-lg">
      <BackLink />

      {/**
        * The document's own header, above the paper rather than on it.
        *
        * `no-print`, because the printed artefact is the certificate and
        * nothing else: a page that prints its own navigation is the defect the
        * print isolation rules were written to end.
        */}
      <div className="certificate-header no-print">
        <div className="stack-xs" style={{ minWidth: 0 }}>
          <h2 className="page-title truncate">{certificate.title}</h2>
          <p className="dim small">
            {hoursLabel} · {formatDay(certificate.endDatetime)}
            {certificate.organizationName ? ` · ${certificate.organizationName}` : ''}
          </p>
        </div>

        <div className="certificate-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setSharing(true)}>
            <Share2 size={15} aria-hidden="true" /> Share
          </button>
          {/**
            * Download opens a menu rather than acting immediately, because there
            * are genuinely two things a person means by it: a file to keep, and
            * paper for a school office. Both are real — see
            * `server/certificatePdf.js` — and neither is a stand-in for the
            * other. The menu carries no third entry: there is no image export,
            * because there is no implementation that produces a correct
            * certificate image, and a control that produces a wrong one is worse
            * than an absent one.
            */}
          <ActionsMenu
            label="Download this certificate"
            triggerText={downloading ? 'Preparing…' : 'Download'}
            triggerClassName="btn btn-primary row"
            icon={Download}
            disabled={downloading}
            items={[
              { id: 'pdf', label: 'Download PDF', icon: Download, onSelect: download },
              { id: 'print', label: 'Print', icon: Printer, onSelect: print },
            ]}
          />
        </div>
      </div>

      <div className="certificate-canvas certificate-stage">
        <CertificateDocument certificate={certificate} volunteer={currentUser} />
      </div>

      <p className="small dim row no-print certificate-note">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>
          Hours on this certificate were confirmed by the organizer after the event.
          Anyone can check it at <span className="tnum">{certificate.verifyLabel}</span>.
        </span>
      </p>

      {/**
        * Both halves are true at once, and saying only one of them is how this
        * screen used to be wrong in the opposite direction — it answered "no
        * such certificate" to the student while the public check answered
        * `valid` to anyone else.
        *
        * `no-print`, like the note above it: the printed artefact is the
        * certificate, and the certificate is not void. This is the context the
        * holder needs for the difference they will otherwise notice on their
        * own profile and have no explanation for.
        */}
      {certificate.eventCancelled && (
        <p className="small dim row no-print certificate-note">
          <Info size={14} aria-hidden="true" />
          <span>
            This event was called off after your hours were confirmed. The
            certificate stays valid and anyone can still check it — but the
            hours are not counted in your service totals, so you will not find
            them on your transcript.
          </span>
        </p>
      )}

      {sharing && (
        <CertificateShareDialog
          certificate={{ ...certificate, hoursLabel }}
          onClose={() => setSharing(false)}
          onShared={() => trackAmplitudeEvent(EVENT.SHARED_CERTIFICATE)}
          addToast={addToast}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/certificates" className="btn btn-ghost btn-sm row no-print" style={{ gap: 6, alignSelf: 'flex-start' }}>
      <ArrowLeft size={14} aria-hidden="true" /> Back to certificates
    </Link>
  );
}
