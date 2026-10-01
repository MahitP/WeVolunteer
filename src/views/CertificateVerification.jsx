import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { ShieldCheck, ShieldAlert, Loader2, Calendar, Search } from 'lucide-react';
import { formatDay, formatHours } from '../utils/helpers';
import { NO_HOURS_LABEL } from '../utils/serviceRecord';
import { APP_NAME, SCHOOL_NAME } from '../config';
import BrandLockup from '../components/common/BrandLockup';
import useDocumentTitle from '../hooks/useDocumentTitle';

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

/**
 * Arriving with no code at all.
 *
 * `/verify/:code` is the link printed on a certificate, and for most of this
 * page's life it was the only way in — "there's no way to go to /verify unless u
 * go to the specific link". Somebody holding a paper certificate, or reading a
 * code off a screen, had nowhere to type it.
 *
 * The bare `/verify` is that place, and it is the same page rather than a new
 * one: everything after a code is entered — the shape check, the rate-limit
 * handling, the careful separation of "forged" from "we could not reach the
 * server" — is already here and must not be written twice.
 *
 * NOT the same as an invalid code. "The code undefined could not be found in
 * our records" is what the old missing-code branch produced, which accuses
 * somebody of forgery for having typed a URL.
 */
function CodeEntry() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const clean = value.toUpperCase().trim();
  const ready = CODE_SHAPE.test(clean);

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ color: 'var(--ink-3)', marginBottom: 'var(--s4)' }}>
        <ShieldCheck size={48} />
      </div>
      <h1 style={{ fontSize: '1.5rem', marginBottom: 'var(--s2)' }}>Check a certificate</h1>
      <p className="lead" style={{ marginBottom: 'var(--s5)' }}>
        Enter the code printed on a {APP_NAME} certificate to see whether it is genuine.
      </p>

      <form
        className="stack-sm"
        style={{ textAlign: 'left' }}
        onSubmit={e => {
          e.preventDefault();
          if (ready) navigate(`/verify/${clean}`);
        }}
      >
        <label className="label" htmlFor="certificate-code">Certificate code</label>
        <input
          id="certificate-code"
          className="input"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="WEV-XXXX-XXXX"
          autoComplete="off"
          spellCheck="false"
          style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}
        />
        {/* Shape only, and only once there is something to be wrong about. The
            server is what decides whether a well-formed code is real; this just
            avoids spending one of its twenty requests per fifteen minutes on
            something that cannot match anything. */}
        <p className="small dim">
          {clean && !ready
            ? 'Codes look like WEV-XXXX-XXXX.'
            : 'Codes never contain the letters I or O, or the digits 0 or 1.'}
        </p>
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          <Search size={16} aria-hidden="true" /> Check this code
        </button>
      </form>
    </div>
  );
}

