import React, { useState, useMemo, useEffect } from 'react';
import {
  Calendar, Eye, Pencil, Trash2, Search, Copy, Download, X,
  ShieldAlert, ArrowRight, Inbox, CalendarPlus, Lock, Unlock
} from 'lucide-react';
import { formatHours, formatDay, formatTimeRange, isoToLocalInput, countdown, gradeLabel } from '../utils/helpers';
import { api } from '../utils/api';
import Modal, { ModalHead } from '../components/Modal';
import { Seats, DateChip } from '../components/Seats';

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' }
];

export default function OrganizerDashboard({
  currentUser, events = [], applications = [], onStateChange, addToast,
  onViewDetails, onViewVolunteerProfile, setActiveTab
}) {
  const [tab, setTab] = useState('active');
  const [query, setQuery] = useState('');
  const [editingEvent, setEditingEvent] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchOrganizerStats().then(s => !cancelled && setStats(s)).catch(() => {});
    return () => { cancelled = true; };
  }, [currentUser.id, events.length, applications.length]);

  const hosted = useMemo(
    () => events.filter(e => e.organizerId === currentUser.id),
    [events, currentUser.id]
  );

  const appsForMe = useMemo(
    () => applications.filter(a => hosted.some(e => e.id === a.eventId)),
    [applications, hosted]
  );

  const pendingApps = appsForMe.filter(a => a.status === 'pending');
  const acceptedApps = appsForMe.filter(a => a.status === 'accepted');

  // Events needing attention, most urgent first — this is the organizer's
  // actual job, so it leads the page instead of a stat wall.
  const needsReview = useMemo(() => hosted
    .map(event => ({
      event,
      pending: pendingApps.filter(a => a.eventId === event.id).length
    }))
    .filter(x => x.pending > 0)
    .sort((a, b) => new Date(a.event.applicationDeadline) - new Date(b.event.applicationDeadline)),
    [hosted, pendingApps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = tab === 'completed'
      ? hosted.filter(e => e.status === 'completed')
      : hosted.filter(e => e.status !== 'completed' && e.status !== 'cancelled');
    return source
      .filter(e => !q || e.title.toLowerCase().includes(q) || e.location.toLowerCase().includes(q))
      .sort((a, b) => new Date(a.startDatetime) - new Date(b.startDatetime));
  }, [hosted, tab, query]);

  const uniqueVolunteers = new Set(acceptedApps.map(a => a.userId)).size;
  const hoursCredited = stats?.hoursAwarded ?? 0;

  /* ── Actions ─────────────────────────────────────────────── */

  const handleDelete = async (event) => {
    const signups = appsForMe.filter(a => a.eventId === event.id).length;
    const warning = signups > 0
      ? `\n\n${signups} volunteer sign-up${signups !== 1 ? 's' : ''} will be removed with it.`
      : '';
    if (!window.confirm(`Delete "${event.title}"?${warning}\n\nThis cannot be undone.`)) return;
    try {
      await api.deleteEvent(event.id);
      addToast(`"${event.title}" deleted.`, 'success');
      onStateChange();
    } catch (err) {
      addToast(`Could not delete: ${err.message}`, 'error');
    }
  };

  const handleToggleStatus = async (event) => {
    const next = event.status === 'open' ? 'closed' : 'open';
    try {
      await api.toggleEventStatus(event.id, next);
      addToast(next === 'open' ? 'Applications reopened.' : 'Applications closed.', 'success');
      onStateChange();
    } catch (err) {
      addToast(`Could not update: ${err.message}`, 'error');
    }
  };

  const handleDuplicate = async (event) => {
    try {
      await api.duplicateEvent(event.id);
      addToast(`Copied "${event.title}" with dates moved forward one week.`, 'success');
      onStateChange();
    } catch (err) {
      addToast(`Could not duplicate: ${err.message}`, 'error');
    }
  };

  const handleExport = async (event) => {
    try {
      const blob = await api.exportRosterCSV(event.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${event.title.replace(/[^a-z0-9]/gi, '_')}_roster.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast('Roster downloaded.', 'success');
    } catch (err) {
      addToast(`Could not export: ${err.message}`, 'error');
    }
  };

  const downloadRosterCSV = () => {
    const escCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const roster = rosterOf(acceptedApps);
    const rows = [
      ['Volunteer Name', 'Grade', 'Email', 'Shifts With You', 'Total Volunteered Hours'].map(escCell).join(','),
      ...roster.map(r => [
        r.name,
        gradeLabel(r.grade),
        r.volunteer?.email || '',
        r.shifts,
        Number(r.hours).toFixed(2)
      ].map(escCell).join(','))
    ].join('\n');

    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'sbvolunteers_roster_ledger.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addToast('Roster downloaded.', 'success');
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editForm.title?.trim()) {
      addToast('Give the event a name.', 'error');
      return;
    }
    try {
      await api.updateEvent(editingEvent.id, {
        title: editForm.title,
        description: editForm.description,
        category: editForm.category,
        location: editForm.location,
        applicationDeadline: new Date(editForm.applicationDeadline).toISOString(),
        autoApprove: editForm.autoApprove,
        slots: editingEvent.slots || []
      });
      addToast('Event updated.', 'success');
      setEditingEvent(null);
      onStateChange();
    } catch (err) {
      addToast(`Could not save: ${err.message}`, 'error');
    }
  };

  const startEdit = (event) => {
    setEditingEvent(event);
    setEditForm({
      title: event.title,
      category: event.category,
      description: event.description,
      location: event.location,
      applicationDeadline: isoToLocalInput(event.applicationDeadline),
      autoApprove: !!event.autoApprove
    });
  };

  /* ── Unverified organizers can't do anything yet ─────────── */
  if (!currentUser.verified) {
    return (
      <div className="card empty" style={{ maxWidth: 520, margin: '0 auto' }}>
        <span className="empty-icon" style={{ background: 'var(--warn-tint)', color: 'var(--warn)' }}>
          <ShieldAlert size={20} />
        </span>
        <h3>Your organizer account is awaiting approval</h3>
        <p>
          A school administrator needs to verify <span className="strong">{currentUser.email}</span> before
          you can post events. You can browse opportunities in the meantime.
        </p>
        <div className="alert alert-info" style={{ marginTop: 'var(--s4)', textAlign: 'left' }}>
          <span>
            <span className="alert-title">Testing the demo?</span>{' '}
            Switch to the System Admin account in the demo bar above to approve yourself.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      {/* ── What needs a decision ── */}
      {needsReview.length > 0 && (
        <section className="card" style={{ borderColor: 'var(--warn)', borderLeftWidth: 3 }}>
          <div className="card-body">
            <div className="row-between row-wrap" style={{ gap: 'var(--s3)' }}>
              <div>
                <div className="eyebrow" style={{ color: 'var(--warn)' }}>Needs your decision</div>
                <h2 style={{ marginTop: 2 }}>
                  {pendingApps.length} application{pendingApps.length !== 1 ? 's' : ''} waiting
                  {needsReview.length > 1 && ` across ${needsReview.length} events`}
                </h2>
              </div>
              <button className="btn btn-primary" onClick={() => onViewDetails(needsReview[0].event)}>
                Review {needsReview.length > 1 ? 'the closest deadline' : 'applications'} <ArrowRight size={15} />
              </button>
            </div>

            {needsReview.length > 1 && (
              <div className="list" style={{ marginTop: 'var(--s4)' }}>
                {needsReview.map(({ event, pending }) => (
                  <button key={event.id} className="list-row" style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => onViewDetails(event)}>
                    <DateChip iso={event.startDatetime} />
                    <span className="truncate" style={{ flex: 1 }}>
                      <span className="person-name truncate">{event.title}</span>
                      <span className="person-meta tnum">
                        Applications close {countdown(event.applicationDeadline).toLowerCase()}
                      </span>
                    </span>
                    <span className="tag tag-warn">{pending} pending</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Programme at a glance ── */}
      <section className="stats">
        <div className="stat">
          <div className="stat-label">Active events</div>
          <div className="stat-value">{hosted.filter(e => e.status === 'open' || e.status === 'closed').length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Volunteers confirmed</div>
          <div className="stat-value">{uniqueVolunteers}</div>
          <div className="stat-note">{acceptedApps.length} shift assignments</div>
        </div>
        <div className="stat">
          <div className="stat-label">Awaiting review</div>
          <div className="stat-value" style={{ color: pendingApps.length ? 'var(--warn)' : undefined }}>
            {pendingApps.length}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Hours credited</div>
          <div className="stat-value accent">{formatHours(hoursCredited)}</div>
        </div>
      </section>

      {/* ── Events ── */}
      <section>
        <div className="section-head">
          <h2>Your events</h2>
          <button className="btn btn-primary btn-sm section-action" onClick={() => setActiveTab('create')}>
            <CalendarPlus size={14} /> New event
          </button>
        </div>

        <div className="toolbar">
          <div className="segmented">
            {TABS.map(t => (
              <button key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="input-affix" style={{ maxWidth: 300 }}>
            <Search size={15} />
            <input
              type="search" className="input" placeholder="Find an event…"
              value={query} onChange={e => setQuery(e.target.value)}
              aria-label="Search your events"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="card empty">
            <span className="empty-icon"><Calendar size={18} /></span>
            <h3>{query ? 'No events match that search' : tab === 'completed' ? 'No completed events yet' : 'No active events'}</h3>
            <p>
              {query
                ? 'Try a different name or location.'
                : tab === 'completed'
                  ? 'Events move here once you take attendance.'
                  : 'Create a sign-up sheet and volunteers can start claiming shifts.'}
            </p>
            {!query && tab === 'active' && (
              <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('create')}>
                <CalendarPlus size={14} /> Create your first event
              </button>
            )}
          </div>
        ) : (
          <div className="tablewrap">
            <div className="tablescroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th style={{ minWidth: 160 }}>Sign-ups</th>
                    <th>Status</th>
                    <th className="cell-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(event => {
                    const evApps = appsForMe.filter(a => a.eventId === event.id);
                    const pending = evApps.filter(a => a.status === 'pending').length;
                    const accepted = evApps.filter(a => a.status === 'accepted').length;
                    const closed = event.status === 'closed' ||
                      new Date() > new Date(event.applicationDeadline);

                    return (
                      <tr key={event.id}>
                        <td>
                          <div className="cell-title truncate" style={{ maxWidth: 280 }}>{event.title}</div>
                          <div className="small dim truncate" style={{ maxWidth: 280 }}>
                            {event.category} · {event.location}
                          </div>
                        </td>
                        <td className="tnum">
                          <div className="small strong">{formatDay(event.startDatetime)}</div>
                          <div className="small dim">
                            {formatTimeRange(event.startDatetime, event.endDatetime)}
                          </div>
                        </td>
                        <td>
                          <Seats filled={accepted} total={event.maxSpots} />
                          {pending > 0 && (
                            <button
                              className="tag tag-warn"
                              style={{ marginTop: 6, cursor: 'pointer' }}
                              onClick={() => onViewDetails(event)}
                            >
                              {pending} to review
                            </button>
                          )}
                        </td>
                        <td>
                          {event.status === 'completed' ? (
                            <span className="status status-muted">Completed</span>
                          ) : closed ? (
                            <span className="status status-muted">Closed</span>
                          ) : (
                            <span className="status status-ok">Open</span>
                          )}
                        </td>
                        <td className="cell-actions">
                          <div className="row" style={{ gap: 2 }}>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Open event"
                              onClick={() => onViewDetails(event)}>
                              <Eye size={14} />
                            </button>
                            {event.status !== 'completed' && (
                              <>
                                <button className="btn btn-ghost btn-sm btn-icon" title="Edit details"
                                  onClick={() => startEdit(event)}>
                                  <Pencil size={14} />
                                </button>
                                <button
                                  className="btn btn-ghost btn-sm btn-icon"
                                  title={event.status === 'open' ? 'Close sign-ups' : 'Reopen sign-ups'}
                                  onClick={() => handleToggleStatus(event)}
                                >
                                  {event.status === 'open' ? <Lock size={14} /> : <Unlock size={14} />}
                                </button>
                              </>
                            )}
                            <button className="btn btn-ghost btn-sm btn-icon" title="Duplicate, one week later"
                              onClick={() => handleDuplicate(event)}>
                              <Copy size={14} />
                            </button>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Download roster as CSV"
                              onClick={() => handleExport(event)}>
                              <Download size={14} />
                            </button>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Delete event"
                              style={{ color: 'var(--danger)' }}
                              onClick={() => handleDelete(event)}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ── Volunteer roster ── */}
      <section>
        <div className="section-head">
          <h2>Your volunteers</h2>
          {acceptedApps.length > 0 && (
            <button className="btn btn-secondary btn-sm section-action" onClick={downloadRosterCSV}>
              <Download size={14} /> Download ledger
            </button>
          )}
        </div>
        {acceptedApps.length === 0 ? (
          <div className="card empty">
            <span className="empty-icon"><Inbox size={18} /></span>
            <h3>No confirmed volunteers yet</h3>
            <p>Once you confirm applications, the people helping at your events show up here.</p>
          </div>
        ) : (
          <div className="list">
            {rosterOf(acceptedApps).map(person => (
              <div key={person.id} className="list-row">
                <span className="avatar">{person.avatar || '👤'}</span>
                <div className="truncate" style={{ flex: 1 }}>
                  <div className="person-name truncate">{person.name}</div>
                  <div className="person-meta truncate">
                    {[gradeLabel(person.grade), `${person.shifts} shift${person.shifts !== 1 ? 's' : ''} with you`]
                      .filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className={`hourspill ${!person.hours ? 'zero' : ''}`}>
                  {formatHours(person.hours)} <span>total</span>
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => onViewVolunteerProfile(person.volunteer)}>
                  Profile
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Quick edit ── */}
      {editingEvent && (
        <Modal onClose={() => setEditingEvent(null)} label="Edit event">
          <ModalHead
            title="Edit event"
            description="Shifts and times are edited on the event's sign-up sheet."
            onClose={() => setEditingEvent(null)}
          />

            <form id="quick-edit" className="modal-body" onSubmit={saveEdit}>
              <div className="field">
                <label htmlFor="qe-title">Event name</label>
                <input id="qe-title" className="input" value={editForm.title || ''}
                  onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="qe-cat">Category</label>
                  <select id="qe-cat" className="select" value={editForm.category || 'School'}
                    onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}>
                    <option value="School">School project</option>
                    <option value="5K">5K run / athletics</option>
                    <option value="Food Pantry">Food pantry</option>
                    <option value="Fundraiser">Fundraiser</option>
                    <option value="Other">Other community service</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="qe-deadline">Applications close</label>
                  <input id="qe-deadline" type="datetime-local" className="input"
                    value={editForm.applicationDeadline || ''}
                    onChange={e => setEditForm(f => ({ ...f, applicationDeadline: e.target.value }))} />
                </div>
              </div>

              <div className="field">
                <label htmlFor="qe-loc">Location</label>
                <input id="qe-loc" className="input" value={editForm.location || ''}
                  onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} />
              </div>

              <div className="field">
                <label htmlFor="qe-desc">What volunteers need to know</label>
                <textarea id="qe-desc" className="textarea" value={editForm.description || ''}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
              </div>

              {/* Mirrors the wording on the create form exactly — the same
                  choice must not be described two different ways. */}
              <div className="field">
                <span className="label">Selection method</span>
                <div className="stack-sm">
                  <label className="check" data-checked={!editForm.autoApprove ? 'true' : 'false'}>
                    <input
                      type="radio" name="edit-selection" checked={!editForm.autoApprove}
                      onChange={() => setEditForm(f => ({ ...f, autoApprove: false }))}
                    />
                    <span>
                      <span className="check-title">Manual review</span>
                      <span className="check-desc">
                        You review applicants after the deadline and choose who is accepted, waitlisted, or rejected.
                      </span>
                    </span>
                  </label>
                  <label className="check" data-checked={editForm.autoApprove ? 'true' : 'false'}>
                    <input
                      type="radio" name="edit-selection" checked={!!editForm.autoApprove}
                      onChange={() => setEditForm(f => ({ ...f, autoApprove: true }))}
                    />
                    <span>
                      <span className="check-title">Auto Select</span>
                      <span className="check-desc">
                        After the deadline the system picks volunteers automatically, giving those with fewer hours a better chance while keeping everyone eligible.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </form>

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setEditingEvent(null)}>Cancel</button>
            <button className="btn btn-primary" type="submit" form="quick-edit">Save changes</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Collapse shift assignments into one row per person. */
function rosterOf(acceptedApps) {
  const byUser = new Map();
  for (const app of acceptedApps) {
    const existing = byUser.get(app.userId);
    if (existing) {
      existing.shifts += 1;
    } else {
      byUser.set(app.userId, {
        id: app.userId,
        name: app.volunteer?.name,
        avatar: app.volunteer?.avatar,
        grade: app.volunteer?.grade,
        hours: app.volunteer?.volunteeredHours || 0,
        shifts: 1,
        volunteer: app.volunteer
      });
    }
  }
  return [...byUser.values()].sort((a, b) => b.hours - a.hours);
}
