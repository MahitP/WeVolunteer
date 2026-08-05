import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, EyeOff, RotateCw, ChevronLeft } from 'lucide-react';
import { api } from '../utils/api';
import { BarChart } from '../components/BarChart';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';

/**
 * Error triage. `super_admin` only.
 *
 * ── Why this is a route and not a fourth dashboard ──
 *
 * `super_admin` already reaches `AdminDashboard` through the `staff` persona.
 * Adding a persona for this would touch `PERSONAS`, `PAGE_META`,
 * `DASHBOARD_NAV` and `App.shellByRole.test.jsx` — a much larger change than a
 * triage screen justifies. So this is one more capability-gated route in
 * `APP_ROUTES`, reached from one more `NAV` entry, exactly like every other
 * page in the shell.
 *
 * ── The gate is real; hiding it is not the gate ──
 *
 * `error.read` and `error.write` are in `SUPER_ONLY`, so `can()` refuses them
 * BEFORE it consults per-user grants — no `user_capabilities` row can reach
 * this, and `capability.grant` is not a path to it. The hidden nav entry and
 * the route gate are UX; the four endpoints re-check on every request. That is
 * what makes it safe for this screen to render redacted stacks and file paths.
 *
 * ── What is shown, and what is deliberately not ──
 *
 * Sorting is not offered. The API orders by `last_seen_at DESC` because the
 * thing that broke most recently is the thing most likely to still be broken,
 * and a sort control would imply the server can answer questions it cannot.
 * The plan does not ask for one either.
 */

const STATUS_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' },
  { value: '', label: 'All' },
];

const SOURCE_FILTERS = [
  { value: '', label: 'All sources' },
  { value: 'client', label: 'Client' },
  { value: 'server', label: 'Server' },
  { value: 'worker', label: 'Worker' },
];

/** Matches the server's own page size, so "Next" means what the server does. */
const PAGE_SIZE = 50;

const STATUS_TONE = { open: 'tag-danger', resolved: 'tag-ok', ignored: 'tag-info' };
const SOURCE_TONE = { client: 'tag-brand', server: 'tag-accent', worker: 'tag-info' };

/** Absolute is the wrong unit for triage: "3 hours ago" answers "is it still
 *  happening", which is the only question this screen exists to answer. */
