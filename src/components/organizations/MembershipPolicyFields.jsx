import {
  JOIN_POLICIES, INVITE_POLICIES, VISIBILITIES,
  JOIN_POLICY_COPY, INVITE_POLICY_COPY, VISIBILITY_COPY,
} from '../../organizationPolicy';

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
 *
 * ── Why each input names itself explicitly ──
 *
 * Wrapping the input in the whole `<label>` made the browser compute the
 * accessible name from every text node inside it — and with no whitespace
 * between the two spans, that name was literally `AnyoneStudents can join this
 * organization straight away.` A screen-reader user heard a run-together word
 * followed by a sentence, for every option, in every group.
 *
 * So the concise title is the NAME (`aria-labelledby`) and the consequence is
 * the DESCRIPTION (`aria-describedby`). Announced as "Anyone, radio button",
 * then the sentence — which is the same order a sighted reader takes them in,
 * and it makes the group navigable by title rather than by paragraph.
 */
export default function MembershipPolicyFields({
  joinPolicy, invitePolicy, visibility, onChange, disabled = false,
}) {
  return (
    <div className="stack-lg">
      <fieldset className="org-policy-group">
        <legend className="org-policy-legend">Who can join?</legend>
        {JOIN_POLICIES.map(value => (
          <PolicyOption
            key={value}
            group="joinPolicy"
            value={value}
            copy={JOIN_POLICY_COPY[value]}
            checked={joinPolicy === value}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </fieldset>

      <fieldset className="org-policy-group">
        <legend className="org-policy-legend">Who can share the invitation link?</legend>
        {INVITE_POLICIES.map(value => (
          <PolicyOption
            key={value}
            group="invitePolicy"
            value={value}
            copy={INVITE_POLICY_COPY[value]}
            checked={invitePolicy === value}
            disabled={disabled}
            onChange={onChange}
          />
        ))}

        {/**
          * The limit of this setting, stated where somebody might otherwise
          * assume it goes further.
          *
          * "Any member can share the link" does not mean any member can decide
          * what the link is. Creating one, replacing one and switching one off
          * stay with managers, because replacing a link stops every copy
          * already handed out from working — and a manager reading this group
          * is exactly the person who needs to know that before choosing the
          * wider option.
          */}
        <p className="muted small org-policy-footnote">
          Creating a link, regenerating it and switching it off are always a manager’s decision.
        </p>
      </fieldset>

      {/**
        * Visibility — a SECOND question, deliberately not a fourth option above.
        *
        * "Who can join" and "who can see" are different, and folding them into
        * one list produces states nobody wants to name while making the useful
        * combination inexpressible: findable, with a door. That is a public club
        * whose joining is set to Invitation only, and it is what a school club
        * asks for.
        *
        * Placed last, after both membership questions, because it is the one
        * with consequences outside the platform — and reading the two joining
        * settings first is what stops "Anyone can see this page" from being read
        * as "anyone can join it".
        */}
      <fieldset className="org-policy-group">
        <legend className="org-policy-legend">Who can see this organization’s page?</legend>
        {VISIBILITIES.map(value => (
          <PolicyOption
            key={value}
            group="visibility"
            value={value}
            copy={VISIBILITY_COPY[value]}
            checked={visibility === value}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </fieldset>
    </div>
  );
}

/**
 * One radio: a title, a consequence, and sometimes a second-order note.
 *
 * The ids are derived from the group and the value, which are both from frozen
 * vocabularies — so they are stable across renders and unique on the page
 * without a counter or a `useId` per option.
 */
function PolicyOption({ group, value, copy, checked, disabled, onChange }) {
  const titleId = `policy-${group}-${value}-title`;
  const descId = `policy-${group}-${value}-desc`;

  return (
    <label className="org-policy-option">
      <input
        type="radio"
        name={group}
        value={value}
        checked={checked}
        disabled={disabled}
        /* The title alone is the name; the sentence is the description. See the
           component header for the run-together name this replaced. */
        aria-labelledby={titleId}
        aria-describedby={descId}
        onChange={() => onChange(group, value)}
      />
      <span className="org-policy-text">
        <span className="org-policy-label" id={titleId}>{copy.label}</span>
        <span className="org-policy-consequence" id={descId}>{copy.consequence}</span>
        {/**
          * The second-order consequence, shown only where it is not obvious.
          *
          * Managers most often assume invitation-only also hides the club, and
          * a public page is the setting where what is actually disclosed is
          * worth listing beside the choice.
          *
          * Inside the described element, so it is read as part of the
          * description rather than being announced separately or not at all.
          */}
        {copy.note && <span className="org-policy-note">{copy.note}</span>}
      </span>
    </label>
  );
}
