import React, { useEffect, useState } from 'react';
/**
 * Every icon rendered below must be imported here.
 *
 * Five were not — UserX, UserCheck, CheckCircle, Search and Trash2 — and
 * `UserX`/`UserCheck` are the Deny and Approve controls in the organizer review
 * queue. React threw `ReferenceError: UserX is not defined` the moment the queue
 * had a single pending organizer, so the whole screen fell into the error
 * boundary and no organizer could ever be approved — which means no organizer
 * could ever post an event. `oxlint` reports these as `jsx-no-undef`; the
 * warning is not cosmetic, it is a guaranteed render crash.
 */
import {
  Calendar, ShieldCheck, Flag,
  UserX, UserCheck, CheckCircle, Search, Trash2
} from 'lucide-react';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { api } from '../utils/api';
import { formatHours, formatDay, eventPermissions } from '../utils/helpers';
import { BarChart } from '../components/BarChart';
import ResolutionModal from '../components/ResolutionModal';
import { categoryLabel } from '../moderation';

/**
 * The statuses a report can still be worked in, and how each one is coloured.
 *
 * `escalated` counts as live for the same reason `evidenceHolds.js` treats it
 * that way: a report that has left the queue for a phone call is the last one
 * whose evidence should look finished.
 */
const LIVE_STATUSES = new Set(['open', 'reviewing', 'escalated']);
const STATUS_TAG = {
  open: 'tag-danger',
  reviewing: 'tag-info',
  escalated: 'tag-warn',
  resolved: 'tag-ok',
  dismissed: 'tag-ok',
};

