import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Plus, Settings2, Users, CalendarDays } from 'lucide-react';
import { api } from '../utils/api';
import { can } from '../authz';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import OrgAvatar from '../components/common/OrgAvatar';
import { organizationPath, organizationSubPath } from '../utils/organizationUrl';

/**
 * The organizations you belong to, and the ones you run.
 *
 * ── Why this page exists ──
 *
 * There were three organization routes — create one, edit one, view one — and no
 * page that listed them. An organizer who founded a club had nowhere that said
 * so: they had to remember the slug or find their own club through the public
 * search, alongside everybody else's. The server has supported `?mine=true`
 * since organizations shipped and the only thing consuming it was the dropdown
 * in the event editor.
 *
 * So this is the missing middle of the journey: see what you have, manage one,
 * or make another — in that order, because the first is what somebody arriving
 * here almost always wants.
 *
 * ── Managing versus belonging ──
 *
 * Both are shown, separated, because they are different relationships and
 * running them together would put a club somebody merely joined next to one
 * they are responsible for. The Manage control appears only on the first group,
 * and the server re-checks it regardless — this page hiding a link is a
 * convenience, never the check.
 */
export default function OrganizationsHome({ currentUser }) {
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const canCreate = can(currentUser, 'organization.create') && Boolean(currentUser?.verified);

  useEffect(() => {
    let cancelled = false;
    api.fetchOrganizations({ mine: true, limit: 50 })
      .then(res => { if (!cancelled) setMine(res?.organizations ?? []); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const managed = mine.filter(o => o.viewerRole === 'manager' || o.memberRole === 'manager');
  const joined = mine.filter(o => !(o.viewerRole === 'manager' || o.memberRole === 'manager'));

  return (
    <div className="page stack-lg">
      <div className="page-head row-between row-wrap" style={{ gap: 'var(--s3)' }}>
        <div>
          <h2 className="page-title">Organizations</h2>
          <p className="muted">Clubs and programmes you run or belong to.</p>
        </div>
        {canCreate && (
          <Link to="/organizations/new" className="btn btn-primary">
            <Plus size={16} aria-hidden="true" /> Create organization
          </Link>
        )}
      </div>

      {error && <p className="alert alert-danger" role="alert">{error}</p>}

      {loading ? (
        <LoadingSkeleton heights={[120, 120]} className="stack-lg" style={{}} />
      ) : mine.length === 0 ? (
        <EmptyState
          icon={Building2}
          /* The only thing under this page's h1, so the default h3 would skip a
             level for anybody navigating by heading. */
          headingLevel={2}
          title="You are not in any organizations yet"
          message={canCreate
            ? 'Create one for your club or programme, or join one from Discover.'
            : 'Join one from Discover and it will appear here.'}
          action={canCreate
            ? <Link className="btn btn-primary" to="/organizations/new"><Plus size={15} aria-hidden="true" /> Create organization</Link>
            : <Link className="btn btn-secondary" to="/discover?find=organizations">Browse organizations</Link>}
        />
      ) : (
        <>
          {managed.length > 0 && (
            <OrgGroup title="You manage" organizations={managed} manageable />
          )}
          {joined.length > 0 && (
            <OrgGroup title="You belong to" organizations={joined} />
          )}
        </>
      )}
    </div>
  );
}

function OrgGroup({ title, organizations, manageable = false }) {
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2></div>
      <div className="card-body">
        <ul className="list org-home-list">
          {organizations.map(org => (
            <li key={org.id} className="list-row">
              <Link to={organizationPath(org)} className="card-link row person">
                <OrgAvatar organization={org} size={20} />
                <span className="stack-xs" style={{ minWidth: 0 }}>
                  <span className="person-name truncate">{org.name}</span>
                  <span className="person-meta truncate">
                    <Users size={12} aria-hidden="true" /> {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                    {org.eventCount > 0 && (
                      <> · <CalendarDays size={12} aria-hidden="true" /> {org.eventCount} {org.eventCount === 1 ? 'event' : 'events'}</>
                    )}
                  </span>
                </span>
              </Link>
              {/* Outside the link, never inside it: a control nested in an
                  anchor is invalid markup and a mis-tap navigates instead. */}
              {manageable && (
                <Link
                  to={organizationSubPath(org, 'edit')}
                  className="btn btn-secondary btn-sm"
                  aria-label={`Manage ${org.name}`}
                >
                  <Settings2 size={14} aria-hidden="true" /> Manage
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
