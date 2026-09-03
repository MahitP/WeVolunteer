import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MembershipPolicyFields from './MembershipPolicyFields';
import { JOIN_POLICIES, INVITE_POLICIES } from '../../organizationPolicy';

/**
 * The settings a manager reads before deciding who can get into their club.
 *
 * ── Why the copy is the subject of this file ──
 *
 * The values are `open`, `invite` and `request`, and a screen that showed those
 * would have told the manager the value and not the effect. The whole point of
 * this component is that every option carries one sentence of consequence, so
 * the assertions are on the sentences: a refactor that kept the radios and lost
 * the explanations would have removed the reason the component exists while
 * leaving it functional.
 *
 * The second-order note on invitation-only is asserted by itself, because it is
 * the assumption managers actually make — that going invite-only also hides the
 * club — and it does not.
 */

const show = (over = {}) => {
  const onChange = vi.fn();
  render(
    <MembershipPolicyFields
      joinPolicy="open"
      invitePolicy="helpers"
      onChange={onChange}
      {...over}
    />,
  );
  return onChange;
};

describe('who can join', () => {
  it('asks the question as a question', () => {
    show();
    expect(screen.getByRole('group', { name: 'Who can join?' })).toBeInTheDocument();
  });

  it('offers every mode the server accepts, and no others', () => {
    show();
    const radios = screen.getAllByRole('radio', { name: /Anyone|Invitation only|Request to join/ });
    expect(radios).toHaveLength(JOIN_POLICIES.length);
  });

  it('says what each one does', () => {
    show();
    expect(screen.getByText('Students can join this organization straight away.')).toBeInTheDocument();
    expect(screen.getByText(/Students need this organization’s invitation link to join/)).toBeInTheDocument();
    expect(screen.getByText('Students ask to join, and a manager accepts or declines.')).toBeInTheDocument();
  });

  /**
   * The assumption this note exists to correct.
   *
   * §17 of the brief and the join route agree: an invitation-only club is still
   * listed in search. A manager who believed otherwise would choose this setting
   * for privacy it does not provide.
   */
  it('corrects the assumption that invitation-only means hidden', () => {
    show();
    expect(screen.getByText(/still appears in search/)).toBeInTheDocument();
    expect(screen.getByText(/told they need one/)).toBeInTheDocument();
  });

  it('marks the current setting', () => {
    show({ joinPolicy: 'request' });
    expect(screen.getByRole('radio', { name: /Request to join/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Anyone/ })).not.toBeChecked();
  });

  it('reports a change by the field name the API expects', () => {
    const onChange = show();
    fireEvent.click(screen.getByRole('radio', { name: /Invitation only/ }));
    expect(onChange).toHaveBeenCalledWith('joinPolicy', 'invite');
  });
});

describe('who can share the link', () => {
  it('asks its own question', () => {
    show();
    expect(screen.getByRole('group', { name: 'Who can share the invitation link?' })).toBeInTheDocument();
  });

  it('offers exactly the two the server accepts', () => {
    show();
    const radios = screen.getAllByRole('radio', { name: /Managers and student organizers|Any member/ });
    expect(radios).toHaveLength(INVITE_POLICIES.length);
  });

  it('reports a change by the field name the API expects', () => {
    const onChange = show();
    fireEvent.click(screen.getByRole('radio', { name: /Any member/ }));
    expect(onChange).toHaveBeenCalledWith('invitePolicy', 'members');
  });

  /**
   * The limit of the setting, where somebody would otherwise assume it goes
   * further.
   *
   * "Any member can share the link" does not mean any member can decide what the
   * link is — and replacing a link stops every copy already handed out from
   * working, which is precisely what a manager choosing the wider option needs
   * to know is still theirs.
   */
  it('says that making and replacing the link stays with managers', () => {
    show();
    expect(screen.getByText(/always a manager’s decision/)).toBeInTheDocument();
  });
});

describe('while a save is in flight', () => {
  it('locks every control rather than only the one pressed', () => {
    show({ disabled: true });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
