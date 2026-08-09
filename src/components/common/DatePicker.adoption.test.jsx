import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../utils/api';
import Signup from '../../views/Signup';
import AdminAuditExplorer from '../../views/AdminAuditExplorer';
import SubjectActions from '../moderation/SubjectActions';

/**
 * The three screens that swapped `<input type="date">` for `DatePicker`.
 *
 * ── Why this file exists separately from DatePicker.test.jsx ──
 *
 * That file proves the component is correct. This one proves the SWAP was, which
 * is a different claim and the one that can quietly go wrong: the component can
 * be perfect and an adoption can still lose the `max` that keeps a date of birth
 * out of the future, or stop the audit filter from reaching the API, or drop the
 * `disabled` that stops a moderator editing a suspension mid-flight.
 *
 * So each case here asserts the behaviour the native input had, through the new
 * control — same value format, same bounds, same required-ness. A styling change
 * that costs a rule is a regression, and unifying five controls is exactly the
 * kind of change that pays for polish with behaviour.
 */

vi.mock('../../utils/api');

/** The picker's own text box for a field, found by the screen's own label. */
const pickerFor = (labelText) => screen.getByLabelText(labelText);
/** The calendar button belonging to the Nth picker on screen. */
const toggles = () => screen.getAllByRole('button', { name: /choose a date/i });

/* ── Signup: the age gate ────────────────────────────────────────────────── */

