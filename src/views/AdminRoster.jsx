import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { Link } from 'react-router-dom';
import { Shield, Activity, User, Crown, AlertTriangle, X, Download } from 'lucide-react';

import { ROLE, can } from '../authz';
import { useStepUp } from '../components/auth/useStepUp';
import { STEP_UP } from '../utils/stepUp';
import { useModal } from '../utils/useModal';

import LoadingSkeleton from '../components/common/LoadingSkeleton';
import PendingInvitations from '../components/admin/PendingInvitations';

const formatDate = (iso) => new Date(iso).toLocaleDateString();


function PromoteAdminModal({ onCancel, onPromote }) {
  const dialogRef = useModal(onCancel);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleLookup = async (e) => {
    e.preventDefault();
    setError(null);
    setUser(null);
    setLoading(true);
    try {
      const u = await api.lookupUserByEmail(email);
      /**
       * Role names come from `ROLE`, never from literals — the completeness
       * guard fails the build on the literal spelling, and the reason is that a
       * mistyped role string is a silent deny rather than an error.
       *
       * These two checks are UX only. The server re-decides both in
       * `POST /api/admin/users/:id/promote`, which is the actual boundary; this
       * just tells the operator immediately rather than after a round trip.
       */
      if (u.role === ROLE.ADMIN || u.role === ROLE.SUPER_ADMIN) {
        throw new Error('User is already an administrator.');
      }
      if (u.role !== ROLE.STUDENT) {
        throw new Error('Only students can be promoted to administrator.');
      }
      setUser(u);
    } catch (err) {
      setError(err.message || 'Failed to lookup user');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!user || !reason.trim()) return;
    onPromote(user.id, reason);
  };

  return (
    <div className="modal-overlay">
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="promote-title" style={{ maxWidth: '420px' }}>
        <div className="modal-head">
          <h2 id="promote-title">Promote Administrator</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body stack-md">
          <p className="muted">
            Promoting a user grants them broad access to platform data and the ability to act on reports.
          </p>

          {!user ? (
            <form onSubmit={handleLookup} className="stack">
              <div className="field">
                <label htmlFor="emailInput">User Email</label>
                <input
                  id="emailInput"
                  type="email"
                  className="input"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="student@example.com"
                  required
                />
              </div>
              {error && <div className="text-danger" style={{ fontSize: '0.875rem' }}>{error}</div>}
              <div className="modal-foot">
                <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={loading || !email}>
                  {loading ? 'Searching...' : 'Lookup User'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="stack">
              <div className="card" style={{ padding: 'var(--s3)', background: 'var(--surface-2)' }}>
                <div className="row">
                  <span className="avatar">{user.avatar || <User size={16} />}</span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{user.name}</div>
                    <div className="muted" style={{ fontSize: '0.875rem' }}>{user.email}</div>
                  </div>
                </div>
              </div>

              <div className="field">
                <label htmlFor="reasonInput">Reason for Promotion</label>
                <textarea
                  id="reasonInput"
                  className="input"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Elected to executive board for 2026-2027"
                  rows={3}
                  required
                />
                <div className="muted" style={{ fontSize: '0.75rem', marginTop: '4px' }}>
                  This reason is recorded in the audit log and cannot be changed.
                </div>
              </div>

              <div className="modal-foot">
                <button type="button" className="btn btn-secondary" onClick={() => setUser(null)}>Back</button>
                <button type="submit" className="btn btn-primary" disabled={!reason.trim()}>
                  Promote to Administrator
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function RevokeAdminModal({ admin, onCancel, onRevoke }) {
  const dialogRef = useModal(onCancel);
  const [confirmText, setConfirmText] = useState('');
  
  const expectedText = admin?.name || 'Revoke';

  const handleSubmit = (e) => {
    e.preventDefault();
    if (confirmText !== expectedText) return;
    onRevoke(admin.id);
  };

  if (!admin) return null;

  return (
    <div className="modal-overlay">
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="revoke-title" style={{ maxWidth: '420px' }}>
        <div className="modal-head">
          <h2 id="revoke-title">Revoke Administrator</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body stack-md">
          <div className="alert alert-warn" style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>Warning: </strong>
              Revoking administrative access takes effect immediately.
              They will be unassigned from any open reports or appeals.
            </div>
          </div>

          <p>
            You are about to revoke access for <strong>{admin.name}</strong> ({admin.email}).
          </p>

          <div className="field">
            <label htmlFor="confirmInput">
              Type <strong>{expectedText}</strong> to confirm
            </label>
            <input
              id="confirmInput"
              type="text"
              className="input"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder={expectedText}
              required
            />
          </div>

          <div className="modal-foot">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button 
              type="submit" 
              className="btn btn-danger" 
              disabled={confirmText !== expectedText}
            >
              Revoke Access
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminRoster({ currentUser }) {
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);

  const [promoting, setPromoting] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [feedback, setFeedback] = useState(null);
  /* With the other state rather than beside the handler below: that handler is
     defined after the loading and error early-returns, so a hook there is
     called conditionally. oxlint's react-hooks rule catches it. */
  const [exporting, setExporting] = useState(false);
  
  const { run, modal: stepUpModal } = useStepUp();

  const showFeedback = (type, message) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 5000);
  };

  const handlePromote = async (userId, reason) => {
    try {
      await run(
        STEP_UP.ADMIN_PROMOTE,
        { targetUserId: userId },
        (headers) => api.promoteAdmin(userId, reason, headers)
      );
      setPromoting(false);
      showFeedback('success', 'Administrator promoted successfully');
      // Refresh roster
      const updated = await api.fetchAdminRoster();
      setAdmins(updated);
    } catch (err) {
      if (err?.data?.code !== 'reauth_required') {
        showFeedback('error', err.message || 'Failed to promote administrator');
      }
    }
  };

  const handleRevoke = async (userId) => {
    try {
      await run(
        STEP_UP.ADMIN_REVOKE,
        { targetUserId: userId },
        (headers) => api.revokeAdmin(userId, headers)
      );
      setRevoking(null);
      showFeedback('success', 'Administrative access revoked');
      // Refresh roster
      const updated = await api.fetchAdminRoster();
      setAdmins(updated);
    } catch (err) {
      if (err?.data?.code !== 'reauth_required') {
        showFeedback('error', err.message || 'Failed to revoke administrator');
      }
    }
  };


  useEffect(() => {
    api.fetchAdminRoster()
      .then(setAdmins)
      .catch(err => setError(err.message || 'Failed to load roster'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h2 className="page-title">Administrator Roster</h2>
          </div>
        </header>
        <div className="stack">
          <LoadingSkeleton rows={5} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h2 className="page-title">Administrator Roster</h2>
          </div>
        </header>
        <div className="stack">
          <div className="empty-state">
            <AlertTriangle className="empty-icon" size={48} />
            <h3>Failed to Load Roster</h3>
            <p className="muted">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  /**
   * Download the STUDENT roster — every active student, with contact details.
   *
   * ── Why this control exists here ──
   *
   * `GET /api/admin/reports/export` had no user interface at all, so the only
   * way to run it was curl. It also used to be gated on `report.resolve`, which
   * means "resolve the safety reports people file" — so the capability to
   * review one report granted a bulk download of every child's email address.
   * It is `roster.export` now, SUPER_ONLY and ungrantable; see the note in
   * `server/authz.js`.
   *
   * On this page because this is where a roster already lives, and because the
   * page is already the owner's. Not on the Admin hub as a tile: a tile is a
   * destination, and this is an action.
   */
  const exportStudents = async () => {
    setExporting(true);
    try {
      const blob = await api.exportStudentRosterCSV();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'WeVolunteer_students.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showFeedback('success', 'Student roster downloaded. The export is recorded in the audit trail.');
    } catch (err) {
      showFeedback('error', `Could not export the roster: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h2 className="page-title">Administrator Roster</h2>
          <p className="muted">Platform administrators and their effective capabilities</p>
        </div>
        <div className="row row-wrap">
          {/* Gated on the capability the endpoint requires rather than on this
              page's own. Both are SUPER_ONLY today, so the sets are identical —
              but coupling one capability's membership to another is how a
              button comes to appear for somebody the server then refuses. */}
          {can(currentUser, 'roster.export') && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={exportStudents}
              disabled={exporting}
            >
              <Download size={16} aria-hidden="true" />
              {exporting ? ' Preparing…' : ' Export students (CSV)'}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setPromoting(true)}>
            Promote Administrator
          </button>
        </div>

      </header>

      <div className="stack">
        {stepUpModal}
        {promoting && (
          <PromoteAdminModal
            onCancel={() => setPromoting(false)}
            onPromote={handlePromote}
          />
        )}
        {revoking && (
          <RevokeAdminModal
            admin={revoking}
            onCancel={() => setRevoking(null)}
            onRevoke={handleRevoke}
          />
        )}

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Identity</th>
                  <th>Role</th>
                  <th>Last Sign-In</th>
                  <th>30-Day Activity</th>
                  <th className="cell-actions">Details</th>
                </tr>
              </thead>
              <tbody>
                {admins.map(admin => {
                  const isExpanded = expandedRow === admin.id;

                  return (
                    <React.Fragment key={admin.id}>
                      <tr style={{ borderBottom: isExpanded ? 'none' : '' }}>
                        <td className="cell-title">
                          <div className="row">
                            <span className="avatar">
                              {admin.avatar || <User size={16} />}
                            </span>
                            <div>
                              <div>{admin.name}</div>
                              <div className="muted" style={{ fontSize: '0.75rem' }}>{admin.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          {admin.isOwner ? (
                            <div className="badge">
                              <Crown size={12} style={{ marginRight: '4px' }} /> Owner
                            </div>
                          ) : (
                            <div className="badge">Administrator</div>
                          )}
                        </td>
                        <td>
                          {admin.lastSignInAt ? formatDate(admin.lastSignInAt) : 'Never'}
                        </td>
                        <td>
                          {/* Two bare icons and two numbers said nothing to
                              anyone who could not see them — `title` is a hover
                              affordance, not an accessible name, so a screen
                              reader announced "1 2" and a mouse was the only way
                              to learn which was which. The visible text stays
                              compact; the name spells it out. */}
                          <div className="row">
                            <span title="Decisions made (last 30 days)">
                              <Shield size={14} className="muted" style={{ marginRight: '4px' }} aria-hidden="true" />
                              <span aria-label={`${admin.decisionCount} decisions in the last 30 days`}>
                                {admin.decisionCount}
                              </span>
                            </span>
                            <span title="Evidence reviewed (last 30 days)" style={{ marginLeft: 'var(--s3)' }}>
                              <Activity size={14} className="muted" style={{ marginRight: '4px' }} aria-hidden="true" />
                              <span aria-label={`${admin.evidenceReadCount} evidence reads in the last 30 days`}>
                                {admin.evidenceReadCount}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="cell-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setExpandedRow(isExpanded ? null : admin.id)}
                          >
                            {isExpanded ? 'Hide Capabilities' : 'View Capabilities'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: 'var(--surface-2)' }}>
                          <td colSpan="5" style={{ padding: 'var(--s4)' }}>
                            <div className="stack-md" style={{ maxWidth: '600px' }}>
                              
                              <div className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                                <div>
                                  <h4 style={{ margin: '0 0 var(--s2) 0', fontSize: '0.875rem' }}>Promotion Metadata</h4>
                                  {admin.promotedAt ? (
                                    <ul className="muted" style={{ margin: 0, paddingLeft: 'var(--s4)', fontSize: '0.8125rem' }}>
                                      <li>Promoted: {formatDate(admin.promotedAt)}</li>
                                      <li>By: {admin.promotedBy}</li>
                                      <li>Reason: {admin.promotionReason}</li>
                                    </ul>
                                  ) : (
                                    <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
                                      Promoted prior to metadata tracking.
                                    </p>
                                  )}
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  <Link
                                    to={`/admin/audit-logs?adminId=${admin.id}`}
                                    className="btn btn-primary btn-sm"
                                  >
                                    View Audit Trail
                                  </Link>
                                  {!admin.isOwner && (
                                    <button 
                                      type="button" 
                                      className="btn btn-danger btn-sm"
                                      onClick={() => setRevoking(admin)}
                                      style={{ marginLeft: 'var(--s2)' }}
                                    >
                                      Revoke
                                    </button>
                                  )}

                                </div>
                              </div>

                              <div>
                                <h4 style={{ margin: '0 0 var(--s2) 0', fontSize: '0.875rem' }}>Effective Capabilities</h4>
                                <div className="row" style={{ flexWrap: 'wrap' }}>
                                  {admin.capabilities.length === 0 ? (
                                    <span className="muted" style={{ fontSize: '0.8125rem' }}>None</span>
                                  ) : (
                                    admin.capabilities.map(cap => (
                                      <span key={cap} className="badge badge-subtle">{cap}</span>
                                    ))
                                  )}
                                </div>
                                {(admin.grants?.length > 0 || admin.withholdings?.length > 0) && (
                                  <div style={{ marginTop: 'var(--s2)', fontSize: '0.8125rem' }} className="muted">
                                    {admin.grants?.length > 0 && <div>+ Explicit grants: {admin.grants.join(', ')}</div>}
                                    {admin.withholdings?.length > 0 && <div>- Withholdings: {admin.withholdings.join(', ')}</div>}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Beside the roster rather than on its own page: a pending invitation is
            a future row in the table above, and an owner asking "who has
            administrative access" should not have to check two screens to learn
            who is about to. */}
        <PendingInvitations addToast={showFeedback ? (m, t) => showFeedback(t, m) : undefined} />
      </div>
    </div>
  );
}
