import React, { useState, useEffect, useCallback } from 'react';
import { MailPlus, Clock, X } from 'lucide-react';
import { api } from '../../utils/api';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';
import { useModal } from '../../utils/useModal';

/**
 * Pending administrator invitations, on the Admin Roster.
 *
 * ── Why it lives beside the roster rather than on its own page ──
 *
 * A pending invitation is a future row in the table above it. Separating them
 * would mean an owner deciding "who has administrative access" had to check two
 * screens, and the second one is the one that answers "and who is about to".
 *
 * ── The link is never shown here ──
 *
 * Not as a field, not behind a "copy" button, not on hover. An inviter who holds
 * the token can accept from an address they control, which defeats the whole
 * point of binding acceptance to a verified address (IV-4, IV-7). The server does
 * not return it, and this component is written so there is nothing to display
 * even if that changed.
 */

const dayCount = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
};

const expiresIn = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  if (days <= 0) return 'Expired';
  return days === 1 ? 'Tomorrow' : `In ${days} days`;
};

function InviteModal({ onCancel, onInvite, busy }) {
  const dialogRef = useModal(onCancel);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');

  const ready = email.includes('@') && reason.trim().length >= 12;

  return (
    <div className="modal-overlay">
      <div
        className="modal" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby="invite-title" style={{ maxWidth: '460px' }}
      >
        <div className="modal-head">
          <h2 id="invite-title">Invite an administrator</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <form
          className="modal-body stack-md"
          onSubmit={(e) => { e.preventDefault(); if (ready) onInvite({ email: email.trim(), reason }); }}
        >
          <div className="alert alert-warn">
            <div>
              <span className="alert-title">This is a position of trust</span>
              <p>
                Administrators review safety reports and can suspend accounts on a platform
                used mostly by under-18s.
              </p>
            </div>
          </div>

          <div className="field">
            <label htmlFor="invite-email">Their email address</label>
            <input
              id="invite-email" type="email" className="input" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="person@example.org" required
            />
            {/* Says where the link goes, because the answer is the security
                property: only the mailbox holder can use it. */}
            <p className="muted">
              The invitation goes to this address, and only somebody signed in as this
              address can accept it. The link is never shown to you.
            </p>
          </div>

          <div className="field">
            <label htmlFor="invite-reason">Why</label>
            <textarea
              id="invite-reason" className="input" rows={3} value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Elected to the executive board for 2026-2027"
              required
            />
            <p className="muted">
              Recorded against the invitation and read later by whoever asks why this
              person is an administrator. At least 12 characters.
            </p>
          </div>

          <div className="modal-foot">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
              {busy ? 'Sending…' : 'Send the invitation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PendingInvitations({ addToast }) {
  const [invitations, setInvitations] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const { run, modal: stepUpModal } = useStepUp();

  const load = useCallback(async () => {
    try {
      const res = await api.fetchAdminInvitations();
      setInvitations(res.invitations ?? []);
      setError(null);
    } catch (err) {
      setError(err?.message || 'Could not load the pending invitations.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const send = async ({ email, reason }) => {
    setBusy(true);
    try {
      /* Bound to the address, so one verification invites one person. */
      const res = await run(
        STEP_UP.ADMIN_INVITE,
        { email: email.trim().toLowerCase() },
        (headers) => api.inviteAdmin({ email, reason }, headers)
      );
      setInviting(false);
      addToast?.(res.message ?? `Invitation sent to ${email}.`, 'success');
      await load();
    } catch (err) {
      if (err?.data?.code !== 'reauth_required') {
        addToast?.(err?.message || 'Could not send that invitation.', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitation) => {
    try {
      await api.revokeAdminInvitation(invitation.id);
      addToast?.(`Invitation for ${invitation.email} revoked.`, 'success');
      await load();
    } catch (err) {
      addToast?.(err?.message || 'Could not revoke that invitation.', 'error');
    }
  };

  return (
    <section aria-labelledby="invitations-heading" className="stack-sm">
      {stepUpModal}
      {inviting && (
        <InviteModal onCancel={() => setInviting(false)} onInvite={send} busy={busy} />
      )}

      <div className="section-head">
        <h2 id="invitations-heading">Pending invitations</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setInviting(true)}>
          <MailPlus size={14} aria-hidden="true" /> Invite an administrator
        </button>
      </div>

      {error && <p className="text-danger" role="alert">{error}</p>}

      {invitations === null && !error && <p className="muted">Loading…</p>}

      {invitations?.length === 0 && (
        <p className="muted">
          Nobody has been invited. An invitation grants nothing until the person accepts it
          from the address it was sent to.
        </p>
      )}

      {invitations?.length > 0 && (
        <ul className="invite-list">
          {invitations.map((inv) => (
            <li key={inv.id} className="invite-row" data-expired={inv.expired ? 'true' : 'false'}>
              <div className="invite-cell">
                <span className="invite-label">Address</span>
                <span className="invite-email">{inv.email}</span>
              </div>
              <div className="invite-cell">
                <span className="invite-label">Invited by</span>
                <span>{inv.invitedByName}</span>
              </div>
              <div className="invite-cell">
                <span className="invite-label">Age</span>
                <span>{dayCount(inv.created_at) === 0 ? 'Today' : `${dayCount(inv.created_at)} days`}</span>
              </div>
              <div className="invite-cell">
                <span className="invite-label">Expires</span>
                <span className={inv.expired ? 'text-danger' : undefined}>
                  <Clock size={13} aria-hidden="true" /> {expiresIn(inv.expires_at)}
                </span>
              </div>
              <p className="invite-reason">{inv.reason}</p>
              <button
                type="button" className="btn btn-ghost btn-sm invite-revoke"
                onClick={() => revoke(inv)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
