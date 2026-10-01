import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, LifeBuoy, ShieldAlert } from 'lucide-react';
import { api } from '../utils/api';
import { formatDay } from '../utils/helpers';
import { ISSUE_CATEGORIES, isSensitive } from '../issueReports';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';

const labelFor = (value) => ISSUE_CATEGORIES.find(c => c.value === value)?.label || value;

/**
 * Reported problems, for the staff who read them (N13, FX-75).
 *
 * Reports were stored and announced by email, and nothing in the product
 * showed them. For a security or privacy report that was worse than
 * inconvenient: its email deliberately leaves the contents out and says "open
 * the report in the admin area to read it" — and there was no such page. This
 * is that page, reached from a tile on the Admin hub and gated, like the API
 * behind it, on `report.resolve`.
 *
 * Screenshots load from `/api/issues/:id/screenshots/:n`, which answers only to
 * that capability and tells the browser not to keep a copy.
 */
export default function AdminIssues() {
  const [state, setState] = useState({ loading: true, issues: [], error: '' });

  useEffect(() => {
    let alive = true;
    api.fetchIssueReports()
      .then(res => { if (alive) setState({ loading: false, issues: res?.issues ?? [], error: '' }); })
      .catch(err => { if (alive) setState({ loading: false, issues: [], error: err?.message || 'Reports could not be loaded.' }); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="page stack-lg">
      <div>
        <Link to="/admin/moderation" className="btn btn-ghost btn-sm loggedhours-back">
          <ArrowLeft size={15} aria-hidden="true" /> Back to Admin
        </Link>
      </div>
      <div className="stack-xs">
        <h2 className="page-title">Reported problems</h2>
        <p className="muted">
          What people sent from Report an Issue, newest first. Security and privacy reports are
          read here and nowhere else: their emails leave the contents out.
        </p>
      </div>

      {state.loading && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}
      {!state.loading && state.error && <p className="small dim" role="status">{state.error}</p>}
      {!state.loading && !state.error && state.issues.length === 0 && (
        <EmptyState icon={LifeBuoy} title="No problems have been reported" message="Reports appear here as people send them." />
      )}

      {!state.loading && state.issues.length > 0 && (
        <ul className="stack-md issue-list">
          {state.issues.map(issue => (
            <li key={issue.id} className="card card-pad stack-sm">
              <div className="row row-wrap issue-head">
                <span className="strong tnum">{issue.reference}</span>
                <span className={`tag${isSensitive(issue.category) ? ' tag-danger' : ''}`}>
                  {isSensitive(issue.category) && <ShieldAlert size={12} aria-hidden="true" />} {labelFor(issue.category)}
                </span>
                <span className="small dim">{formatDay(issue.createdAt)}</span>
                <span className="small dim">
                  {issue.reporter ? `from ${issue.reporter.name}${issue.reporter.username ? ` (@${issue.reporter.username})` : ''}` : 'from a deleted account'}
                </span>
              </div>
              <p className="issue-description">{issue.description}</p>
              {issue.context?.path && <p className="small dim">Sent from {issue.context.path}</p>}
              {issue.screenshots > 0 && (
                <div className="issue-shots">
                  {Array.from({ length: issue.screenshots }, (_, i) => {
                    const src = `/api/issues/${issue.id}/screenshots/${i + 1}`;
                    return (
                      <a key={src} href={src} target="_blank" rel="noopener noreferrer" className="issue-shot">
                        <img src={src} alt={`Screenshot ${i + 1} of ${issue.screenshots} for ${issue.reference}`} loading="lazy" />
                      </a>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
