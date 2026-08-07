import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { Shield, Search, ChevronLeft, ChevronRight, Activity, Filter, FileText } from 'lucide-react';
import { useModal } from '../utils/useModal';

const formatDateShort = (iso) => new Date(iso).toLocaleDateString();
const formatDateTime = (iso) => new Date(iso).toLocaleString();

const LOG_ACTIONS = [
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_WARNED',
  'ACCOUNT_UNSUSPENDED',
  'OWNER_BOOTSTRAPPED',
  'OWNER_RETIRED',
  'OWNER_CREDENTIAL_RESET',
  'ORGANIZER_APPROVED',
  'ORGANIZER_DENIED',
  'APPEAL_TOKEN_ISSUED'
];

function AuditDetailModal({ log, onClose }) {
  const dialogRef = useModal(onClose);
  if (!log) return null;

  return (
    <div className="modal-overlay">
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>Audit Record: {log.id}</h2>
        </div>
        <div className="modal-body stack-md">
          <div className="form-group">
            <label>Action</label>
            <div><strong>{log.action}</strong></div>
          </div>
          <div className="form-group">
            <label>Timestamp</label>
            <div>{formatDateTime(log.created_at)}</div>
          </div>
          <div className="form-group">
            <label>Actor (Admin)</label>
            <div>{log.admin_name} <code style={{ marginLeft: '4px' }}>({log.admin_id})</code></div>
          </div>
          {log.target_user_id && (
            <div className="form-group">
              <label>Target User</label>
              <div>{log.target_user_name} <code style={{ marginLeft: '4px' }}>({log.target_user_id})</code></div>
            </div>
          )}
          <div className="form-group">
            <label>Details</label>
            <pre style={{ whiteSpace: 'pre-wrap', padding: '12px', background: 'var(--surface-2)', borderRadius: '4px' }}>
              {log.details || 'No details provided.'}
            </pre>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function AdminAuditExplorer() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);

  /**
   * `filters` is the APPLIED query — changing it is what fetches.
   *
   * The search box is deliberately not part of it. Every control used to write
   * into this object on change, and the fetch effect depends on the whole
   * object, so typing "SEARCHABLE" was ten requests, each a
   * `details LIKE '%…%'` against a table with no index able to serve it and
   * which only ever grows. `searchInput` holds the text; submitting commits it.
   *
   * The select and the two date inputs still apply on change, and should: they
   * are single discrete choices, so one change is one query the reader meant.
   */
  const [filters, setFilters] = useState({
    page: 1,
    limit: 20,
    action: '',
    search: '',
    startDate: '',
    endDate: ''
  });
  const [searchInput, setSearchInput] = useState('');

  const fetchLogs = useCallback(async (currentFilters) => {
    setLoading(true);
    try {
      const res = await api.fetchAuditLogs(currentFilters);
      setLogs(res.logs);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      setError(null);
    } catch (err) {
      /**
       * Distinguished, because the two need different next actions.
       *
       * This screen is reachable only by the platform owner, so "Access Denied"
       * is simultaneously the least likely explanation and the most alarming
       * one: it tells the one person entitled to be here that they are not.
       * A request that did not come back is a retry; a refusal is not.
       */
      const denied = /denied|forbidden|403/i.test(err?.message ?? '');
      setError(denied
        ? { title: 'Access denied', message: 'This record is restricted to the platform owner.' }
        : { title: 'Couldn\'t load the audit trail', message: 'The request did not come back. Nothing has changed — try again.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs(filters);
  }, [fetchLogs, filters]);

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value, page: 1 }));
  };

  /**
   * Commits the typed text into the applied filters, which is what triggers the
   * effect. Returning to page 1 matters: page 3 of one search is not page 3 of
   * the next, and leaving the offset behind strands the reader on what looks
   * like an empty result.
   */
  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setFilters(prev => ({ ...prev, search: searchInput, page: 1 }));
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Audit Explorer</h1>
        <p className="muted">
          Immutable, append-only record of privileged administrative actions and safety interventions.
        </p>
      </header>

      <section className="card" style={{ marginBottom: '16px' }}>
        <form onSubmit={handleSearchSubmit} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: '1 1 200px', marginBottom: 0 }}>
            <label htmlFor="search">Search Details</label>
            <input
              id="search"
              name="search"
              type="text"
              placeholder="Search audit trail..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          
          <div className="form-group" style={{ flex: '0 0 180px', marginBottom: 0 }}>
            <label htmlFor="action">Action</label>
            <select
              id="action"
              name="action"
              value={filters.action}
              onChange={handleFilterChange}
              style={{ width: '100%' }}
            >
              <option value="">All Actions</option>
              {LOG_ACTIONS.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ flex: '0 0 150px', marginBottom: 0 }}>
            <label htmlFor="startDate">Start Date</label>
            <input
              id="startDate"
              name="startDate"
              type="date"
              value={filters.startDate}
              onChange={handleFilterChange}
              style={{ width: '100%' }}
            />
          </div>

          <div className="form-group" style={{ flex: '0 0 150px', marginBottom: 0 }}>
            <label htmlFor="endDate">End Date</label>
            <input
              id="endDate"
              name="endDate"
              type="date"
              value={filters.endDate}
              onChange={handleFilterChange}
              style={{ width: '100%' }}
            />
          </div>
        </form>
      </section>

      {error ? (
        <EmptyState icon={Shield} title={error.title} message={error.message} />
      ) : loading && logs.length === 0 ? (
        <LoadingSkeleton heights={[40, 60, 60, 60, 60]} />
      ) : logs.length === 0 ? (
        <EmptyState icon={FileText} title="No logs found" message="Try adjusting your filters or date range." />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '12px' }}>Timestamp</th>
                  <th style={{ padding: '12px' }}>Action</th>
                  <th style={{ padding: '12px' }}>Actor</th>
                  <th style={{ padding: '12px' }}>Target</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '12px', whiteSpace: 'nowrap' }}>
                      {formatDateShort(log.created_at)}
                    </td>
                    <td style={{ padding: '12px' }}>
                      <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <Activity size={16} />
                        {log.action}
                      </span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      {log.admin_name}
                    </td>
                    <td style={{ padding: '12px' }}>
                      {log.target_user_name || <span className="muted" style={{ fontStyle: 'italic' }}>System</span>}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right' }}>
                      <button 
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSelectedLog(log)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {totalPages > 1 && (
            <div className="row-between" style={{ padding: '16px', borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              <span className="muted">
                Showing {((filters.page - 1) * filters.limit) + 1} to {Math.min(filters.page * filters.limit, total)} of {total} entries
              </span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={filters.page === 1}
                  onClick={() => setFilters(p => ({ ...p, page: p.page - 1 }))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={filters.page >= totalPages}
                  onClick={() => setFilters(p => ({ ...p, page: p.page + 1 }))}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {selectedLog && (
        <AuditDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}
    </div>
  );
}
