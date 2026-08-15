/**
 * Logged hours — one place to see everything you have volunteered.
 *
 * ── Why the page exists ──
 *
 * A student's volunteering was spread across three screens: the dashboard's
 * "Service history" (recent shifts, truncated), the printable transcript at
 * /portfolio (WeVolunteer service only, formatted for a school office), and
 * /hours/external (a form, with its own entries listed underneath it). "How much
 * have I actually done?" was not answerable from any one of them.
 *
 * ── The distinction the page is built around ──
 *
 * Two lists, never one, and never a combined total:
 *
 *   WeVolunteer service   An organizer marked you present. It is the number on
 *                         your profile, your certificate and your transcript.
 *   External volunteering Something you did elsewhere and wrote down yourself.
 *                         Nobody checked it. It counts towards nothing here.
 *
 * They are rendered as separate sections with separate headings and separate
 * totals, and the external one carries a "Self-reported" tag on every row —
 * because a reader scanning a list of hours will take the whole list to mean the
 * same thing unless each part says otherwise. `hoursCredited` and
 * `selfReportedHours` are never added together on this page, in the summary or
 * anywhere else; see the header of server/volunteerStats.js for why that
 * separation is a security property rather than a formatting preference.
 *
 * ── No new navigation ──
 *
 * Reached from the dashboard's Service history and from the student's own
 * profile, and it links back to the dashboard. It is deliberately not a rail
 * entry: it is somewhere you go from your hours, not a destination you navigate
 * to first.
 */
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, History, NotebookPen, Pencil, Plus, Printer, Trash2, CalendarCheck2, ExternalLink,
} from 'lucide-react';
import { api } from '../utils/api';
import { formatHours, formatDay } from '../utils/helpers';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import ConfirmDialog from '../components/common/ConfirmDialog';

