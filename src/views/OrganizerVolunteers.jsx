import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, Inbox } from 'lucide-react';
import { acceptedForOrganizer, rosterOf, downloadRosterCsv } from '../utils/volunteerRoster';
import VolunteerRosterRow from '../components/organizer/VolunteerRosterRow';
import EmptyState from '../components/common/EmptyState';

/**
 * Everyone who has volunteered at an organizer's events.
 *
 * The dashboard shows the first few and links here — the owner's rule for every
 * long list (FX-31): "show more … to take them to the specific webpage", with a
 * way back, rather than letting the dashboard grow by one row per volunteer.
 * Same roster, same order and same ledger as the dashboard, from the shared
 * `utils/volunteerRoster.js`.
 */
export default function OrganizerVolunteers({ currentUser, events = [], applications = [], onViewVolunteerProfile, addToast }) {
  const accepted = useMemo(
    () => acceptedForOrganizer(events, applications, currentUser?.id),
    [events, applications, currentUser?.id]
  );
  const roster = useMemo(() => rosterOf(accepted), [accepted]);

  return (
    <div className="page stack-lg">
      <div className="page-head row-between row-wrap">
        <div>
          <Link to="/" className="btn btn-ghost btn-sm loggedhours-back">
            <ArrowLeft size={15} aria-hidden="true" /> Back to dashboard
          </Link>
          <h2 className="page-title">Your volunteers</h2>
          <p className="muted">
            {roster.length === 1 ? 'One person has' : `${roster.length} people have`} volunteered at your events, most hours first.
          </p>
        </div>
        {roster.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={() => { downloadRosterCsv(accepted); addToast?.('Roster downloaded.', 'success'); }}
          >
            <Download size={15} aria-hidden="true" /> Download ledger
          </button>
        )}
      </div>

      {roster.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No confirmed volunteers yet"
          message="Once you confirm applications, the people helping at your events show up here."
        />
      ) : (
        <div className="card">
          <div className="list">
            {roster.map(person => (
              <VolunteerRosterRow key={person.id} person={person} onViewProfile={onViewVolunteerProfile} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
