import React, { useState } from 'react';
import DatePicker from './DatePicker';

/**
 * A day and a time of day, as the app's own date picker and a time box.
 *
 * It replaces `<input type="datetime-local">`, the browser's control, which is
 * a different widget in every engine, takes none of the theme, and opens as a
 * segmented spinner that asks for digits — the thing the owner asked to be rid
 * of (P2-16, LG-11, ruling 8). CreateEvent already split its deadline this way;
 * this is that pairing as one component, so the edit form and the quick edit
 * do not each reinvent it.
 *
 * The value is the same `YYYY-MM-DDTHH:mm` string a `datetime-local` input
 * produced, so a caller swaps one for the other and changes nothing else. A
 * time chosen before a day is held here until a day arrives, because the value
 * cannot carry a time without one.
 *
 * @param {object} props
 * @param {string} props.id          id of the date box; the time box is `${id}-time`
 * @param {string} props.label       the date box's label
 * @param {string} props.timeLabel   the time box's label
 * @param {string} props.value       `YYYY-MM-DDTHH:mm`, or `''`
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.min]       earliest day, `YYYY-MM-DD`
 * @param {string} [props.max]       latest day, `YYYY-MM-DD`
 * @param {string} [props.error]
 * @param {string} [props.defaultTime]  used when a day is chosen with no time yet
 */
export default function DateTimeField({
  id, label, timeLabel, value, onChange, min, max, error = '', defaultTime = '09:00',
}) {
  const [day = '', time = ''] = (value || '').split('T');
  const [pendingTime, setPendingTime] = useState('');
  const shownTime = time.slice(0, 5) || pendingTime;

  return (
    <div className="field-row datetime-field">
      <div className="field">
        <DatePicker
          id={id}
          label={label}
          value={day}
          min={min || undefined}
          max={max || undefined}
          error={error}
          openOnClick
          onChange={(d) => onChange(d ? `${d}T${shownTime || defaultTime}` : '')}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-time`}>{timeLabel}</label>
        <input
          id={`${id}-time`}
          type="time"
          className="input"
          value={shownTime}
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => {
            /* A cleared time sends nothing: `${day}T` is half a value, which
               the edit form could neither draw nor save (it threw on submit).
               The field keeps its last whole time; a date is always sent with
               one (final audit, Phase 6 review). */
            if (!e.target.value) return;
            if (day) onChange(`${day}T${e.target.value}`);
            else setPendingTime(e.target.value);
          }}
        />
      </div>
    </div>
  );
}
