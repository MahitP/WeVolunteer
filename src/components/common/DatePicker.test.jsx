import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DatePicker from './DatePicker';

/**
 * Cover for the app's one date control.
 *
 * ── Why this component exists at all ──
 *
 * Five screens used `<input type="date">`: Signup, AdminAuditExplorer,
 * SubjectActions, BrowseEvents and CreateEvent. A native date input is a
 * different control in every browser — a text box with a tiny icon in one, a
 * three-segment spinner in another, a full-screen wheel on iOS — and none of them
 * take the app's tokens, so the one control on the sign-up form that a
 * fourteen-year-old must fill in was also the only one that did not look like the
 * product. Dark mode was worse: the picker chrome stayed light.
 *
 * ── What these tests pin, and why each one is here ──
 *
 * The value contract (`YYYY-MM-DD` in and out) is the whole reason a swap at five
 * call sites is safe, so it is asserted first and from both directions.
 *
 * Everything after it is keyboard and screen-reader behaviour. A hand-rolled
 * calendar is the classic place accessibility is lost — a grid of `<div onClick>`
 * is unreachable by Tab, has no announced dates, and traps a keyboard user with
 * no way out. `dialogSemantics.test.jsx` exists in this repo because two dialogs
 * had shipped exactly that way. So the arrow keys, PageUp/PageDown, Home/End,
 * Escape-restores-focus and the `role="grid"` wiring are asserted rather than
 * assumed, and a regression in any of them fails the build.
 *
 * The locale is pinned to `en-US` throughout. The component reads month and
 * weekday names from `Intl`, and asserting against the test runner's ambient
 * locale is how a suite passes on a laptop and fails in CI.
 */

const LOCALE = 'en-US';

/** A controlled host, because the component is controlled and half of what is
 *  worth testing is what it does with a value coming back down. */
function Host({ initial = '', onChange, ...props }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="dp">When</label>
      <DatePicker
        id="dp"
        locale={LOCALE}
        value={value}
        onChange={(next) => { setValue(next); onChange?.(next); }}
        {...props}
      />
    </>
  );
}

const input = () => screen.getByLabelText('When');
const toggle = () => screen.getByRole('button', { name: /choose a date/i });
const open = () => fireEvent.click(toggle());
const dialog = () => screen.getByRole('dialog');
/** A day cell by its full accessible name, e.g. /14 September 2026/ — the label
 *  a screen reader reads, not the bare number a sighted user sees. */
const cell = (iso) => document.querySelector(`[data-dp-iso="${iso}"]`);

describe('DatePicker — the value contract', () => {
  it('shows a controlled ISO value in the text input', () => {
    render(<Host initial="2026-09-14" />);
    expect(input()).toHaveValue('2026-09-14');
  });

  it('shows an empty input for an empty value', () => {
    render(<Host initial="" />);
    expect(input()).toHaveValue('');
  });

  it('calls onChange with the ISO string when a day is picked', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" onChange={onChange} />);
    open();
    fireEvent.click(cell('2026-09-21'));
    expect(onChange).toHaveBeenCalledWith('2026-09-21');
  });

  it('reflects the new value back into the input after a pick', () => {
    render(<Host initial="2026-09-14" />);
    open();
    fireEvent.click(cell('2026-09-02'));
    expect(input()).toHaveValue('2026-09-02');
  });

  it('closes after a pick and returns focus to the trigger', () => {
    render(<Host initial="2026-09-14" />);
    open();
    fireEvent.click(cell('2026-09-02'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());
  });
});

describe('DatePicker — typing', () => {
  /**
   * The reason the text input is not read-only.
   *
   * Signup asks for a date of birth. Somebody born in 1979 is ~560 months back
   * from today, and a calendar with only month arrows makes that a click
   * marathon. Typing has to work, and so do the month/year selects below.
   */
  it('accepts a typed ISO date', () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '1979-05-14' } });
    expect(onChange).toHaveBeenCalledWith('1979-05-14');
  });

  it('accepts the locale field order for a year-last date', () => {
    // en-US is month-first, so 5/14/1979 is 14 May, not an invalid 5 Fourteenuary.
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '5/14/1979' } });
    expect(onChange).toHaveBeenCalledWith('1979-05-14');
  });

  it('does not fire onChange for text that is not yet a date', () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '1979-0' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an impossible date rather than rolling it over', () => {
    // `new Date(1979, 1, 30)` is 2 March. A date input must not silently
    // reinterpret what somebody typed.
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '1979-02-30' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clearing the text clears the value', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('restores the committed value when the text is left unparseable on blur', () => {
    render(<Host initial="2026-09-14" />);
    fireEvent.change(input(), { target: { value: 'not a date' } });
    fireEvent.blur(input());
    expect(input()).toHaveValue('2026-09-14');
  });
});

