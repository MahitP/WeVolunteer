import React, { useEffect, useState } from 'react';
import { Scale, AlertTriangle, Flag } from 'lucide-react';
import ConfirmDialog from '../common/ConfirmDialog';
import { api } from '../../utils/api';
import { DECISION_LABELS, isFinal } from '../../appeals';

/**
 * Appeals against this organization's bans.
 *
 * ── Why the organization owns this ──
 *
 * A ban is issued by one manager and is a decision of the club. Sending the
 * appeal back to whoever pressed the button asks the person being complained
 * about to judge the complaint, and it fails outright the moment that manager
 * leaves, is away, or is the reason for the appeal. Every manager sees it — the
 * same set that could have issued the ban in the first place.
 *
 * A club with one manager still works, because that manager is one of "every
 * manager" rather than a special case.
 *
 * ── Conflict of interest is shown, not enforced ──
 *
 * Where the reader issued the ban under appeal, the card says so. It does not
 * refuse: in a one-manager club there is nobody to hand it to, and refusing
 * would leave the appellant with no route at all. Naming it is what lets a
 * second manager choose to take it instead.
 *
 * ── Placement ──
 *
 * The bottom of the management area, below the roster. It is the rarest thing a
 * manager does and the one with the most text; putting it above the members
 * list would push the roster off a phone screen for a card that is empty on
 * most days.
 */
const SPAM_NOTE = 'Keeps sending appeals against their ban from our organization after we have said no.';

export default function AppealInbox({ orgKey, addToast }) {
  /* Appeal spam (FX-70): the appeal being reported, and the note sent with it. */
  const [reporting, setReporting] = useState(null);
  const [reportNote, setReportNote] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const sendReport = async () => {
    setReportBusy(true);
    try {
      const res = await api.reportOrganizationAppeal(orgKey, reporting.id, { description: reportNote.trim() });
      addToast?.(res?.duplicate ? 'The moderators already have a report about this.' : 'Reported to the moderators.', 'success');
      setReporting(null);
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setReportBusy(false);
    }
  };
  const [appeals, setAppeals] = useState(null);
  const [busy, setBusy] = useState(null);
  const [reasoning, setReasoning] = useState({});

  useEffect(() => {
    let cancelled = false;
    api.fetchOrganizationAppeals(orgKey)
      .then(res => { if (!cancelled) setAppeals(res?.appeals ?? []); })
      /* An empty inbox and an unreachable one look the same to a reader, so a
         failure renders as "nothing to review" rather than as a broken card in
         the management page. The toast is where the error is reported — and it
         has to actually be raised: this catch used to set the empty state and
         say nothing, so a manager whose inbox failed to load saw no card, was
         told nothing, and had every reason to believe there was nothing
         waiting. Hiding the card is only defensible when something else speaks. */
      .catch(() => {
        if (cancelled) return;
        setAppeals([]);
        addToast?.('Could not load appeals for this organization. Reload to try again.', 'error');
      });
    return () => { cancelled = true; };
  }, [orgKey, addToast]);

  const decide = async (appeal, decision) => {
    const why = (reasoning[appeal.id] || '').trim();
    setBusy(appeal.id);
    try {
      await api.decideOrganizationAppeal(orgKey, appeal.id, { decision, reasoning: why });
      const res = await api.fetchOrganizationAppeals(orgKey);
      setAppeals(res?.appeals ?? []);
      addToast?.(
        decision === 'reversed'
          ? `Ban lifted. ${appeal.appellant.name} can join again.`
          : 'The ban stays in place, and they have been told why.',
        'success',
      );
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /* Rendered only when there is something to review. A permanently empty card
     at the foot of every organization page is furniture. */
  if (!appeals || appeals.length === 0) return null;

  const open = appeals.filter(a => !isFinal(a.status));

  return (
    <section className="card" aria-labelledby="appeal-inbox-heading">
      <div className="card-head">
        <h2 id="appeal-inbox-heading">
          <Scale size={16} aria-hidden="true" /> Appeals
        </h2>
        <p className="muted small">
          {open.length > 0
            ? `${open.length} waiting for a decision. Any manager of this organization can answer.`
            : 'Nothing waiting. Past decisions are kept below.'}
        </p>
      </div>

      <div className="card-body stack-md">
        {appeals.map(a => (
          <article key={a.id} className="appeal-inbox-item stack-sm">
            <div className="row-between row-wrap">
              <span className="strong">
                {a.appellant.name}
                {a.appellant.username && <span className="dim"> @{a.appellant.username}</span>}
              </span>
              <span className={`status ${isFinal(a.status) ? '' : 'status-warn'}`}>
                {isFinal(a.status) ? DECISION_LABELS[a.decision] || 'Decided' : 'Waiting'}
              </span>
            </div>

            {a.ban?.reason && (
              <p className="small dim">
                Banned {a.ban.bannedBy ? `by ${a.ban.bannedBy} ` : ''}
                {a.ban.bannedAt ? `on ${new Date(a.ban.bannedAt).toLocaleDateString()}` : ''}
                {' — '}{a.ban.reason}
              </p>
            )}

            {/* Surfaced so a second manager can choose to take it. */}
            {a.youIssuedThisBan && !isFinal(a.status) && (
              <p className="small" role="note">
                <AlertTriangle size={13} aria-hidden="true" />{' '}
                You issued this ban. Another manager can decide it instead, if there is one.
              </p>
            )}

            <blockquote className="appeal-inbox-statement">{a.statement}</blockquote>

            {/* Appeal spam (FX-70): appeals are capped at five in thirty days,
                and a manager can still hand a pattern of them to the
                moderators, from the appeal itself. */}
            <div>
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => { setReporting(a); setReportNote(SPAM_NOTE); }}
                aria-label={`Report ${a.appellant.name}`}>
                <Flag size={13} aria-hidden="true" /> Report
              </button>
            </div>

            {isFinal(a.status) ? (
              <p className="small dim">
                {DECISION_LABELS[a.decision] || 'Decided'}
                {a.decidedBy ? ` by ${a.decidedBy}` : ''}
                {a.decidedAt ? ` on ${new Date(a.decidedAt).toLocaleDateString()}` : ''}
                {a.reasoning ? ` — ${a.reasoning}` : ''}
              </p>
            ) : (
              <>
                <label className="field">
                  <span>Why</span>
                  <textarea
                    className="input"
                    rows={2}
                    maxLength={5000}
                    value={reasoning[a.id] || ''}
                    onChange={e => setReasoning(r => ({ ...r, [a.id]: e.target.value }))}
                    placeholder="They are told this, whichever way you decide."
                  />
                </label>
                <div className="row row-wrap">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy === a.id}
                    onClick={() => decide(a, 'reversed')}
                  >
                    Lift the ban
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy === a.id}
                    onClick={() => decide(a, 'stands')}
                  >
                    Keep the ban
                  </button>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
      {reporting && (
        <ConfirmDialog
          title={`Report ${reporting.appellant.name} to the moderators?`}
          confirmLabel="Send report"
          busy={reportBusy}
          busyLabel="Sending…"
          confirmDisabled={!reportNote.trim()}
          onConfirm={sendReport}
          onCancel={() => setReporting(null)}
        >
          <p>
            The moderators see this appeal and your note, and decide what happens. It does not
            change the ban or the appeal.
          </p>
          <div className="field">
            <label htmlFor="appeal-report-note">What is happening?</label>
            <textarea id="appeal-report-note" className="input" rows={3} maxLength={1000}
              value={reportNote} onChange={e => setReportNote(e.target.value)} />
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}
