import React from 'react';
import { useModal } from '../utils/useModal';
import { X, Printer, ShieldCheck } from 'lucide-react';
import { formatHours, formatDay, gradeLabel } from '../utils/helpers';

/**
 * A single event's certificate, printable to paper or PDF.
 *
 * The verification code is deterministic on the server, so a school office can
 * check a printed copy against the platform. It is an identifier, not a
 * secret — the same role a receipt number plays.
 */
export default function CertificateModal({ certificate, volunteer, onClose }) {
  const dialogRef = useModal(onClose);
  if (!certificate) return null;

  const verifyPath = `/verify/${certificate.code}`;

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

        <div className="modal-body" style={{ background: 'var(--surface-2)' }}>
          <div className="certificate" id="printable-certificate">
            <div style={{ textAlign: 'center' }}>
              <div className="certificate-org">
                South Brunswick Volunteer Network · New Jersey
              </div>
              <div className="certificate-rule" />
              <h1>Certificate of Community Service</h1>

              <p style={{ marginTop: 'var(--s5)', color: '#57534e' }}>This certifies that</p>
              <div className="certificate-name">{volunteer?.name}</div>
              {volunteer?.grade && (
                <p className="certificate-sub">{gradeLabel(volunteer.grade)}</p>
              )}

              <p style={{ color: '#57534e', maxWidth: '48ch', margin: 'var(--s5) auto 0' }}>
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

            <div className="certificate-foot">
              <div>
                <div className="certificate-sign">
                  {certificate.organizerName}
                  {certificate.organizerVerified && ' · Verified organizer'}
                </div>
                <div className="certificate-sign-label">Confirmed by</div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <div className="certificate-code">{certificate.code}</div>
                <div className="certificate-sign-label">
                  Verify at sbvolunteers.org{verifyPath}
                </div>
              </div>
            </div>
          </div>

          <p className="small dim no-print row" style={{ gap: 6, justifyContent: 'center', marginTop: 'var(--s4)' }}>
            <ShieldCheck size={13} />
            Hours on this certificate were confirmed by the organizer after the event.
          </p>
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
