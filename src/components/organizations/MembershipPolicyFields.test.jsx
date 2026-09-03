import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import MembershipPolicyFields from './MembershipPolicyFields';
import { JOIN_POLICIES, INVITE_POLICIES, VISIBILITIES } from '../../organizationPolicy';

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
 *
 * ── Why the radio queries are scoped to their group ──
 *
 * There are now three groups, and "Anyone" appears in two of them ("Anyone" who
 * can join, "Anyone can see this page"). An unscoped name query matched across
 * both and counted four radios where the join question has three — which is the
 * same class of bug the component exists to prevent, found in its own test.
 *
 * ── And why an exact name is asserted at all ──
 *
 * Every radio's accessible name used to be its title and its whole consequence
 * sentence run together with no space — `AnyoneStudents can join this
 * organization straight away.` — because the input was wrapped in a label
 * containing both. The name is now the title alone, with the sentence as the
 * description, so an exact-string query is the assertion that keeps it that
 * way: a regression to the concatenated name fails `name: 'Anyone'`
 * immediately.
 */

const show = (over = {}) => {
  const onChange = vi.fn();
  render(
    <MembershipPolicyFields
      joinPolicy="open"
      invitePolicy="helpers"
      visibility="unlisted"
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
    const group = screen.getByRole('group', { name: 'Who can join?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(JOIN_POLICIES.length);
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
    expect(screen.getByText(/can still find you in search/)).toBeInTheDocument();
    expect(screen.getByText(/told they need a link/)).toBeInTheDocument();
    /* And points at the setting that DOES decide it, so a manager reaching for
       privacy is sent to the right question rather than left with this one. */
    expect(screen.getByText(/separate setting below/)).toBeInTheDocument();
  });

  /**
   * The warning a manager switching to invitation-only actually needs.
   *
   * Nothing rotates a club's links when the policy tightens — a link on a
   * printed flyer has to keep working — so a link shared publicly while the
   * club was open becomes the way in the moment this is chosen. The share
   * dialog now says the same thing from the other side.
   */
  it('warns that links already shared become a way in', () => {
    show();
    expect(screen.getByText(/already shared becomes a way in/)).toBeInTheDocument();
    expect(screen.getByText(/regenerate any you put somewhere public/)).toBeInTheDocument();
  });

  it('marks the current setting', () => {
    show({ joinPolicy: 'request' });
    const group = screen.getByRole('group', { name: 'Who can join?' });
    expect(within(group).getByRole('radio', { name: /Request to join/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Anyone' })).not.toBeChecked();
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

describe('who can see the page', () => {
  it('asks the question as a question', () => {
    show();
    expect(screen.getByRole('group', { name: 'Who can see this organization’s page?' }))
      .toBeInTheDocument();
  });

  it('offers exactly the two values the server accepts', () => {
    show();
    const group = screen.getByRole('group', { name: /Who can see/ });
    expect(within(group).getAllByRole('radio')).toHaveLength(VISIBILITIES.length);
  });

  /**
   * The disclosure, listed beside the choice.
   *
   * A manager of a club full of children is entitled to read what a public page
   * publishes before agreeing to it, rather than being sent to the privacy
   * notice — and the list is also the assertion that the public projection has
   * not quietly grown. If member names ever appear on a public page, this
   * sentence becomes false and this test is where that is noticed.
   */
  it('says what a public page shows, and what it never shows', () => {
    show();
    expect(screen.getByText(/works without an account/)).toBeInTheDocument();
    expect(screen.getByText(/never who is in it, and never where an event is/))
      .toBeInTheDocument();
  });

  it('says an unlisted club still works through its invitation links', () => {
    show();
    expect(screen.getByText(/Somebody without an account sees nothing at all/))
      .toBeInTheDocument();
    expect(screen.getByText(/invitation links still work/)).toBeInTheDocument();
  });

  it('reports a change by the field name the API expects', () => {
    const onChange = show();
    const group = screen.getByRole('group', { name: /Who can see/ });
    fireEvent.click(within(group).getByRole('radio', { name: 'Anyone can see this page' }));
    expect(onChange).toHaveBeenCalledWith('visibility', 'public');
  });

  /**
   * The two axes are independent, and this is the assertion that says so.
   *
   * A public club that admits by invitation is the combination a school club
   * actually asks for, and it is precisely the one a single four-value enum
   * could not express. If somebody ever folds visibility back into the join
   * modes, this fails.
   */
  it('lets a club be public and invitation-only at the same time', () => {
    show({ joinPolicy: 'invite', visibility: 'public' });
    const joining = screen.getByRole('group', { name: 'Who can join?' });
    const seeing = screen.getByRole('group', { name: /Who can see/ });
    expect(within(joining).getByRole('radio', { name: 'Invitation only' })).toBeChecked();
    expect(within(seeing).getByRole('radio', { name: 'Anyone can see this page' })).toBeChecked();
  });
});

describe('while a save is in flight', () => {
  it('locks every control rather than only the one pressed', () => {
    show({ disabled: true });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