export default function AdminDashboard({ addToast }) {
  const [pendingOrganizers, setPendingOrganizers] = useState([]);
  const [events, setEvents] = useState([]);
  const [totals, setTotals] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);
  // A deletion refused because the event is under a live safety review.
  const [heldReason, setHeldReason] = useState(null);
  const [resolvingReport, setResolvingReport] = useState(null); // { id, status }

  const loadData = async () => {
    try {
      const [orgs, evts, stats, rpts] = await Promise.all([
        api.apiFetch('/api/admin/organizers/pending'),
        api.fetchEvents(),
        api.fetchAdminStats().catch(() => null),
        api.apiFetch('/api/admin/reports').catch(() => [])
      ]);
      setPendingOrganizers(orgs);
      setEvents(evts);
      setTotals(stats);
      setReports(rpts);
    } catch (err) {
      addToast(`Could not load the review queue: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  /**
   * Closing a report, with the resolution and the note the server requires.
   *
   * The error is re-thrown so `ResolutionModal` can show it inline and keep what
   * the moderator typed. It used to be swallowed into a toast and the dialog
   * closed regardless, which on a refusal — a note one character short, a
   * conflict of interest — lost the note and told them the report was updated.
   */
  const submitResolution = async (reportId, status, resolution, resolutionNote) => {
    setBusyId(reportId);
    try {
      await api.apiFetch(`/api/admin/reports/${reportId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, resolution, resolutionNote })
      });
      addToast(`Report marked as ${status}.`, 'success');
      setResolvingReport(null);
      loadData();
    } catch (err) {
      addToast(`Failed to update report: ${err.message}`, 'error');
      throw err;
    } finally {
      setBusyId(null);
    }
  };

  /** Moving a report along without closing it — no resolution is required yet. */
  const setReportStatus = async (reportId, status) => {
    setBusyId(reportId);
    try {
      await api.apiFetch(`/api/admin/reports/${reportId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      loadData();
    } catch (err) {
      addToast(`Failed to update report: ${err.message}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (org) => {
    setBusyId(org.id);
    try {
      await api.apiFetch(`/api/admin/organizers/${org.id}/approve`, { method: 'POST' });
      addToast(`${org.name} can now post events.`, 'success');
      loadData();
    } catch (err) {
      addToast(`Could not approve: ${err.message}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const deny = async (org) => {
    if (!window.confirm(`Deny ${org.name}?\n\nTheir account will be removed and they'll need to register again.`)) return;
    setBusyId(org.id);
    try {
      await api.apiFetch(`/api/admin/organizers/${org.id}/deny`, { method: 'POST' });
      addToast(`${org.name}'s request was denied.`, 'info');
      loadData();
    } catch (err) {
      addToast(`Could not deny: ${err.message}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const removeEvent = async (event) => {
    if (!window.confirm(`Remove "${event.title}"?\n\nAll sign-ups for it will be deleted. This cannot be undone.`)) return;
    setHeldReason(null);
    try {
      await api.deleteEvent(event.id);
      addToast(`"${event.title}" removed.`, 'success');
      loadData();
    } catch (err) {
      // The evidence hold applies to administrators too — it is about the
      // evidence, not about who is asking — so this surface needs the same
      // persistent explanation the organizer's does.
      if (err.status === 409) setHeldReason(err.message);
      addToast(err.status === 409 ? err.message : `Could not remove: ${err.message}`, 'error');
    }
  };

  if (loading) {
    return <LoadingSkeleton heights={[84, 200, 280]} />;
  }

  const q = query.trim().toLowerCase();
  const filteredEvents = events.filter(e =>
    !q || e.title.toLowerCase().includes(q) ||
    e.organizerName?.toLowerCase().includes(q) ||
    e.location?.toLowerCase().includes(q)
  );

  return (
    <div className="stack-lg">
      {resolvingReport && (
        <ResolutionModal 
          report={resolvingReport}
          onClose={() => setResolvingReport(null)}
          onSubmit={submitResolution}
          isSubmitting={busyId === resolvingReport.id}
        />
      )}
      
      {heldReason && (
        <div className="alert alert-warn" role="alert">
          <Flag size={18} aria-hidden="true" />
          <span className="stack-xs">
            <strong>This event is on hold</strong>
            <span className="small">{heldReason}</span>
          </span>
        </div>
      )}

      {/* ── Platform totals ── */}
      {totals && (
        <section className="stats">
          <div className="stat">
            <div className="stat-label">Students</div>
            <div className="stat-value">{totals.students}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Organizers</div>
            <div className="stat-value">{totals.organizers}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Events posted</div>
            <div className="stat-value">{totals.events}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Hours credited</div>
            <div className="stat-value accent">{formatHours(totals.hours)}</div>
          </div>
        </section>
      )}

      {/* ── Programme health ──
          Rates rather than raw counts: these are the numbers that tell staff
          whether volunteering is actually working, not just happening. */}
      {totals && (
        <section>
          <div className="section-head"><h2>Programme health</h2></div>
          <div className="grid grid-3">
            <RateCard
              label="Show-up rate"
              value={totals.attendanceRate}
              note="Confirmed volunteers who attended"
              good={(v) => v >= 80}
            />
            <RateCard
              label="Events completed"
              value={totals.completionRate}
              note="Finished rather than cancelled"
              good={(v) => v >= 80}
            />
            <RateCard
              label="Students volunteering"
              value={totals.participationRate}
              note={`${totals.activeVolunteers} of ${totals.students} have served`}
              good={(v) => v >= 40}
            />
          </div>
        </section>
      )}

      {/* ── Participation over time ── */}
      {totals?.monthlyHours?.length > 0 && (
        <section>
          <div className="section-head"><h2>Participation</h2></div>
          <div className="grid grid-2">
            <div className="card card-pad">
              <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>Hours credited by month</div>
              <BarChart
                data={totals.monthlyHours} valueKey="hours" labelKey="month" highlightLast
                caption="Hours credited by month" unit="Hours" periodLabel="Month"
              />
            </div>
            <div className="card card-pad">
              <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>Volunteers active by month</div>
              {/*
                The caption is not decoration. The visual half of the chart is
                aria-hidden, so this is the only description a screen-reader user
                receives — and until BarChart took a prop it was hardcoded to
                "Hours by period", which announced this count of PEOPLE as hours.
              */}
              <BarChart
                data={totals.monthlyHours} valueKey="volunteers" labelKey="month" highlightLast
                caption="Volunteers active by month" unit="Volunteers" periodLabel="Month"
                emptyText="No volunteers recorded yet"
              />
            </div>
          </div>
        </section>
      )}

      {/* ── Who is carrying the programme ── */}
      {totals?.topOrganizers?.length > 0 && (
        <section>
          <div className="section-head"><h2>Most active organizers</h2></div>
          <div className="list">
            {totals.topOrganizers.map((o, i) => (
              <div key={o.id} className="list-row">
                <span className="rank">{i + 1}</span>
                <span className="avatar sm">{o.avatar || '👤'}</span>
                <span className="truncate" style={{ flex: 1 }}>
                  <span className="person-name truncate row" style={{ gap: 5 }}>
                    {o.name}
                    {o.verified && <ShieldCheck size={12} style={{ color: 'var(--ok)' }} />}
                  </span>
                  <span className="person-meta">
                    {o.events} event{o.events !== 1 ? 's' : ''} hosted
                  </span>
                </span>
                <span className="hourspill">{formatHours(o.hours)} <span>credited</span></span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Approval queue: the admin's actual job ── */}
      <section>
        <div className="section-head">
          <h2>Organizer requests</h2>
          {pendingOrganizers.length > 0 && (
            <span className="section-action tag tag-warn">{pendingOrganizers.length} waiting</span>
          )}
        </div>

        {pendingOrganizers.length === 0 ? (
          <EmptyState 
            icon={ShieldCheck} 
            title="Nothing to review" 
            message="New organizer requests will appear here for approval." 
          />
        ) : (
          <div className="stack">
            {pendingOrganizers.map(org => (
              <div key={org.id} className="card card-pad">
                <div className="row-between row-wrap" style={{ gap: 'var(--s4)', alignItems: 'flex-start' }}>
                  <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s4)', minWidth: 0 }}>
                    <span className="avatar lg">{org.avatar || '👤'}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="strong">{org.name}</div>
                      <div className="small muted">{org.email}</div>
                      <div className="small" style={{ marginTop: 6 }}>
                        <span className="dim">Affiliation </span>
                        <span className="strong">{org.school || 'Not provided'}</span>
                      </div>
                      {org.bio && (
                        <p className="small muted" style={{
                          marginTop: 'var(--s3)', paddingLeft: 'var(--s3)',
                          borderLeft: '2px solid var(--rule)', maxWidth: '58ch'
                        }}>
                          {org.bio}
                        </p>
                      )}
                      <div className="small dim" style={{ marginTop: 'var(--s3)' }}>
                        Requested {formatDay(org.createdAt)}
                      </div>
                    </div>
                  </div>

                  <div className="row" style={{ gap: 'var(--s2)' }}>
                    <button className="btn btn-danger btn-sm" disabled={busyId === org.id} onClick={() => deny(org)}>
                      <UserX size={14} /> Deny
                    </button>
                    <button className="btn btn-primary btn-sm" disabled={busyId === org.id} onClick={() => approve(org)}>
                      <UserCheck size={14} /> Approve
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Moderation Queue ── */}
      <section>
        <div className="section-head">
          <h2>Moderation queue</h2>
          {reports.filter(r => r.status === 'open').length > 0 && (
            <span className="section-action tag tag-danger">{reports.filter(r => r.status === 'open').length} waiting</span>
          )}
        </div>

        {reports.length === 0 ? (
          <EmptyState 
            icon={Flag} 
            title="No reports" 
            message="Community reports will appear here for review." 
          />
        ) : (
          <div className="stack">
            {reports.map(report => (
              <div key={report.id} className="card card-pad" style={{ opacity: report.status === 'resolved' || report.status === 'dismissed' ? 0.6 : 1 }}>
                <div className="row-between row-wrap" style={{ gap: 'var(--s4)', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row row-wrap" style={{ gap: 'var(--s2)', marginBottom: 'var(--s1)' }}>
                      <span className={`tag ${STATUS_TAG[report.status] ?? 'tag-info'}`}>
                        {report.status.toUpperCase()}
                      </span>
                      {/* Priority is derived server-side from the category and
                          from who is reporting whom, and it decides whether this
                          is looked at today or tomorrow. It was computed on every
                          report and then shown on none of them, which made the
                          whole derivation invisible to the person it exists to
                          help. */}
                      {report.priority === 'urgent' && (
                        <span className="tag tag-warn">URGENT</span>
                      )}
                      <span className="small strong capitalize">Reported {report.target_type}</span>
                      <span className="small dim">{formatDay(report.created_at)}</span>
                    </div>

                    {/* What the reporter said was wrong, in the words they were
                        offered. The stored value is snake_case and is never shown. */}
                    <div className="small" style={{ marginBottom: 'var(--s2)' }}>
                      <span className="dim">Category: </span>
                      <span className="strong">{categoryLabel(report.category)}</span>
                    </div>

                    {/* The email is only rendered when there is a live account
                        behind it. `reporter_id` is nullable since the reporter
                        cascade was severed, so a purged reporter leaves the
                        snapshotted name and nothing to contact. "(undefined)"
                        beside a student's name is worse than no email. */}
                    <div className="small" style={{ marginBottom: 'var(--s2)' }}>
                      <span className="dim">Reported by: </span>
                      <span className="strong">{report.reporter_name}</span>
                      {report.reporter_email && <span className="muted"> ({report.reporter_email})</span>}
                    </div>

                    <div className="inset" style={{ marginBottom: 'var(--s3)', background: 'var(--surface-2)' }}>
                      <div className="small strong" style={{ marginBottom: 4 }}>What was reported:</div>

                      {/* What was pointed at. A conversation, a person and a
                          certificate have no body of their own, so without the
                          snapshot label they rendered as an unlabelled row — the
                          same blank cell a moderator reads as "nothing wrong
                          here". */}
                      {report.target_label && (
                        <p className="small strong">{report.target_label}</p>
                      )}

                      {/* Three distinct states, and a moderator's decision can
                          turn on which one they are reading. `target_missing` is
                          now only ever true when there is genuinely nothing: it
                          used to be true for every conversation and message
                          report, so the queue told the moderator "no copy was
                          kept" about reports holding hundreds of preserved
                          messages. */}
                      {report.target_title && (
                        <p className="small muted">&quot;{report.target_title}&quot;</p>
                      )}
                      {report.target_is_snapshot && (
                        <p className="small dim">
                          Preserved copy — the original was deleted after this report was filed.
                        </p>
                      )}
                      {report.target_missing && (
                        <p className="small muted">
                          No copy of this was kept — it was deleted before reports were preserved.
                        </p>
                      )}

                      {/* Evidence availability, so a moderator knows there is
                          something to open. Reading it is a separate, logged act
                          behind its own capability, which is why the count is
                          here and the bodies are not. */}
                      {report.evidence_count > 0 && (
                        <p className="small dim">
                          {report.evidence_count} message{report.evidence_count === 1 ? '' : 's'} preserved
                          as evidence.
                        </p>
                      )}
                    </div>

                    {/* The reporter's own words. This read `report.reason`, a
                        column the unified model renamed to `description`, so the
                        heading was followed by nothing at all on every report in
                        the queue — the one part of a report that is authoritative
                        content rather than a derived label. */}
                    <div className="small strong" style={{ marginBottom: 4 }}>What they told us:</div>
                    {report.description
                      ? <p className="small">{report.description}</p>
                      : <p className="small dim">They chose a category and did not add anything else.</p>}

                    {/* A closed report keeps its outcome visible: "who decided
                        this, and why" is the question an appeal starts from. */}
                    {report.resolution && (
                      <p className="small dim" style={{ marginTop: 'var(--s2)' }}>
                        {report.resolution.replace(/_/g, ' ')}
                        {report.resolved_by_name ? ` — ${report.resolved_by_name}` : ''}
                      </p>
                    )}
                  </div>

                  {/* Actions on every LIVE status, not just `open`.
                      They were gated on `open` alone, so the moment a moderator
                      picked a report up it lost its buttons: `reviewing` and
                      `escalated` reports could be created and then never closed
                      from the product at all — and an escalated report is by
                      definition the one somebody is actively dealing with. */}
                  {LIVE_STATUSES.has(report.status) && (
                    <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
                      {report.status === 'open' && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setReportStatus(report.id, 'reviewing')}
                          disabled={busyId === report.id}
                        >
                          Start review
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setResolvingReport({ id: report.id, status: 'dismissed' })}
                        disabled={busyId === report.id}
                      >
                        Dismiss
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => setResolvingReport({ id: report.id, status: 'resolved' })}
                        disabled={busyId === report.id}
                      >
                        <CheckCircle size={14} /> Resolve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── All events ── */}
      <section>
        <div className="section-head"><h2>All events</h2></div>

        <div className="toolbar">
          <div className="input-affix">
            <Search size={15} />
            <input
              type="search" className="input" placeholder="Search by event, organizer, or place…"
              value={query} onChange={e => setQuery(e.target.value)}
              aria-label="Search events"
            />
          </div>
          <span className="small dim nowrap" style={{ marginLeft: 'auto' }}>
            {filteredEvents.length} of {events.length}
          </span>
        </div>

        {filteredEvents.length === 0 ? (
          <EmptyState 
            icon={Calendar} 
            title="No events match that search" 
            message="Try a different organizer name, event title, or location." 
          />
        ) : (
          <div className="tablewrap">
            <div className="tablescroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Organizer</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th className="cell-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map(event => (
                    <tr key={event.id}>
                      <td>
                        <div className="cell-title truncate" style={{ maxWidth: 260 }}>{event.title}</div>
                        <div className="small dim truncate" style={{ maxWidth: 260 }}>
                          {event.category} · {event.location}
                        </div>
                      </td>
                      <td className="small">{event.organizerName}</td>
                      <td className="small tnum">{formatDay(event.startDatetime)}</td>
                      <td>
                        <span className={`status ${
                          event.status === 'open' ? 'status-ok'
                            : event.status === 'completed' ? 'status-info' : 'status-muted'
                        }`}>
                          {event.status === 'open' ? 'Open'
                            : event.status === 'completed' ? 'Completed'
                            : event.status === 'closed' ? 'Closed' : 'Cancelled'}
                        </span>
                      </td>
                      <td className="cell-actions">
                        {eventPermissions(event).canDelete ? (
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            style={{ color: 'var(--danger)' }}
                            title="Remove this event"
                            onClick={() => removeEvent(event)}
                          >
                            <Trash2 size={14} />
                          </button>
                        ) : (
                          // Admins are not exempt: an event that produced service
                          // hours is part of a student's record either way.
                          <span className="small dim" title={eventPermissions(event).blockedReason}>
                            Protected
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * A percentage with a plain-language read on whether it is healthy.
 * A number alone makes staff guess what "62%" means.
 */
function RateCard({ label, value, note, good }) {
  const known = value !== null && value !== undefined;
  const isGood = known && good(value);
  return (
    <div className="card card-pad">
      <div className="stat-label">{label}</div>
      <div className="row" style={{ gap: 'var(--s2)', alignItems: 'baseline', marginTop: 2 }}>
        <span className="stat-value" style={{ color: known ? (isGood ? 'var(--ok)' : 'var(--warn)') : 'var(--ink-3)' }}>
          {known ? `${value}%` : '—'}
        </span>
        {known && (
          <span className={`status ${isGood ? 'status-ok' : 'status-pending'}`}>
            {isGood ? 'Healthy' : 'Worth a look'}
          </span>
        )}
      </div>
      <p className="small dim" style={{ marginTop: 4 }}>
        {known ? note : 'Not enough data yet'}
      </p>
    </div>
  );
}
