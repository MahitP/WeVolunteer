import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, BarChart3, Bug, CheckCircle2, Clock, Database, ExternalLink,
  Gauge, HeartPulse, Mail, MinusCircle, RefreshCw, Server, Sparkles, Zap,
} from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';

/**
 * Owner Center — one page that answers "is WeVolunteer healthy, and what needs
 * my attention?"
 *
 * ── What it is for ──
 *
 * Operating this platform meant opening Better Stack, Amplitude, the Upstash
 * console and the Pinecone console to answer questions that are each one line
 * long. This page holds those lines. It deliberately does NOT reproduce any of
 * those products: every section ends in a link to the real thing, because the
 * moment an answer here raises a question, the answer to that question is in a
 * tool built for it.
 *
 * ── Four requests, four independent cards ──
 *
 * The local half — this process, this database, the error trend — answers in a
 * millisecond and renders first. Each vendor is its own request behind its own
 * cache (`server/routes/ownerRoutes.js`), so one unreachable provider costs one
 * card rather than the page. A card that fails says what happened and offers
 * the same external link it would have offered had it worked.
 *
 * ── Nothing here is invented ──
 *
 * There are no placeholder figures and no controls that do not act. A number
 * that could not be read renders as "Unavailable" and a provider with no
 * credentials renders as "Not configured", with the variable that would
 * configure it named — which is the one piece of information the person reading
 * this page can actually act on.
 *
 * ── Refresh is manual ──
 *
 * There is no polling loop. Amplitude prices queries against an hourly budget
 * and Upstash prices commands against a monthly one, and a dashboard left open
 * in a tab overnight is exactly how a free tier is spent by accident. The
 * "Updated N ago" clock ticks on its own; nothing is fetched until somebody
 * asks.
 */
export default function OwnerCenter() {
  const [health, setHealth] = useState(request());
  const [monitoring, setMonitoring] = useState(request());
  const [analytics, setAnalytics] = useState(request());
  const [infrastructure, setInfrastructure] = useState(request());
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  /**
   * Guards every `setState` after an unmount.
   *
   * Four requests in flight and a page an owner opens and leaves quickly is the
   * shape that produces a state update on an unmounted tree.
   *
   * ── The line that says `alive.current = true` is load-bearing ──
   *
   * Without it this component renders "Checking…" forever, and it does so ONLY
   * in development — which is the worst place for a bug to only appear, because
   * it is the only place anybody looks. `main.jsx` renders inside `StrictMode`,
   * which mounts every effect, tears it down, and mounts it again. The teardown
   * sets the flag false; on the second mount nothing set it back, so every one
   * of the four responses arrived, found `alive.current === false`, and was
   * discarded. The network tab showed four 200s and the page showed nothing.
   *
   * Setting it on mount rather than only on unmount is what makes the guard a
   * property of the current mount instead of of the module. Found by opening the
   * page, which no unit test would have: `render()` in jsdom mounts once.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (fresh) => {
    setRefreshing(true);
    /* Existing data is deliberately KEPT while a refresh runs — the cards fade
       rather than empty. A dashboard that blanks itself every time somebody
       presses refresh is one that cannot be watched during an incident, which
       is the only time anybody presses it twice. */
    const run = async (fn, set) => {
      set(prev => ({ ...prev, loading: true }));
      try {
        const data = await fn();
        if (alive.current) set({ loading: false, data, error: null });
      } catch (err) {
        if (alive.current) set(prev => ({ loading: false, data: prev.data, error: err?.message || 'failed' }));
      }
    };

    await Promise.all([
      run(() => api.fetchOwnerHealth(), setHealth),
      run(() => api.fetchOwnerMonitoring(fresh), setMonitoring),
      run(() => api.fetchOwnerAnalytics(fresh), setAnalytics),
      run(() => api.fetchOwnerInfrastructure(fresh), setInfrastructure),
    ]);

    if (alive.current) {
      setRefreshing(false);
      setUpdatedAt(Date.now());
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const services = useMemo(
    () => serviceStatuses({ health: health.data, monitoring: monitoring.data, infrastructure: infrastructure.data }),
    [health.data, monitoring.data, infrastructure.data],
  );
  const needAttention = services.filter(s => s.tone === 'danger' || s.tone === 'warn');
  const anythingLoaded = health.data || monitoring.data || analytics.data || infrastructure.data;

  return (
    <div className="page stack-lg">
      <header className="owner-head">
        <div className="stack-xs" style={{ minWidth: 0 }}>
          <h2 className="row page-title" style={{ gap: 8 }}>
            <Gauge size={20} style={{ color: 'var(--brand)' }} aria-hidden="true" /> Owner Center
          </h2>
          <p className="dim small">
            Health, incidents, usage and the services WeVolunteer runs on — with a way through
            to each of them.
          </p>
        </div>

        <div className="owner-head-actions">
          {/**
            * The headline verdict, derived rather than declared.
            *
            * `role="status"` so a screen reader is told when it changes after a
            * refresh; the element is present from the first render so the live
            * region exists before it has anything to announce.
            */}
          <p className={`owner-verdict tone-${anythingLoaded ? (needAttention.length ? 'warn' : 'ok') : 'muted'}`} role="status">
            {!anythingLoaded
              ? 'Checking…'
              : needAttention.length === 0
                ? <><CheckCircle2 size={15} aria-hidden="true" /> All systems operational</>
                : <><AlertTriangle size={15} aria-hidden="true" /> {needAttention.length} {needAttention.length === 1 ? 'system needs' : 'systems need'} attention</>}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => load(true)}
            disabled={refreshing}
          >
            <RefreshCw size={15} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <UpdatedAgo at={updatedAt} />

      <SystemsCard services={services} loading={!anythingLoaded} />

      <ErrorsCard state={health} />

      <MonitoringCard state={monitoring} />

      <AnalyticsCard state={analytics} />

      <InfrastructureCard state={infrastructure} />
    </div>
  );
}

