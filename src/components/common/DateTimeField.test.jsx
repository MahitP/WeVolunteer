import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DateTimeField from './DateTimeField';
import CalendarView from '../../views/CalendarView';
import { LocationProvider } from '../../contexts/LocationContext';

vi.mock('../../utils/api', () => ({ api: new Proxy({}, { get: () => vi.fn().mockResolvedValue(null) }) }));

/**
 * One date picker, everywhere (ruling 8).
 *
 * The owner asked for the app's own date picker "basically everywhere" (P2-16)
 * and for the application-close field to open it on a click rather than ask for
 * digits (LG-11). Five screens had moved to it; the event edit form, the
 * dashboard's quick edit, the organization share dialog and the Legal Center
 * editor still drew the browser's own control, and the calendar had no way to
 * jump to a date. Typing stays, as the keyboard and screen-reader route.
 */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.jsx$/.test(entry.name) && !/\.test\.jsx$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('no browser date control is left', () => {
  it('has no type="date" or type="datetime-local" input anywhere under src/', () => {
    const offenders = walk(path.join(process.cwd(), 'src'))
      .filter(f => /type=["'](date|datetime-local)["']/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')))
      .map(f => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});

describe('DateTimeField', () => {
  it('composes a day from the picker and a time into the value a datetime input gave', () => {
    const onChange = vi.fn();
    render(<DateTimeField id="dt" label="Starts" timeLabel="Start time" value="" onChange={onChange} defaultTime="09:00" />);
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-14' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-14T09:00');
  });

  it('keeps the day when the time changes, and the time when the day does', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DateTimeField id="dt" label="Starts" timeLabel="Start time" value="2026-11-14T09:00" onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '13:30' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-14T13:30');
    rerender(<DateTimeField id="dt" label="Starts" timeLabel="Start time" value="2026-11-14T13:30" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-15' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-15T13:30');
  });

  it('opens the calendar when the date box is clicked (LG-11)', () => {
    render(<DateTimeField id="dt" label="Applications close" timeLabel="Closing time" value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Applications close'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('labels both halves, so neither is an unnamed box', () => {
    render(<DateTimeField id="dt" label="Ends" timeLabel="End time" value="2026-11-14T11:00" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Ends')).toHaveValue('2026-11-14');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00');
  });
});

describe('the calendar jumps to a date', () => {
  it('moves to the month of the date chosen, and selects that day', () => {
    render(
      <MemoryRouter>
        <LocationProvider>
          <CalendarView currentUser={{ id: 's', role: 'student', withheld: [] }} events={[]} applications={[]} onViewEvent={vi.fn()} />
        </LocationProvider>
      </MemoryRouter>,
    );
    const target = new Date();
    target.setMonth(target.getMonth() + 5, 9);
    const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-09`;
    fireEvent.change(screen.getByLabelText('Go to date'), { target: { value: iso } });
    const monthLabel = target.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    expect(screen.getByText(monthLabel)).toBeInTheDocument();
    expect(document.querySelector('.cal-day.is-selected .cal-date')?.textContent).toBe('9');
  });
});

/**
 * Clearing the time never sends half a value (final audit, Phase 6 review).
 *
 * The time box's clear button sent `${day}T` — "2026-10-11T". The edit form
 * then drew the date blank as well (it could not parse it), its "missing"
 * check passed on the truthy string, and Save threw `RangeError: Invalid time
 * value` with nothing shown to the organizer.
 */
describe('clearing the time', () => {
  it('keeps the last whole value rather than sending "YYYY-MM-DDT"', () => {
    const onChange = vi.fn();
    render(<DateTimeField id="t" label="Applications close" timeLabel="Closing time"
      value="2026-10-11T17:00" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Closing time'), { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Closing time')).toHaveValue('17:00');
  });

  it('still sends a new time when one is typed', () => {
    const onChange = vi.fn();
    render(<DateTimeField id="t" label="Applications close" timeLabel="Closing time"
      value="2026-10-11T17:00" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Closing time'), { target: { value: '18:30' } });
    expect(onChange).toHaveBeenCalledWith('2026-10-11T18:30');
  });
});