describe('Signup date of birth', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const mount = () => render(<MemoryRouter><Signup /></MemoryRouter>);

  it('is a DatePicker, not a native date input', () => {
    const { container } = mount();
    expect(container.querySelector('input[type="date"]'), 'the native control is gone').toBeNull();
    expect(container.querySelector('#su-dob.dp-input')).toBeTruthy();
  });

  it('keeps the screen\'s own label wired to the field', () => {
    mount();
    expect(pickerFor('Date of birth')).toHaveAttribute('id', 'su-dob');
  });

  it('still names the field for the API', () => {
    mount();
    expect(pickerFor('Date of birth')).toHaveAttribute('name', 'dateOfBirth');
  });

  /**
   * The rule the native `max` carried: a date of birth cannot be in the future.
   * It was a convenience rather than the check — the server owns the age gate —
   * but losing it means the form cheerfully offers next year.
   */
  it('refuses a future date of birth', () => {
    mount();
    const nextYear = `${new Date().getFullYear() + 1}-06-15`;
    fireEvent.change(pickerFor('Date of birth'), { target: { value: nextYear } });
    fireEvent.blur(pickerFor('Date of birth'));
    expect(pickerFor('Date of birth')).toHaveValue('');
  });

  it('accepts a real past date of birth typed in full', () => {
    mount();
    fireEvent.change(pickerFor('Date of birth'), { target: { value: '2008-04-30' } });
    expect(pickerFor('Date of birth')).toHaveValue('2008-04-30');
  });

  it('opens the calendar on the most recent legal month rather than one nobody wants', () => {
    mount();
    fireEvent.click(toggles()[0]);
    /* `max` is today, and with no value yet the calendar clamps today into range
       — so it opens on this month, not on a month 500 clicks away. */
    const thisMonth = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
      .format(new Date());
    expect(within(screen.getByRole('dialog')).getByRole('grid'))
      .toHaveAccessibleName(thisMonth);
  });

  it('offers a year select reaching back a working lifetime', () => {
    mount();
    fireEvent.click(toggles()[0]);
    const years = [...screen.getByLabelText('Year').options].map(o => o.value);
    expect(years).toContain(String(new Date().getFullYear() - 45));
    expect(years).not.toContain(String(new Date().getFullYear() + 1));
  });

  /**
   * The client-side age gate, which is a blocker sentence rather than a field
   * error: `detailsBlocker` names the first thing missing and disables Continue.
   * The date of birth is the sixth thing it checks, so name and username are
   * filled first to bring it to the front.
   */
  const reachDobBlocker = async () => {
    api.checkUsername.mockResolvedValue({ available: true });
    mount();
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Ada Vale' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'adavale' } });
    await waitFor(() => expect(screen.getByText('Enter your date of birth.')).toBeInTheDocument(),
      { timeout: 3000 });
  };

  it('still blocks the step while the date of birth is empty', async () => {
    await reachDobBlocker();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  /** The swap is only safe if the picker's value reaches the state that gates
   *  the step — this is the assertion that proves the wire is connected. */
  it('stops blocking once a date of birth is given through the picker', async () => {
    await reachDobBlocker();
    fireEvent.change(pickerFor('Date of birth'), { target: { value: '2008-04-30' } });
    await waitFor(() => expect(screen.queryByText('Enter your date of birth.')).not.toBeInTheDocument());
  });

  it('accepts a date chosen from the calendar as well as typed', async () => {
    await reachDobBlocker();
    fireEvent.click(toggles()[0]);
    const grid = within(screen.getByRole('dialog')).getByRole('grid');
    const pickable = [...within(grid).getAllByRole('gridcell')]
      .find(c => c.getAttribute('aria-disabled') === 'false');
    fireEvent.click(pickable);
    expect(pickerFor('Date of birth').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(screen.queryByText('Enter your date of birth.')).not.toBeInTheDocument());
  });

  /**
   * The server's refusal, announced.
   *
   * `errors.dateOfBirth` is set from `err.data.field` — in practice the
   * `under_minimum_age` refusal, the one error on this field with a consequence.
   * The provider path is used because it submits from the step the date of birth
   * is ON, so the message lands beside the field rather than on a later step.
   *
   * Before the swap this rendered a plain `<span>` that announced nothing: a
   * screen-reader user was told only that the form had not gone through. The
   * picker gives it `role="alert"`.
   */
  it('announces a server refusal of the date of birth and marks the field invalid', async () => {
    api.checkUsername.mockResolvedValue({ available: true });
    api.fetchOAuthProviders?.mockResolvedValue?.([]);
    const err = new Error('You need to be older to use WeVolunteer.');
    err.data = { field: 'dateOfBirth' };
    api.signup.mockRejectedValue(err);

    render(
      <MemoryRouter initialEntries={[{
        pathname: '/signup',
        state: { signupData: { provider: 'google', email: 'ada@sbschools.org', name: 'Ada Vale', signupToken: 't' } },
      }]}>
        <Signup />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'adavale' } });
    fireEvent.change(pickerFor('Date of birth'), { target: { value: '2020-04-30' } });
    fireEvent.click(screen.getByLabelText(/agree/i));
    fireEvent.click(screen.getByLabelText(/seen/i));

    const submitBtn = screen.getByRole('button', { name: /Create account/ });
    await waitFor(() => expect(submitBtn).not.toBeDisabled(), { timeout: 3000 });
    fireEvent.click(submitBtn);

    /* Two alerts, both wanted: the form-level one at the top of the page, and the
       field-level one beside the control. Only the second is new, so it is the
       one asserted by position rather than by text. */
    const alerts = await screen.findAllByRole('alert');
    const onTheField = alerts.find(a => a.closest('.dp'));
    expect(onTheField, 'the refusal must be announced beside the field').toBeTruthy();
    expect(onTheField).toHaveTextContent(/older/i);
    expect(pickerFor('Date of birth')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the screen\'s hint reachable from the field', () => {
    mount();
    const ids = pickerFor('Date of birth').getAttribute('aria-describedby').split(/\s+/);
    expect(ids, 'the "why we ask" hint must survive the swap').toContain('su-dob-hint');
  });
});

/* ── AdminAuditExplorer: the From/To filter ──────────────────────────────── */

describe('AdminAuditExplorer date filters', () => {
  const PAGE = {
    logs: [], total: 0, totalPages: 1, page: 1, actions: ['ACCOUNT_SUSPENDED'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAuditLogs.mockResolvedValue(PAGE);
  });

  it('renders both ends as pickers, not native date inputs', async () => {
    const { container } = render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(0);
    expect(container.querySelector('#audit-start.dp-input')).toBeTruthy();
    expect(container.querySelector('#audit-end.dp-input')).toBeTruthy();
  });

  it('sends startDate to the API when From is set', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
    fireEvent.change(pickerFor('From'), { target: { value: '2026-08-01' } });
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: '2026-08-01' }),
    ));
  });

  it('sends endDate to the API when To is set', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
    fireEvent.change(pickerFor('To'), { target: { value: '2026-08-31' } });
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ endDate: '2026-08-31' }),
    ));
  });

  it('keeps both ends independent, so a one-sided range still works', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
    fireEvent.change(pickerFor('From'), { target: { value: '2026-08-01' } });
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: '2026-08-01', endDate: '' }),
    ));
  });

  /**
   * The behaviour the search box was deliberately kept OUT of, and which the date
   * fields have always had: changing a filter refetches and returns to page 1.
   * Page 3 of one range is not page 3 of the next.
   */
  it('returns to page 1 when a date filter changes', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
    fireEvent.change(pickerFor('From'), { target: { value: '2026-08-01' } });
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1 }),
    ));
  });

  it('leaves the non-date filters working through the shared handler', async () => {
    render(<AdminAuditExplorer />);
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'ACCOUNT_SUSPENDED' } });
    await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'ACCOUNT_SUSPENDED' }),
    ));
  });
});

