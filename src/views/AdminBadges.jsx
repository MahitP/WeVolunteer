import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Award, AlertTriangle, Plus, Search, X } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { BADGE_CRITERIA_TYPES, BADGE_CRITERIA_META } from '../badgeCriteria';

/**
 * Badge administration.
 *
 * ── What was missing, and what was not ──
 *
 * Nothing here is new capability. `server/routes/badgeRoutes.js` has had four
 * finished endpoints for as long as badges have existed — list definitions
 * including inactive ones, create-or-update a definition, award one by hand,
 * revoke one — each validated, each inside a transaction, each writing an audit
 * row naming who acted. Every one of them had zero callers. An administrator
 * could not define a badge, award one, or take back a wrong one except with
 * `curl`.
 *
 * The revoke route's own note says why that mattered most: attendance can be
 * un-marked, `finalizeAttendance` takes the hours back off the ledger, and the
 * badge earned on those hours stays on the profile that also shows the
 * corrected record. That correction path was real, built, and impossible to
 * perform. The same note records the other case — a manual award made to the
 * wrong student, which `badgeService` deliberately never withdraws because it
 * only reverses its own.
 *
 * The code was also written as if a screen existed: `POST /api/admin/badges`
 * answers a bad criteria type with `{ error, field: 'criteria_type' }`, and a
 * field-level error shape has exactly one consumer.
 *
 * ── Why the vocabulary is imported rather than typed out ──
 *
 * `BADGE_CRITERIA_TYPES` and `BADGE_CRITERIA_META` come from
 * `server/badgeCriteria.js` through `src/badgeCriteria.js`. A criteria type the
 * server does not know produces a badge that is visible in the catalogue and
 * can never be earned by anybody — nothing throws, nothing logs, and the
 * symptom is "nobody has qualified yet". A hand-written dropdown is how that
 * happens, so the list is shared at build time. Same arrangement as
 * `src/issueReports.js`, and the reason `GET /api/issues/categories` has no
 * callers.
 *
 * ── Two sections, because there are two jobs ──
 *
 * Defining what the platform recognises is an administrative act on every
 * student's record at once, and `recordAudit` treats it that way — no
 * `targetUserId`, because a definition is about nobody in particular. Awarding
 * and revoking are acts about ONE person. Those are different jobs with
 * different blast radii, so they are different sections rather than one table
 * with more buttons.
 *
 * The person section shows what somebody already holds before offering to
 * change it, which is what makes revoking possible at all: an administrator
 * correcting a mistake needs to see the mistake.
 */

/** A definition the form is willing to submit. */
const blankBadge = () => ({
  id: null,
  name: '',
  description: '',
  icon: '🏅',
  category: '',
  criteria_type: 'hours',
  criteria_value: '',
  active: true,
});

