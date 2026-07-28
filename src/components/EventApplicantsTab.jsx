import React from 'react';
import { Check, Clock4 } from 'lucide-react';
import { formatHours, gradeLabel } from '../utils/helpers';
import ApplicantReview from './ApplicantReview';

export default function EventApplicantsTab({
  event,
  eventApps,
  pendingApps,
  acceptedApps,
  waitlistApps,
  signupsClosed,
  selectionRuns,
  runsLoading,
  submitting,
  handleRunAutoSelect,
  handleConfirmAutoSelect,
  onViewVolunteerProfile,
  decide,
  bulkDecide
}) {
  return (
    <div className="tabpanel-content">
      {/* Case 1: Selection is confirmed (Selection summary exists) */}
      {event.selectionSummary ? (
        <>
          <div className="card" style={{ padding: 'var(--s4)', background: 'var(--surface-3)', border: '1px solid var(--rule)', borderRadius: 8, marginBottom: 'var(--s4)' }}>
            <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink)' }}>Selection Run Summary</h4>
            <p className="small dim" style={{ margin: '4px 0 12px 0' }}>
              Completed on {new Date(event.selectionSummary.timestamp).toLocaleString()}
            </p>
            <div className="row row-wrap" style={{ gap: 'var(--s4)' }}>
              <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                <span className="small dim">Total Applicants</span>
                <strong className="large">{event.selectionSummary.totalApplicants}</strong>
              </div>
              <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                <span className="small dim">Accepted</span>
                <strong className="large text-ok">{event.selectionSummary.acceptedVolunteers}</strong>
              </div>
              <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                <span className="small dim">Waitlisted</span>
                <strong className="large text-warn">{event.selectionSummary.waitlistedVolunteers}</strong>
              </div>
              <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                <span className="small dim">Avg. Hours (Accepted)</span>
                <strong className="large">{event.selectionSummary.avgAcceptedHours} hrs</strong>
              </div>
              <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                <span className="small dim">Avg. Hours (Waitlisted)</span>
                <strong className="large">{event.selectionSummary.avgWaitlistedHours} hrs</strong>
              </div>
            </div>
          </div>

          <section>
            <div className="section-head">
              <h3>Final Accepted Volunteers</h3>
              {acceptedApps.length > 0 && <span className="section-action tag tag-ok">{acceptedApps.length}</span>}
            </div>
            {acceptedApps.length === 0 ? (
              <div className="card empty">
                <p>No volunteers were accepted.</p>
              </div>
            ) : (
              <div className="list">
                {acceptedApps.map(app => (
                  <div key={app.id} className="list-row">
                    <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                      <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                      <span className="truncate">
                        <span className="person-name truncate">{app.volunteer?.name}</span>
                        <span className="person-meta truncate">
                          {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                    <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                      {formatHours(app.volunteer?.volunteeredHours)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="section-head">
              <h3>Waitlist Order</h3>
              {waitlistApps.length > 0 && <span className="section-action tag tag-warn">{waitlistApps.length}</span>}
            </div>
            {waitlistApps.length === 0 ? (
              <div className="card empty">
                <p>Waitlist is empty.</p>
              </div>
            ) : (
              <div className="list">
                {[...waitlistApps]
                  .sort((a, b) => (a.waitlistOrder || 999) - (b.waitlistOrder || 999))
                  .map((app, index) => (
                    <div key={app.id} className="list-row">
                      <span className="small badge" style={{ marginRight: 8, background: 'var(--rule)', color: 'var(--ink-2)', padding: '2px 6px', borderRadius: 4 }}>
                        #{app.waitlistOrder || (index + 1)}
                      </span>
                      <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                        <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                        <span className="truncate">
                          <span className="person-name truncate">{app.volunteer?.name}</span>
                          <span className="person-meta truncate">
                            {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                      <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                        {formatHours(app.volunteer?.volunteeredHours)}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          {/* Case 2: Before deadline */}
          {!signupsClosed ? (
            <section>
              <div className="section-head">
                <h3>Applicants so far</h3>
                {pendingApps.length > 0 && <span className="section-action tag tag-warn">{pendingApps.length}</span>}
              </div>
              <p className="small dim" style={{ marginTop: -8, marginBottom: 'var(--s3)' }}>
                Selection will be available manually once the application deadline is reached ({new Date(event.applicationDeadline).toLocaleString()}).
              </p>
              <ApplicantReview
                applications={pendingApps}
                onViewVolunteer={onViewVolunteerProfile}
                busy={submitting}
                onBulkDecide={bulkDecide}
              />
            </section>
          ) : (
            <>
              {/* Case 3: After deadline, selection NOT confirmed */}
              {runsLoading && selectionRuns.length === 0 ? (
                <div className="stack-sm" style={{ marginBottom: 'var(--s4)' }}>
                  <div className="skeleton skeleton-row" />
                  <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                </div>
              ) : selectionRuns.length === 0 ? (
                <div className="card" style={{ padding: 'var(--s4)', textAlign: 'center', background: 'var(--surface-3)', border: '1px solid var(--rule)', borderRadius: 8, marginBottom: 'var(--s4)' }}>
                  <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Applications Closed – Auto Select Ready</h3>
                  <p className="small dim" style={{ margin: 'var(--s2) 0 var(--s4) 0' }}>
                    The application deadline has passed. You can now run the weighted selection.
                  </p>
                  <button className="btn btn-primary" onClick={handleRunAutoSelect} disabled={submitting}>
                    {submitting ? 'Running…' : 'Run Auto Select'}
                  </button>
                </div>
              ) : (
                <>
                  {/* Case 4: Preview screen of the latest draft run */}
                  {(() => {
                    const latestDraft = selectionRuns[selectionRuns.length - 1];
                    const previewSelectedApps = eventApps.filter(a => latestDraft.selectedIds.includes(a.id));
                    const previewWaitlistApps = eventApps.filter(a => latestDraft.waitlistIds.includes(a.id));

                    const totalSelectedHours = previewSelectedApps.reduce((sum, a) => sum + (a.volunteer?.volunteeredHours || 0), 0);
                    const totalWaitlistHours = previewWaitlistApps.reduce((sum, a) => sum + (a.volunteer?.volunteeredHours || 0), 0);

                    const avgSelectedHrs = previewSelectedApps.length > 0 ? (totalSelectedHours / previewSelectedApps.length).toFixed(1) : '0';
                    const avgWaitlistHrs = previewWaitlistApps.length > 0 ? (totalWaitlistHours / previewWaitlistApps.length).toFixed(1) : '0';

                    return (
                      <>
                        <div className="card" style={{ padding: 'var(--s4)', background: 'var(--surface-3)', border: '1px solid var(--rule)', borderRadius: 8, marginBottom: 'var(--s4)' }}>
                          <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink)' }}>Auto Select Results (Preview)</h4>
                          <p className="small dim" style={{ margin: '4px 0 12px 0' }}>
                            Generated draft Run #{latestDraft.runNumber} on {new Date(latestDraft.createdAt).toLocaleTimeString()}
                          </p>
                          <div className="row row-wrap" style={{ gap: 'var(--s4)', marginBottom: 'var(--s4)' }}>
                            <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                              <span className="small dim">Applicants</span>
                              <strong className="large">{previewSelectedApps.length + previewWaitlistApps.length}</strong>
                            </div>
                            <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                              <span className="small dim">Accepted</span>
                              <strong className="large text-ok">{previewSelectedApps.length}</strong>
                            </div>
                            <div className="stack-xs" style={{ flex: 1, minWidth: 100 }}>
                              <span className="small dim">Waitlisted</span>
                              <strong className="large text-warn">{previewWaitlistApps.length}</strong>
                            </div>
                            <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                              <span className="small dim">Avg. Hours (Accepted)</span>
                              <strong className="large">{avgSelectedHrs} hrs</strong>
                            </div>
                            <div className="stack-xs" style={{ flex: 1.5, minWidth: 150 }}>
                              <span className="small dim">Avg. Hours (Waitlisted)</span>
                              <strong className="large">{avgWaitlistHrs} hrs</strong>
                            </div>
                          </div>

                          <div className="row" style={{ gap: 12 }}>
                            <button className="btn btn-secondary" onClick={handleRunAutoSelect} disabled={submitting}>
                              Run Again
                            </button>
                            <button className="btn btn-primary" onClick={handleConfirmAutoSelect} disabled={submitting}>
                              Confirm Results
                            </button>
                          </div>
                        </div>

                        <section>
                          <div className="section-head">
                            <h3>Accepted Volunteers (Preview)</h3>
                            {previewSelectedApps.length > 0 && <span className="section-action tag tag-ok">{previewSelectedApps.length}</span>}
                          </div>
                          {previewSelectedApps.length === 0 ? (
                            <div className="card empty"><p>No volunteers selected.</p></div>
                          ) : (
                            <div className="list">
                              {previewSelectedApps.map(app => (
                                <div key={app.id} className="list-row">
                                  <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                    <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                    <span className="truncate">
                                      <span className="person-name truncate">{app.volunteer?.name}</span>
                                      <span className="person-meta truncate">
                                        {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                      </span>
                                    </span>
                                  </button>
                                  <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                    {formatHours(app.volunteer?.volunteeredHours)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </section>

                        <section>
                          <div className="section-head">
                            <h3>Waitlist Order (Preview)</h3>
                            {previewWaitlistApps.length > 0 && <span className="section-action tag tag-warn">{previewWaitlistApps.length}</span>}
                          </div>
                          {previewWaitlistApps.length === 0 ? (
                            <div className="card empty"><p>Waitlist is empty.</p></div>
                          ) : (
                            <div className="list">
                              {latestDraft.waitlistIds.map((id, idx) => {
                                const app = previewWaitlistApps.find(a => a.id === id);
                                if (!app) return null;
                                return (
                                  <div key={app.id} className="list-row">
                                    <span className="small badge" style={{ marginRight: 8, background: 'var(--rule)', color: 'var(--ink-2)', padding: '2px 6px', borderRadius: 4 }}>
                                      #{idx + 1}
                                    </span>
                                    <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                                      <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                                      <span className="truncate">
                                        <span className="person-name truncate">{app.volunteer?.name}</span>
                                        <span className="person-meta truncate">
                                          {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                                        </span>
                                      </span>
                                    </button>
                                    <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                                      {formatHours(app.volunteer?.volunteeredHours)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      </>
                    );
                  })()}
                </>
              )}

              {/* Before running selection, show the pending applicants list for review */}
              {selectionRuns.length === 0 && (
                <section>
                  <div className="section-head">
                    <h3>Applicants to Review</h3>
                    {pendingApps.length > 0 && <span className="section-action tag tag-warn">{pendingApps.length}</span>}
                  </div>
                  <ApplicantReview
                    applications={pendingApps}
                    onViewVolunteer={onViewVolunteerProfile}
                    busy={submitting}
                  />
                </section>
              )}
            </>
          )}
        </>
      )}

      {/* Persistent Audit Log History for Organizers/Admins */}
      {selectionRuns.length > 0 && (
        <section style={{ marginTop: 'var(--s4)' }}>
          <div className="card" style={{ padding: 'var(--s3) var(--s4)', background: 'var(--surface-3)', border: '1px solid var(--rule)', borderRadius: 8 }}>
            <h4 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-2)' }}>Audit Log History</h4>
            <div className="stack-xs" style={{ marginTop: 8 }}>
              {selectionRuns.map(run => (
                <div key={run.id} className="small dim stack-xs" style={{ padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
                  <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <span style={{ color: run.isConfirmed ? 'var(--ok)' : 'inherit', fontWeight: run.isConfirmed ? 600 : 'normal' }}>
                      {run.isConfirmed ? 'Confirmed Run ' : 'Run '}#{run.runNumber}
                    </span>
                    <span>{new Date(run.createdAt).toLocaleString()}</span>
                  </div>
                  {run.reason && (
                    <div style={{ color: 'var(--ink-2)', fontStyle: 'italic', paddingLeft: 8, borderLeft: '2px solid var(--rule)' }}>
                      Reason: {run.reason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* When waitlist exists, allow accepting them */}
      {waitlistApps.length > 0 && (
        <section>
          <div className="section-head">
            <h3>Waitlist</h3>
            <span className="section-action small dim">{waitlistApps.length}</span>
          </div>
          <p className="small muted" style={{ marginTop: -8, marginBottom: 'var(--s3)' }}>
            These volunteers are next in line. Accept one if a spot opens up.
          </p>
          <div className="list">
            {waitlistApps.map(app => (
              <div key={app.id} className="list-row">
                <button className="person" onClick={() => onViewVolunteerProfile(app.volunteer)}>
                  <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                  <span className="truncate">
                    <span className="person-name truncate">{app.volunteer?.name}</span>
                    <span className="person-meta truncate">
                      {[gradeLabel(app.volunteer?.grade), app.slot?.name].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                <span className={`hourspill ${!app.volunteer?.volunteeredHours ? 'zero' : ''}`}>
                  {formatHours(app.volunteer?.volunteeredHours)}
                </span>
                <div className="row" style={{ gap: 4, marginLeft: 'auto' }}>
                  <button className="btn btn-primary btn-sm" disabled={submitting}
                    onClick={() => decide(app.id, app.volunteer?.name, 'accepted')}>
                    <Check size={13} /> Accept
                  </button>
                  <button className="btn btn-danger btn-sm btn-icon" title="Reject" disabled={submitting}
                    onClick={() => decide(app.id, app.volunteer?.name, 'rejected')}>
                    <Clock4 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
