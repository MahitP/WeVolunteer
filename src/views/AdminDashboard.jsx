import React, { useEffect, useState } from 'react';
import {
  UserCheck, UserX, Trash2, Search, ShieldCheck, Calendar, Flag, CheckCircle
} from 'lucide-react';
import { api } from '../utils/api';
import { formatHours, formatDay, eventPermissions } from '../utils/helpers';
import { BarChart } from '../components/BarChart';

export default function AdminDashboard({ addToast }) {
  const [pendingOrganizers, setPendingOrganizers] = useState([]);
  const [events, setEvents] = useState([]);
  const [totals, setTotals] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);

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

  const resolveReport = async (reportId, status) => {
    setBusyId(reportId);
    try {
      await api.apiFetch(`/api/admin/reports/${reportId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      addToast(`Report marked as ${status}.`, 'success');
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
    try {
      await api.deleteEvent(event.id);
      addToast(`"${event.title}" removed.`, 'success');
      loadData();
    } catch (err) {
      addToast(`Could not remove: ${err.message}`, 'error');
    }
  };

  if (loading) {
    return (
      <div className="stack">
        <div className="skeleton" style={{ height: 84 }} />
        <div className="skeleton" style={{ height: 200 }} />
        <div className="skeleton" style={{ height: 280 }} />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filteredEvents = events.filter(e =>
    !q || e.title.toLowerCase().includes(q) ||
    e.organizerName?.toLowerCase().includes(q) ||
    e.location?.toLowerCase().includes(q)
  );

  return (
    <div className="stack-lg">
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
              <BarChart data={totals.monthlyHours} valueKey="hours" labelKey="month" highlightLast />
            </div>
            <div className="card card-pad">
              <div className="eyebrow" style={{ marginBottom: 'var(--s3)' }}>Volunteers active by month</div>
              <BarChart data={totals.monthlyHours} valueKey="volunteers" labelKey="month" highlightLast />
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
          <div className="card empty">
            <span className="empty-icon" style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }}>
              <ShieldCheck size={18} />
            </span>
            <h3>Nothing to review</h3>
            <p>New organizer requests will appear here for approval.</p>
          </div>
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
            <span className="section-action tag tag-error">{reports.filter(r => r.status === 'open').length} waiting</span>
          )}
        </div>

        {reports.length === 0 ? (
          <div className="card empty">
            <span className="empty-icon" style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }}>
              <Flag size={18} />
            </span>
            <h3>No reports</h3>
            <p>Community reports will appear here for review.</p>
          </div>
        ) : (
          <div className="stack">
            {reports.map(report => (
              <div key={report.id} className="card card-pad" style={{ opacity: report.status === 'resolved' || report.status === 'dismissed' ? 0.6 : 1 }}>
                <div className="row-between row-wrap" style={{ gap: 'var(--s4)', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 'var(--s2)', marginBottom: 'var(--s1)' }}>
                      <span className={`tag ${report.status === 'open' ? 'tag-error' : 'tag-ok'}`}>
                        {report.status.toUpperCase()}
                      </span>
                      <span className="small strong capitalize">Reported {report.target_type}</span>
                      <span className="small dim">{formatDay(report.created_at)}</span>
                    </div>
                    
                    <div className="small" style={{ marginBottom: 'var(--s2)' }}>
                      <span className="dim">Reported by: </span>
                      <span className="strong">{report.reporter_name}</span> <span className="muted">({report.reporter_email})</span>
                    </div>

                    <div className="inset" style={{ marginBottom: 'var(--s3)', background: 'var(--surface-2)' }}>
                      <div className="small strong" style={{ marginBottom: 4 }}>Target Content:</div>
                      <p className="small muted">"{report.target_title}"</p>
                    </div>

                    <div className="small strong" style={{ marginBottom: 4 }}>Reason for report:</div>
                    <p className="small">{report.reason}</p>
                  </div>

                  {report.status === 'open' && (
                    <div className="row" style={{ gap: 'var(--s2)' }}>
                      <button 
                        className="btn btn-ghost btn-sm" 
                        onClick={() => resolveReport(report.id, 'dismissed')}
                        disabled={busyId === report.id}
                      >
                        Dismiss
                      </button>
                      <button 
                        className="btn btn-primary btn-sm"
                        onClick={() => resolveReport(report.id, 'resolved')}
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
          <div className="card empty">
            <span className="empty-icon"><Calendar size={18} /></span>
            <h3>No events match that search</h3>
            <p>Try a different organizer name, event title, or location.</p>
          </div>
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
