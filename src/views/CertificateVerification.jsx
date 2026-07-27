import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { ShieldCheck, ShieldAlert, Loader2, Calendar } from 'lucide-react';
import { formatDay, formatHours } from '../utils/helpers';
import { APP_NAME } from '../config';

/**
 * Shape of a certificate code, for rejecting obvious nonsense without a round
 * trip: `WEV-XXXX-XXXX`.
 *
 * Deliberately checks shape only, not the exact alphabet the server draws
 * from. A code containing a character the generator never emits still goes to
 * the server, which answers authoritatively — being lenient here means a
 * change to the generator can never cause this page to reject a genuine
 * certificate offline. The strict alphabet lives in server/certificates.js and
 * is the only place that decides what a real code looks like.
 */
const CODE_SHAPE = /^WEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export default function CertificateVerification() {
  const { code } = useParams();
  // loading · valid · invalid · ratelimited · error
  const [status, setStatus] = useState('loading');
  const [certData, setCertData] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cleanCode = String(code || '').toUpperCase().trim();

    // A missing or malformed code cannot match anything. Answer immediately
    // rather than spending one of the verify endpoint's 20 requests per 15
    // minutes on input we already know is not a code.
    if (!cleanCode || !CODE_SHAPE.test(cleanCode)) {
      setStatus('invalid');
      return;
    }

    setStatus('loading');

    api.verifyCertificate(cleanCode)
      .then(res => {
        if (cancelled) return;
        if (res?.valid) {
          setCertData(res);
          setStatus('valid');
        } else {
          setStatus('invalid');
        }
      })
      .catch(err => {
        if (cancelled) return;
        // 404 is the server saying, authoritatively, that no certificate has
        // this code — that is an invalid certificate, not a failure of ours.
        if (err.status === 404) {
          setStatus('invalid');
          return;
        }
        // Being rate limited says nothing about the certificate. Reporting it
        // as invalid would accuse a genuine record of being forged simply
        // because the office checked several in a row.
        if (err.status === 429) {
          setStatus('ratelimited');
          return;
        }
        // Anything else — unreachable server, 5xx, unexpected shape — is our
        // problem, and must never be presented as a verdict on the certificate.
        setStatus('error');
      });

    return () => { cancelled = true; };
  }, [code, attempt]);

  const retry = () => setAttempt(a => a + 1);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--surface-2)' }}>
      <header className="topbar" style={{ justifyContent: 'center' }}>
        <a className="brand" href="/" style={{ pointerEvents: 'none' }}>
          <span className="brand-mark">SB</span>
          <span className="brand-text">
            <span className="brand-name">{APP_NAME}</span>
            <span className="brand-sub">Verification</span>
          </span>
        </a>
      </header>

      <main style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 'var(--s4)' }}>
        <div className="card" style={{ maxWidth: 500, width: '100%', padding: 'var(--s6)' }}>
          {status === 'loading' && (
            <div className="stack-sm" style={{ alignItems: 'center', textAlign: 'center', padding: 'var(--s6) 0' }}>
              <Loader2 size={32} className="spin" style={{ color: 'var(--ink-3)' }} />
              <p className="lead">Verifying certificate...</p>
            </div>
          )}

          {status === 'invalid' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--danger)', marginBottom: 'var(--s4)' }}>
                <ShieldAlert size={48} />
              </div>
              <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s2)' }}>Invalid Certificate</h1>
              <p className="lead" style={{ marginBottom: 'var(--s5)' }}>
                The code <strong>{code}</strong> could not be found in our records.
              </p>
              <div className="surface inset" style={{ padding: 'var(--s4)', borderRadius: 8, textAlign: 'left', marginBottom: 'var(--s5)' }}>
                <p className="small dim">
                  <strong>Why am I seeing this?</strong><br />
                  This certificate may be forged, or the code was mistyped. {APP_NAME} certificates are cryptographically tied to the student's attendance records.
                  {' '}Codes look like <strong>WEV-XXXX-XXXX</strong> and never contain the letters I or O, or the digits 0 or 1.
                </p>
              </div>
              <Link to="/" className="btn btn-secondary">Return to home</Link>
            </div>
          )}

          {status === 'ratelimited' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--warn)', marginBottom: 'var(--s4)' }}>
                <ShieldAlert size={48} />
              </div>
              <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s2)' }}>Too many checks</h1>
              <p className="lead" style={{ marginBottom: 'var(--s5)' }}>
                This service limits how many certificates can be checked in a short period.
                Please wait a few minutes and try again.
              </p>
              <div className="surface inset" style={{ padding: 'var(--s4)', borderRadius: 8, textAlign: 'left', marginBottom: 'var(--s5)' }}>
                <p className="small dim">
                  <strong>This is not a verdict on the certificate.</strong><br />
                  The code <strong>{code}</strong> has not been checked yet — the limit was reached before we could look it up.
                </p>
              </div>
              <button className="btn btn-secondary" onClick={retry}>Try again</button>
            </div>
          )}

          {status === 'error' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--warn)', marginBottom: 'var(--s4)' }}>
                <ShieldAlert size={48} />
              </div>
              <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s2)' }}>Verification unavailable</h1>
              <p className="lead" style={{ marginBottom: 'var(--s5)' }}>
                We couldn't reach the verification service. Please try again in a moment.
              </p>
              <div className="surface inset" style={{ padding: 'var(--s4)', borderRadius: 8, textAlign: 'left', marginBottom: 'var(--s5)' }}>
                <p className="small dim">
                  <strong>This is not a verdict on the certificate.</strong><br />
                  The code <strong>{code}</strong> could not be checked. It has been neither confirmed nor rejected.
                </p>
              </div>
              <button className="btn btn-secondary" onClick={retry}>Try again</button>
            </div>
          )}

          {status === 'valid' && certData && (
            <div>
              <div style={{ textAlign: 'center', color: 'var(--ok)', marginBottom: 'var(--s4)' }}>
                <ShieldCheck size={48} />
              </div>
              <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s2)', textAlign: 'center' }}>
                Verified Certificate
              </h1>
              <p className="lead" style={{ textAlign: 'center', marginBottom: 'var(--s5)' }}>
                This is a valid South Brunswick community service record.
              </p>

              <div className="surface inset" style={{ padding: 'var(--s5)', borderRadius: 8, marginBottom: 'var(--s5)' }}>
                <div style={{ display: 'grid', gap: 'var(--s4)' }}>
                  <div>
                    <div className="small dim">Student</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{certData.volunteerName}</div>
                  </div>
                  <div>
                    <div className="small dim">Hours Credited</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--brand)' }}>
                      {formatHours(certData.hours)}
                    </div>
                  </div>
                  <div>
                    <div className="small dim">Event</div>
                    <div style={{ fontWeight: 500 }}>{certData.eventTitle}</div>
                  </div>
                  <div>
                    <div className="small dim">Organizer</div>
                    <div>{certData.organizerName}</div>
                  </div>
                  <div>
                    <div className="small dim">Completed</div>
                    <div className="row" style={{ gap: 6 }}>
                      <Calendar size={14} />
                      {formatDay(certData.completedAt)}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'center' }}>
                <p className="small dim" style={{ marginBottom: 'var(--s4)' }}>
                  Certificate Code: <strong>{code.toUpperCase()}</strong>
                </p>
                <Link to="/" className="btn btn-secondary">Done</Link>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
