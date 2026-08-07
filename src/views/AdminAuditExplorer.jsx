import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { Shield, Search, ChevronLeft, ChevronRight, FileText, ChevronDown } from 'lucide-react';
import { auditLabel, auditTone, auditTimestamp } from './auditFormat';

const PAGE_SIZE = 20;

/**
 * The administrative audit trail, for the platform owner.
 *
 * ── What this screen is for ──
 *
 * Answering "what did this administrator do, and when" months after the fact.
 * That framing decides the layout: the rows are a chronology, not a dataset, so
 * they are read down rather than compared across, and the field that explains an
 * entry — `details`, the sentence somebody wrote at the time — belongs on the
 * row rather than behind a button.
 *
 * ── Why this is not a `<table>` ──
 *
 * It was. `.table` carries `min-width: 680px` and the wrapper scrolls, which is
 * the right call for a dense grid on a laptop and the wrong one here: on a phone
 * the action names were clipped mid-word and Actor, Target and the controls were
 * entirely off-screen, reachable only by horizontal scrolling nobody discovers.
 *
 * A list of records styled by grid gives the aligned columns on a wide screen
 * and genuinely stacks on a narrow one — the same markup, no duplicated
 * rendering, no min-width floor. `<table>` semantics buy little for a log whose
 * rows are read individually and whose most useful column is a paragraph.
 */
