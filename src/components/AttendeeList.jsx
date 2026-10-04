import React, { useEffect, useState } from 'react';
import { Users, Lock, EyeOff } from 'lucide-react';
import { api } from '../utils/api';
import { gradeLabel } from '../utils/helpers';

/**
 * Who else is coming.
 *
 * The server decides whether this caller may see the roster; `visible: false`
 * with a reason is a normal response. We never fetch-and-hide on the client.
 */
export default function AttendeeList({
  eventId,
  currentUser,
  onViewVolunteer
}) {
  const [state, setState] = useState({
    loading: true,
    visible: false,
    reason: null,
    attendees: []
  });
  useEffect(() => {
    let cancelled = false;
    setState(s => ({
      ...s,
      loading: true
    }));
    api.fetchAttendees(eventId).then(res => {
      if (!cancelled) setState({
        loading: false,
        ...res
      });
    }).catch(() => {
      if (!cancelled) setState({
        loading: false,
        visible: false,
        reason: 'error',
        attendees: []
      });
    });
    return () => {
      cancelled = true;
    };
  }, [eventId]);
  if (state.loading) {
    return <div className="stack-sm">
        {[0, 1, 2].map(i => <div key={i} className="skeleton skeleton-row" />)}
      </div>;
  }
  if (!state.visible) {
    const copy = {
      not_accepted: {
        icon: Users,
        title: 'Visible once you\'re confirmed',
        body: 'To protect volunteers\' privacy, the list of who\'s going is shown only to people confirmed for this event.'
      },
      private: {
        icon: EyeOff,
        title: 'The organizer keeps this private',
        body: 'This event\'s volunteer list isn\'t shared. Only the organizer can see who is coming.'
      },
      error: {
        icon: Lock,
        title: 'Couldn\'t load the list',
        body: 'Try reopening this event.'
      }
    }[state.reason] || {
      icon: Lock,
      title: 'Not available',
      body: ''
    };
    const Icon = copy.icon;
    return <div className="empty s-ffedc8">
        <span className="empty-icon"><Icon size={18} /></span>
        <h3>{copy.title}</h3>
        <p>{copy.body}</p>
      </div>;
  }
  if (state.attendees.length === 0) {
    return <div className="empty s-ffedc8">
        <span className="empty-icon"><Users size={18} /></span>
        <h3>No one confirmed yet</h3>
        <p>You'll be among the first. Confirmed volunteers show up here.</p>
      </div>;
  }
  /* Counted only when every grade is known. A student running the event is not
     sent the grade of a volunteer who keeps it private — the key is absent —
     and a count over the rest would be a wrong number stated as a fact. */
  const gradesKnown = state.attendees.every(a => Object.hasOwn(a, 'grade'));
  const students = gradesKnown ? state.attendees.filter(a => /^\d+$/.test(String(a.grade))) : [];
  return <div>
      <p className="small muted s-450599">
        <span className="strong">{state.attendees.length} volunteer{state.attendees.length !== 1 ? 's' : ''}</span> confirmed
        {students.length > 0 && `, including ${students.length} student${students.length !== 1 ? 's' : ''}`}.
      </p>

      <div className="list">
        {state.attendees.map(person => {
        const isMe = person.id === currentUser?.id;
        const meta = [gradeLabel(person.grade), person.school].filter(Boolean).join(' · ');
        return <div key={person.id} className={`list-row ${isMe ? 'is-me' : ''}`}>
              <span className="avatar">{person.avatar || '👤'}</span>
              <div className="truncate s-49cdf8">
                <div className="person-name truncate">
                  {person.name}{isMe && ' (you)'}
                </div>
                {meta && <div className="person-meta truncate">{meta}</div>}
              </div>
              {onViewVolunteer && !isMe && <button className="btn btn-ghost btn-sm" onClick={() => onViewVolunteer(person)}>
                  Profile
                </button>}
            </div>;
      })}
      </div>
    </div>;
}