export default function CertificateVerification() {
  const { code } = useParams();
  // entry · loading · valid · invalid · ratelimited · error
  const [status, setStatus] = useState(code ? 'loading' : 'entry');
  const [certData, setCertData] = useState(null);
  const [attempt, setAttempt] = useState(0);

  /**
   * This page names its own browser tab.
   *
   * `/verify` and `/verify/:code` are public and carry no `shellWhenSignedIn`,
   * so they render standalone — but `App.jsx`'s title effect sits ABOVE its
   * early returns and runs anyway, and `tabForPath` has no `/verify` branch, so
   * it fell through to `return 'dashboard'`. Every certificate a college opened
   * was in a tab that said "Dashboard · WeVolunteer". Measured live on
   * `/verify/WEV-UENF-2DM9`, which rendered a correct verified certificate under
   * the dashboard's name.
   *
   * That is the fifth instance of the defect `tabForPath` records four times,
   * and the worst-placed one: this is the page the platform tells students to
   * hand to an admissions office, so it is the tab most likely to be sitting in
   * a stranger's background while they compare it against something else, and a
   * WCAG 2.4.2 (Page Titled, Level A) failure on the one page whose entire job
   * is to be trusted by an outsider.
   *
   * Fixed HERE rather than with a `tabForPath` branch because the title depends
   * on the ANSWER, not the route: the same path is a search box, a verdict, or
   * neither. That is the distinction `useDocumentTitle` exists for, and the
   * Legal Center's documents are the precedent.
   *
   * `ratelimited` and `error` deliberately fall back to the neutral name. The
   * body of this page is careful never to present "we could not check" as a
   * verdict on the certificate, and a tab reading "Certificate not verified"
   * would undo that in the one place the reader glances at without reading.
   */
  useDocumentTitle(
    status === 'valid' ? 'Verified certificate'
      : status === 'invalid' ? 'Certificate not verified'
        : status === 'loading' ? 'Checking a certificate'
          : 'Check a certificate',
  );

  useEffect(() => {
    let cancelled = false;
    const cleanCode = String(code || '').toUpperCase().trim();

    /* No code in the URL is a visit to `/verify`, not a failed verification.
       See CodeEntry. */
    if (!cleanCode) {
      setStatus('entry');
      return;
    }

    // A malformed code cannot match anything. Answer immediately rather than
    // spending one of the verify endpoint's 20 requests per 15 minutes on input
    // we already know is not a code.
    if (!CODE_SHAPE.test(cleanCode)) {
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
          {/* The same lockup as the app shell (N10). */}
          <BrandLockup sub="Verification" />
        </a>
      </header>

      <main style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 'var(--s4)' }}>
        <div className="card" style={{ maxWidth: 500, width: '100%', padding: 'var(--s6)' }}>
          {status === 'entry' && <CodeEntry />}

          {status === 'loading' && (
            <div className="stack-sm" style={{ alignItems: 'center', textAlign: 'center', padding: 'var(--s6) 0' }}>
              <Loader2 size={32} className="spin" style={{ color: 'var(--ink-3)' }} />
              <p className="lead">Verifying certificate...</p>
            </div>
          )}

          {status === 'invalid' && (
            /**
             * `data-error-kind` on a page that is not an `ErrorExperience`.
             *
             * The accessibility sweep reads this attribute to answer the one
             * question an HTTP status cannot: "did I measure the page this route
             * names, or a panel standing in for it?" React Router serves the
             * shell for any path, so `/verify/<anything>` answers 200 and lands
             * on exactly the requested path whether or not the code is real.
             *
             * That mattered because a certificate code cannot be written down.
             * `generateCode` in server/certificates.js draws it from
             * `crypto.randomBytes`, so the harness's typed fixture was different
             * from every seeded code and this branch is what `/verify/:code`
             * rendered on every run — measured, and reported as coverage of the
             * public verification page. `a11y/harness/walk.mjs` calls that
             * "worse than skipping a route, because it produces numbers that
             * look like coverage".
             *
             * `a11y/harness/fixtures.mjs` now resolves a real code from
             * `/api/certificates` at walk time, so the sweep measures the
             * verified page. This marker is the backstop for the day that lookup
             * finds nothing — a seed without an attended event, say — so the
             * sweep says "unmeasured" instead of quietly auditing this panel
             * again. Same reasoning, and the same attribute, as `CertificateView`.
             *
             * Only THIS state carries it. "Too many checks" and "Verification
             * unavailable" are explicitly not verdicts on the certificate, and
             * marking them 404 would claim the code did not resolve when the
             * truth is that it was never looked up.
             */
            <div style={{ textAlign: 'center' }} data-error-kind="404">
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
                This is a valid {SCHOOL_NAME} {certData.participation ? 'participation' : 'community service'} record.
              </p>

              <div className="surface inset" style={{ padding: 'var(--s5)', borderRadius: 8, marginBottom: 'var(--s5)' }}>
                <div style={{ display: 'grid', gap: 'var(--s4)' }}>
                  <div>
                    <div className="small dim">Student</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{certData.volunteerName}</div>
                  </div>
                  {/* What the document is, as the paper says it (ruling 16): a
                      Certificate of Participation carries no hours. */}
                  {certData.participation ? (
                    <div>
                      <div className="small dim">Certificate of Participation</div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--brand)' }}>
                        {NO_HOURS_LABEL}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="small dim">Hours Credited</div>
                      <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--brand)' }}>
                        {formatHours(certData.hours)}
                      </div>
                    </div>
                  )}
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