function relative(iso) {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Filters({ status, source, onStatus, onSource, disabled }) {
  return (
    <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
      <div className="row" role="group" aria-label="Filter by status" style={{ gap: 'var(--s1)' }}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value || 'all'}
            className={`btn btn-sm ${status === f.value ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={status === f.value}
            disabled={disabled}
            onClick={() => onStatus(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <label className="row" style={{ gap: 'var(--s2)' }}>
        <span className="small dim">Source</span>
        <select
          className="input"
          value={source}
          disabled={disabled}
          onChange={(e) => onSource(e.target.value)}
        >
          {SOURCE_FILTERS.map((f) => (
            <option key={f.value || 'all'} value={f.value}>{f.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function GroupRow({ group, onOpen }) {
  return (
    <button className="etri-row" onClick={() => onOpen(group.fingerprint)}>
      <span className="etri-row-main">
        <span className="row row-wrap" style={{ gap: 'var(--s2)' }}>
          <span className={`tag ${SOURCE_TONE[group.source] ?? 'tag-info'}`}>{group.source}</span>
          {group.kind && <span className="tag">{group.kind}</span>}
          <span className={`tag ${STATUS_TONE[group.status] ?? 'tag-info'}`}>{group.status}</span>
        </span>
        {/* The message can be a full sentence or a minified one-liner, and it is
            the only thing that identifies the problem — so it wraps rather than
            truncating to an ellipsis that hides which failure this is. */}
        <span className="etri-message">{group.message}</span>
        <span className="small dim etri-route">{group.route}</span>
      </span>

      <span className="etri-row-meta">
        <span className="etri-count">{group.occurrences}</span>
        <span className="small dim">
          {group.users_seen} {group.users_seen === 1 ? 'person' : 'people'}
        </span>
        <span className="small dim">{relative(group.last_seen_at)}</span>
      </span>
    </button>
  );
}

function Detail({ fingerprint, onBack, onStatusChange, addToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.fetchErrorGroup(fingerprint));
    } catch (err) {
      setError(err.message || 'Could not load that error group.');
    }
  }, [fingerprint]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (status) => {
    setSaving(true);
    try {
      await api.updateErrorStatus(fingerprint, status);
      addToast(`Marked ${status}.`, 'success');
      await load();
      onStatusChange();
    } catch (err) {
      addToast(err.message || 'Could not update that group.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="stack-lg">
        <button className="btn btn-secondary" onClick={onBack}><ChevronLeft size={15} /> All errors</button>
        <EmptyState icon={AlertTriangle} title="Could not load that error" message={error} />
      </div>
    );
  }
  if (!data) return <LoadingSkeleton heights={[64, 180, 240]} />;

  const { group, events } = data;

  return (
    <div className="stack-lg">
      <div className="row row-between row-wrap" style={{ gap: 'var(--s3)' }}>
        <button className="btn btn-secondary" onClick={onBack}><ChevronLeft size={15} /> All errors</button>
        <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
          {group.status !== 'resolved' && (
            <button className="btn btn-primary" disabled={saving} onClick={() => setStatus('resolved')}>
              <CheckCircle2 size={15} /> Resolve
            </button>
          )}
          {group.status !== 'ignored' && (
            <button className="btn btn-secondary" disabled={saving} onClick={() => setStatus('ignored')}>
              <EyeOff size={15} /> Ignore
            </button>
          )}
          {group.status !== 'open' && (
            <button className="btn btn-secondary" disabled={saving} onClick={() => setStatus('open')}>
              <RotateCw size={15} /> Reopen
            </button>
          )}
        </div>
      </div>

      <section className="card card-pad stack-sm">
        <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
          <span className={`tag ${SOURCE_TONE[group.source] ?? 'tag-info'}`}>{group.source}</span>
          {group.kind && <span className="tag">{group.kind}</span>}
          <span className={`tag ${STATUS_TONE[group.status] ?? 'tag-info'}`}>{group.status}</span>
          {group.release && <span className="tag">v{group.release}</span>}
        </div>
        <h2 className="etri-message">{group.message}</h2>
        <p className="small dim etri-route">{group.route}</p>

        <div className="grid grid-3">
          <div className="stat">
            <div className="stat-label">Occurrences</div>
            <div className="stat-value">{group.occurrences}</div>
          </div>
          <div className="stat">
            <div className="stat-label">People affected</div>
            <div className="stat-value">{group.users_seen}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Last seen</div>
            <div className="stat-value">{relative(group.last_seen_at)}</div>
          </div>
        </div>

        <p className="small dim">
          First seen {relative(group.first_seen_at)}
          {group.resolved_at && ` · resolved ${relative(group.resolved_at)}`}
        </p>

        {/* A fingerprint is 64 hex characters and will not wrap on its own.
            It is shown because it is what an engineer greps the server logs
            for, and `break-all` is what keeps it from widening the page. */}
        <p className="small dim etri-fingerprint">{group.fingerprint}</p>
      </section>

      <section>
        <div className="section-head">
          <h2>Recent occurrences</h2>
        </div>
        {events.length === 0 ? (
          <EmptyState
            title="No evidence retained"
            message="Occurrences are swept after 30 days. The counter above survives them."
          />
        ) : (
          <div className="stack-sm">
            {events.map((ev) => (
              <div key={ev.id} className="card card-pad stack-sm">
                <div className="row row-between row-wrap" style={{ gap: 'var(--s2)' }}>
                  <span className="small">{relative(ev.occurred_at)}</span>
                  <span className="row row-wrap small dim" style={{ gap: 'var(--s2)' }}>
                    {ev.method && <span>{ev.method}</span>}
                    {ev.status_code != null && <span>{ev.status_code}</span>}
                    {ev.role && <span>{ev.role}</span>}
                  </span>
                </div>
                {/* Already redacted server-side — emails, tokens and ids are
                    replaced before storage, so nothing here needs masking on
                    the way out. It scrolls rather than wraps because a wrapped
                    stack frame is unreadable. */}
                {ev.stack && <pre className="etri-stack">{ev.stack}</pre>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function ErrorDashboard({ addToast }) {
  const [groups, setGroups] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, sum] = await Promise.all([
        api.fetchErrorGroups({ status, source, limit: PAGE_SIZE, offset }),
        api.fetchErrorSummary(),
      ]);
      setGroups(list.groups ?? []);
      setTotal(list.total ?? 0);
      setSummary(sum);
    } catch (err) {
      setError(err.message || 'Could not load errors.');
    } finally {
      setLoading(false);
    }
  }, [status, source, offset]);

  useEffect(() => { load(); }, [load]);

  /* A filter change makes the current offset meaningless — page 3 of "open" is
     not page 3 of "all". Resetting is what stops a filter landing on an empty
     page that looks like "no errors". */
  const changeStatus = (value) => { setOffset(0); setStatus(value); };
  const changeSource = (value) => { setOffset(0); setSource(value); };

  if (selected) {
    return (
      <Detail
        fingerprint={selected}
        onBack={() => setSelected(null)}
        onStatusChange={load}
        addToast={addToast}
      />
    );
  }

  /* The paging bounds, named once. Both the button state and the handler read
     these, so there is no second copy to disagree with the first. */
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const statusCount = (name) => summary?.byStatus?.find((s) => s.status === name)?.groups ?? 0;
  const totalOccurrences = (summary?.bySource ?? []).reduce((n, s) => n + (s.occurrences ?? 0), 0);
  const clientGroups = summary?.bySource?.find((s) => s.source === 'client')?.groups ?? 0;

  return (
    <div className="stack-lg">
      {/* FOUR, not three. `.stats` is `auto-fit minmax(150px, 1fr)`, so at phone
          width it resolves to two columns — and three tiles leave a bordered
          empty cell sitting in the grid, which reads as a stat that failed to
          load. Four fills 2x2 on a phone and a single row on a desktop. The
          fourth is not filler: "how much of the queue has been dealt with" is
          the other half of "how much is open". */}
      <section className="stats">
        <div className="stat">
          <div className="stat-label">Open problems</div>
          <div className="stat-value">{statusCount('open')}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Resolved</div>
          <div className="stat-value">{statusCount('resolved')}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total occurrences</div>
          <div className="stat-value">{totalOccurrences}</div>
        </div>
        <div className="stat">
          <div className="stat-label">From browsers</div>
          <div className="stat-value">{clientGroups}</div>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Occurrences by day</h2></div>
        <div className="card card-pad">
          {/* Every one of these four props has a default written for the hours
              chart this component was built for. Omitting `caption` announces
              "Hours by period" to a screen reader, and the caption is the ONLY
              description such a reader gets — the visual half is aria-hidden.
              `emptyText` would otherwise read "No hours recorded yet". */}
          <BarChart
            data={summary?.byDay ?? []}
            valueKey="count"
            labelKey="day"
            highlightLast
            caption="Error occurrences by day, over the last 30 days"
            unit="Occurrences"
            periodLabel="Day"
            emptyText="No occurrences recorded yet"
          />
          <p className="small dim" style={{ marginTop: 'var(--s3)' }}>
            A 30-day window over retained evidence, not an all-time total —
            occurrences are swept after 30 days while the counters survive.
          </p>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Problems</h2></div>
        <div className="stack-sm">
          <Filters
            status={status}
            source={source}
            onStatus={changeStatus}
            onSource={changeSource}
            disabled={loading}
          />

          {loading && <LoadingSkeleton heights={[72, 72, 72]} className="stack-sm" style={{}} />}

          {!loading && error && (
            <EmptyState
              icon={AlertTriangle}
              title="Could not load errors"
              message={error}
              action={<button className="btn btn-primary" onClick={load}>Try again</button>}
            />
          )}

          {!loading && !error && groups.length === 0 && (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing to triage"
              message={
                status === 'open'
                  ? 'No open problems. Errors reported by browsers and the server land here.'
                  : 'No groups match this filter.'
              }
            />
          )}

          {!loading && !error && groups.map((g) => (
            <GroupRow key={g.fingerprint} group={g} onOpen={setSelected} />
          ))}

          {!loading && !error && total > PAGE_SIZE && (
            <div className="row row-between row-wrap" style={{ gap: 'var(--s2)' }}>
              <span className="small dim">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <div className="row" style={{ gap: 'var(--s2)' }}>
                {/* Each bound is expressed ONCE and drives both the disabled
                    state and the handler. The first version also clamped inside
                    the handler with `Math.max(0, …)`, and a mutation test showed
                    that clamp could not be made to fire: `disabled` already
                    blocked the only path to it. Two guards where one makes the
                    other unreachable is one guard and one thing that looks like
                    a guard — and the unreachable half is what rots. */}
                <button
                  className="btn btn-secondary"
                  disabled={!canPrev}
                  onClick={() => setOffset(offset - PAGE_SIZE)}
                >
                  Previous
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={!canNext}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
