import React from 'react';
import { useModal } from '../utils/useModal';
import { X, Printer, ShieldCheck } from 'lucide-react';
import { formatHours, formatDay, gradeLabel } from '../utils/helpers';
import { publicOrigin } from '../config';

/**
 * A single event's certificate, printable to paper or PDF.
 *
 * The verification code is a random value stored server-side and handed out
 * with the printout, so a school office can check a printed copy against the
 * platform. It is a bearer credential for "whoever holds this piece of
 * paper" — possession of the code is what it proves, nothing more.
 */
export default function CertificateModal({ certificate, volunteer, onClose }) {
  // Bail out BEFORE useModal runs. useModal locks body scrolling for as long as
  // it is mounted; calling it and then returning null left the page unscrollable
  // with no dialog on screen and no visible way out — which read to users as the
  // app freezing. A component that renders nothing must have no side effects.
  if (!certificate) return null;
  return <CertificateDialog certificate={certificate} volunteer={volunteer} onClose={onClose} />;
}

function CertificateDialog({ certificate, volunteer, onClose }) {
  const dialogRef = useModal(onClose);

  const verifyPath = `/verify/${certificate.code}`;
  const verifyHost = publicOrigin();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal-lg"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Certificate for ${certificate.title}`}
      >
        <div className="modal-head no-print">
          <div>
            <h2>Certificate of service</h2>
            <p className="lead">Print it or save it as a PDF for your records.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="modal-body certificate-canvas">
          <div className="certificate" id="printable-certificate">
            <div style={{ textAlign: 'center' }}>
              <div className="certificate-org">
                WeVolunteer Network
              </div>
              <div className="certificate-rule" />
              <h1>Certificate of Community Service</h1>

              <p style={{ marginTop: 'var(--s5)', color: 'var(--certificate-ink-2)' }}>This certifies that</p>
              {/**
                * A name, or a visible admission that we do not have one.
                *
                * `{volunteer?.name}` alone renders an empty element when the
                * prop is missing or the profile fetch failed, so the finished
                * certificate has a blank where the subject belongs — printed,
                * signed and handed to a college with nobody's name on it. A
                * document that is silently wrong is worse than one that says it
                * is incomplete.
                */}
              <div className="certificate-name">{volunteer?.name || 'Name unavailable'}</div>
              {volunteer?.grade && (
                <p className="certificate-sub">{gradeLabel(volunteer.grade)}</p>
              )}

              <p style={{ color: 'var(--certificate-ink-2)', maxWidth: '48ch', margin: 'var(--s5) auto 0' }}>
                volunteered at
              </p>
              <div className="certificate-event">{certificate.title}</div>
              <p className="certificate-sub">
                {certificate.location} · {formatDay(certificate.startDatetime)}
              </p>

              <div className="certificate-hours" style={{ marginTop: 'var(--s6)' }}>
                {formatHours(certificate.hours)}
              </div>
              <p className="certificate-sub">of verified community service</p>
            </div>

            {/**
              * Two parties, two rules.
              *
              * A certificate of service is a claim about a volunteer that an
              * organizer attests to, and until now only the organizer appeared
              * at the foot of it. The document named its subject in the body and
              * then presented a single signature, which reads as an organizer
              * signing something about themselves.
              *
              * Both names sit ABOVE their rule with the capacity below it, the
              * way a signed document is laid out and the same shape the
              * transcript already uses. `.certificate-sign`'s `min-height` is
              * what keeps the two rules on one line when one name wraps and the
              * other does not — it was written for this pairing before there was
              * anything to pair.
              */}
            <div className="certificate-foot">
              <div className="certificate-sign-block">
                {/* Same reasoning as the volunteer name in the body: an empty
                    signature line is indistinguishable from an unsigned
                    certificate. */}
                <div className="certificate-sign">
                  {volunteer?.name || 'Name unavailable'}
                </div>
                <div className="certificate-sign-label">Volunteer</div>
              </div>

              <div className="certificate-sign-block">
                <div className="certificate-sign">
                  {certificate.organizerName || 'Organizer unavailable'}
                  {certificate.organizerVerified && ' · Verified organizer'}
                </div>
                <div className="certificate-sign-label">Program Coordinator</div>
              </div>
            </div>

            {/**
              * The verification code, displaced by the second signature and
              * given its own line rather than dropped.
              *
              * It is the only thing on the certificate a school office can act
              * on, so it keeps its own rule and its own caption. Centred beneath
              * both signatures it reads as belonging to the document rather than
              * to either party — which is accurate: the platform issues it, not
              * the organizer.
              */}
            <div className="certificate-verify">
              <div className="certificate-code">{certificate.code}</div>
              <div className="certificate-sign-label">
                Verify at {verifyHost}{verifyPath}
              </div>
            </div>
          </div>

          <div className="small dim no-print row-between" style={{ marginTop: 'var(--s4)' }}>
            <span className="row" style={{ gap: 6 }}>
              <ShieldCheck size={13} />
              Hours on this certificate were confirmed by the organizer after the event.
            </span>
            <span>Generated on {formatDay(new Date().toISOString())}</span>
          </div>
        </div>

        <div className="modal-foot no-print">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() => window.print()}>
            <Printer size={15} /> Print or save as PDF
          </button>
        </div>
      </div>
    </div>
  );
}
