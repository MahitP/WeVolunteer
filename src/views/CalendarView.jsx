import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, MapPin, Clock } from 'lucide-react';
import { formatHours, formatTimeRange, formatDay } from '../utils/helpers';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * A month view of everything with a date attached.
 *
 * Entry kinds are deliberately few, and each maps to an existing colour:
 *   shift    — you are confirmed (brand green)
 *   pending  — you applied, awaiting a decision (amber/warn)
 *   deadline — applications close that day (warn)
 *   hosting  — an event you run (brand, organizer view)
 */
const KIND_META = {
  shift: { tone: 'brand', label: 'Confirmed shift' },
  pending: { tone: 'warn', label: 'Awaiting decision' },
  deadline: { tone: 'danger', label: 'Application deadline' },
  hosting: { tone: 'brand', label: 'You are hosting' }
};

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function CalendarView({ currentUser, events = [], applications = [], onViewEvent }) {
  // Fixed for the lifetime of the view so memos have a stable dependency
  const [today] = useState(() => new Date());
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selected, setSelected] = useState(null);

  const isOrganizer = currentUser?.role === 'organizer';

  /** Everything with a date, flattened into calendar entries. */
  const entries = useMemo(() => {
    const out = [];

    if (isOrganizer) {
      for (const event of events) {
        if (event.organizerId !== currentUser.id) continue;
        for (const slot of event.slots || []) {
          out.push({
            kind: 'hosting', date: new Date(slot.startDatetime), event,
            title: event.title, detail: slot.name,
            startDatetime: slot.startDatetime, endDatetime: slot.endDatetime
          });
        }
        if (event.applicationDeadline && event.status === 'open') {
          out.push({
            kind: 'deadline', date: new Date(event.applicationDeadline), event,
            title: event.title, detail: 'Applications close'
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
          kind: 'shift', date: new Date(app.slot.startDatetime), event,
          title: event.title, detail: app.slot.name,
          startDatetime: app.slot.startDatetime, endDatetime: app.slot.endDatetime,
          hours: app.slot.hours
        });
      } else if (app.status === 'pending' || app.status === 'waitlisted') {
        out.push({
          kind: 'pending', date: new Date(app.slot.startDatetime), event,
          title: event.title, detail: app.slot.name,
          startDatetime: app.slot.startDatetime, endDatetime: app.slot.endDatetime
        });
      }
    }

    // Deadlines for open events the student has not yet applied to
    const appliedIds = new Set(mine.filter(a => a.status !== 'rejected').map(a => a.eventId));
    for (const event of events) {
      if (event.status !== 'open' || appliedIds.has(event.id)) continue;
      if (new Date(event.applicationDeadline) < new Date()) continue;
      out.push({
        kind: 'deadline', date: new Date(event.applicationDeadline), event,
        title: event.title, detail: 'Applications close'
      });
    }
    return out;
  }, [events, applications, currentUser, isOrganizer]);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      if (isNaN(e.date.getTime())) continue;
      const key = dayKey(e.date);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.date - b.date);
    }
    return map;
  }, [entries]);

  /**
   * Four shifts of one event on one day is one thing happening, not four.
   * The grid shows it once with a count; the day detail still lists each shift.
   */
  const chipsFor = (dayEntries) => {
    const seen = new Map();
    for (const e of dayEntries) {
      const key = `${e.event?.id}:${e.kind}`;
      if (seen.has(key)) seen.get(key).count++;
      else seen.set(key, { ...e, count: 1 });
    }
    return [...seen.values()];
  };

  // Month grid, Monday-first, padded to whole weeks
  const grid = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // Sunday=0 → Monday-first
    const start = new Date(year, month, 1 - offset);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push(d);
    }
    // Drop a trailing all-next-month week
    return cells.slice(0, cells[35].getMonth() === month ? 42 : 35);
  }, [cursor]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const selectedEntries = selected ? (byDay.get(dayKey(selected)) || []) : [];

  const move = (delta) => {
    setCursor(c => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    setSelected(null);
  };
  const goToday = () => {
    const now = new Date();
    setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelected(now);
  };

  const upcoming = useMemo(() => entries
    .filter(e => e.date >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
    .sort((a, b) => a.date - b.date)
    .slice(0, 5), [entries, today]);

  return (
    <div className="stack-lg">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => move(-1)} aria-label="Previous month">
            <ChevronLeft size={15} />
          </button>
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => move(1)} aria-label="Next month">
            <ChevronRight size={15} />
          </button>
          <h2 style={{ marginLeft: 'var(--s2)', minWidth: '9ch' }}>{monthLabel}</h2>
        </div>

        <button className="btn btn-ghost btn-sm" onClick={goToday}>Today</button>

        <div className="row row-wrap small dim" style={{ gap: 'var(--s3)', marginLeft: 'auto' }}>
          {(isOrganizer ? ['hosting', 'deadline'] : ['shift', 'pending', 'deadline']).map(k => (
            <span key={k} className="row" style={{ gap: 5 }}>
              <span className={`cal-key tone-${KIND_META[k].tone}`} />
              {KIND_META[k].label}
            </span>
          ))}
        </div>
      </div>

      <div className="calendar">
        <div className="cal-head">
          {WEEKDAYS.map(d => <div key={d} className="cal-weekday">{d}</div>)}
        </div>

        <div className="cal-grid">
          {grid.map(date => {
            const inMonth = date.getMonth() === cursor.getMonth();
            const isToday = dayKey(date) === dayKey(today);
            const isSelected = selected && dayKey(date) === dayKey(selected);
            const dayEntries = byDay.get(dayKey(date)) || [];
            const chips = chipsFor(dayEntries);

            return (
              <button
                key={date.toISOString()}
                className={`cal-day ${inMonth ? '' : 'is-outside'} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`}
                onClick={() => setSelected(date)}
                aria-label={`${formatDay(date.toISOString())}${dayEntries.length ? `, ${dayEntries.length} item${dayEntries.length !== 1 ? 's' : ''}` : ''}`}
                aria-pressed={isSelected}
              >
                <span className="cal-date">{date.getDate()}</span>
                <span className="cal-entries">
                  {chips.slice(0, 3).map((e, i) => (
                    <span key={i} className={`cal-chip tone-${KIND_META[e.kind].tone}`}>
                      {e.title}{e.count > 1 && ` ×${e.count}`}
                    </span>
                  ))}
                  {chips.length > 3 && (
                    <span className="cal-more">+{chips.length - 3} more</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Detail for the chosen day, or what's next ── */}
      {selected ? (
        <section>
          <div className="section-head">
            <h2>{formatDay(selected.toISOString())}</h2>
            <button className="btn btn-ghost btn-sm section-action" onClick={() => setSelected(null)}>
              Clear
            </button>
          </div>
          {selectedEntries.length === 0 ? (
            <div className="card empty" style={{ padding: 'var(--s8) var(--s4)' }}>
              <span className="empty-icon"><CalendarDays size={18} /></span>
              <h3>Nothing on this day</h3>
              <p>Pick another date, or browse opportunities to fill it.</p>
            </div>
          ) : (
            <div className="list">
              {selectedEntries.map((e, i) => <EntryRow key={i} entry={e} onViewEvent={onViewEvent} />)}
            </div>
          )}
        </section>
      ) : (
        <section>
          <div className="section-head"><h2>Coming up</h2></div>
          {upcoming.length === 0 ? (
            <div className="card empty" style={{ padding: 'var(--s8) var(--s4)' }}>
              <span className="empty-icon"><CalendarDays size={18} /></span>
              <h3>Nothing scheduled</h3>
              <p>
                {isOrganizer
                  ? 'Events you host will appear here once you post them.'
                  : 'Shifts you are accepted for and deadlines you care about will appear here.'}
              </p>
            </div>
          ) : (
            <div className="list">
              {upcoming.map((e, i) => <EntryRow key={i} entry={e} onViewEvent={onViewEvent} showDate />)}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function EntryRow({ entry, onViewEvent, showDate }) {
  const meta = KIND_META[entry.kind];
  return (
    <button
      className="list-row"
      style={{ width: '100%', textAlign: 'left' }}
      onClick={() => onViewEvent?.(entry.event.id)}
    >
      <span className={`cal-key tone-${meta.tone}`} style={{ width: 4, height: 34, borderRadius: 2 }} />
      <span className="truncate" style={{ flex: 1 }}>
        <span className="person-name truncate">{entry.title}</span>
        <span className="person-meta truncate row" style={{ gap: 'var(--s3)' }}>
          <span>{entry.detail}</span>
          {entry.startDatetime && (
            <span className="row tnum" style={{ gap: 4 }}>
              <Clock size={11} /> {formatTimeRange(entry.startDatetime, entry.endDatetime)}
            </span>
          )}
          {entry.event?.location && (
            <span className="row truncate" style={{ gap: 4 }}>
              <MapPin size={11} /> {entry.event.location}
            </span>
          )}
        </span>
      </span>
      {showDate && (
        <span className="small dim nowrap tnum">{formatDay(entry.date.toISOString())}</span>
      )}
      {entry.hours > 0 && <span className="hourspill">{formatHours(entry.hours)}</span>}
    </button>
  );
}
