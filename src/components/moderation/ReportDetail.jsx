import React, { useEffect, useState } from 'react';
import { AlertTriangle, Lock, ShieldAlert } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import SubjectActions from './SubjectActions';
import { api } from '../../utils/api';
import { can } from '../../authz';
import { categoryLabel } from '../../moderation';
import { formatDay } from '../../utils/helpers';

/**
 * One report, everything recorded about it, and the evidence behind it.
 *
 * ── Why this exists ──
 *
 * The Moderation Center listed reports and rendered the evidence COUNT — "1
 * message preserved as evidence" — with no way to open it. Everything behind that
 * sentence was already built: `report_evidence` froze the bodies at filing,
 * database triggers made them immutable, `report.evidence.read` gated the read
 * and `GET /api/admin/reports/:id/evidence` served it and logged who asked. No
 * client code called it. So a moderator deciding whether to suspend a student
 * could see that evidence existed and could not read it, and the one situation
 * the Youth Safety Guidelines say an administrator reads private messages in was
 * a sentence describing something the product could not do.
 *
 * ── Evidence is fetched on request, never on open ──
 *
 * Reading the bodies is a disclosure, not a page load. The server writes an
 * `admin_audit_logs` row and a durable `evidence_viewed` row to the report's
 * append-only history on every call, because "who read this student's private
 * messages" is a question a parent or a district asks years later.
 *
 * Fetching it eagerly with the report would log a read for every moderator who
 * merely opened a report to see what it said — the trail would then record
 * disclosures that never happened, which is worse than not recording them: it
 * makes the log useless as evidence in the direction it exists to serve. So the
 * button is the consent, the request is the act, and the copy says so before it
 * is pressed.
 *
 * ── Read-only, and not merely by omission ──
 *
 * There is no edit affordance here and there is no endpoint behind one. The
 * frozen rows cannot be updated or deleted by any path, including a `bin/`
 * script — `BEFORE UPDATE` and `BEFORE DELETE` triggers on `report_evidence`
 * abort the write (migration 013). This view states that to the moderator,
 * because "can I be accused of altering this" is a fair question to have
 * answered on the screen rather than in a schema file.
 */

/** Action names as a moderator reads them, keyed by the stored value. */
const ACTION_LABELS = {
  filed: 'Report filed',
  status_changed: 'Status changed',
  prioritised: 'Priority changed',
  assigned: 'Assigned',
  unassigned: 'Unassigned',
  resolved: 'Decided',
  reopened: 'Reopened',
  evidence_viewed: 'Preserved messages read',
  self_review: 'Self-review — the actor is named in this report',
};

/**
 * What changed, in words, for one history row.
 *
 * Returns null when there is nothing to add beyond the action's own name, so the
 * timeline does not render an empty second line under "Report filed".
 */
function describeChange(row) {
  if (row.old_status && row.new_status) return `${row.old_status} → ${row.new_status}`;
  if (row.new_status) return `set to ${row.new_status}`;
  if (row.old_priority && row.new_priority) return `${row.old_priority} → ${row.new_priority}`;
  if (row.new_resolution) return row.new_resolution.replace(/_/g, ' ');
  return null;
}