export default function AdminBadges() {
  const [badges, setBadges] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [editing, setEditing] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState('');
  const [people, setPeople] = useState(null);
  const [searching, setSearching] = useState(false);
  const [subject, setSubject] = useState(null);
  const [held, setHeld] = useState(null);
  const [heldError, setHeldError] = useState('');

  const [awardId, setAwardId] = useState('');
  const [awardReason, setAwardReason] = useState('');
  const [awarding, setAwarding] = useState(false);
  const [awardError, setAwardError] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeBusy, setRevokeBusy] = useState(false);

  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await api.fetchBadgeDefinitions();
      setBadges(res.badges || []);
    } catch (err) {
      setBadges([]);
      setLoadError(err.message || 'These badge definitions could not be loaded.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Debounced AND aborted, which are two different fixes — the reasoning is
   * `BrowseEvents`'s, for the same endpoint.
   *
   * The debounce stops "dana" being four requests. The abort stops a slow
   * response for "da" landing after a fast one for "dana" and replacing newer
   * results with older ones, which the debounce narrows but does not close.
   *
   * `type: 'users'` is the value `/api/directory/search` actually accepts —
   * 'people' is what the Discover scope control calls it in the UI, and passing
   * that here searched organizations too.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setPeople(null); setSearching(false); return undefined; }

    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchDirectory(q, { type: 'users', limit: 10, signal: controller.signal })
        .then(res => { setPeople(res.users || []); setSearching(false); })
        .catch(err => {
          if (err.name === 'AbortError') return;
          setPeople([]);
          setSearching(false);
        });
    }, 250);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const loadHeld = useCallback(async (person) => {
    setHeldError('');
    setHeld(null);
    try {
      const res = await api.apiFetch(`/api/users/${encodeURIComponent(person.id)}/badges`);
      setHeld(res.badges || []);
    } catch (err) {
      setHeld([]);
      setHeldError(err.message || 'Their badges could not be loaded.');
    }
  }, []);

  const pick = async (person) => {
    setSubject(person);
    setQuery('');
    setPeople(null);
    setAwardError('');
    setAwardId('');
    setAwardReason('');
    await loadHeld(person);
  };

  const submitDefinition = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.saveBadgeDefinition({
        ...editing,
        /* Sent as-is. The server validates and coerces: an empty threshold
           becomes 0, which is what `manual` and `early_adopter` want, and a
           non-numeric one is refused with `field: 'criteria_value'`. Coercing
           here would mean two rules for one question. */
        criteria_value: editing.criteria_value,
      });
      setNotice(editing.id ? `Saved “${editing.name}”.` : `Created “${editing.name}”.`);
      setEditing(null);
      await load();
    } catch (err) {
      /* `field` is what lets the message land on the control that caused it.
         The endpoint returns it for both criteria faults, which is the whole
         reason it does. */
      setFormError({ message: err.message || 'That badge could not be saved.', field: err.field });
    } finally {
      setSaving(false);
    }
  };

  const submitAward = async (e) => {
    e.preventDefault();
    setAwarding(true);
    setAwardError('');
    try {
      await api.awardBadge({ userId: subject.id, badgeId: awardId, reason: awardReason.trim() || undefined });
      setNotice(`Awarded to ${subject.name}.`);
      setAwardId('');
      setAwardReason('');
      await loadHeld(subject);
    } catch (err) {
      /* 409 is its own case and worth keeping distinct: the request was
         well-formed and conflicts with a UNIQUE(user_id, badge_id) row that
         already exists, which is "they already have it" rather than an error
         the administrator should re-read the form over. */
      setAwardError(err.message || 'That badge could not be awarded.');
    } finally {
      setAwarding(false);
    }
  };

  const confirmRevoke = async () => {
    setRevokeBusy(true);
    try {
      await api.revokeBadge({
        userId: subject.id,
        badgeId: revoking.id,
        reason: revokeReason.trim() || undefined,
      });
      setNotice(`Removed “${revoking.name}” from ${subject.name}.`);
      setRevoking(null);
      setRevokeReason('');
      await loadHeld(subject);
    } catch (err) {
      setHeldError(err.message || 'That badge could not be removed.');
      setRevoking(null);
    } finally {
      setRevokeBusy(false);
    }
  };

  const meta = BADGE_CRITERIA_META[editing?.criteria_type] || {};
  const noticeRef = useRef(null);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);

  if (badges === null) {
    return (
      <div className="page">
        <header className="page-head">
          <div><h2 className="page-title">Badges</h2></div>
        </header>
        <div className="stack"><LoadingSkeleton rows={5} /></div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h2 className="page-title">Badges</h2>
          <p className="muted">
            What the platform recognises, and who holds what. Defining a badge changes
            every student&apos;s record at once; awarding one is about a single person.
          </p>
        </div>
        <div>
          <button type="button" className="btn btn-primary" onClick={() => { setEditing(blankBadge()); setFormError(null); }}>
            <Plus size={16} aria-hidden="true" /> New badge
          </button>
        </div>
      </header>

      <div className="stack">
        {/* Announced rather than only shown: every action here writes an audit
            row against the administrator's name, so "did that work" must not be
            answered by inspecting the table. */}
        {notice && (
          <div className="alert alert-brand" role="status" tabIndex={-1} ref={noticeRef}>
            <Award size={18} aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}

        {loadError && (
          <div className="alert alert-danger" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <span className="alert-title">These badge definitions could not be loaded.</span>{' '}
              {loadError}{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Try again</button>
            </span>
          </div>
        )}

        {/* ── Definitions ───────────────────────────────────────────────────── */}
        <section className="card card-pad" aria-labelledby="badge-definitions-heading">
          <div className="card-head"><h3 id="badge-definitions-heading">Badge definitions</h3></div>

          {badges.length === 0 ? (
            <EmptyState
              icon={Award}
              title="No badges are defined yet"
              message="A badge is a name, an icon and a rule for earning it. Students see the ones they hold on their profile."
              headingLevel={4}
              action={
                <button type="button" className="btn btn-primary" onClick={() => setEditing(blankBadge())}>
                  Define the first badge
                </button>
              }
            />
          ) : (
            <div className="tablescroll">
              <table className="table">
                <caption className="sr-only">
                  Every badge definition, active and inactive, with how it is earned.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Badge</th>
                    <th scope="col">How it is earned</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {badges.map(b => {
                    const m = BADGE_CRITERIA_META[b.criteria_type];
                    return (
                      <tr key={b.id}>
                        <td>
                          <span aria-hidden="true">{b.icon}</span>{' '}
                          <span className="strong">{b.name}</span>
                          <div className="muted small">{b.description}</div>
                        </td>
                        <td>
                          {m ? m.label : b.criteria_type}
                          {m?.threshold ? ` · ${b.criteria_value}${m.unit === '%' ? '%' : ` ${m.unit}`}` : ''}
                          {/* A type the evaluator does not know can only get here
                              from a row that predates the validator. Saying so is
                              better than rendering it as if it worked, because the
                              symptom is otherwise a badge nobody ever earns. */}
                          {!m && <div className="muted small">Unknown to the evaluator — this badge cannot be earned.</div>}
                        </td>
                        <td>{b.active ? 'Active' : 'Inactive'}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setEditing({ ...b, active: Boolean(b.active), criteria_value: b.criteria_value ?? '' });
                              setFormError(null);
                            }}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── One person's badges ───────────────────────────────────────────── */}
        <section className="card card-pad" aria-labelledby="badge-person-heading">
          <div className="card-head"><h3 id="badge-person-heading">Award or take back a badge</h3></div>

          <div className="form-group">
            <label htmlFor="badge-person-search">Find a volunteer</label>
            <div className="input-with-icon">
              <Search size={16} aria-hidden="true" />
              <input
                id="badge-person-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or username"
                autoComplete="off"
              />
            </div>
            <p className="muted small" id="badge-person-hint">
              Two characters or more. Awarding and removing both write an audit row against your name.
            </p>
          </div>

          {searching && <p className="muted" role="status">Searching…</p>}
          {people && people.length === 0 && !searching && (
            <p className="muted" role="status">Nobody matched that.</p>
          )}
          {people && people.length > 0 && (
            <ul className="list-plain" aria-label="Search results">
              {people.map(u => (
                <li key={u.id}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick(u)}>
                    <span aria-hidden="true">{u.avatar || '👤'}</span> {u.name}
                    {u.username ? <span className="muted"> @{u.username}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {subject && (
            <div className="stack">
              <div className="row-between row-wrap">
                <h4>
                  <span aria-hidden="true">{subject.avatar || '👤'}</span> {subject.name}
                </h4>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setSubject(null); setHeld(null); setAwardError(''); }}
                >
                  <X size={16} aria-hidden="true" /> Clear
                </button>
              </div>

              {heldError && (
                <div className="alert alert-danger" role="alert">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span>{heldError}</span>
                </div>
              )}

              {held === null ? <LoadingSkeleton rows={2} /> : held.length === 0 ? (
                <p className="muted">They hold no badges yet.</p>
              ) : (
                <ul className="list-plain" aria-label={`Badges ${subject.name} holds`}>
                  {held.map(b => (
                    <li key={b.id} className="row-between row-wrap">
                      <span>
                        <span aria-hidden="true">{b.icon}</span> {b.name}
                        {b.earned_at && (
                          <span className="muted small"> · earned {new Date(b.earned_at).toLocaleDateString()}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setRevoking(b); setRevokeReason(''); }}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={submitAward} className="stack-md" noValidate>
                <div className="form-group">
                  <label htmlFor="badge-award-select">Award a badge by hand</label>
                  <select
                    id="badge-award-select"
                    value={awardId}
                    onChange={(e) => setAwardId(e.target.value)}
                    required
                  >
                    <option value="">Choose a badge…</option>
                    {badges.filter(b => b.active).map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  {/* Only active definitions. Awarding an inactive badge would put
                      something on a profile that the catalogue does not list. */}
                </div>
                <div className="form-group">
                  <label htmlFor="badge-award-reason">Why (optional, kept in the audit trail)</label>
                  <input
                    id="badge-award-reason"
                    type="text"
                    value={awardReason}
                    onChange={(e) => setAwardReason(e.target.value)}
                    maxLength={200}
                  />
                </div>
                {awardError && (
                  <div className="alert alert-danger" role="alert">
                    <AlertTriangle size={18} aria-hidden="true" />
                    <span>{awardError}</span>
                  </div>
                )}
                <button type="submit" className="btn btn-primary" disabled={awarding || !awardId}>
                  {awarding ? 'Awarding…' : 'Award badge'}
                </button>
              </form>
            </div>
          )}
        </section>
      </div>

      {editing && (
        <BadgeForm
          badge={editing}
          meta={meta}
          error={formError}
          busy={saving}
          onChange={setEditing}
          onSubmit={submitDefinition}
          onCancel={() => { setEditing(null); setFormError(null); }}
        />
      )}

      {revoking && (
        <ConfirmDialog
          title={`Remove “${revoking.name}”?`}
          confirmLabel={revokeBusy ? 'Removing…' : 'Remove badge'}
          destructive
          busy={revokeBusy}
          onConfirm={confirmRevoke}
          onCancel={() => setRevoking(null)}
        >
          <p>
            This takes the badge off {subject?.name}&apos;s profile. It is recorded in the audit
            trail against your name.
          </p>
          <p className="muted small">
            If they still meet the criteria for an automatic badge, it can be earned again.
            A badge given by hand will not come back on its own.
          </p>
          <div className="form-group">
            {/* Worded differently from the award form's reason field, which can
                be on screen at the same time. Two controls whose accessible
                names are both "Why (optional…)" are indistinguishable to a
                screen reader, and were to `getByLabelText` as well. */}
            <label htmlFor="badge-revoke-reason">Why it is being removed (optional, kept in the audit trail)</label>
            <input
              id="badge-revoke-reason"
              type="text"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              maxLength={200}
            />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The definition form.
 *
 * A dialog rather than an inline row, because it is the same form for creating
 * and editing and because the threshold field's meaning changes with the
 * criteria type — a control that appears and disappears inside a table row is
 * harder to follow than one in a panel that is about a single badge.
 */
function BadgeForm({ badge, meta, error, busy, onChange, onSubmit, onCancel }) {
  const nameRef = useRef(null);
  const typeRef = useRef(null);
  const valueRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  /* Field-level, using the `field` the endpoint sends. Focus moves to the
     control that caused the refusal rather than leaving the reader to find it. */
  useEffect(() => {
    if (!error?.field) return;
    if (error.field === 'criteria_type') typeRef.current?.focus();
    if (error.field === 'criteria_value') valueRef.current?.focus();
  }, [error]);

  const set = (patch) => onChange({ ...badge, ...patch });

  return (
    <ConfirmDialog
      title={badge.id ? 'Edit badge' : 'New badge'}
      confirmLabel={busy ? 'Saving…' : 'Save badge'}
      busy={busy}
      onConfirm={onSubmit}
      onCancel={onCancel}
    >
      <form onSubmit={onSubmit} className="stack-md" noValidate>
        {error && (
          <div className="alert alert-danger" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>{error.message}</span>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="badge-name">Name</label>
          <input id="badge-name" ref={nameRef} type="text" required maxLength={80}
            value={badge.name} onChange={(e) => set({ name: e.target.value })} />
        </div>

        <div className="form-group">
          <label htmlFor="badge-description">Description</label>
          <input id="badge-description" type="text" required maxLength={200}
            value={badge.description} onChange={(e) => set({ description: e.target.value })} />
          <p className="muted small">Students read this on their profile, so say what earning it means.</p>
        </div>

        <div className="form-group">
          <label htmlFor="badge-icon">Icon</label>
          <input id="badge-icon" type="text" required maxLength={8}
            value={badge.icon} onChange={(e) => set({ icon: e.target.value })} />
          <p className="muted small">One emoji.</p>
        </div>

        <div className="form-group">
          <label htmlFor="badge-category">Category</label>
          <input id="badge-category" type="text" required maxLength={40}
            value={badge.category} onChange={(e) => set({ category: e.target.value })} />
          <p className="muted small">Groups the badge in the catalogue, e.g. Service, Reliability.</p>
        </div>

        <div className="form-group">
          <label htmlFor="badge-criteria-type">How it is earned</label>
          <select id="badge-criteria-type" ref={typeRef} value={badge.criteria_type}
            onChange={(e) => set({ criteria_type: e.target.value })}>
            {/* From the server's own list. A type it does not know produces a
                badge that is visible and unearnable, so this cannot be typed
                out here — see src/badgeCriteria.js. */}
            {BADGE_CRITERIA_TYPES.map(t => (
              <option key={t} value={t}>{BADGE_CRITERIA_META[t]?.label || t}</option>
            ))}
          </select>
          {meta.help && <p className="muted small">{meta.help}</p>}
        </div>

        {/* The threshold only exists for the types that count something.
            `manual` and `early_adopter` take none, and offering an empty number
            field for them invites a value that changes nothing. */}
        {meta.threshold && (
          <div className="form-group">
            <label htmlFor="badge-criteria-value">
              Threshold{meta.unit ? ` (${meta.unit})` : ''}
            </label>
            <input id="badge-criteria-value" ref={valueRef} type="number" min="0" step="1"
              value={badge.criteria_value}
              onChange={(e) => set({ criteria_value: e.target.value })} />
          </div>
        )}

        <div className="form-group">
          <label htmlFor="badge-active" className="row">
            <input id="badge-active" type="checkbox" checked={badge.active}
              onChange={(e) => set({ active: e.target.checked })} />
            <span>Active</span>
          </label>
          <p className="muted small">
            An inactive badge stays on the profiles of everyone who already holds it and is
            not offered to anybody new. This is how a badge is retired without rewriting
            history.
          </p>
        </div>
      </form>
    </ConfirmDialog>
  );
}
