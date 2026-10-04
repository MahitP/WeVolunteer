import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, UserCheck, UserMinus, Users } from 'lucide-react';
import { api } from '../utils/api';
import { formatDay } from '../utils/helpers';
import ConfirmDialog from '../components/common/ConfirmDialog';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';

const MIN_REASON = 10;

/**
 * Approved organizers, and taking approval back (P2-12).
 *
 * The owner asked for a way to "make an approved organizer unapproved", with
 * records kept and only administrators able to do it. Revoking takes away the
 * ability to post new events. Their events stay, every volunteer's hours at
 * them stay, and the organizer can still record attendance for events already
 * run. A reason is required because it goes in the audit trail. Approving again
 * restores them.
 *
 * Its own page rather than a list on the dashboard, by the owner's rule for long
 * lists (FX-31); the dashboard's Organizer requests links here.
 */
export default function AdminOrganizers({ addToast }) {
  const [state, setState] = useState({ loading: true, organizers: [], error: '' });
  const [revoking, setRevoking] = useState(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    api.apiFetch('/api/admin/organizers/approved')
      .then(res => setState({ loading: false, organizers: res?.organizers ?? [], error: '' }))
      .catch(err => setState({ loading: false, organizers: [], error: err?.message || 'Organizers could not be loaded.' }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const revoke = async () => {
    const org = revoking;
    setBusyId(org.id);
    try {
      await api.apiFetch(`/api/admin/organizers/${org.id}/revoke`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      addToast?.(`${org.name} can no longer post new events.`, 'info');
      setRevoking(null);
      setReason('');
      load();
    } catch (err) {
      addToast?.(`Could not revoke: ${err.message}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (org) => {
    setBusyId(org.id);
    try {
      await api.apiFetch(`/api/admin/organizers/${org.id}/approve`, { method: 'POST' });
      addToast?.(`${org.name} can post events again.`, 'success');
      load();
    } catch (err) {
      addToast?.(`Could not restore: ${err.message}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page stack-lg">
      <div>
        <Link to="/#organizer-requests" className="btn btn-ghost btn-sm loggedhours-back">
          <ArrowLeft size={15} aria-hidden="true" /> Back to organizer requests
        </Link>
      </div>
      <div className="stack-xs">
        <h2 className="page-title">Approved organizers</h2>
        <p className="muted">
          Revoking approval stops an organizer posting new events. Their events, and the hours
          volunteers earned at them, stay on everybody&rsquo;s record.
        </p>
      </div>

      {state.loading && <LoadingSkeleton heights={[72, 72, 72]} className="stack-md" />}
      {!state.loading && state.error && <p className="small dim" role="status">{state.error}</p>}
      {!state.loading && !state.error && state.organizers.length === 0 && (
        <EmptyState icon={Users} title="No approved organizers yet" message="Organizers appear here once they are approved." />
      )}

      {state.organizers.length > 0 && (
        <ul className="list card">
          {state.organizers.map(org => (
            <li key={org.id} className="list-row">
              <div className="truncate s-49cdf8">
                <div className="person-name truncate">{org.name}</div>
                <div className="person-meta truncate">
                  {[org.school, `${org.events} event${org.events === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              {org.status === 'revoked' ? (
                <>
                  <span className="tag tag-warn">Approval revoked {formatDay(org.revokedAt)}</span>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busyId === org.id}
                    onClick={() => restore(org)} aria-label={`Restore approval for ${org.name}`}>
                    <UserCheck size={14} aria-hidden="true" /> Restore approval
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === org.id}
                  onClick={() => { setRevoking(org); setReason(''); }} aria-label={`Revoke approval for ${org.name}`}>
                  <UserMinus size={14} aria-hidden="true" /> Revoke approval
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}'s approval?`}
          destructive
          confirmLabel="Revoke approval"
          busy={busyId === revoking.id}
          busyLabel="Revoking…"
          confirmDisabled={reason.trim().length < MIN_REASON}
          onConfirm={revoke}
          onCancel={() => setRevoking(null)}
        >
          <p>
            They will not be able to post new events. Their past events and every volunteer&rsquo;s
            hours stay, and they can still record attendance for events already run. You can
            restore approval later.
          </p>
          <div className="field">
            <label htmlFor="revoke-reason">Why? <span className="muted">(kept in the audit trail)</span></label>
            <textarea id="revoke-reason" className="input" rows={3} maxLength={500}
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