describe('DatePicker — accessible structure', () => {
  it('gives the popup a role and an accessible name', () => {
    render(<Host initial="2026-09-14" />);
    open();
    expect(dialog()).toHaveAccessibleName(/choose a date/i);
  });

  it('names the trigger', () => {
    render(<Host initial="2026-09-14" />);
    expect(toggle()).toHaveAccessibleName(/choose a date/i);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    open();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the days as a real grid of gridcells', () => {
    render(<Host initial="2026-09-14" />);
    open();
    const grid = within(dialog()).getByRole('grid');
    expect(grid).toHaveAccessibleName(/september 2026/i);
    expect(within(grid).getAllByRole('gridcell').length).toBe(42);
  });

  it('exposes the whole date on a cell, not just the number', () => {
    render(<Host initial="2026-09-14" />);
    open();
    // "14" alone tells a screen-reader user nothing about which month they are in.
    expect(cell('2026-09-14')).toHaveAttribute('aria-label', expect.stringMatching(/September 14, 2026/));
  });

  it('marks the selected day with aria-selected and nothing else', () => {
    render(<Host initial="2026-09-14" />);
    open();
    expect(cell('2026-09-14')).toHaveAttribute('aria-selected', 'true');
    expect(cell('2026-09-15')).toHaveAttribute('aria-selected', 'false');
  });

  it('announces the visible month in a live region', () => {
    render(<Host initial="2026-09-14" />);
    open();
    const live = document.querySelector('[data-dp-live]');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveTextContent(/September 2026/i);
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(live).toHaveTextContent(/October 2026/i);
  });

  it('renders an error with role="alert" and marks the input invalid', () => {
    render(<Host initial="" error="Enter your date of birth." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your date of birth.');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
  });

  it('has no alert and is not invalid without an error', () => {
    render(<Host initial="" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the caller\'s aria-describedby alongside its own', () => {
    render(<Host initial="" describedBy="outside-hint" error="Nope." />);
    const ids = input().getAttribute('aria-describedby').split(/\s+/);
    expect(ids).toContain('outside-hint');
    expect(ids.length).toBeGreaterThan(1);
  });
});

describe('DatePicker — min, max and disabled days', () => {
  it('marks a day before min as aria-disabled and refuses to select it', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" min="2026-09-10" onChange={onChange} />);
    open();
    expect(cell('2026-09-09')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(cell('2026-09-09'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks a day after max as aria-disabled and refuses to select it', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" max="2026-09-20" onChange={onChange} />);
    open();
    expect(cell('2026-09-21')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(cell('2026-09-21'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves days inside the range selectable', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" min="2026-09-10" max="2026-09-20" onChange={onChange} />);
    open();
    expect(cell('2026-09-11')).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(cell('2026-09-11'));
    expect(onChange).toHaveBeenCalledWith('2026-09-11');
  });

  it('honours an arbitrary isDateDisabled predicate', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" isDateDisabled={(iso) => iso === '2026-09-16'} onChange={onChange} />);
    open();
    expect(cell('2026-09-16')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(cell('2026-09-16'));
    expect(onChange).not.toHaveBeenCalled();
    expect(cell('2026-09-17')).toHaveAttribute('aria-disabled', 'false');
  });

  it('will not step past max with the keyboard', () => {
    render(<Host initial="2026-09-20" max="2026-09-20" />);
    open();
    const grid = within(dialog()).getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(cell('2026-09-20')).toHaveAttribute('tabindex', '0');
  });

  it('opens on max when there is no value, so a birth date does not start 500 months away', () => {
    render(<Host initial="" max="2008-04-30" />);
    open();
    expect(within(dialog()).getByRole('grid')).toHaveAccessibleName(/April 2008/i);
  });
});

describe('DatePicker — keyboard', () => {
  const openAtSeptember = () => {
    render(<Host initial="2026-09-14" />);
    open();
    return within(dialog()).getByRole('grid');
  };

  it('starts with the selected day as the single tab stop in the grid', () => {
    openAtSeptember();
    expect(cell('2026-09-14')).toHaveAttribute('tabindex', '0');
    expect(cell('2026-09-15')).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(cell('2026-09-14'));
  });

  it('moves a day with ArrowRight and ArrowLeft', () => {
    const grid = openAtSeptember();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cell('2026-09-15'));
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cell('2026-09-13'));
  });

  it('moves a week with ArrowDown and ArrowUp', () => {
    const grid = openAtSeptember();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cell('2026-09-21'));
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cell('2026-09-07'));
  });

  it('moves a month with PageDown and PageUp', () => {
    const grid = openAtSeptember();
    fireEvent.keyDown(grid, { key: 'PageDown' });
    expect(document.activeElement).toBe(cell('2026-10-14'));
    fireEvent.keyDown(grid, { key: 'PageUp' });
    fireEvent.keyDown(grid, { key: 'PageUp' });
    expect(document.activeElement).toBe(cell('2026-08-14'));
  });

  it('clamps PageDown onto the last day of a shorter month', () => {
    // 31 January + one month is not 31 February.
    render(<Host initial="2026-01-31" />);
    open();
    fireEvent.keyDown(within(dialog()).getByRole('grid'), { key: 'PageDown' });
    expect(document.activeElement).toBe(cell('2026-02-28'));
  });

  it('goes to the bounds of the week with Home and End', () => {
    // 14 September 2026 is a Monday; the grid is Monday-first, like CalendarView.
    const grid = openAtSeptember();
    fireEvent.keyDown(grid, { key: 'End' });
    expect(document.activeElement).toBe(cell('2026-09-20'));
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(document.activeElement).toBe(cell('2026-09-14'));
  });

  it('selects the focused day with Enter', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" onChange={onChange} />);
    open();
    const grid = within(dialog()).getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('2026-09-15');
  });

  it('selects the focused day with Space', () => {
    const onChange = vi.fn();
    render(<Host initial="2026-09-14" onChange={onChange} />);
    open();
    const grid = within(dialog()).getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith('2026-09-21');
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const grid = openAtSeptember();
    fireEvent.keyDown(grid, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());
  });

  it('closes on Escape pressed anywhere in the popup, not only the grid', () => {
    render(<Host initial="2026-09-14" />);
    open();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());
  });

  it('cycles Tab within the popup rather than leaking to the page behind', () => {
    render(<Host initial="2026-09-14" />);
    open();
    const stops = [...dialog().querySelectorAll('[data-dp-stop]')];
    expect(stops.length).toBeGreaterThan(2);
    stops[stops.length - 1].focus();
    fireEvent.keyDown(dialog(), { key: 'Tab' });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
  });

  it('opens from the trigger with the keyboard and lands in the grid', () => {
    render(<Host initial="2026-09-14" />);
    fireEvent.click(toggle());
    expect(document.activeElement).toBe(cell('2026-09-14'));
  });
});

describe('DatePicker — dismissal', () => {
  it('closes on an outside click', () => {
    render(<Host initial="2026-09-14" />);
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays open when the click is inside the popup', () => {
    render(<Host initial="2026-09-14" />);
    open();
    fireEvent.mouseDown(dialog());
    expect(screen.queryByRole('dialog')).toBeInTheDocument();
  });
});

describe('DatePicker — month and year selects', () => {
  /** The direct route to a distant year, which is what makes a DOB bearable. */
  it('jumps the visible month with the month select', () => {
    render(<Host initial="2026-09-14" />);
    open();
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '0' } });
    expect(within(dialog()).getByRole('grid')).toHaveAccessibleName(/January 2026/i);
  });

  it('jumps the visible year with the year select', () => {
    render(<Host initial="2026-09-14" max="2026-12-31" />);
    open();
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '1979' } });
    expect(within(dialog()).getByRole('grid')).toHaveAccessibleName(/September 1979/i);
  });

  it('offers a hundred years back from max, so a birth year is one choice', () => {
    render(<Host initial="" max="2026-08-08" />);
    open();
    const years = [...screen.getByLabelText('Year').options].map(o => o.value);
    expect(years).toContain('1979');
    expect(years).toContain('2026');
    expect(years).not.toContain('2027');
  });
});

describe('DatePicker — disabled', () => {
  it('does not open when disabled', () => {
    render(<Host initial="2026-09-14" disabled />);
    expect(input()).toBeDisabled();
    expect(toggle()).toBeDisabled();
    open();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