export default function LoggedHours({ currentUser, addToast }) {
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(null);

  /**
   * One request, not two.
   *
   * `/api/users/:id/service-record` already carries the confirmed shifts, the
   * caller's own external entries and the derived stats, and it applies the
   * privacy rule for all three in one place. Asking two endpoints would mean two
   * loading states for one page and two chances for the two halves to disagree
   * about what is on it.
   */
  const load = useCallback(() => {
    if (!currentUser?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    api.fetchServiceRecord(currentUser.id)
      .then(res => { if (!cancelled) { setRecord(res); setError(''); } })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not load your hours.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  useEffect(() => load(), [load]);

  const remove = async (entry) => {
    try {
      await api.deleteExternalHours(entry.id);
      addToast?.('Entry removed from your log.', 'success');
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <LoadingSkeleton heights={[96, 240, 240]} className="stack-lg" />;

  if (error) {
    return (
      <EmptyState
        icon={History}
        title="Your hours could not be loaded"
        message={error}
        action={<button className="btn btn-secondary btn-sm" onClick={load}>Try again</button>}
      />
    );
  }

  /* `present` is the organizer's record. A shift somebody was marked absent for
     is not service, so it is not on a page about what they have done — the
     dashboard is where an attendance problem belongs. */
  const attended = (record?.completed ?? []).filter(c => c.present);
  const external = record?.external ?? [];
  const credited = record?.stats?.hoursCredited ?? 0;
  const selfReported = external.reduce((sum, e) => sum + Number(e.hours || 0), 0);

  return (
    <div className="page stack-lg">
      <div className="page-head row-between row-wrap">
        <div>
          <Link to="/" className="btn btn-ghost btn-sm loggedhours-back">
            <ArrowLeft size={15} aria-hidden="true" /> Back to dashboard
          </Link>
          <h2 className="page-title">Logged hours</h2>
          <p className="muted">
            Everything you have volunteered, in one place — what WeVolunteer confirmed, and what
            you have recorded yourself.
          </p>
        </div>
        <Link to="/portfolio" className="btn btn-secondary">
          <Printer size={15} aria-hidden="true" /> Printable transcript
        </Link>
      </div>

      {/**
        * Two figures side by side, never summed, and labelled by WHO stands
        * behind each. A single "total hours" here would be the whole reason the
        * two lists below are kept apart, undone in one line of arithmetic.
        */}
      <div className="grid grid-2 loggedhours-totals">
        <div className="card card-pad stack-xs">
          <span className="eyebrow">Confirmed by an organizer</span>
          <span className="stat-value">{formatHours(credited)}</span>
          <span className="small muted">
            {attended.length} {attended.length === 1 ? 'shift' : 'shifts'} on WeVolunteer. This is
            the figure on your profile, certificates and transcript.
          </span>
        </div>
        <div className="card card-pad stack-xs">
          <span className="eyebrow">Self-reported by you</span>
          <span className="stat-value">{formatHours(selfReported)}</span>
          <span className="small muted">
            {external.length} external {external.length === 1 ? 'entry' : 'entries'}. Kept for your
            own history — not counted towards WeVolunteer hours or awards.
          </span>
        </div>
      </div>

      {/* ── WeVolunteer service ── */}
      <section className="card">
        <div className="card-head row-between row-wrap">
          <h2 className="row loggedhours-heading">
            <CalendarCheck2 size={16} aria-hidden="true" /> WeVolunteer service
          </h2>
          <span className="tag tag-ok">Confirmed by an organizer</span>
        </div>
        <div className="card-body">
          {attended.length === 0 ? (
            <EmptyState
              icon={History}
              title="No confirmed shifts yet"
              message="Hours appear here once an organizer marks you present for a shift you worked."
              action={<Link className="btn btn-primary btn-sm" to="/discover">Find an opportunity</Link>}
            />
          ) : (
            <ul className="list loggedhours-list">
              {attended.map((c, i) => (
                <li key={`${c.eventId}-${c.startDatetime}-${i}`} className="list-row loggedhours-row">
                  <span className="loggedhours-date">{formatDay(c.startDatetime)}</span>
                  <span className="loggedhours-body">
                    <span className="loggedhours-title">{c.title}</span>
                    <span className="muted loggedhours-meta">
                      {c.location ? `${c.location} · ` : ''}{c.category}
                    </span>
                  </span>
                  {/* An event whose organizer chose not to credit hours is still
                      service, and hiding the row would make the list disagree
                      with the dashboard. It says so instead of showing "0 hrs",
                      which reads as a mistake. */}
                  <span className="hourspill">
                    {c.creditsHours ? `+${formatHours(c.hoursAwarded)}` : 'No hours'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── External volunteering ── */}
      <section className="card">
        <div className="card-head row-between row-wrap">
          <h2 className="row loggedhours-heading">
            <ExternalLink size={16} aria-hidden="true" /> External volunteering
          </h2>
          <span className="tag ext-kind">
            <NotebookPen size={13} aria-hidden="true" /> Self-reported
          </span>
        </div>
        <div className="card-body stack-md">
          <p className="small muted loggedhours-note">
            Volunteering you did somewhere WeVolunteer doesn&rsquo;t run. Nobody reviews these — they
            are your own record, they are not visible to anybody else, and they do not appear on
            your WeVolunteer transcript or certificates.
          </p>

          {external.length === 0 ? (
            <EmptyState
              icon={NotebookPen}
              title="Nothing logged yet"
              message="Add the volunteering you have done outside WeVolunteer so your history is complete."
              action={
                <Link className="btn btn-primary btn-sm" to="/hours/external">
                  <Plus size={14} aria-hidden="true" /> Log external hours
                </Link>
              }
            />
          ) : (
            <>
              <ul className="list loggedhours-list">
                {external.map(entry => (
                  <li key={entry.id} className="list-row loggedhours-row">
                    <span className="loggedhours-date">{entry.occurredOn}</span>
                    <span className="loggedhours-body">
                      <span className="loggedhours-title">{entry.activityName}</span>
                      <span className="muted loggedhours-meta">{entry.organizationName}</span>
                    </span>
                    <span className="tag ext-kind">
                      <NotebookPen size={13} aria-hidden="true" /> Self-reported
                    </span>
                    <span className="hourspill">{formatHours(entry.hours)}</span>
                    {/**
                      * Edit, not just delete.
                      *
                      * `PATCH /api/external-hours/:id` existed with no caller, so
                      * the one thing a student could not do was fix a wrong date
                      * without deleting the entry and retyping the rest. There is
                      * no state in which one of these becomes uneditable —
                      * nobody else's judgement is stored on it.
                      */}
                    <Link
                      className="btn btn-ghost btn-icon"
                      to={`/hours/external?edit=${encodeURIComponent(entry.id)}`}
                      aria-label={`Edit ${entry.activityName}`}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </Link>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Remove ${entry.activityName} from your log`}
                      onClick={() => setDeleting(entry)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <Link className="btn btn-secondary btn-sm" to="/hours/external">
                <Plus size={14} aria-hidden="true" /> Log another entry
              </Link>
            </>
          )}
        </div>
      </section>

      {deleting && (
        <ConfirmDialog
          title="Remove this entry?"
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        >
          <span>
            &ldquo;{deleting.activityName}&rdquo; will be removed from your log. This cannot be
            undone, but you can log it again.
          </span>
        </ConfirmDialog>
      )}
    </div>
  );
}