/** A timestamp with the time of day, which a moderation trail needs and `formatDay` drops. */
function formatMoment(value) {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  return at.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function ReportDetail({ reportId, user, onClose, onChanged, addToast }) {
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [evidenceError, setEvidenceError] = useState(null);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

  const mayReadEvidence = can(user, 'report.evidence.read');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await api.fetchReport(reportId);
        if (live) setDetail(data);
      } catch (err) {
        if (live) setLoadError(err?.message || 'Could not load this report.');
      }
    })();
    return () => { live = false; };
  }, [reportId]);

  const openEvidence = async () => {
    setLoadingEvidence(true);
    setEvidenceError(null);
    try {
      const data = await api.fetchReportEvidence(reportId);
      setEvidence(data.messages || []);
      // The read is now on the record, so the timeline the moderator is looking
      // at is out of date by exactly one row. Refetching keeps the screen honest
      // about what it has just caused.
      try {
        setDetail(await api.fetchReport(reportId));
      } catch { /* the evidence is what was asked for; a stale timeline can wait */ }
      onChanged?.();
    } catch (err) {
      setEvidenceError(err?.message || 'Could not open the preserved messages.');
      addToast?.(`Could not open the evidence: ${err?.message || 'unknown error'}`, 'error');
    } finally {
      setLoadingEvidence(false);
    }
  };

  const report = detail?.report;
  const history = detail?.history || [];

  return (
    <Modal onClose={onClose} label="Report detail" size="lg" className="modal-report">
      <ModalHead
        title={report ? `Report — ${categoryLabel(report.category)}` : 'Report'}
        description="Everything recorded about this report, and the evidence preserved with it."
        onClose={onClose}
      />

      <div className="modal-body">
        {loadError && (
          <div className="alert alert-danger" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{loadError}</span>
          </div>
        )}

        {!detail && !loadError && <p className="small dim">Loading…</p>}

        {report && (
          <div className="stack-md">
            {/* ── What this report is ── */}
            <div className="stack-xs">
              <div className="small">
                <span className="dim">Status </span>
                <span className="strong capitalize">{report.status}</span>
                {report.priority === 'urgent' && <span className="tag tag-warn">URGENT</span>}
              </div>
              <div className="small">
                <span className="dim">Category </span>
                <span className="strong">{categoryLabel(report.category)}</span>
              </div>
              <div className="small">
                <span className="dim">Reported {report.target_type} </span>
                {report.target_label && <span className="strong">{report.target_label}</span>}
              </div>
              <div className="small">
                <span className="dim">Reported by </span>
                <span className="strong">{report.reporter_name}</span>
                {report.reporter_email && <span className="muted"> ({report.reporter_email})</span>}
              </div>
              <div className="small">
                <span className="dim">Filed </span>
                <span>{formatMoment(report.created_at)}</span>
              </div>
              {report.assigned_to_name && (
                <div className="small">
                  <span className="dim">Assigned to </span>
                  <span className="strong">{report.assigned_to_name}</span>
                </div>
              )}
            </div>

            {/* ── What the reporter said, in their own words ── */}
            <div className="inset">
              <div className="small strong">What they told us</div>
              {report.description
                ? <p className="small">{report.description}</p>
                : <p className="small dim">They chose a category and did not add anything else.</p>}
            </div>

            {report.resolution && (
              <div className="inset">
                <div className="small strong">Decision</div>
                <p className="small capitalize">{report.resolution.replace(/_/g, ' ')}</p>
                {report.resolution_note && <p className="small">{report.resolution_note}</p>}
                <p className="small dim">
                  {report.resolved_by_name ? `${report.resolved_by_name} · ` : ''}
                  {formatMoment(report.resolved_at)}
                </p>
              </div>
            )}

            {/* ── Evidence ── */}
            <div className="stack-xs">
              <div className="small strong">Evidence</div>

              {report.evidence_count > 0 ? (
                <>
                  {/* The verb agrees too. "1 message were copied" is the kind of
                      sloppiness that makes a moderation surface read as untended,
                      on the screen where a moderator is deciding about a child. */}
                  <p className="small dim">
                    {report.evidence_count === 1
                      ? '1 message was copied and frozen when this report was filed.'
                      : `${report.evidence_count} messages were copied and frozen when this `
                        + 'report was filed.'}
                  </p>

                  {!mayReadEvidence && (
                    /**
                     * Named rather than hidden. A moderator who can work the queue
                     * but not read messages needs to know the evidence exists and
                     * that somebody else can read it — silently omitting the
                     * control reads as "there is nothing here", which is the one
                     * thing it must not say on a safety surface.
                     */
                    <p className="small dim">
                      Reading preserved messages needs the evidence permission, which this
                      account does not have. An administrator can read them and add what they
                      find to this report.
                    </p>
                  )}

                  {mayReadEvidence && evidence === null && (
                    <>
                      <p className="small dim">
                        Opening these shows private messages between the people in this
                        report. It is recorded permanently against this report, with your
                        name and the time.
                      </p>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={openEvidence}
                        disabled={loadingEvidence}
                      >
                        <ShieldAlert size={14} aria-hidden="true" />
                        {loadingEvidence ? 'Opening…' : 'Open preserved messages'}
                      </button>
                    </>
                  )}

                  {evidenceError && (
                    <div className="alert alert-danger" role="alert">
                      <AlertTriangle size={16} aria-hidden="true" />
                      <span>{evidenceError}</span>
                    </div>
                  )}

                  {evidence !== null && (
                    <div className="stack-xs">
                      <p className="small dim">
                        <Lock size={12} aria-hidden="true" /> Read-only. These copies cannot be
                        edited or deleted by anyone, including an administrator.
                      </p>
                      {evidence.length === 0 && (
                        <p className="small dim">No messages were preserved with this report.</p>
                      )}
                      {evidence.map(message => (
                        <div key={message.message_id} className="inset">
                          <div className="small strong">{message.sender_name}</div>
                          <p className="small">{message.body}</p>
                          {/* Two timestamps, because they are two facts: when it was
                              said, and when this report froze a copy of it. */}
                          <p className="small dim">
                            Sent {formatMoment(message.created_at)}
                            {message.captured_at
                              ? ` · preserved ${formatMoment(message.captured_at)}`
                              : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="small dim">
                  Nothing was preserved with this report. Message and conversation reports
                  keep a frozen copy; other kinds point at content that may still be live.
                </p>
              )}
            </div>

            {/* ── Acting on the person ──
                Below the evidence on purpose: the decision to warn or suspend
                somebody should be reachable after reading what they are supposed
                to have done, not before it. */}
            <SubjectActions
              subject={report.subject}
              user={user}
              addToast={addToast}
              onDone={async () => {
                // The suspension or warning is now on the record; refetch so the
                // timeline and the subject's status both reflect it.
                try { setDetail(await api.fetchReport(reportId)); } catch { /* non-fatal */ }
                onChanged?.();
              }}
            />

            {/* ── What has been done, in order ── */}
            <div className="stack-xs">
              <div className="small strong">History</div>
              {history.length === 0 ? (
                <p className="small dim">Nothing has been recorded against this report yet.</p>
              ) : (
                <div className="timeline">
                  {history.map(row => {
                    const change = describeChange(row);
                    return (
                      <div key={row.id} className="timeline-item">
                        <div className="timeline-date">{formatMoment(row.created_at)}</div>
                        <div className="timeline-title">
                          {ACTION_LABELS[row.action] ?? row.action.replace(/_/g, ' ')}
                        </div>
                        <div className="timeline-meta">
                          {row.actor_name}
                          {change ? ` · ${change}` : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