/** The shape every one of the four requests is held in. */
function request() {
  return { loading: true, data: null, error: null };
}

/* ── Shared pieces ───────────────────────────────────────────────────────── */

/**
 * "Updated 42 seconds ago", ticking without fetching anything.
 *
 * The distinction matters enough to be its own component: the number has to
 * keep moving so a stale page is visibly stale, and nothing about that requires
 * asking a vendor anything. A twenty-second interval is invisible to a reader
 * and free.
 */
function UpdatedAgo({ at }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!at) return undefined;
    const id = window.setInterval(() => tick(n => n + 1), 20_000);
    return () => window.clearInterval(id);
  }, [at]);

  if (!at) return null;
  return <p className="dim small owner-updated">Updated {relative(at)}.</p>;
}

function relative(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * A provider's non-`ok` state, said in words a person can act on.
 *
 * One component for all four providers, because the states are one vocabulary
 * (`server/integrations/providerResult.js`) and the whole reason that vocabulary
 * exists is so the page does not grow a translation layer per vendor.
 *
 * `not_configured` names the environment variables that would switch the
 * integration on — which is the one piece of information that turns "this card
 * is empty" into something the reader can act on. The NAMES come from the
 * server (`result.configureWith`) and are deliberately not written here.
 * `server/redis.privacy.test.js` fails the build on any file under `src/` that
 * so much as names one of the Redis connection variables — because a `VITE_`-
 * prefixed one would compile a write credential into the browser bundle, and the
 * cheapest way to make that impossible is to keep client source from naming
 * them at all. Copy that hard-coded them would be one careless refactor away
 * from being that bug, so it does not exist. A variable NAME is not a
 * credential; no value ever leaves the server.
 */
function ProviderNotice({ result, link, linkLabel }) {
  const configureWith = result?.configureWith;
  const copy = {
    not_configured: {
      tone: 'muted',
      title: 'Not configured',
      body: configureWith
        ? `Set ${configureWith} to switch this on. WeVolunteer runs normally without it.`
        : 'This integration has not been set up. WeVolunteer runs normally without it.',
    },
    unauthorized: {
      tone: 'danger',
      title: 'Credentials refused',
      body: 'The service rejected the token. It may have been rotated or revoked.',
    },
    forbidden: {
      tone: 'danger',
      title: 'Not permitted',
      body: 'The token is valid but is not allowed to read this.',
    },
    plan_restricted: {
      tone: 'muted',
      title: 'Not available on your plan',
      body: 'This account’s plan does not include this query. Nothing else here is affected.',
    },
    not_found: {
      tone: 'warn',
      title: 'Nothing to read',
      body: 'The service answered, but there is nothing set up on it yet.',
    },
    rate_limited: {
      tone: 'warn',
      title: 'Rate limited',
      body: 'The service asked us to slow down. Try again in a few minutes.',
    },
    timeout: {
      tone: 'warn',
      title: 'Took too long to answer',
      body: 'The service did not respond in time. It may be busy.',
    },
    unavailable: {
      tone: 'warn',
      title: 'Unable to reach service',
      body: 'The request did not get through. This says nothing about WeVolunteer itself.',
    },
    bad_response: {
      tone: 'warn',
      title: 'Unexpected answer',
      body: 'The service replied with something we did not understand.',
    },
  }[result?.state] || {
    tone: 'muted',
    title: 'Unavailable',
    body: 'No reading is available right now.',
  };

  return (
    <div className="owner-notice">
      <p className={`owner-notice-title tone-${copy.tone}`}>
        <MinusCircle size={15} aria-hidden="true" /> {copy.title}
      </p>
      <p className="small dim">{result?.detail || copy.body}</p>
      {result?.fetchedAt && result.stale && (
        <p className="small dim">Showing the last reading, from {relative(result.fetchedAt)}.</p>
      )}
      {link && <ExternalDashboardLink href={link} label={linkLabel} />}
    </div>
  );
}

/**
 * A link out to the service's own dashboard.
 *
 * `rel="noopener noreferrer"` is not decoration here: without `noopener` the
 * opened page holds `window.opener` and can navigate this tab, and this tab is
 * an authenticated owner session.
 */
function ExternalDashboardLink({ href, label }) {
  return (
    <a className="btn btn-secondary btn-sm row owner-link" href={href} target="_blank" rel="noopener noreferrer">
      {label} <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

/** A figure, with an optional week-on-week change beside it. */
function Figure({ label, value, trend, note }) {
  return (
    <div className="owner-figure">
      <span className="owner-figure-label">{label}</span>
      <span className="owner-figure-value tnum">{value}</span>
      {typeof trend === 'number' && (
        /* `+0%` is a real answer and is shown as one. A missing trend is `null`
           and renders nothing, because "we cannot tell yet" and "no change" are
           different things to put in front of somebody. */
        <span className={`owner-figure-trend tone-${trend > 0 ? 'ok' : trend < 0 ? 'warn' : 'muted'}`}>
          {trend > 0 ? '+' : ''}{trend}% vs last week
        </span>
      )}
      {note && <span className="owner-figure-note">{note}</span>}
    </div>
  );
}

/**
 * A daily series, drawn small.
 *
 * Hand-written SVG rather than a charting library, following the same reasoning
 * `AdminImpact.jsx` records: one series against one axis does not justify a
 * dependency, and a hand-drawn path is the only version whose colours come from
 * the live theme tokens.
 *
 * `aria-hidden` with the figure stated in text beside it — a sparkline conveys
 * shape, and shape is not something to describe badly to a screen reader when
 * the number it decorates is already there.
 */
function Sparkline({ points }) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const width = 160;
  const height = 34;
  const max = Math.max(...points.map(p => p.value), 1);
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(height - (p.value / max) * (height - 2) - 1).toFixed(1)}`)
    .join(' ');

  return (
    <svg className="owner-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      <path d={path} fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Systems ─────────────────────────────────────────────────────────────── */

/**
 * Every service, reduced to one word and one colour.
 *
 * ── The rule this function exists to enforce ──
 *
 * A service is only reported operational when something was actually checked.
 * "The environment variable is set" is not a health check, and a page that
 * turns configuration into a green tick is worse than one with no ticks: it
 * teaches its reader that green means nothing. So `not configured` is its own,
 * neutral state, and anything unread says "unknown" rather than borrowing the
 * colour of a pass.
 */
function serviceStatuses({ health, monitoring, infrastructure }) {
  const services = [];

  /**
   * Nothing at all until something has been read.
   *
   * The first version listed Application and Database unconditionally, so the
   * grid rendered two rows reading "Unknown" before the first response arrived —
   * which looks like two broken services rather than like a page that has not
   * finished loading. The card's skeleton is the honest first frame, and it only
   * appears if this returns an empty list.
   */
  if (!health && !monitoring && !infrastructure) return services;

  services.push({
    id: 'application',
    icon: Server,
    label: 'Application',
    ...(health
      ? { tone: 'ok', state: 'Operational', detail: `Up ${duration(health.application?.uptimeSeconds)} · ${health.application?.environment}` }
      : { tone: 'muted', state: 'Unknown' }),
  });

  services.push({
    id: 'database',
    icon: Database,
    label: 'Database',
    ...(health
      ? (health.database?.state === 'ok'
        ? { tone: 'ok', state: 'Operational', detail: `Answered in ${health.database.latencyMs} ms` }
        : { tone: 'danger', state: 'Error', detail: 'The database did not answer a read.' })
      : { tone: 'muted', state: 'Unknown' }),
  });

  if (health) {
    services.push({ id: 'mail', icon: Mail, label: 'Email', ...mailStatus(health.mail) });

    const queue = health.notificationQueue || {};
    services.push({
      id: 'queue',
      icon: Clock,
      label: 'Notification queue',
      ...(queue.error
        ? { tone: 'warn', state: 'Unknown', detail: 'The queue could not be read.' }
        : Number(queue.failed) > 0
          ? { tone: 'warn', state: 'Degraded', detail: `${queue.failed} failed` }
          : { tone: 'ok', state: 'Operational', detail: pendingLabel(queue) }),
    });

    /**
     * Backups, using the server's own definition of "needs attention".
     *
     * `NEEDS_ATTENTION` in `server/backupStatus.js` is the list `alerting.js`
     * already acts on without being asked, and the three states in it —
     * `stale`, `none`, `unknown` — are exactly the ones an owner should see red
     * for. Re-deriving that judgement here would be a second opinion about a
     * question the server has already answered, which is how two surfaces come
     * to disagree about whether the backups are fine.
     */
    const backup = health.backup || {};
    services.push({
      id: 'backup',
      icon: Database,
      label: 'Backups',
      ...(backup.status === 'ok'
        ? { tone: 'ok', state: 'Current', detail: `${backup.count} kept · newest ${backup.ageHours} h old` }
        : backup.status === 'unconfigured'
          ? { tone: 'muted', state: 'Not configured' }
          : backup.status === 'stale'
            ? { tone: 'danger', state: 'Stale', detail: `Newest is ${backup.ageHours} h old` }
            : backup.status === 'none'
              ? { tone: 'danger', state: 'None taken' }
              : { tone: 'warn', state: 'Unknown' }),
    });

    const ledger = health.hoursLedger || {};
    services.push({
      id: 'ledger',
      icon: Activity,
      label: 'Hours ledger',
      ...(ledger.inParity === true
        ? { tone: 'ok', state: 'In parity' }
        : ledger.inParity === false
          ? { tone: 'danger', state: 'Diverged', detail: `${ledger.mismatchedUsers} volunteers do not reconcile` }
          : { tone: 'warn', state: 'Unknown', detail: 'The parity check did not run.' }),
    });
  }

  if (monitoring) {
    const monitors = monitoring.monitors || {};
    services.push({
      id: 'monitoring',
      icon: HeartPulse,
      label: 'Uptime monitoring',
      ...(monitors.state === 'ok'
        ? (monitors.down > 0
          ? { tone: 'danger', state: 'Monitor down', detail: `${monitors.down} of ${monitors.monitors.length} down` }
          : { tone: 'ok', state: 'Operational', detail: `${monitors.up} up` })
        : monitors.state === 'not_configured'
          ? { tone: 'muted', state: 'Not configured' }
          : { tone: 'warn', state: 'Unavailable' }),
    });

    services.push({
      id: 'telemetry',
      icon: BarChart3,
      label: 'Telemetry',
      ...(monitoring.telemetry?.enabled
        ? (monitoring.telemetry.dropped > 0
          ? { tone: 'warn', state: 'Dropping records', detail: `${monitoring.telemetry.dropped} dropped since boot` }
          : { tone: 'ok', state: 'Sending' })
        : { tone: 'muted', state: 'Not configured', detail: telemetryReason(monitoring.telemetry?.reason) }),
    });
  }

  if (infrastructure) {
    const redis = infrastructure.redis || {};
    services.push({
      id: 'redis',
      icon: Zap,
      label: 'Redis',
      ...(redis.state === 'not_configured'
        ? { tone: 'muted', state: 'Not configured' }
        : redis.state !== 'ok'
          ? { tone: 'warn', state: 'Unavailable' }
          : redis.reachable
            ? (redis.status?.degraded
              ? { tone: 'warn', state: 'Degraded', detail: 'Falling back to per-process limits.' }
              : { tone: 'ok', state: 'Connected', detail: `${redis.latencyMs} ms` })
            : { tone: 'danger', state: 'Unreachable', detail: redis.reason }),
    });

    const vector = infrastructure.vector || {};
    services.push({
      id: 'vector',
      icon: Sparkles,
      label: 'Vector search',
      ...(vector.state === 'not_configured'
        ? { tone: 'muted', state: 'Not configured' }
        : vector.state !== 'ok'
          ? { tone: 'warn', state: 'Unavailable' }
          : vector.reachable
            ? { tone: 'ok', state: 'Connected', detail: `${formatNumber(vector.records)} records` }
            : { tone: 'warn', state: 'Unreachable', detail: vector.reason }),
    });
  }

  return services;
}

/**
 * Whether mail is set up, and whether it is working — which are two questions.
 *
 * `smtpConfigured` answers only the first, and answering only the first is the
 * failure `/api/admin/system/status` was extended to fix: during an SMTP outage
 * it stayed `true` while every verification link silently failed to arrive, and
 * with email verification on by default that is a silent lockout of every new
 * account.
 *
 * So "configured" is the union of the two providers plus SMTP (a deployment can
 * run on Resend alone), and "working" is read from the counters: a failure with
 * no success after it means the last thing this process tried did not arrive.
 * A process that has sent nothing at all is reported as configured and quiet,
 * which is the honest answer on a morning with no signups.
 */
function mailStatus(mail = {}) {
  const health = mail.health || {};
  const providers = health.providers || {};
  const configured = Boolean(
    mail.smtpConfigured || providers.primary?.configured || providers.fallback?.configured,
  );
  if (!configured) return { tone: 'muted', state: 'Not configured' };

  if (Number(health.permanentFailures) > 0) {
    return { tone: 'danger', state: 'Failing', detail: `${health.permanentFailures} messages gave up` };
  }
  if (Number(health.queued) > 0) {
    return { tone: 'warn', state: 'Retrying', detail: `${health.queued} queued after a failure` };
  }
  /* Bounces are the provider's verdict, and a healthy send says nothing about
     them: a message Resend accepted and then hard-bounced looks like a success
     everywhere else in this payload. */
  const bounced = Number(mail.delivery?.bounced ?? 0);
  if (mail.delivery?.configured && bounced > 0) {
    return { tone: 'warn', state: 'Bouncing', detail: `${bounced} bounced in the last 7 days` };
  }
  return { tone: 'ok', state: 'Operational', detail: `${health.successes ?? 0} sent since boot` };
}

/**
 * Why telemetry is off, in words, or nothing.
 *
 * `resolveTelemetryConfig` answers with an identifier — `not_configured`,
 * `bad_host`, `insecure_host`, `test_environment` — and three of the four tell a
 * reader something the state word does not. The fourth is `not_configured`,
 * which is exactly what the row already says: printing it produced
 * "Not configured / not_configured", which is a raw internal token shown to a
 * person and says nothing twice.
 *
 * An unrecognised reason is passed through rather than dropped: a new one is
 * more useful shown than hidden, and this is an owner-only page.
 */
function telemetryReason(reason) {
  if (!reason || reason === 'not_configured') return null;
  return {
    bad_host: 'The ingesting host is not a valid URL.',
    insecure_host: 'The ingesting host is plain HTTP, which is refused in production.',
    disabled_by_operator: 'Switched off deliberately.',
    test_environment: 'Refused under a test runner.',
  }[reason] || reason;
}

function pendingLabel(queue) {
  const pending = Number(queue.pending ?? queue.queued ?? 0);
  if (!Number.isFinite(pending)) return null;
  return `${pending} waiting`;
}

function duration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return 'an unknown time';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

const numberFormat = new Intl.NumberFormat();
function formatNumber(value) {
  return Number.isFinite(Number(value)) ? numberFormat.format(Number(value)) : 'Unavailable';
}

function SystemsCard({ services, loading }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>Systems</h3>
      </div>
      <div className="card-body">
        {loading && services.length === 0
          ? <LoadingSkeleton heights={[52, 52, 52]} className="stack-md" />
          : (
            <ul className="owner-systems">
              {services.map(({ id, icon: Icon, label, tone, state, detail }) => (
                <li key={id} className="owner-system">
                  <span className={`owner-dot tone-${tone}`} aria-hidden="true" />
                  <Icon size={15} className="owner-system-icon" aria-hidden="true" />
                  <span className="owner-system-label">{label}</span>
                  <span className={`owner-system-state tone-${tone}`}>{state}</span>
                  {detail && <span className="owner-system-detail">{detail}</span>}
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
}

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The error picture, read from this database rather than from a vendor.
 *
 * The full evidence — messages, stacks, routes, occurrence counts — lives at
 * `/errors` behind `error.read`, and this card links there rather than
 * repeating any of it. Two surfaces disclosing the same evidence under
 * different capabilities is how one of them ends up with the weaker rules.
 */
function ErrorsCard({ state }) {
  const errors = state.data?.errors;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 8 }}><Bug size={16} aria-hidden="true" /> Errors</h3>
        <Link className="btn btn-secondary btn-sm" to="/errors">Open error triage</Link>
      </div>
      <div className="card-body">
        {!errors
          ? (state.loading
            ? <LoadingSkeleton heights={[64]} />
            : <p className="small dim">The error trend could not be read.</p>)
          : (
            <div className="owner-figures">
              <Figure
                label="Last 24 hours"
                value={formatNumber(errors.last24h)}
                trend={errors.changePercent === null ? undefined : errors.changePercent}
                note={errors.changePercent === null ? `${formatNumber(errors.previous24h)} the day before` : null}
              />
              <Figure label="Open problems" value={formatNumber(errors.openGroups)} note="Distinct, untriaged" />
              <Figure
                label="Evidence kept"
                value={`${errors.windowDays} days`}
                note="Occurrences are swept after this"
              />
            </div>
          )}
      </div>
    </section>
  );
}

/* ── Better Stack ────────────────────────────────────────────────────────── */

function MonitoringCard({ state }) {
  const data = state.data;
  const monitors = data?.monitors;
  const incidents = data?.incidents;

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 8 }}><HeartPulse size={16} aria-hidden="true" /> Uptime and incidents</h3>
        {data?.links?.dashboard && <ExternalDashboardLink href={data.links.dashboard} label="Open Better Stack" />}
      </div>
      <div className="card-body stack-md">
        {!data && state.loading && <LoadingSkeleton heights={[80, 80]} className="stack-md" />}
        {!data && !state.loading && <p className="small dim">Monitoring status could not be read.</p>}

        {data && (
          <>
            {monitors?.state === 'ok' ? (
              monitors.monitors.length === 0 ? (
                <p className="small dim">
                  No monitors are set up yet. Better Stack&rsquo;s free plan includes ten.
                </p>
              ) : (
                <ul className="owner-list">
                  {monitors.monitors.map(m => (
                    <li key={m.id} className="owner-list-row">
                      <span className={`owner-dot tone-${monitorTone(m)}`} aria-hidden="true" />
                      <span className="owner-list-main">
                        <span className="owner-list-title">{m.name}</span>
                        {m.url && <span className="owner-list-sub truncate">{m.url}</span>}
                      </span>
                      <span className={`owner-list-state tone-${monitorTone(m)}`}>
                        {m.paused ? 'Paused' : m.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              /* No `link`: this card's header already carries "Open Better
                 Stack", and two identical buttons a hundred pixels apart is
                 furniture rather than an affordance. The infrastructure panels
                 below DO pass one, because they have no header link of their
                 own. */
              <ProviderNotice result={monitors} />
            )}

            {incidents?.state === 'ok' && (
              <div className="stack-xs">
                <h4 className="owner-subhead">
                  {incidents.active.length > 0 ? 'Open incidents' : 'Recent incidents'}
                </h4>
                <IncidentList
                  incidents={incidents.active.length > 0 ? incidents.active : incidents.recent}
                  active={incidents.active.length > 0}
                  historyAvailable={incidents.recentAvailable}
                />
              </div>
            )}

            {/**
              * The telemetry pipeline, which is a LOCAL fact and is shown even
              * when the Uptime API is not configured — which is this
              * deployment's current state. Whether logs are being sent is
              * something only this process can answer: Better Stack has no way
              * to report "nothing arrived because the token was never set".
              */}
            {data.telemetry && (
              <p className="small dim owner-telemetry">
                Telemetry: {data.telemetry.enabled
                  ? `sending · ${formatNumber(data.telemetry.sent)} records since boot`
                    + (data.telemetry.dropped > 0 ? ` · ${formatNumber(data.telemetry.dropped)} dropped` : '')
                  : `off${telemetryReason(data.telemetry.reason) ? ` — ${telemetryReason(data.telemetry.reason)}` : ' — not set up'}`}
                {data.links?.telemetry && (
                  <> · <a href={data.links.telemetry} target="_blank" rel="noopener noreferrer">Logs and traces</a></>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function monitorTone(monitor) {
  if (monitor.paused) return 'muted';
  if (monitor.status === 'down') return 'danger';
  if (monitor.status === 'up') return 'ok';
  return 'warn';
}

function IncidentList({ incidents, active, historyAvailable }) {
  if (!incidents.length) {
    return (
      <p className="small dim">
        {historyAvailable
          ? 'Nothing has gone wrong recently.'
          : 'No open incidents. The history could not be read.'}
      </p>
    );
  }
  return (
    <ul className="owner-list">
      {incidents.map(i => (
        <li key={i.id} className="owner-list-row">
          <span className={`owner-dot tone-${active && !i.resolvedAt ? 'danger' : 'muted'}`} aria-hidden="true" />
          <span className="owner-list-main">
            <span className="owner-list-title">{i.name}</span>
            <span className="owner-list-sub truncate">
              {[i.cause, i.startedAt ? `started ${relative(Date.parse(i.startedAt))}` : null]
                .filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className={`owner-list-state tone-${i.resolvedAt ? 'ok' : 'danger'}`}>
            {i.resolvedAt ? 'Resolved' : i.acknowledgedAt ? 'Acknowledged' : 'Open'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ── Amplitude ───────────────────────────────────────────────────────────── */

function AnalyticsCard({ state }) {
  const data = state.data;
  const users = data?.users;
  const events = data?.events;

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 8 }}><BarChart3 size={16} aria-hidden="true" /> Usage</h3>
        {data?.links?.dashboard && <ExternalDashboardLink href={data.links.dashboard} label="Open Amplitude" />}
      </div>
      <div className="card-body stack-md">
        {!data && state.loading && <LoadingSkeleton heights={[80, 120]} className="stack-md" />}
        {!data && !state.loading && <p className="small dim">Analytics could not be read.</p>}

        {data && users?.state === 'ok' && (
          <>
            <div className="owner-figures">
              <Figure label="Active today" value={formatNumber(users.active.today)} />
              <Figure label="Active this week" value={formatNumber(users.active.last7)} trend={users.active.trend ?? undefined} />
              <Figure
                label="New this week"
                value={users.new ? formatNumber(users.new.last7) : 'Unavailable'}
                trend={users.new?.trend ?? undefined}
              />
            </div>
            <div className="owner-spark-row">
              <Sparkline points={users.active.points} />
              <span className="small dim">Active users, last {users.windowDays} days</span>
            </div>
          </>
        )}

        {data && users && users.state !== 'ok' && (
          /* No `link` — the card header already carries "Open Amplitude". */
          <ProviderNotice result={users} />
        )}

        {data && events?.state === 'ok' && (
          <div className="stack-xs">
            <h4 className="owner-subhead">Feature usage · last {events.windowDays} days</h4>
            <FeatureUsage events={events.events} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The tracked events, as bars.
 *
 * Bars are scaled against the largest READ value, not against a total, because
 * these events are not parts of a whole — "certificates downloaded" is not a
 * share of "home page views". An unread event draws no bar and says
 * "Unavailable", rather than drawing a zero-length one that reads as "nobody
 * uses this".
 */
function FeatureUsage({ events }) {
  const max = Math.max(1, ...events.map(e => (typeof e.total === 'number' ? e.total : 0)));
  return (
    <ul className="owner-usage">
      {events.map(e => (
        <li key={e.name} className="owner-usage-row">
          <span className="owner-usage-label" title={e.description}>{e.label}</span>
          <span className="owner-usage-track" aria-hidden="true">
            {typeof e.total === 'number' && (
              <span className="owner-usage-fill" style={{ width: `${Math.round((e.total / max) * 100)}%` }} />
            )}
          </span>
          <span className="owner-usage-value tnum">
            {typeof e.total === 'number' ? formatNumber(e.total) : 'Unavailable'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ── Upstash and Pinecone ────────────────────────────────────────────────── */

function InfrastructureCard({ state }) {
  const data = state.data;
  const redis = data?.redis;
  const vector = data?.vector;

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 8 }}><Server size={16} aria-hidden="true" /> Infrastructure</h3>
      </div>
      <div className="card-body owner-infra">
        {!data && state.loading && <LoadingSkeleton heights={[120, 120]} className="stack-md" />}
        {!data && !state.loading && <p className="small dim">Infrastructure status could not be read.</p>}

        {data && (
          <>
            <div className="owner-infra-panel">
              <h4 className="owner-subhead row" style={{ gap: 6 }}><Zap size={14} aria-hidden="true" /> Redis</h4>
              {redis?.state !== 'ok' ? (
                /* Covers "not set up" as well as "could not be read": both are
                   `state !== 'ok'` now, and the notice tells them apart from the
                   state word the server sent. */
                <ProviderNotice result={redis} link={data.links?.upstash} linkLabel="Open Upstash" />
              ) : (
                <>
                  <p className={`owner-inline-state tone-${redis.reachable ? (redis.status?.degraded ? 'warn' : 'ok') : 'danger'}`}>
                    {redis.reachable
                      ? `Connected · ${redis.latencyMs} ms`
                      : `Unreachable · ${redis.reason}`}
                  </p>
                  <dl className="owner-meta">
                    <div><dt>Commands this boot</dt><dd className="tnum">{formatNumber(redis.status?.usage?.commands)}</dd></div>
                    <div><dt>Failures</dt><dd className="tnum">{formatNumber(redis.status?.usage?.failures)}</dd></div>
                    <div><dt>Free plan</dt><dd className="tnum">{formatNumber(redis.status?.plan?.commandsPerMonth)} / month</dd></div>
                  </dl>
                  <p className="small dim">
                    The count is what this process has spent since it started, not the monthly total.
                  </p>
                  <ExternalDashboardLink href={data.links?.upstash} label="Open Upstash" />
                </>
              )}
            </div>

            <div className="owner-infra-panel">
              <h4 className="owner-subhead row" style={{ gap: 6 }}><Sparkles size={14} aria-hidden="true" /> Vector search</h4>
              {vector?.state !== 'ok' ? (
                <ProviderNotice result={vector} link={data.links?.pinecone} linkLabel="Open Pinecone" />
              ) : (
                <>
                  <p className={`owner-inline-state tone-${vector.reachable ? 'ok' : 'warn'}`}>
                    {vector.reachable ? 'Connected' : `Unreachable · ${vector.reason}`}
                  </p>
                  <dl className="owner-meta">
                    <div><dt>Index</dt><dd className="truncate">{vector.index}</dd></div>
                    <div><dt>Namespace</dt><dd className="truncate">{vector.namespace}</dd></div>
                    <div><dt>Records here</dt><dd className="tnum">{formatNumber(vector.records)}</dd></div>
                    <div><dt>Reranks this boot</dt><dd className="tnum">{formatNumber(vector.usage?.rerankUnits)}</dd></div>
                    <div><dt>Rerank budget</dt><dd className="tnum">{formatNumber(vector.budget?.rerankBudget)} / month</dd></div>
                  </dl>
                  <p className="small dim">
                    Discover falls back to keyword search when this is unavailable, so an outage here
                    is quiet rather than visible.
                  </p>
                  <ExternalDashboardLink href={data.links?.pinecone} label="Open Pinecone" />
                </>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
