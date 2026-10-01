import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CalendarDays, MapPin, Clock } from 'lucide-react';
import { formatHours, formatTimeRange, formatDay, haversineDistance } from '../utils/helpers';
import { useLocationContext } from '../contexts/LocationContext';
import { can } from '../authz.js';
import DatePicker from '../components/common/DatePicker';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * A month view of everything with a date attached.
 *
 * Entry kinds are deliberately few, and each maps to an existing colour:
 *   shift    — you are confirmed (brand green)
 *   pending  — you applied, awaiting a decision (amber/warn)
 *   deadline — applications close that day (warn)
 *   hosting  — an event you run (brand, organizer view)
 *   scheduled — any event's shift (brand, administrator view)
 */
const KIND_META = {
  shift: {
    tone: 'brand',
    label: 'Confirmed shift'
  },
  pending: {
    tone: 'warn',
    label: 'Awaiting decision'
  },
  history: {
    tone: 'muted',
    label: 'Past shift'
  },
  deadline: {
    tone: 'danger',
    label: 'Application deadline'
  },
  hosting: {
    tone: 'brand',
    label: 'You are hosting'
  },
  scheduled: {
    tone: 'brand',
    label: 'Event shift'
  }
};
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export default function CalendarView({
  currentUser,
  events = [],
  applications = [],
  onViewEvent
}) {
  // Fixed for the lifetime of the view so memos have a stable dependency
  const [today] = useState(() => new Date());
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    // In month mode we usually start at the 1st, but to support week mode gracefully,
    // let's keep the cursor on the actual current day initially.
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  });
  const [selected, setSelected] = useState(null);
  const [viewMode, setViewMode] = useState('month'); // 'month' or 'week'
  const [filter, setFilter] = useState('all'); // 'all', 'upcoming', 'pending', 'history'
  const isOrganizer = currentUser?.role === 'organizer';
  /**
   * An administrator's calendar is the district's schedule (ruling 2).
   *
   * The owner put Calendar back on the administrator's bar and said what it
   * shows: every event on the platform. Anybody who was not an organizer used
   * to get the volunteer's view, so an administrator — who applies to nothing —
   * saw only "Applications close" markers, under a legend about their own
   * confirmed shifts. `event.moderate` is the administrator's capability, and
   * an organizer never holds it.
   */
  const isDistrict = !isOrganizer && can(currentUser, 'event.moderate');
  /* The organizer's and the administrator's views share a layout: no
     "Awaiting" or "History", because neither is the reader's own record. */
  const isSchedule = isOrganizer || isDistrict;
  const { location: myLocation } = useLocationContext();

  /** Everything with a date, flattened into calendar entries. */
  const entries = useMemo(() => {
    const out = [];
    if (isOrganizer) {
      for (const event of events) {
        if (event.organizerId !== currentUser.id) continue;
        for (const slot of event.slots || []) {
          out.push({
            kind: 'hosting',
            date: new Date(slot.startDatetime),
            event,
            title: event.title,
            detail: slot.name,
            startDatetime: slot.startDatetime,
            endDatetime: slot.endDatetime
          });
        }
        if (event.applicationDeadline && event.status === 'open') {
          out.push({
            kind: 'deadline',
            date: new Date(event.applicationDeadline),
            event,
            title: event.title,
            detail: 'Applications close'
          });
        }
      }
      return out;
    }

    if (isDistrict) {
      for (const event of events) {
        if (event.status === 'cancelled') continue;
        for (const slot of event.slots || []) {
          out.push({
            kind: 'scheduled',
            date: new Date(slot.startDatetime),
            event,
            title: event.title,
            detail: slot.name,
            startDatetime: slot.startDatetime,
            endDatetime: slot.endDatetime
          });
        }
        if (event.applicationDeadline && event.status === 'open') {
          out.push({
            kind: 'deadline',
            date: new Date(event.applicationDeadline),
            event,
            title: event.title,
            detail: 'Applications close'
          });
        }
      }
      return out;
    }

    // Student view: their own shifts and the deadlines that still matter
    const mine = applications.filter(a => a.userId === currentUser?.id);
    for (const app of mine) {
      if (!app.slot?.startDatetime) continue;
      const event = events.find(e => e.id === app.eventId);
      if (!event || event.status === 'cancelled') continue;
      if (app.status === 'accepted') {
        out.push({
          kind: new Date(app.slot.endDatetime) < new Date() ? 'history' : 'shift',
          date: new Date(app.slot.startDatetime),
          event,
          title: event.title,
          detail: app.slot.name,
          startDatetime: app.slot.startDatetime,
          endDatetime: app.slot.endDatetime,
          hours: app.slot.hours,
          attendance: app.attendance
        });
      } else if (app.status === 'pending' || app.status === 'waitlisted') {
        if (new Date(app.slot.startDatetime) < new Date()) continue; // Skip past pending
        out.push({
          kind: 'pending',
          date: new Date(app.slot.startDatetime),
          event,
          title: event.title,
          detail: app.slot.name,
          startDatetime: app.slot.startDatetime,
          endDatetime: app.slot.endDatetime
        });
      }
    }

    // Deadlines for open events the student has not yet applied to
    const appliedIds = new Set(mine.filter(a => a.status !== 'rejected' && a.status !== 'withdrawn').map(a => a.eventId));
    for (const event of events) {
      if (event.status !== 'open' || appliedIds.has(event.id)) continue;
      if (new Date(event.applicationDeadline) < new Date()) continue;
      out.push({
        kind: 'deadline',
        date: new Date(event.applicationDeadline),
        event,
        title: event.title,
        detail: 'Applications close'
      });
    }
    return out;
  }, [events, applications, currentUser, isOrganizer, isDistrict]);

  /**
   * Distance attached once, here, rather than computed inside `EntryRow`.
   *
   * `EntryRow` renders the selected day AND all three agenda lists, so a hook
   * inside it would run once per visible row for an answer that depends only on
   * one position and one event. Computed here it stays presentational.
   *
   * Null throughout when the volunteer has not shared a position, or the event
   * has no pin — both ordinary, and both render nothing at all.
   */
  const entriesWithDistance = useMemo(() => {
    if (!myLocation) return entries;
    return entries.map(entry => {
      const e = entry.event;
      if (!e || e.latitude == null || e.longitude == null) return entry;
      return {
        ...entry,
        distanceMiles: haversineDistance(myLocation.latitude, myLocation.longitude, e.latitude, e.longitude),
      };
    });
  }, [entries, myLocation]);

  const filteredEntries = useMemo(() => {
    const all = entriesWithDistance;
    if (filter === 'all') return all;
    if (filter === 'upcoming') return all.filter(e => e.kind === 'shift' || e.kind === 'hosting' || e.kind === 'scheduled');
    if (filter === 'pending') return all.filter(e => e.kind === 'pending' || e.kind === 'deadline');
    if (filter === 'history') return all.filter(e => e.kind === 'history');
    return all;
  }, [entriesWithDistance, filter]);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of filteredEntries) {
      if (isNaN(e.date.getTime())) continue;
      const key = dayKey(e.date);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.date - b.date);
    }
    return map;
  }, [filteredEntries]);

  /**
   * Four shifts of one event on one day is one thing happening, not four.
   * The grid shows it once with a count; the day detail still lists each shift.
   */
  const chipsFor = dayEntries => {
    const seen = new Map();
    for (const e of dayEntries) {
      const key = `${e.event?.id}:${e.kind}`;
      if (seen.has(key)) seen.get(key).count++;else seen.set(key, {
        ...e,
        count: 1
      });
    }
    return [...seen.values()];
  };

  // Month or Week grid, Monday-first
  const grid = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const date = cursor.getDate();
    
    if (viewMode === 'week') {
      const first = new Date(year, month, date);
      const offset = (first.getDay() + 6) % 7; // Sunday=0 → Monday-first
      const start = new Date(year, month, date - offset);
      const cells = [];
      for (let i = 0; i < 7; i++) {
        cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      }
      return cells;
    }

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push(d);
    }
    return cells.slice(0, cells[35].getMonth() === month ? 42 : 35);
  }, [cursor, viewMode]);

  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  });
  
  const weekLabel = useMemo(() => {
    if (!grid.length) return '';
    const start = grid[0];
    const end = grid[6];
    if (start.getMonth() === end.getMonth()) {
      return `${start.toLocaleDateString(undefined, { month: 'short' })} ${start.getDate()} - ${end.getDate()}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString(undefined, { month: 'short' })} ${start.getDate()} - ${end.toLocaleDateString(undefined, { month: 'short' })} ${end.getDate()}, ${end.getFullYear()}`;
  }, [grid]);

  const selectedEntries = selected ? byDay.get(dayKey(selected)) || [] : [];
  const move = delta => {
    if (viewMode === 'week') {
      setCursor(c => new Date(c.getFullYear(), c.getMonth(), c.getDate() + (delta * 7)));
    } else {
      setCursor(c => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    }
    setSelected(null);
  };
  /**
   * Jump to a date (ruling 8). The owner asked for the app's date picker "for
   * the pick date in calendar" too; with only month arrows, a date half a year
   * out was six clicks and a squint. Choosing one moves the grid to its month
   * — or its week — and selects the day, the same as clicking it.
   */
  const [jumpDate, setJumpDate] = useState('');
  const jumpTo = (iso) => {
    setJumpDate(iso);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    setCursor(date);
    setSelected(date);
  };
  const goToday = () => {
    const now = new Date();
    setCursor(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    setSelected(now);
  };
  
  const agendaUpcoming = useMemo(() => entries.filter(e => (e.kind === 'shift' || e.kind === 'hosting' || e.kind === 'scheduled') && e.date >= new Date(today.getFullYear(), today.getMonth(), today.getDate())).sort((a, b) => a.date - b.date).slice(0, 5), [entries, today]);
  const agendaPending = useMemo(() => entries.filter(e => (e.kind === 'pending' || e.kind === 'deadline') && e.date >= new Date(today.getFullYear(), today.getMonth(), today.getDate())).sort((a, b) => a.date - b.date).slice(0, 5), [entries, today]);
  const agendaHistory = useMemo(() => entries.filter(e => e.kind === 'history').sort((a, b) => b.date - a.date).slice(0, 5), [entries]);
  
  return <div className="stack-lg">
      <div className="toolbar s-7ba55e">
        <div className="row s-65ce96">
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => move(-1)} aria-label="Previous">
            <ChevronLeft size={15} />
          </button>
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => move(1)} aria-label="Next">
            <ChevronRight size={15} />
          </button>
          <h2 className="s-badf1b">{viewMode === 'week' ? weekLabel : monthLabel}</h2>
        </div>

        <div className="row">
          <label className="sr-only" htmlFor="cal-goto">Go to date</label>
          <DatePicker id="cal-goto" className="cal-goto" value={jumpDate} onChange={jumpTo} placeholder="Go to date" openOnClick />
          <button className="btn btn-ghost btn-sm" onClick={goToday} aria-current={dayKey(cursor) === dayKey(today) ? 'date' : undefined}>Today</button>
          <div className="row" style={{ background: 'var(--surface-3)', borderRadius: 'var(--r-md)', padding: 2, border: '1px solid var(--rule)' }}>
            {/* No class for the active state: the inline style below already
                sets its background, colour and shadow. The generated class that
                used to sit here never had a rule written for it and was a no-op,
                so it is dropped rather than given one.

                The INACTIVE segment sets no box-shadow at all, and that is
                load-bearing rather than tidy. It used to set `boxShadow: 'none'`
                — redundant, because `.btn-ghost` has no shadow to remove — and
                an inline declaration beats every stylesheet rule. The app's
                focus indicator IS a box-shadow (`:focus-visible { box-shadow:
                var(--focus) }`), so the inline `none` silently deleted the focus
                ring from whichever segment was not selected: a WCAG 2.4.7
                failure on a control a keyboard user has to pass through to
                reach the calendar. The active segment kept its
                `--control-shadow` and so always looked fine.
                Omitting the property lets the ring paint. */}
            <button
              className={`btn btn-sm ${viewMode === 'month' ? '' : 'btn-ghost'}`}
              onClick={() => setViewMode('month')}
              style={{ margin: 0, borderRadius: 'calc(var(--r-md) - 2px)', background: viewMode === 'month' ? 'var(--surface)' : 'transparent', color: viewMode === 'month' ? 'var(--ink)' : 'var(--ink-2)', boxShadow: viewMode === 'month' ? 'var(--control-shadow)' : undefined }}
            >Month</button>
            <button 
              className={`btn btn-sm ${viewMode === 'week' ? '' : 'btn-ghost'}`}
              onClick={() => setViewMode('week')}
              style={{ margin: 0, borderRadius: 'calc(var(--r-md) - 2px)', background: viewMode === 'week' ? 'var(--surface)' : 'transparent', color: viewMode === 'week' ? 'var(--ink)' : 'var(--ink-2)', boxShadow: viewMode === 'week' ? 'var(--control-shadow)' : undefined }}
            >Week</button>
          </div>
        </div>

        <div className="row row-wrap small dim s-4f3bdc">
          {(isOrganizer ? ['hosting', 'deadline'] : isDistrict ? ['scheduled', 'deadline'] : ['shift', 'pending', 'history']).map(k => <span key={k} className="row s-a39dc0">
              <span className={`cal-key tone-${KIND_META[k].tone}`} />
              {KIND_META[k].label}
            </span>)}
        </div>
      </div>

      <div className="row" style={{ gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {['all', 'upcoming', 'pending', 'history'].map(f => {
           if (isSchedule && (f === 'pending' || f === 'history')) return null;
           const labels = { all: 'Everything', upcoming: 'Upcoming', pending: 'Awaiting', history: 'History' };
           return (
             <button 
               key={f}
               className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
               onClick={() => setFilter(f)}
               style={{ borderRadius: 20 }}
             >
               {labels[f]}
             </button>
           );
        })}
      </div>

      <div className={`calendar ${viewMode === 'week' ? 'calendar-week' : 'calendar-month'}`}>
        <div className="cal-head">
          {WEEKDAYS.map(d => <div key={d} className="cal-weekday">{d}</div>)}
        </div>

        <div className="cal-grid" style={viewMode === 'week' ? { gridTemplateRows: 'minmax(120px, 1fr)' } : {}}>
          {grid.map(date => {
          const inMonth = viewMode === 'week' || date.getMonth() === cursor.getMonth();
          const isToday = dayKey(date) === dayKey(today);
          const isSelected = selected && dayKey(date) === dayKey(selected);
          const dayEntries = byDay.get(dayKey(date)) || [];
          const chips = chipsFor(dayEntries);
          return <button key={date.toISOString()} className={`cal-day ${inMonth ? '' : 'is-outside'} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`} onClick={() => setSelected(date)} aria-label={`${formatDay(date.toISOString())}${dayEntries.length ? `, ${dayEntries.length} item${dayEntries.length !== 1 ? 's' : ''}` : ''}`} aria-pressed={isSelected}>
                <span className="cal-date">{date.getDate()}</span>
                <span className="cal-entries">
                  {chips.slice(0, viewMode === 'week' ? 10 : 3).map((e, i) => <span key={i} className={`cal-chip tone-${KIND_META[e.kind].tone}`}>
                      {e.title}{e.count > 1 && ` ×${e.count}`}
                    </span>)}
                  {chips.length > (viewMode === 'week' ? 10 : 3) && <span className="cal-more">+{chips.length - (viewMode === 'week' ? 10 : 3)} more</span>}
                </span>
              </button>;
        })}
        </div>
      </div>

      {/* ── Detail for the chosen day, or what's next ── */}
      {selected ? <section>
          <div className="section-head">
            <h2>{formatDay(selected.toISOString())}</h2>
            <button className="btn btn-ghost btn-sm section-action" onClick={() => setSelected(null)}>
              Clear
            </button>
          </div>
          {selectedEntries.length === 0 ? <div className="card empty" style={{ background: 'var(--surface-2)', borderColor: 'var(--rule)', color: 'var(--ink-3)' }}>
              <span className="empty-icon"><CalendarDays size={18} /></span>
              <h3 style={{ color: 'var(--ink)' }}>Nothing on this day</h3>
              <p>Pick another date, or find something on Discover to fill it.</p>
              {/* The sentence above named a next step and the card offered no
                  way to take it. Discover is in the rail for everybody who can
                  reach this page, so this was a promise the reader had to go and
                  keep themselves. */}
              <Link to="/discover" className="btn btn-secondary btn-sm">Discover</Link>
            </div> : <div className="list">
              {selectedEntries.map((e, i) => <EntryRow key={i} entry={e} onViewEvent={onViewEvent} />)}
            </div>}
        </section> : (
          <div className="stack-lg">
            <section>
              <div className="section-head"><h2>Upcoming Shifts</h2></div>
              {agendaUpcoming.length === 0 ? <div className="card empty" style={{ background: 'var(--surface-2)', borderColor: 'var(--rule)', color: 'var(--ink-3)' }}>
                  <span className="empty-icon"><CalendarDays size={18} /></span>
                  <h3 style={{ color: 'var(--ink)' }}>Nothing scheduled</h3>
                  <p>
                    {isOrganizer ? 'Events you host will appear here once you post them.'
                      : isDistrict ? 'Events posted on WeVolunteer will appear here.'
                      : 'Shifts you are accepted for will appear here.'}
                  </p>
                </div> : <div className="list">
                  {agendaUpcoming.map((e, i) => <EntryRow key={i} entry={e} onViewEvent={onViewEvent} showDate />)}
                </div>}
            </section>
            
            {!isSchedule && (
              /* `row-wrap`, and a flex-basis rather than a bare `flex: 1`.
                 `.row` is `nowrap`, and `flex: 1` is `flex: 1 1 0%` with
                 `min-width: auto` — so neither column could shrink below its own
                 content and the pair pushed the document 85px wider than a
                 phone, giving the whole app a horizontal scrollbar. An 18rem
                 basis keeps them side by side wherever there is room and drops
                 History beneath Awaiting Decision when there is not. */
              <div className="row row-wrap" style={{ alignItems: 'flex-start', gap: 'var(--s6)' }}>
                <section style={{ flex: '1 1 18rem', minWidth: 0 }}>
                  <div className="section-head"><h2>Awaiting Decision</h2></div>
                  {agendaPending.length === 0 ? (
                    <div className="card empty" style={{ background: 'var(--surface-2)', borderColor: 'var(--rule)', padding: 'var(--s4)' }}>
                      <p className="small dim">No pending applications.</p>
                    </div>
                  ) : <div className="list">
                    {agendaPending.map((e, i) => <EntryRow key={i} entry={e} onViewEvent={onViewEvent} showDate />)}
                  </div>}
                </section>
                <section style={{ flex: '1 1 18rem', minWidth: 0 }}>
                  <div className="section-head"><h2>History</h2></div>
                  {agendaHistory.length === 0 ? (
                    <div className="card empty" style={{ background: 'var(--surface-2)', borderColor: 'var(--rule)', padding: 'var(--s4)' }}>
                      <p className="small dim">No past shifts yet.</p>
                    </div>
                  ) : <div className="list">
                    {agendaHistory.map((e, i) => <EntryRow key={i} entry={e} onViewEvent={onViewEvent} showDate />)}
                  </div>}
                </section>
              </div>
            )}
          </div>
        )}
    </div>;
}
function EntryRow({
  entry,
  onViewEvent,
  showDate
}) {
  const meta = KIND_META[entry.kind];
  return <button className="list-row s-0a650c" onClick={() => onViewEvent?.(entry.event.id)}>
      <span className={`cal-key tone-${meta.tone} s-47a499`} />
      <span className="truncate s-49cdf8">
        <span className="person-name truncate">{entry.title}</span>
        <span className="person-meta truncate row s-615dbe">
          <span>{entry.detail}</span>
          {entry.startDatetime && <span className="row tnum s-9d3307">
              <Clock size={11} /> {formatTimeRange(entry.startDatetime, entry.endDatetime)}
            </span>}
          {/* Text, not a link. This row's root is a <button>, and an anchor
              nested inside a button is invalid HTML with genuinely broken
              keyboard behaviour. The row already opens the event, where the
              location IS a link — so the affordance is one press away rather
              than duplicated badly here. Distance still helps at a glance. */}
          {entry.event?.location && <span className="row truncate s-9d3307">
              <MapPin size={11} /> {entry.event.location}
              {entry.distanceMiles != null && (
                <span className="dim tnum"> · {entry.distanceMiles.toFixed(1)} mi</span>
              )}
            </span>}
        </span>
      </span>
      {showDate && <span className="small dim nowrap tnum">{formatDay(entry.date.toISOString())}</span>}
      {entry.hours > 0 && <span className="hourspill">{formatHours(entry.hours)}</span>}
    </button>;
}
