import React from 'react';
import { formatHours, gradeLabel } from '../../utils/helpers';

/** One volunteer in an organizer's roster — the dashboard's row, shared. */
export default function VolunteerRosterRow({ person, onViewProfile }) {
  return (
    <div className="list-row">
      <span className="avatar">{person.avatar || '👤'}</span>
      <div className="roster-person s-49cdf8">
        <div className="person-name">{person.name}</div>
        <div className="person-meta truncate">
          {[gradeLabel(person.grade), `${person.shifts} shift${person.shifts !== 1 ? 's' : ''} with you`].filter(Boolean).join(' · ')}
        </div>
      </div>
      <span className={`hourspill ${!person.hours ? 'zero' : ''}`}>
        {formatHours(person.hours)} <span>total</span>
      </span>
      <button className="btn btn-ghost btn-sm" onClick={() => onViewProfile(person.volunteer)}>
        Profile
      </button>
    </div>
  );
}