/* ── SubjectActions: the day a suspension lifts ──────────────────────────── */

describe('SubjectActions suspension end date', () => {
  const SUBJECT = { id: 'u_org', name: 'Chris Vale', accountStatus: 'active', suspendedUntil: null };
  const ADMIN = { id: 'a1', role: 'super_admin', capabilities: ['*'] };
  const REASON = 'Messaging a student after being asked to stop.';

  beforeEach(() => { vi.clearAllMocks(); });

  const openSuspend = () => {
    render(<SubjectActions subject={SUBJECT} user={ADMIN} addToast={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Suspend$/ }));
    fireEvent.change(
      screen.getByRole('textbox', { name: /Why are you suspending them/ }),
      { target: { value: REASON } },
    );
  };

  it('is a DatePicker, not a native date input', () => {
    const { container } = render(<SubjectActions subject={SUBJECT} user={ADMIN} addToast={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Suspend$/ }));
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('#subject-action-until.dp-input')).toBeTruthy();
  });

  /**
   * The end-of-day conversion, which is the one thing about this field that has
   * ever been wrong: `YYYY-MM-DD` read as an instant is UTC midnight, so "until
   * the 14th" would end the suspension as the 14th began. The picker still hands
   * back the same `YYYY-MM-DD`, so the fix downstream is untouched — this asserts
   * it end to end rather than trusting that.
   */
  it('still ends a chosen day at the end of that day', async () => {
    api.suspendUser.mockResolvedValue({});
    openSuspend();
    fireEvent.change(pickerFor(/Until/), { target: { value: '2026-09-14' } });
    fireEvent.click(screen.getByRole('button', { name: /Suspend this account/ }));

    await waitFor(() => expect(api.suspendUser).toHaveBeenCalled());
    const sent = new Date(api.suspendUser.mock.calls[0][1].until);
    expect(sent.getFullYear()).toBe(2026);
    expect(sent.getMonth()).toBe(8);
    expect(sent.getDate()).toBe(14);
    expect(sent.getHours()).toBe(23);
  });

  it('can be picked from the calendar as well as typed', async () => {
    api.suspendUser.mockResolvedValue({});
    openSuspend();
    fireEvent.click(screen.getByRole('button', { name: /choose a date/i }));
    fireEvent.click(document.querySelector('[data-dp-iso="2026-09-14"]')
      ?? within(screen.getByRole('dialog')).getAllByRole('gridcell')[10]);
    expect(pickerFor(/Until/).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('still means "no end date" when left empty', async () => {
    api.suspendUser.mockResolvedValue({});
    openSuspend();
    fireEvent.click(screen.getByRole('button', { name: /Suspend this account/ }));
    await waitFor(() => expect(api.suspendUser).toHaveBeenCalledWith('u_org', {
      reason: REASON, until: null,
    }));
  });

  /** It is optional, so it must not acquire a required marker in the swap. */
  it('stays optional', () => {
    openSuspend();
    expect(pickerFor(/Until/)).not.toBeRequired();
  });

  it('is disabled while the suspension is in flight, like the rest of the form', async () => {
    let release;
    api.suspendUser.mockReturnValue(new Promise(r => { release = r; }));
    openSuspend();
    fireEvent.click(screen.getByRole('button', { name: /Suspend this account/ }));
    await waitFor(() => expect(pickerFor(/Until/)).toBeDisabled());
    expect(screen.getByRole('button', { name: /choose a date/i })).toBeDisabled();
    release({});
  });

  it('offers no end-date picker when lifting a suspension', () => {
    const SUSPENDED = { ...SUBJECT, accountStatus: 'suspended' };
    render(<SubjectActions subject={SUSPENDED} user={ADMIN} addToast={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Lift the suspension/ }));
    expect(screen.queryByLabelText(/Until/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose a date/i })).not.toBeInTheDocument();
  });
});