export default function AdminAuditExplorer() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  /**
   * `filters` is the APPLIED query — changing it is what fetches.
   *
   * The search box is deliberately not part of it. Every control used to write
   * into this object on change, and the fetch effect depends on the whole
   * object, so typing "SEARCHABLE" was ten requests, each a
   * `details LIKE '%…%'` against a table with no index able to serve it and
   * which only ever grows. `searchInput` holds the text; submitting commits it.
   */
  const [filters, setFilters] = useState({
    page: 1, limit: PAGE_SIZE, action: '', search: '', startDate: '', endDate: '',
  });
  const [searchInput, setSearchInput] = useState('');

  const fetchLogs = useCallback(async (currentFilters) => {
    setLoading(true);
    try {
      const res = await api.fetchAuditLogs(currentFilters);
      setLogs(res.logs);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      /* Derived server-side from the trail itself, so the filter cannot offer an
         action nobody writes — see the endpoint for the drift that caused. */
      if (Array.isArray(res.actions)) setActions(res.actions);
      setError(null);
    } catch (err) {
      /**
       * Distinguished, because the two need different next actions. This screen
       * is reachable only by the platform owner, so "Access Denied" is
       * simultaneously the least likely explanation and the most alarming one.
       */
      const denied = /denied|forbidden|403/i.test(err?.message ?? '');
      setError(denied
        ? { title: 'Access denied', message: 'This record is restricted to the platform owner.' }
        : { title: 'Couldn\'t load the audit trail', message: 'The request did not come back. Nothing has changed — try again.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLogs(filters); }, [fetchLogs, filters]);

  /* Every filter change returns to page 1: page 3 of one filter is not page 3
     of the next, and keeping the offset strands the reader on an empty result. */
  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value, page: 1 }));
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setFilters(prev => ({ ...prev, search: searchInput, page: 1 }));
  };

  const canPrev = filters.page > 1;
  const canNext = filters.page < totalPages;
  const firstOnPage = total === 0 ? 0 : ((filters.page - 1) * filters.limit) + 1;
  const lastOnPage = Math.min(filters.page * filters.limit, total);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Audit Explorer</h1>
        <p className="muted">
          Every privileged action, append-only and impossible to edit. Kept for one year.
        </p>
      </header>

      <div className="stack">
        <form onSubmit={handleSearchSubmit} className="audit-filters" role="search">
          <div className="field audit-filter-search">
            <label htmlFor="audit-search">Search the record</label>
            <div className="audit-search-wrap">
              <Search size={16} className="audit-search-icon" aria-hidden="true" />
              <input
                id="audit-search"
                name="search"
                type="search"
                className="input"
                placeholder="Words from an entry…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="audit-action">Action</label>
            <select
              id="audit-action" name="action" className="input"
              value={filters.action} onChange={handleFilterChange}
            >
              <option value="">All actions</option>
              {actions.map(a => <option key={a} value={a}>{auditLabel(a)}</option>)}
            </select>
          </div>

          <div className="field">
            <label htmlFor="audit-start">From</label>
            <input
              id="audit-start" name="startDate" type="date" className="input"
              value={filters.startDate} onChange={handleFilterChange}
            />
          </div>

          <div className="field">
            <label htmlFor="audit-end">To</label>
            <input
              id="audit-end" name="endDate" type="date" className="input"
              value={filters.endDate} onChange={handleFilterChange}
            />
          </div>

          <button type="submit" className="btn btn-secondary audit-filter-submit">Search</button>
        </form>

        {error ? (
          <EmptyState icon={Shield} title={error.title} message={error.message} />
        ) : loading && logs.length === 0 ? (
          <LoadingSkeleton heights={[40, 72, 72, 72, 72]} />
        ) : logs.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Nothing matches those filters"
            message="Try a wider date range, or clear the action filter."
          />
        ) : (
          <>
            {/* Column headings, shown only where there are columns. `aria-hidden`
                because each row already labels its own fields for a screen
                reader — repeating them here would announce every heading twice. */}
            <div className="audit-head" aria-hidden="true">
              <span>When</span><span>Action</span><span>Who</span><span>About</span>
            </div>

            <ul className="audit-list">
              {logs.map((log) => {
                const when = auditTimestamp(log.created_at);
                const isOpen = expanded === log.id;
                return (
                  <li key={log.id} className="audit-row" data-tone={auditTone(log.action)}>
                    <div className="audit-cell audit-when">
                      <span className="audit-label">When</span>
                      <time dateTime={log.created_at} title={when.title}>
                        {when.date} <span className="audit-time">{when.time}</span>
                      </time>
                    </div>

                    <div className="audit-cell audit-action">
                      <span className="audit-label">Action</span>
                      <span className="audit-action-name">{auditLabel(log.action)}</span>
                    </div>

                    <div className="audit-cell">
                      <span className="audit-label">Who</span>
                      <span>{log.admin_name}</span>
                    </div>

                    <div className="audit-cell">
                      <span className="audit-label">About</span>
                      <span>
                        {log.target_user_name || <span className="muted">No one in particular</span>}
                      </span>
                    </div>

                    {/* The sentence somebody wrote at the time. It is the reason
                        the row exists, so it sits on the row rather than behind
                        a button — the old screen hid it in a modal and showed a
                        column of identical action names instead. */}
                    {log.details && (
                      <p className="audit-details">{log.details}</p>
                    )}

                    <button
                      type="button"
                      className="btn btn-ghost btn-sm audit-more"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : log.id)}
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                      {isOpen ? 'Hide record' : 'Full record'}
                    </button>

                    {isOpen && (
                      <dl className="audit-full">
                        <dt>Record id</dt><dd><code>{log.id}</code></dd>
                        <dt>Stored action</dt><dd><code>{log.action}</code></dd>
                        <dt>Recorded</dt><dd>{when.title}</dd>
                        <dt>Actor</dt><dd>{log.admin_name} <code>{log.admin_id}</code></dd>
                        {log.target_user_id && (
                          <>
                            <dt>Subject</dt>
                            <dd>{log.target_user_name} <code>{log.target_user_id}</code></dd>
                          </>
                        )}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="audit-pager">
              <p className="muted">
                {firstOnPage}–{lastOnPage} of {total}
              </p>
              <div className="row">
                <button
                  type="button" className="btn btn-secondary btn-sm" disabled={!canPrev}
                  onClick={() => setFilters(p => ({ ...p, page: p.page - 1 }))}
                >
                  <ChevronLeft size={14} aria-hidden="true" /> Previous
                </button>
                <button
                  type="button" className="btn btn-secondary btn-sm" disabled={!canNext}
                  onClick={() => setFilters(p => ({ ...p, page: p.page + 1 }))}
                >
                  Next <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
