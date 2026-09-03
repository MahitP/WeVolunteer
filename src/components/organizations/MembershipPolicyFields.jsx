import { JOIN_POLICIES, INVITE_POLICIES, JOIN_POLICY_COPY, INVITE_POLICY_COPY } from '../../organizationPolicy';

/**
 * Who can join, and who can share the link.
 *
 * ── Why each option carries a sentence ──
 *
 * The stored values are `open`, `invite` and `request`, and a settings screen
 * that showed those would have told a manager the value and not the effect. Each
 * option here is a short label plus one sentence of consequence, because the
 * decision being made — who can get into a club full of children — is one
 * somebody should understand before they save it, rather than after a student
 * tells them the Join button stopped working.
 *
 * The words live in `src/organizationPolicy.js` beside the vocabulary they
 * describe, so a fourth mode cannot be added to the enum without somebody having
 * to write what it does.
 *
 * ── Radios, not a `<select>` ──
 *
 * Three mutually exclusive choices, each needing a line of explanation. A select
 * can hold three options and cannot hold three explanations: the consequence
 * would have to move to a paragraph underneath that changes when the value does,
 * which is the same information arriving after the decision instead of with it.
 * A `<fieldset>` with a `<legend>` is also what makes the group announce itself
 * as one question rather than as three unrelated checkboxes.
 */
export default function MembershipPolicyFields({ joinPolicy, invitePolicy, onChange, disabled = false }) {
  return (
    <div className="stack-lg">
      <fieldset className="org-policy-group">
        <legend className="org-policy-legend">Who can join?</legend>

        {JOIN_POLICIES.map((value) => {
          const copy = JOIN_POLICY_COPY[value];
          return (
            <label key={value} className="org-policy-option">
              <input
                type="radio"
                name="joinPolicy"
                value={value}
                checked={joinPolicy === value}
                disabled={disabled}
                onChange={() => onChange('joinPolicy', value)}
              />
              <span className="org-policy-text">
                <span className="org-policy-label">{copy.label}</span>
                <span className="org-policy-consequence">{copy.consequence}</span>
                {/* The second-order consequence, shown only where it is not
                    obvious. Managers most often assume invitation-only also
                    hides the club, and it does not. */}
                {copy.note && <span className="org-policy-note">{copy.note}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="org-policy-group">
        <legend className="org-policy-legend">Who can share the invitation link?</legend>

        {INVITE_POLICIES.map((value) => {
          const copy = INVITE_POLICY_COPY[value];
          return (
            <label key={value} className="org-policy-option">
              <input
                type="radio"
                name="invitePolicy"
                value={value}
                checked={invitePolicy === value}
                disabled={disabled}
                onChange={() => onChange('invitePolicy', value)}
              />
              <span className="org-policy-text">
                <span className="org-policy-label">{copy.label}</span>
                <span className="org-policy-consequence">{copy.consequence}</span>
              </span>
            </label>
          );
        })}

        {/**
          * The limit of this setting, stated where somebody might otherwise
          * assume it goes further.
          *
          * "Any member can share the link" does not mean any member can decide
          * what the link is. Creating one, replacing one and switching one off
          * stay with managers, because replacing a link stops every copy already
          * handed out from working — and a manager reading this group is exactly
          * the person who needs to know that before choosing the wider option.
          */}
        <p className="muted small org-policy-footnote">
          Creating a link, regenerating it and switching it off are always a manager’s decision.
        </p>
      </fieldset>
    </div>
  );
}
