import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * The application's date control. One of these, everywhere a date is asked for.
 *
 * ── The incident ──
 *
 * Five screens each rendered a bare `<input type="date">`: Signup (date of
 * birth), AdminAuditExplorer (a From/To filter range), SubjectActions (the day a
 * suspension lifts), BrowseEvents and CreateEvent. A native date input is a
 * different control in every engine — a text box with a hairline icon in one, a
 * three-segment spinner in another, a full-screen wheel on iOS — and none of them
 * accept `--input-bg`, `--rule` or `--brand`. So the app had five dates that each
 * looked like the browser rather than the product, and in dark mode the picker
 * chrome stayed light while everything around it went dark.
 *
 * It was worst on Signup. The date of birth is the age gate: it is the one field
 * on that form a fourteen-year-old cannot skip, and it was the one field that did
 * not look like the rest of the form.
 *
 * ── Why the text input is not read-only ──
 *
 * The other half of the Signup problem. A calendar with only month arrows puts a
 * 1979 birth date about 560 clicks away, which is not a date picker, it is a
 * punishment. So there are three routes to any date and all of them work:
 *
 *   1. type it — see `parseTyped`
 *   2. the month and year selects in the popup header
 *   3. the grid, by mouse or by keyboard
 *
 * and the calendar opens on `value`, else on `max` clamped into range, else
 * today. With `max` set to today, Signup's calendar therefore opens on the most
 * recent legal answer rather than on a month nobody wants.
 *
 * ── Why typed input never guesses the field order ──
 *
 * `05/14/1979` and `14/05/1979` are both real conventions and picking wrong
 * silently stores the wrong date of birth, which is the one field here with a
 * legal consequence. So a year-first string is read in ISO order, and a year-last
 * string is read in the order `Intl` reports for the locale — read, not guessed —
 * with the opposite order used only when the locale's own order cannot produce a
 * real date. Nothing is ever rolled over: `1979-02-30` is refused, where
 * `new Date(1979, 1, 30)` would have quietly answered 2 March.
 *
 * ── Dates are handled as local calendar days, never as instants ──
 *
 * Every date here is a `YYYY-MM-DD` string, and every conversion goes through
 * `new Date(y, m, d)`. `new Date('2026-09-14')` parses as UTC MIDNIGHT, so west
 * of Greenwich it is the 13th — the same off-by-a-day that SubjectActions
 * documents in its suspension window. There is no `Date` constructed from an ISO
 * string anywhere in this file, on purpose.
 *
 * ── Theming and accessibility are not negotiable here ──
 *
 * Every colour is a token, so light and dark both come from `[data-theme]` with
 * no second code path. The popup is a `role="dialog"` with a name, the days are a
 * real `role="grid"` of `gridcell`s each carrying its FULL date rather than a bare
 * number, focus is trapped while open and returned to the trigger on close, and
 * the grid keeps a single tab stop with a roving `tabindex` as the ARIA grid
 * pattern requires. `dialogSemantics.test.jsx` exists in this repo because two
 * dialogs shipped as unreachable `<div onClick>` soup; a calendar is the easiest
 * place in an app to repeat that.
 *
 * @param {object}   props
 * @param {string}   [props.id]             id of the text input, so an external `<label htmlFor>` works
 * @param {string}   [props.name]           forwarded to the text input
 * @param {string}   props.value            the selected day as `YYYY-MM-DD`, or `''`
 * @param {(iso: string) => void} props.onChange  called with `YYYY-MM-DD`, or `''` when cleared
 * @param {string}   [props.min]            earliest selectable day, `YYYY-MM-DD`
 * @param {string}   [props.max]            latest selectable day, `YYYY-MM-DD`
 * @param {(iso: string) => boolean} [props.isDateDisabled]  refuse individual days
 * @param {string}   [props.label]          renders an internal `<label>`; omit when the caller has its own
 * @param {string}   [props.error]          shown with `role="alert"`; also marks the input invalid
 * @param {boolean}  [props.required]
 * @param {boolean}  [props.disabled]
 * @param {string}   [props.inputClassName] extra classes for the text input (e.g. `input-lg`)
 * @param {string}   [props.className]      extra classes for the wrapper
 * @param {string}   [props.describedBy]    caller's `aria-describedby`, kept alongside this component's own
 * @param {string}   [props.placeholder]
 * @param {string}   [props.locale]         overrides the ambient locale; tests pin it
 */

