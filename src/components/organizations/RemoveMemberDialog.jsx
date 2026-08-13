import React, { useState } from 'react';
import { UserMinus, Ban } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';

/**
 * Removing somebody from an organization, or banning them.
 *
 * ── Two actions in one dialog, and why they are not two buttons of equal weight ──
 *
 * Removing is routine roster management and is reversible: they can join again.
 * Banning is a standing decision that they may not. Presenting those side by
 * side as equals is how somebody bans a member they meant to remove — so the
 * reversible action is the default and the primary control, and the permanent
 * one is a deliberate switch that visibly changes what the dialog says before
 * anything is confirmed.
 *
 * ── The reason ──
 *
 * Optional for a removal: demanding a justification for routine work trains
 * people to type "n/a", which is worse than an honest blank.
 *
 * Required for a ban, here and again at the route and the column. A person told
 * they are banned and not told why has nothing to appeal against, and the reason
 * is what an administrator hearing that appeal actually reads.
 */
export default function RemoveMemberDialog({ member, organizationName, busy, onCancel, onConfirm }) {
  const [mode, setMode] = useState('kick');
  const [reason, setReason] = useState('');

  const banning = mode === 'ban';
  const canConfirm = !busy && (!banning || reason.trim().length > 0);

  return (
    <Modal onClose={onCancel} label={`Remove ${member.name} from ${organizationName}`} size="sm">
      <ModalHead
        title={banning ? `Ban ${member.name}?` : `Remove ${member.name}?`}
        description={banning
          ? `They will be removed and cannot rejoin ${organizationName} while the ban is active.`
          : 'They can still join this organization again.'}
        onClose={onCancel}
      />

      <div className="modal-body stack-md">
        <label className="field">
          <span>Reason {banning ? '' : <span className="dim">(optional)</span>}</span>
          <textarea
            className="input"
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder={banning
              ? 'Why are they being banned? They are told this, and it is what any appeal is heard against.'
              : 'Optional — they will see this if you write one.'}
            aria-describedby="remove-reason-hint"
          />
          <span className="field-hint" id="remove-reason-hint">
            {banning
              ? 'Required. The person is told the reason, and so is anyone reviewing an appeal.'
              : 'They are told they were removed either way.'}
          </span>
        </label>

        {/* A switch rather than a second confirm button: the heading, the
            description and the hint all change first, so nobody discovers what
            they chose only after it has happened. */}
        <label className="check">
          <input
            type="checkbox"
            checked={banning}
            onChange={e => setMode(e.target.checked ? 'ban' : 'kick')}
          />
          <span>Ban instead — they cannot rejoin</span>
        </label>
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={banning ? 'btn btn-danger-solid' : 'btn btn-danger'}
          disabled={!canConfirm}
          onClick={() => onConfirm({ mode, reason: reason.trim() })}
        >
          {banning
            ? <><Ban size={15} aria-hidden="true" /> Ban {member.name}</>
            : <><UserMinus size={15} aria-hidden="true" /> Remove {member.name}</>}
        </button>
      </div>
    </Modal>
  );
}
