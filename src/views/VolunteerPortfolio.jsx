import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { formatHours, formatDay } from '../utils/helpers';
import { aggregateServiceByEvent, totalServiceHours } from '../utils/serviceRecord';
import { Printer, ArrowLeft, FileWarning } from 'lucide-react';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { APP_NAME, SCHOOL_NAME, DOCUMENT_SIGNATORY, DOCUMENT_SIGNATORY_TITLE } from '../config';

/**
 * The printable record of verified service — the document a volunteer hands to
 * a college, a scholarship committee or an employer.
 *
 * ── One row per EVENT, not per shift ──
 *
 * Attendance is recorded per shift, because that is how an organizer confirms
 * it. This document was rendering that grain directly, so a volunteer who
 * worked setup, distribution and cleanup at one food drive appeared to have
 * made three commitments — while the summary directly above the table said
 * "1 event completed". The document contradicted itself on the page.
 * `aggregateServiceByEvent` is the translation; the total is preserved exactly.
 *
 * ── Why it is styled as a document rather than as a page ──
 *
 * It uses the certificate's `--cert-*` tokens and its serif, which are
 * deliberately NOT overridden in dark mode: a printed record is a light-paper
 * artefact whatever theme the person viewing it happens to use. That is why the
 * previous version broke in both themes — it drew on `--paper` and `--print-*`
 * for a wrapper that is on screen, so in dark mode the document sat on a dark
 * slab, and in print the background was dropped entirely and the intended white
 * never actually printed.
 *
 * It is not a certificate. A certificate celebrates one event; this is a
 * ledger, and it should read as a record rather than as an award — restrained
 * branding, real totals, no flourish.
 */
export default function VolunteerPortfolio({ currentUser }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    if (!currentUser) return undefined;

    setLoading(true);
    api.fetchVolunteerProfile(currentUser.id)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [currentUser]);

  const events = useMemo(() => aggregateServiceByEvent(data?.completed), [data]);

  if (loading) return <LoadingSkeleton heights={[120, 400]} />;

  if (error || !data) {
    return (
      <EmptyState
        icon={FileWarning}
        title="Transcript unavailable"
        message={error || 'Could not load service records.'}
        style={{ margin: 'var(--s6)' }}
      />
    );
  }

  const { volunteer, stats } = data;
  /* From the rows on the page, so the headline and the table can never
     disagree. `stats.hours` is the same figure by a different route; if the two
     ever diverge the document should show what it is actually printing. */
  const totalHours = totalServiceHours(events);
  const generated = formatDay(new Date().toISOString());

  return (
    <div className="transcript-page">
      <div className="no-print transcript-toolbar">
        <div className="row-between mx-auto" style={{ maxWidth: 800 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} aria-hidden="true" /> Back
          </button>
          <button className="btn btn-primary" onClick={() => window.print()}>
            <Printer size={16} aria-hidden="true" /> Print or save PDF
          </button>
        </div>
      </div>

      <article className="transcript" aria-label="Record of verified volunteer service">
        <header className="transcript-head">
          <div>
            <p className="transcript-org">{APP_NAME}</p>
            <h1 className="transcript-title">Record of Verified Service</h1>
          </div>
          <div className="transcript-issued">
            <div>{SCHOOL_NAME}</div>
            <div>Issued {generated}</div>
          </div>
        </header>

        <section className="transcript-subject">
          <p className="transcript-label">Volunteer</p>
          <p className="transcript-name">{volunteer.name}</p>
          {volunteer.username && <p className="transcript-sub">@{volunteer.username}</p>}
        </section>

        <section className="transcript-totals" aria-label="Totals">
          <div>
            <p className="transcript-label">Verified hours</p>
            <p className="transcript-figure tnum">{formatHours(totalHours)}</p>
          </div>
          <div>
            <p className="transcript-label">Events</p>
            <p className="transcript-figure tnum">{events.length}</p>
          </div>
          {stats?.shiftsCompleted > events.length && (
            <div>
              <p className="transcript-label">Shifts</p>
              <p className="transcript-figure tnum">{stats.shiftsCompleted}</p>
            </div>
          )}
        </section>

        <section className="transcript-history">
          <h2 className="transcript-section-title">Service history</h2>

          {events.length === 0 ? (
            <p className="transcript-empty">No verified service on record.</p>
          ) : (
            <table className="transcript-table">
              <caption className="sr-only">
                Verified volunteer service, one row per event, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Event</th>
                  <th scope="col" className="transcript-hours-col">Hours</th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.eventId ?? e.title}>
                    <td className="tnum">{formatDay(e.firstStart)}</td>
                    <td>
                      <span className="transcript-event">{e.title}</span>
                      {e.organizerName && <span className="transcript-meta">{e.organizerName}</span>}
                      {/* The shift count, never the shift names. It is the one
                          thing lost by aggregating that a reader might want,
                          and it reads as evidence of scale rather than as
                          three separate commitments. */}
                      {e.shifts > 1 && (
                        <span className="transcript-meta tnum">{e.shifts} shifts</span>
                      )}
                    </td>
                    <td className="transcript-hours-col tnum">{formatHours(e.hours)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td className="transcript-total-label">Total verified service</td>
                  <td className="transcript-hours-col tnum">{formatHours(totalHours)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>

        <footer className="transcript-foot">
          <p className="transcript-note">
            Every hour listed was confirmed by the organizer who ran the event on {APP_NAME}.
            Self-reported service recorded elsewhere is not included.
          </p>
          {/**
            * Name above the rule, capacity below it — the way a signed document
            * is laid out, and the same shape the certificates use.
            *
            * The signatory is deployment configuration, not profile data: a
            * transcript is issued by the platform, so joining this to a user row
            * would mean an ordinary profile edit changed the meaning of every
            * transcript already issued.
            */}
          <div className="transcript-sign">
            <p className="transcript-signatory">{DOCUMENT_SIGNATORY}</p>
            <div className="transcript-sign-rule" />
            <p className="transcript-label">Authorized signature</p>
            <p className="transcript-signatory-title">{DOCUMENT_SIGNATORY_TITLE}</p>
          </div>
        </footer>
      </article>
    </div>
  );
}
