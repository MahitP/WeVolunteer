import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { ShieldCheck, ShieldAlert, Loader2, Calendar } from 'lucide-react';
import { formatDay, formatHours } from '../utils/helpers';
import { APP_NAME } from '../config';

export default function CertificateVerification() {
  const { code } = useParams();
  const [status, setStatus] = useState('loading'); // loading, valid, invalid, error
  const [certData, setCertData] = useState(null);

  useEffect(() => {
    if (!code) {
      setStatus('invalid');
      return;
    }
    
    // Auto format lowercase to uppercase for the user
    const cleanCode = code.toUpperCase().trim();

    api.verifyCertificate(cleanCode)
      .then(res => {
        if (res.valid) {
          setCertData(res);
          setStatus('valid');
        } else {
          setStatus('invalid');
        }
      })
      .catch(err => {
        if (err.status === 404) setStatus('invalid');
        else setStatus('error');
      });
  }, [code]);

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
              <div style={{ color: 'var(--critical)', marginBottom: 'var(--s4)' }}>
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
                </p>
              </div>
              <Link to="/" className="btn btn-secondary">Return to home</Link>
            </div>
          )}

          {status === 'error' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--warning)', marginBottom: 'var(--s4)' }}>
                <ShieldAlert size={48} />
              </div>
              <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s2)' }}>System Error</h1>
              <p className="lead" style={{ marginBottom: 'var(--s5)' }}>
                We couldn't reach the verification server. Please try again later.
              </p>
              <button className="btn btn-secondary" onClick={() => window.location.reload()}>Try again</button>
            </div>
          )}

          {status === 'valid' && certData && (
            <div>
              <div style={{ textAlign: 'center', color: 'var(--success)', marginBottom: 'var(--s4)' }}>
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