/* ── Calendar arithmetic ─────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for a y/m/d triple, or null when that day does not exist. */
function makeIso(y, month1, day) {
  if (!Number.isInteger(y) || !Number.isInteger(month1) || !Number.isInteger(day)) return null;
  if (y < 1 || y > 9999 || month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  const d = new Date(y, month1 - 1, day);
  /* The round trip is the validation. `new Date(1979, 1, 30)` is 2 March, so
     without this check an impossible date would be accepted as a real one. */
  if (d.getFullYear() !== y || d.getMonth() !== month1 - 1 || d.getDate() !== day) return null;
  return `${y < 1000 ? String(y).padStart(4, '0') : y}-${pad(month1)}-${pad(day)}`;
}

/** `{ y, m, d }` (m is 0-based) for a strict `YYYY-MM-DD`, else null. */
function parseIso(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = +m[1], month1 = +m[2], day = +m[3];
  if (!makeIso(y, month1, day)) return null;
  return { y, m: month1 - 1, d: day };
}

/** A local `Date` at noon. Noon, not midnight, so a DST transition that shifts a
 *  day by an hour cannot move it onto the day before. */
const dateOf = (y, m, d) => new Date(y, m, d, 12);

const isoOf = (date) => makeIso(date.getFullYear(), date.getMonth() + 1, date.getDate());

const shiftDays = (iso, days) => {
  const p = parseIso(iso);
  if (!p) return iso;
  return isoOf(dateOf(p.y, p.m, p.d + days));
};

/** Same day-of-month in another month, clamped: 31 January + 1 month is 28/29 February. */
function shiftMonths(iso, months) {
  const p = parseIso(iso);
  if (!p) return iso;
  const y = p.y;
  const target = new Date(y, p.m + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return makeIso(target.getFullYear(), target.getMonth() + 1, Math.min(p.d, lastDay));
}

const todayIso = () => isoOf(new Date());

/* ISO dates sort lexicographically, which is why the wire format is worth
   keeping all the way through this file: no comparison needs a Date at all. */
const clampIso = (iso, min, max) => {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
};

/**
 * Monday-first, matching `CalendarView`'s grid.
 *
 * Not read from the locale: the two calendars in this app sit two clicks apart
 * and a week that starts on a different day in each is a bug report waiting to
 * happen. One convention, stated once.
 */
const WEEK_START = 1;

/** The 42 days of a 6×7 grid covering `year`/`month`, Monday-first.
 *
 *  Always 42, never 35: a grid that changes height between months makes the
 *  buttons under it jump, and a control that moves as you use it gets misclicked. */
function monthGrid(year, month) {
  const first = dateOf(year, month, 1);
  const lead = (first.getDay() - WEEK_START + 7) % 7;
  const start = dateOf(year, month, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = dateOf(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { iso: isoOf(d), inMonth: d.getMonth() === month, day: d.getDate() };
  });
}

/* ── Locale-driven formatting and parsing ────────────────────────────────── */

function formatter(locale, options) {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    /* An unknown locale tag must not take the whole form down with it. */
    return new Intl.DateTimeFormat(undefined, options);
  }
}

/** True when the locale writes the day before the month in a numeric date. */
function localeIsDayFirst(locale) {
  try {
    const parts = formatter(locale, { year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(dateOf(2024, 0, 2));
    const day = parts.findIndex(p => p.type === 'day');
    const month = parts.findIndex(p => p.type === 'month');
    return day !== -1 && month !== -1 && day < month;
  } catch {
    return false;
  }
}

/**
 * What somebody typed, as an ISO date, or null.
 *
 * Accepts `-`, `/` and `.` as separators, a bare `YYYYMMDD`, and a two-digit
 * year (70–99 → 1900s, everything else → 2000s, the usual POSIX pivot). Order is
 * decided as described in this file's header: never guessed.
 */
function parseTyped(text, locale) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return makeIso(+m[1], +m[2], +m[3]);

  m = /^(\d{8})$/.exec(t);
  if (m) return makeIso(+t.slice(0, 4), +t.slice(4, 6), +t.slice(6, 8));

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (m[3].length <= 2) y += y >= 70 ? 1900 : 2000;
    const dayFirst = localeIsDayFirst(locale);
    const preferred = dayFirst ? makeIso(y, b, a) : makeIso(y, a, b);
    if (preferred) return preferred;
    /* Only reached when the locale's own order names a month that does not
       exist, e.g. "5/14/1979" read day-first. Then the other order is not a
       guess — it is the only reading that is a date at all. */
    return dayFirst ? makeIso(y, a, b) : makeIso(y, b, a);
  }

  return null;
}

/* ── Component ───────────────────────────────────────────────────────────── */

export default function DatePicker({
  id,
  name,
  value = '',
  onChange,
  min = '',
  max = '',
  isDateDisabled,
  label,
  error = '',
  required = false,
  disabled = false,
  inputClassName = '',
  className = '',
  describedBy = '',
  placeholder = 'YYYY-MM-DD',
  locale,
}) {
  const reactId = useId();
  const inputId = id || `dp-${reactId}`;
  const errorId = `${inputId}-dp-error`;
  const hintId = `${inputId}-dp-hint`;
  const gridId = `${inputId}-dp-grid`;

  const [open, setOpen] = useState(false);
  /** The text box's own content, which is allowed to be mid-edit and therefore
   *  not yet a date. It re-syncs to `value` whenever a committed value arrives. */
  const [text, setText] = useState(value);
  const [view, setView] = useState(() => initialView(value, min, max));
  const [focusedIso, setFocusedIso] = useState(() => clampIso(value || todayIso(), min, max));
  /** Bumped only by the actions that should MOVE the caret into the grid, so
   *  choosing a month from the select does not yank focus out of the select. */
  const [focusTick, setFocusTick] = useState(0);

  const rootRef = useRef(null);
  const popRef = useRef(null);
  const gridRef = useRef(null);
  const toggleRef = useRef(null);

  useEffect(() => { setText(value); }, [value]);

  const dayLabel = useMemo(
    () => formatter(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    [locale],
  );
  const monthLabel = useMemo(() => formatter(locale, { month: 'long', year: 'numeric' }), [locale]);
  const monthNames = useMemo(() => {
    const f = formatter(locale, { month: 'long' });
    return Array.from({ length: 12 }, (_, m) => f.format(dateOf(2024, m, 1)));
  }, [locale]);
  const weekdays = useMemo(() => {
    const short = formatter(locale, { weekday: 'short' });
    const long = formatter(locale, { weekday: 'long' });
    /* 1 January 2024 was a Monday, so this walks the week from WEEK_START. */
    return Array.from({ length: 7 }, (_, i) => {
      const d = dateOf(2024, 0, 1 + i + (WEEK_START - 1));
      return { short: short.format(d), long: long.format(d) };
    });
  }, [locale]);

  const visibleMonthName = monthLabel.format(dateOf(view.y, view.m, 1));

  const isSelectable = useCallback((iso) => {
    if (!iso) return false;
    if (min && iso < min) return false;
    if (max && iso > max) return false;
    if (isDateDisabled?.(iso)) return false;
    return true;
  }, [min, max, isDateDisabled]);

  const cells = useMemo(() => monthGrid(view.y, view.m), [view.y, view.m]);

  /**
   * The year range the select offers.
   *
   * A hundred years back from `max` when only `max` is bounded, which is the
   * date-of-birth case and the reason this select exists. The current view's year
   * is always included so a value outside the computed span can still be shown.
   */
  const years = useMemo(() => {
    const cy = new Date().getFullYear();
    const minY = parseIso(min)?.y;
    const maxY = parseIso(max)?.y;
    let lo = minY ?? (maxY != null ? maxY - 100 : cy - 100);
    let hi = maxY ?? (minY != null ? Math.max(minY + 20, cy + 10) : cy + 10);
    lo = Math.min(lo, view.y);
    hi = Math.max(hi, view.y);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [min, max, view.y]);

  /* ── Opening and closing ───────────────────────────────────────────────── */

  const openPopup = () => {
    if (disabled) return;
    const start = clampIso(parseIso(value) ? value : startOfRange(min, max), min, max);
    setView(initialView(value, min, max));
    setFocusedIso(start);
    setFocusTick(t => t + 1);
    setOpen(true);
  };

  /** Always the way out: the trigger is where focus came from, so it is where
   *  focus goes back to. Dropping it on `<body>` strands a keyboard user. */
  const closePopup = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  const commit = (iso) => {
    if (!isSelectable(iso)) return;
    onChange?.(iso);
    setText(iso);
    closePopup();
  };

  /* Focus follows the roving tabindex, but only when something asked it to. */
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current?.querySelector(`[data-dp-iso="${focusedIso}"]`);
    el?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusTick]);

  /* Outside click. `mousedown` rather than `click`, so the popup is gone before
     a click lands on whatever is underneath it. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /* ── Keyboard ──────────────────────────────────────────────────────────── */

  const moveFocus = (iso) => {
    const next = clampIso(iso, min, max);
    if (!next) return;
    setFocusedIso(next);
    const p = parseIso(next);
    if (p && (p.y !== view.y || p.m !== view.m)) setView({ y: p.y, m: p.m });
    setFocusTick(t => t + 1);
  };

  /** Escape and the Tab cycle belong to the whole popup; the arrows only make
   *  sense over the grid, so they are filtered by where the event started. */
  const onPopupKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopup();
      return;
    }

    if (e.key === 'Tab') {
      const stops = [...(popRef.current?.querySelectorAll('[data-dp-stop]') ?? [])]
        .filter(el => !el.disabled);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !popRef.current?.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    const overGrid = gridRef.current?.contains(e.target) || e.target === gridRef.current;
    if (!overGrid) return;

    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); moveFocus(shiftDays(focusedIso, 1)); break;
      case 'ArrowLeft': e.preventDefault(); moveFocus(shiftDays(focusedIso, -1)); break;
      case 'ArrowDown': e.preventDefault(); moveFocus(shiftDays(focusedIso, 7)); break;
      case 'ArrowUp': e.preventDefault(); moveFocus(shiftDays(focusedIso, -7)); break;
      case 'PageDown': e.preventDefault(); moveFocus(shiftMonths(focusedIso, 1)); break;
      case 'PageUp': e.preventDefault(); moveFocus(shiftMonths(focusedIso, -1)); break;
      case 'Home': {
        e.preventDefault();
        const p = parseIso(focusedIso);
        if (p) moveFocus(shiftDays(focusedIso, -((dateOf(p.y, p.m, p.d).getDay() - WEEK_START + 7) % 7)));
        break;
      }
      case 'End': {
        e.preventDefault();
        const p = parseIso(focusedIso);
        if (p) moveFocus(shiftDays(focusedIso, 6 - ((dateOf(p.y, p.m, p.d).getDay() - WEEK_START + 7) % 7)));
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(focusedIso);
        break;
      default: break;
    }
  };

  /* ── Text input ────────────────────────────────────────────────────────── */

  const onTextChange = (e) => {
    const next = e.target.value;
    setText(next);
    if (next.trim() === '') { onChange?.(''); return; }
    const iso = parseTyped(next, locale);
    if (iso && isSelectable(iso)) {
      onChange?.(iso);
      const p = parseIso(iso);
      if (p) setView({ y: p.y, m: p.m });
      setFocusedIso(iso);
    }
  };

  /** Half-typed text must not survive as the field's apparent answer. */
  const onTextBlur = () => {
    const iso = parseTyped(text, locale);
    if (iso && isSelectable(iso)) setText(iso);
    else setText(value);
  };

  const describedByIds = [describedBy, error ? errorId : '', hintId].filter(Boolean).join(' ');
  const today = todayIso();

  return (
    <div className={`dp ${className}`.trim()} ref={rootRef}>
      {label && <label className="dp-label" htmlFor={inputId}>{label}</label>}

      <div className="dp-control">
        <input
          id={inputId}
          name={name}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className={`input dp-input ${inputClassName}`.trim()}
          value={text}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedByIds || undefined}
          onChange={onTextChange}
          onBlur={onTextBlur}
        />
        <button
          ref={toggleRef}
          type="button"
          className="dp-toggle"
          aria-label="Choose a date"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => (open ? closePopup() : openPopup())}
        >
          <Calendar size={16} aria-hidden="true" />
        </button>

        {open && (
          <div
            ref={popRef}
            className="dp-pop"
            role="dialog"
            aria-modal="true"
            aria-label="Choose a date"
            onKeyDown={onPopupKeyDown}
          >
            <div className="dp-nav">
              <button
                type="button"
                data-dp-stop
                className="dp-nav-btn"
                aria-label="Previous month"
                onClick={() => setView(v => stepMonth(v, -1))}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>

              {/*
                Month and year as selects rather than a caption between two
                arrows. This is the shortcut that makes a date of birth possible
                at all: 1979 is one choice from the year list instead of ~560
                presses of the arrow beside it.
              */}
              <div className="dp-nav-selects">
                <select
                  data-dp-stop
                  className="select dp-select"
                  aria-label="Month"
                  value={view.m}
                  onChange={(e) => setView(v => ({ ...v, m: Number(e.target.value) }))}
                >
                  {monthNames.map((mn, i) => <option key={mn} value={i}>{mn}</option>)}
                </select>
                <select
                  data-dp-stop
                  className="select dp-select dp-select-year"
                  aria-label="Year"
                  value={view.y}
                  onChange={(e) => setView(v => ({ ...v, y: Number(e.target.value) }))}
                >
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>

              <button
                type="button"
                data-dp-stop
                className="dp-nav-btn"
                aria-label="Next month"
                onClick={() => setView(v => stepMonth(v, 1))}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>

            <table
              ref={gridRef}
              id={gridId}
              role="grid"
              className="dp-grid"
              aria-label={visibleMonthName}
            >
              <thead>
                <tr>
                  {weekdays.map(w => (
                    /* `abbr` is what a screen reader reads for the column, so
                       "Monday" is announced where "Mon" is displayed. */
                    <th key={w.long} scope="col" abbr={w.long} className="dp-weekday">{w.short}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3, 4, 5].map(week => (
                  <tr key={week}>
                    {cells.slice(week * 7, week * 7 + 7).map(c => {
                      const selectable = isSelectable(c.iso);
                      const selected = c.iso === value;
                      const isFocused = c.iso === focusedIso;
                      return (
                        <td
                          key={c.iso}
                          role="gridcell"
                          data-dp-iso={c.iso}
                          data-dp-stop={isFocused ? '' : undefined}
                          className={[
                            'dp-cell',
                            c.inMonth ? '' : 'dp-cell-outside',
                            c.iso === today ? 'dp-cell-today' : '',
                            selected ? 'dp-cell-selected' : '',
                            selectable ? '' : 'dp-cell-off',
                          ].filter(Boolean).join(' ')}
                          /* The full date, not the number. "14" on its own tells
                             a screen-reader user nothing about where they are. */
                          aria-label={dayLabel.format(dateOf(parseIso(c.iso).y, parseIso(c.iso).m, parseIso(c.iso).d))}
                          aria-selected={selected}
                          aria-disabled={!selectable}
                          aria-current={c.iso === today ? 'date' : undefined}
                          /* One tab stop for the whole grid, per the ARIA grid
                             pattern — 42 tab stops is not navigation. */
                          tabIndex={isFocused ? 0 : -1}
                          onClick={() => commit(c.iso)}
                        >
                          <span className="dp-cell-num" aria-hidden="true">{c.day}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="dp-foot">
              <button
                type="button"
                data-dp-stop
                className="dp-quick"
                disabled={!isSelectable(today)}
                onClick={() => commit(today)}
              >
                Today
              </button>
              {/* Only offered when there is something to clear and clearing is
                  legal — a disabled-looking control on a required field is noise. */}
              {!required && value && (
                <button
                  type="button"
                  data-dp-stop
                  className="dp-quick"
                  onClick={() => { onChange?.(''); setText(''); closePopup(); }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/*
        One live region, on the wrapper rather than inside the popup, because the
        thing most worth announcing — the date that was chosen — happens as the
        popup unmounts. While open it reports the visible month, which is the
        other change a screen-reader user cannot otherwise perceive.
      */}
      <span className="sr-only" role="status" data-dp-live>
        {open ? visibleMonthName : (value ? `${formatIsoLong(value, dayLabel)} selected` : '')}
      </span>

      <span id={hintId} className="sr-only">
        Type a date as YYYY-MM-DD, or press the Choose a date button to open a calendar.
      </span>

      {error && (
        <span id={errorId} className="field-error" role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  );
}

/* ── Small helpers kept out of the component body ────────────────────────── */

/** Where the calendar opens: the value, else the nearest legal day to today. */
function initialView(value, min, max) {
  const p = parseIso(value) || parseIso(clampIso(todayIso(), min, max));
  const fallback = new Date();
  return p ? { y: p.y, m: p.m } : { y: fallback.getFullYear(), m: fallback.getMonth() };
}

const startOfRange = (min, max) => clampIso(todayIso(), min, max);

function stepMonth(view, delta) {
  const d = new Date(view.y, view.m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

function formatIsoLong(iso, fmt) {
  const p = parseIso(iso);
  return p ? fmt.format(dateOf(p.y, p.m, p.d)) : '';
}
