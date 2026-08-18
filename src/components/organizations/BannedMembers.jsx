import React, { useCallback, useEffect, useState } from 'react';
import { Ban, ShieldCheck, Clock, UserRound } from 'lucide-react';
import { api } from '../../utils/api';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDay } from '../../utils/helpers';

/**
 * Who this organization has banned, and the way back.
 *
 * ── Why a club needs this at all ──
 *
 * Banning worked and left a durable, attributable record. Nothing read it back.
 * So a manager could exclude somebody and then have no way to answer "who is
 * banned from here", "why", or "was that the person I meant" — the record
 * existed and was visible only in the database. A standing decision nobody can
 * review is one nobody can correct.
 *
 * ── Why Unban sits here rather than only in the appeal inbox ──
 *
 * An appeal is ONE route out, not the only one. Requiring the person you
 * excluded by mistake to first write a formal statement asking to be let back in
 * is a bad rule, and it produces a worse record: an appeal "granted" where
 * nothing was ever contested. The two live side by side — the inbox answers
 * things people have written, this answers the club changing its mind.
 *
 * ── What lifting does and does not do ──
 *
 * It means "you may join again", not "you are back in". The server does not
 * restore membership, because re-adding somebody to a club without their asking
 * is the mirror of the original problem. The confirmation says so, because a
 * manager who expects the roster to change and sees it not change will press the
 * button again.
 *
 * ── Placement ──
 *
 * Inside the management area, above the appeal inbox: this is the shorter card
 * and the one whose emptiness is meaningful — "nobody is banned" is a real
 * answer, so it renders that rather than disappearing.
 */
export default function BannedMembers({ orgKey, organizationName, addToast }) {
  const [bans, setBans] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async ({ signal } = {}) => {
    try {
      const res = await api.fetchOrganizationBans(orgKey);
      if (!signal?.aborted) setBans(res?.bans ?? []);
    } catch {
      /* An empty list and an unreachable one must not look the same to a
         manager — this card claims "nobody is banned", which is a statement
         about moderation state and would be a lie if the request simply
         failed.
         
         This used to read `setBans(prev => prev ?? [])`, which did the exact
         thing the paragraph above says not to: on a FAILED FIRST LOAD `prev` is
         null, so the fallback turned it into `[]` and the card announced
         "Nobody is banned from …" on the strength of a request that never
         arrived. A manager checking whether somebody was still excluded got a
         confident no.
         
         Leaving the state alone is what the comment always described. On a
         first load it stays null and the card does not render, saying nothing.
         On a later refresh it keeps the last list that actually loaded, which
         is better than blanking a real one because one poll failed. */
      if (!signal?.aborted) setBans(prev => prev);
    }
  }, [orgKey]);

  useEffect(() => {
    const ac = new AbortController();
    load({ signal: ac.signal });
    return () => ac.abort();
  }, [load]);

  const lift = async () => {
    setBusy(true);
    try {
      await api.liftOrganizationBan(orgKey, confirming.user.id);
      await load();
      addToast?.(`${confirming.user.name} can join ${organizationName} again.`, 'success');
      setConfirming(null);
    } catch (err) {
      addToast?.(err?.message || 'That did not go through. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (bans === null) return null;

  return (
    <section className="card card-pad stack-sm" aria-labelledby="org-banned-heading">
      <h3 id="org-banned-heading" className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
        <Ban size={16} aria-hidden="true" /> Banned members
      </h3>

      {bans.length === 0 ? (
        <p className="muted small">Nobody is banned from {organizationName}.</p>
      ) : (
        <ul className="stack-sm list-plain">
          {bans.map(ban => (
            <li key={ban.id} className="row-between org-ban-row">
              <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
                {/* The same fallback chain the roster on this page uses:
                    uploaded picture, then emoji, then the glyph. */}
                <span className="avatar" aria-hidden="true">
                  {ban.user.profilePictureUrl
                    ? <img src={ban.user.profilePictureUrl} alt="" className="avatar-img" />
                    : (ban.user.avatar || <UserRound size={16} />)}
                </span>
                <div className="stack-xs">
                  <p className="org-ban-name">
                    {ban.user.name}
                    {ban.user.username && <span className="muted"> @{ban.user.username}</span>}
                  </p>
                  <p className="muted small">
                    Banned {formatDay(ban.bannedAt)}
                    {ban.bannedBy?.name && <> by {ban.bannedBy.name}</>}
                  </p>
                  <p className="muted small">Reason: {ban.reason}</p>
                  {/* Surfaced so a manager does not lift a ban here while a
                      colleague is part-way through deciding the appeal against
                      it — the two routes are independent by design. */}
                  {ban.appeal?.pending && (
                    <p className="small org-ban-appeal">
                      <Clock size={13} aria-hidden="true" /> Appeal waiting since {formatDay(ban.appeal.submittedAt)}
                    </p>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirming(ban)}
              >
                <ShieldCheck size={15} aria-hidden="true" /> Unban
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Unban ${confirming.user.name}?`}
          confirmLabel="Unban"
          busy={busy}
          onConfirm={lift}
          onCancel={() => setConfirming(null)}
        >
          <p>
            {confirming.user.name} will be able to join {organizationName} again. They are
            not added back automatically — they join themselves, as anybody would.
          </p>
          {confirming.appeal?.pending && (
            <p className="muted small">
              Their appeal stays open. Lifting the ban here is not a decision on it, and
              it will still be waiting in the appeal inbox.
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}
