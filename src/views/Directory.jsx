/**
 * Find people and organizations.
 *
 * One search box over both, because a student typing "NHS" does not know
 * whether they are looking for a club or a person, and making them choose a tab
 * first is asking them to answer a question they came here to ask. Results are
 * grouped and every row is explicitly badged Member or Organization, so the two
 * are never ambiguous even though they share a list.
 *
 * ── Why the request is debounced and aborted ──
 *
 * `useDebounce` holds the request until typing pauses, so "volunteer" is one
 * query rather than nine. The in-flight request is also ABORTED when a newer
 * one starts — without that, a slow response for "vol" can land after a fast
 * one for "volunteer" and overwrite the newer results with older ones. The
 * debounce is the performance fix; the abort is the correctness one, and they
 * are not the same thing.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Search, Users, UserRound, MapPin, Building2, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { can } from '../authz';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import { useDebounce } from '../hooks/useDebounce';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'users', label: 'People' },
  { id: 'organizations', label: 'Organizations' },
];

export default function Directory({ currentUser }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  const run = useCallback((q, kind) => {
    abortRef.current?.abort();
    if (q.trim().length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    api.searchDirectory(q.trim(), { type: kind, signal: controller.signal })
      .then(res => { setResults(res); setLoading(false); })
      .catch(err => {
        /* An abort is this component cancelling itself, not a failure to show
           the user. Anything else is. */
        if (err.name === 'AbortError') return;
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const debouncedRun = useDebounce(run, 250);

  useEffect(() => {
    debouncedRun(query, type);
  }, [query, type, debouncedRun]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const users = results?.users ?? [];
  const organizations = results?.organizations ?? [];
  const nothing = results && !loading && users.length === 0 && organizations.length === 0;

  return (
    <div className="page stack-lg">
      <div className="page-head row-between">
        <div>
          <h1>Find people and organizations</h1>
          <p className="muted">Search by name, username, or organization.</p>
        </div>
        {can(currentUser, 'organization.create') && (
          <Link className="btn btn-primary" to="/organizations/new">
            <Plus size={16} aria-hidden="true" /> New organization
          </Link>
        )}
      </div>

      <div className="card card-pad stack-md">
        <div className="field">
          <label htmlFor="directory-q">Search</label>
          <div className="search-bar">
            <Search size={16} aria-hidden="true" />
            <input
              id="directory-q"
              className="input"
              type="search"
              value={query}
              placeholder="A name, a username, or an organization"
              autoComplete="off"
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <span className="field-hint">Type at least two characters.</span>
        </div>

        <div className="tabs" role="tablist" aria-label="Filter results">
          {FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={type === f.id}
              className={type === f.id ? 'tab tab-active' : 'tab'}
              onClick={() => setType(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/**
        * A single live region for the whole result count, rather than one per
        * row. A screen reader should hear "7 results" once, not seven
        * announcements racing the debounce.
        */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading ? 'Searching' : results ? `${users.length + organizations.length} results` : ''}
      </p>

      {loading && <LoadingSkeleton heights={[72, 72, 72]} className="stack-md" />}

      {error && !loading && (
        <EmptyState icon={Search} title="Search failed" message={error} />
      )}

      {nothing && (
        <EmptyState
          icon={Search}
          title="Nothing matched"
          message={`No people or organizations matched “${results.query}”. Check the spelling, or try part of a name.`}
        />
      )}

      {!loading && !results && (
        <EmptyState
          icon={Users}
          title="Search for someone"
          message="Find a friend by their username, or an organization you want to join."
        />
      )}

      {!loading && organizations.length > 0 && (
        <section className="stack-md">
          <h2 className="section-head">Organizations</h2>
          <ul className="list directory-list">
            {organizations.map(org => (
              <li key={org.id} className="list-row">
                <Link to={`/organizations/${org.slug}`} className="card card-pad card-link directory-row">
                  <span className="avatar directory-avatar" aria-hidden="true"><Building2 size={18} /></span>
                  <span className="directory-body">
                    <span className="directory-name">{org.name}</span>
                    <span className="muted directory-meta">
                      {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                      {org.eventCount > 0 && ` · ${org.eventCount} ${org.eventCount === 1 ? 'event' : 'events'}`}
                    </span>
                  </span>
                  <span className="tag tag-info directory-kind">Organization</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!loading && users.length > 0 && (
        <section className="stack-md">
          <h2 className="section-head">People</h2>
          <ul className="list directory-list">
            {users.map(user => (
              <li key={user.id} className="list-row">
                <Link
                  to={user.username ? `/users/@${user.username}` : `/users/id/${user.id}`}
                  className="card card-pad card-link directory-row"
                >
                  <span className="avatar directory-avatar" aria-hidden="true">
                    {user.profilePictureUrl
                      ? <img src={user.profilePictureUrl} alt="" className="avatar-img" />
                      : (user.avatar || <UserRound size={18} />)}
                  </span>
                  <span className="directory-body">
                    <span className="directory-name">{user.name}</span>
                    <span className="muted directory-meta">
                      {user.username && `@${user.username}`}
                      {user.location && (
                        <>
                          {user.username && ' · '}
                          <MapPin size={12} aria-hidden="true" /> {user.location}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="tag tag-brand directory-kind">Member</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
