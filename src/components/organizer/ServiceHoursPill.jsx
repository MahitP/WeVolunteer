import React from 'react';
import { Lock } from 'lucide-react';
import { formatHours } from '../../utils/helpers';
import { recordKeptPrivate } from '../../utils/applicantRecord';

/**
 * A volunteer's credited hours, beside their name on a staff screen.
 *
 * Says "Private" when the volunteer keeps their record to themselves, instead
 * of the "0 hrs" that an absent figure would otherwise format to. See
 * `recordKeptPrivate`.
 */
export default function ServiceHoursPill({ volunteer, children = null }) {
  if (recordKeptPrivate(volunteer)) {
    return (
      <span className="hourspill zero" title="They keep their volunteer hours private">
        <Lock size={11} aria-hidden="true" /> Private
      </span>
    );
  }
  const hours = volunteer?.volunteeredHours;
  return (
    <span className={`hourspill ${!hours ? 'zero' : ''}`}>
      {formatHours(hours)}{children}
    </span>
  );
}
