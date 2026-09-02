import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import OwnerCenter from './OwnerCenter';
import { api } from '../utils/api';

/**
 * The Owner Center, from the reader's side.
 *
 * ── What this file is actually guarding ──
 *
 * A status page is only worth having if its greens mean something. Three
 * failures would each quietly destroy that, and none of them throws:
 *
 *   1. **A false green.** Reporting a service as operational because a
 *      credential exists, or because a card has not loaded yet. A reader who
 *      learns that green is unconditional stops reading the greens.
 *   2. **A fabricated figure.** A number that could not be read rendering as
 *      `0` — "nobody signed up this week" and "we could not ask" are different
 *      sentences, and one of them is a lie.
 *   3. **One vendor taking the page down.** The whole point of the split into
 *      four requests is that an unreachable provider costs one card.
 *
 * Every case below is one of those three.
 */

const health = (overrides = {}) => ({
  generatedAt: '2026-09-02T10:00:00.000Z',
  application: { state: 'ok', environment: 'production', uptimeSeconds: 7200, nodeVersion: 'v24.0.0', release: null },
  database: { state: 'ok', latencyMs: 3 },
  mail: { smtpConfigured: true, health: { successes: 4, failures: 0, queued: 0, permanentFailures: 0, providers: {} }, delivery: { configured: false } },
  notificationQueue: { pending: 0, processing: 0, failed: 0 },
  backup: { status: 'ok', count: 3, ageHours: 2 },
  hoursLedger: { inParity: true, mismatchedUsers: 0 },
  errors: { last24h: 4, previous24h: 8, changePercent: -50, openGroups: 2, windowDays: 30 },
  ...overrides,
});

const monitoring = (overrides = {}) => ({
  generatedAt: '2026-09-02T10:00:00.000Z',
  configured: true,
  monitors: {
    state: 'ok',
    monitors: [{ id: '1', name: 'API', url: 'https://x.test', status: 'up', paused: false }],
    up: 1, down: 0, paused: 0,
  },
  incidents: { state: 'ok', active: [], recent: [], recentAvailable: true },
  telemetry: { enabled: true, sent: 120, dropped: 0, failed: 0, queued: 120, pending: 0, reason: null },
  links: { dashboard: 'https://uptime.betterstack.com/', telemetry: 'https://telemetry.betterstack.com/' },
  ...overrides,
});

const analytics = (overrides = {}) => ({
  generatedAt: '2026-09-02T10:00:00.000Z',
  configured: true,
  users: {
    state: 'ok',
    windowDays: 30,
    active: { today: 12, last7: 80, last30: 300, trend: 14, points: [{ date: '2026-08-01', value: 10 }, { date: '2026-08-02', value: 12 }] },
    new: { today: 2, last7: 9, last30: 40, trend: -5, points: [] },
  },
  events: {
    state: 'ok',
    windowDays: 30,
    events: [
      { name: 'Viewed Home Page', label: 'Home page', description: '', total: 400, trend: 5 },
      { name: 'Viewed Certificate', label: 'Certificates opened', description: '', total: 30, trend: null },
    ],
  },
  links: { dashboard: 'https://analytics.amplitude.com/' },
  ...overrides,
});

const infrastructure = (overrides = {}) => ({
  generatedAt: '2026-09-02T10:00:00.000Z',
  redis: {
    state: 'ok', reachable: true, latencyMs: 42,
    status: { configured: true, degraded: false, usage: { commands: 500, failures: 0 }, plan: { commandsPerMonth: 500000 } },
  },
  vector: {
    state: 'ok', reachable: true, index: 'wevolunteer-discover-v1', namespace: 'production',
    records: 128, usage: { rerankUnits: 3 }, budget: { rerankBudget: 400 },
  },
  links: { upstash: 'https://console.upstash.com/redis', pinecone: 'https://app.pinecone.io/' },
  ...overrides,
});

/** Stubs all four reads. Each may be a value or a rejection. */
function stubApi({ h = health(), m = monitoring(), a = analytics(), i = infrastructure() } = {}) {
  const wrap = (value) => (value instanceof Error
    ? vi.fn().mockRejectedValue(value)
    : vi.fn().mockResolvedValue(value));
  vi.spyOn(api, 'fetchOwnerHealth').mockImplementation(wrap(h));
  vi.spyOn(api, 'fetchOwnerMonitoring').mockImplementation(wrap(m));
  vi.spyOn(api, 'fetchOwnerAnalytics').mockImplementation(wrap(a));
  vi.spyOn(api, 'fetchOwnerInfrastructure').mockImplementation(wrap(i));
}

const renderOwner = () => render(<MemoryRouter><OwnerCenter /></MemoryRouter>);
const click = (element) => act(async () => { fireEvent.click(element); });

/**
 * The `<li>` for one service in the Systems grid.
 *
 * Scoped to the grid: "Redis" is also the heading of the infrastructure panel
 * further down, and a bare text query finds both. The grid is the summary and
 * the panel is the detail — a helper that could return either would make a case
 * pass while asserting about the wrong one.
 */
const systemRow = (label) => {
  const grid = document.querySelector('.owner-systems');
  return within(grid).getByText(label).closest('.owner-system');
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the headline verdict', () => {
  it('says all systems are operational only when they are', async () => {
    stubApi();
    renderOwner();
    expect(await screen.findByText(/All systems operational/i)).toBeInTheDocument();
  });

  it('counts what needs attention rather than declaring it', async () => {
    stubApi({
      h: health({ database: { state: 'error' }, backup: { status: 'stale', ageHours: 90, count: 1 } }),
    });
    renderOwner();
    /* Two: the database and the backups. A count derived from the cards is the
       only version that cannot disagree with them. */
    expect(await screen.findByText(/2 systems need attention/i)).toBeInTheDocument();
  });

  /**
   * The false-green case, and the most important one in this file.
   *
   * Before any request resolves there is nothing to be operational ABOUT, and a
   * page that opens on a green tick has taught its reader that the tick is
   * decoration.
   */
  it('does not claim health before anything has been read', () => {
    /* Four requests that never settle. Not `stubApi`, which resolves. */
    vi.spyOn(api, 'fetchOwnerHealth').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, 'fetchOwnerMonitoring').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, 'fetchOwnerAnalytics').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, 'fetchOwnerInfrastructure').mockImplementation(() => new Promise(() => {}));

    renderOwner();
    expect(screen.getByText(/Checking…/)).toBeInTheDocument();
    expect(screen.queryByText(/All systems operational/i)).toBeNull();
  });

  /**
   * The StrictMode double-mount.
   *
   * `main.jsx` renders inside `<StrictMode>`, which mounts every effect, tears
   * it down and mounts it again. The unmount guard that stops a late response
   * writing to a dead tree has to be re-armed on the second mount, or every
   * response is discarded and the page reads "Checking…" forever — which
   * happened, in development only, and no single-mount render test could see it.
   */
  it('still renders when the effect is mounted twice', async () => {
    stubApi();
    render(
      <StrictMode>
        <MemoryRouter><OwnerCenter /></MemoryRouter>
      </StrictMode>,
    );
    expect(await screen.findByText(/All systems operational/i)).toBeInTheDocument();
  });

  it('announces the verdict to a screen reader when it changes', async () => {
    stubApi();
    renderOwner();
    const verdict = await screen.findByRole('status');
    /* A polite live region, present from the first render — one added to the
       page at the moment it gets content is frequently never announced,
       because the assistive technology did not observe it becoming live. */
    expect(verdict).toHaveTextContent(/All systems operational/i);
  });
});

describe('the systems grid', () => {
  it('reports a service by what was checked, not by what is configured', async () => {
    stubApi();
    renderOwner();
    await screen.findByText(/All systems operational/i);

    /* The database line carries the latency of the read it actually did. */
    expect(within(systemRow('Database')).getByText('Operational')).toBeInTheDocument();
    expect(within(systemRow('Database')).getByText(/3 ms/)).toBeInTheDocument();
  });

  it('never carries a status in colour alone', async () => {
    stubApi();
    const { container } = renderOwner();
    await screen.findByText(/All systems operational/i);

    /* WCAG 1.4.1, on the page whose entire job is to report state. Every dot
       sits beside a word that says the same thing. */
    for (const dot of container.querySelectorAll('.owner-dot')) {
      const row = dot.closest('.owner-system, .owner-list-row');
      expect(row.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('shows an unconfigured integration as neutral, not as broken', async () => {
    stubApi({
      i: infrastructure({ redis: { state: 'not_configured', configureWith: 'SOME_VARS' } }),
    });
    renderOwner();
    await screen.findByText(/All systems operational/i);

    /* The pilot runs without Upstash and every caller has an in-process
       fallback. A dashboard that shows red for a supported configuration
       teaches its reader to ignore red. */
    expect(within(systemRow('Redis')).getByText('Not configured')).toBeInTheDocument();
    expect(screen.queryByText(/systems need attention/i)).toBeNull();
  });

  /**
   * The state a real, freshly-connected Better Stack account is in.
   *
   * Found by pointing the integration at the live account: it has a valid token
   * and zero monitors, and the row read "Operational · 0 up" — a green tick for
   * the absence of the check it reports on.
   */
  it('reports a long-open incident in days rather than hundreds of hours', async () => {
    /* Better Stack's own sample incident had been open for 476 hours when this
       was found against the live account — a figure a reader has to divide
       before it means anything. */
    stubApi({
      m: monitoring({
        incidents: {
          state: 'ok', recentAvailable: true, recent: [],
          active: [{
            id: '1', name: 'google.com', cause: 'Sample incident',
            startedAt: new Date(Date.now() - 476 * 3600_000).toISOString(),
            acknowledgedAt: null, resolvedAt: null,
          }],
        },
      }),
    });
    renderOwner();
    expect(await screen.findByText(/20 days ago/)).toBeInTheDocument();
    expect(screen.queryByText(/476 hours ago/)).toBeNull();
  });

  it('does not call zero monitors operational', async () => {
    stubApi({
      m: monitoring({ monitors: { state: 'ok', monitors: [], up: 0, down: 0, paused: 0 } }),
    });
    renderOwner();
    await screen.findByText(/Systems/);

    const row = systemRow('Uptime monitoring');
    expect(within(row).getByText('No monitors')).toBeInTheDocument();
    expect(within(row).queryByText('Operational')).toBeNull();
    /* And it is not alarming either — a pilot that has not set up external
       monitoring yet is in a normal state, not a broken one. */
    expect(screen.queryByText(/systems need attention/i)).toBeNull();
  });

  it('separates a degraded Redis from a healthy one', async () => {
    stubApi({
      i: infrastructure({
        redis: {
          state: 'ok', reachable: true, latencyMs: 40,
          status: { configured: true, degraded: true, usage: {}, plan: {} },
        },
      }),
    });
    renderOwner();
    /* Nothing is broken for users and every shared rate limit has quietly
       become per-process. That is the state worth alerting on. */
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
  });
});

describe('when a provider cannot be read', () => {
  it('keeps the rest of the page', async () => {
    stubApi({ m: new Error('network'), a: new Error('network') });
    renderOwner();

    /* The local half still renders. One unreachable vendor must cost one card,
       not the page — which is the whole reason there are four requests. */
    expect(await screen.findByText(/Systems/)).toBeInTheDocument();
    expect(systemRow('Database')).toBeTruthy();
    expect(screen.getByText(/Monitoring status could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/Analytics could not be read/i)).toBeInTheDocument();
  });

  it('names the variables that would switch an integration on', async () => {
    stubApi({
      a: analytics({
        users: { state: 'not_configured', configureWith: 'AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY' },
        events: { state: 'not_configured' },
      }),
    });
    renderOwner();

    /* The names come from the server payload, never from client source — see
       `redis.privacy.test.js`, which fails the build on a file under `src/`
       that names the Redis connection pair. */
    expect(await screen.findByText(/AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY/)).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('distinguishes a plan restriction from a broken credential', async () => {
    stubApi({
      a: analytics({
        users: { state: 'plan_restricted', detail: 'Amplitude refused this query for this project.' },
      }),
    });
    renderOwner();
    /* The remedies differ and neither is "try again". */
    expect(await screen.findByText(/Not available on your plan/i)).toBeInTheDocument();
    expect(screen.queryByText(/Credentials refused/i)).toBeNull();
  });

  it('says when a figure is old rather than presenting it as current', async () => {
    stubApi({
      m: monitoring({
        monitors: { state: 'timeout', stale: true, fetchedAt: Date.now() - 120_000 },
      }),
    });
    renderOwner();
    expect(await screen.findByText(/Took too long to answer/i)).toBeInTheDocument();
  });

  /**
   * The one way this page could be actively misleading rather than merely
   * unhelpful.
   *
   * `providerCache` serves the last good value as `state: 'ok'` with
   * `stale: true` when a refresh fails — deliberately, so one hiccup does not
   * empty a card somebody is watching during an incident. The card therefore
   * renders NORMALLY, and without a banner nothing anywhere says the figures
   * stopped moving: it keeps showing green while the service has gone quiet.
   */
  it('labels a successful-but-stale reading, and does not call it operational', async () => {
    /* Both stamps come from the SERVER in a real payload, so the fixture pins
       them the same way: `generatedAt` is when the response was built and
       `fetchedAt` is when the cached value was last good. */
    const serverNow = Date.now();
    stubApi({
      m: monitoring({
        generatedAt: new Date(serverNow).toISOString(),
        monitors: {
          state: 'ok', up: 1, down: 0, paused: 0, stale: true, staleReason: 'timeout',
          fetchedAt: serverNow - 180_000,
          monitors: [{ id: '1', name: 'API', url: 'https://x.test', status: 'up', paused: false }],
        },
      }),
    });
    renderOwner();

    expect(await screen.findByText(/Showing the last reading/i)).toBeInTheDocument();
    /* Three minutes, measured server-clock to server-clock, in BOTH places that
       report it. A browser clock an hour out must not turn a 3-minute-old
       figure into an hour-old one. */
    expect(screen.getAllByText(/3 minutes ago/)).toHaveLength(2);
    /* And the summary row — the line somebody actually scans — must not claim a
       service is up on the strength of a figure nobody has confirmed since. */
    expect(within(systemRow('Uptime monitoring')).getByText('Last known good')).toBeInTheDocument();
    expect(within(systemRow('Uptime monitoring')).queryByText('Operational')).toBeNull();
  });

  /**
   * An absent section is indistinguishable from "nothing has gone wrong", which
   * is the most dangerous thing this particular card could imply.
   */
  it('says the incident history could not be read, rather than showing nothing', async () => {
    stubApi({ m: monitoring({ incidents: { state: 'rate_limited' } }) });
    renderOwner();

    expect(await screen.findByText(/Rate limited/i)).toBeInTheDocument();
    /* The monitors half still renders — one failed read costs one section. */
    expect(screen.getByText('API')).toBeInTheDocument();
  });

  it('reports a transport failure in words, not as an internal identifier', async () => {
    stubApi({
      i: infrastructure({
        redis: {
          state: 'ok', reachable: false, reason: 'circuit_open',
          status: { configured: true, degraded: true, usage: {}, plan: {} },
        },
      }),
    });
    renderOwner();

    /* `circuit_open` is right for a log line and wrong on a page a person reads
       — it rendered as "Unreachable · circuit_open". Both the summary row and
       the infrastructure panel say it, so both are checked and neither may
       carry the identifier. */
    const said = await screen.findAllByText(/too many recent failures/i);
    expect(said.length).toBe(2);
    expect(screen.queryByText(/circuit_open/)).toBeNull();
  });

  it('still offers the external dashboard when the integration is down', async () => {
    stubApi({ m: monitoring({ monitors: { state: 'unauthorized' } }) });
    renderOwner();

    /* A card that fails is exactly when a link to the real tool is most
       useful — and the link is not a "quick action" that pretends to work. */
    /* Exactly one. The card header carries it; the failure notice deliberately
       does not repeat it, because two identical buttons a hundred pixels apart
       is furniture rather than an affordance. */
    const links = await screen.findAllByRole('link', { name: /Open Better Stack/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://uptime.betterstack.com/');
    expect(links[0]).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

describe('figures', () => {
  it('shows a number that could not be read as unavailable, never as zero', async () => {
    stubApi({
      a: analytics({
        users: {
          state: 'ok', windowDays: 30,
          active: { today: 3, last7: 20, last30: 90, trend: null, points: [] },
          /* The server sends `null` when the new-user query failed but the
             active one succeeded. */
          new: null,
        },
      }),
    });
    renderOwner();

    const figure = (await screen.findByText('New this week')).closest('.owner-figure');
    expect(within(figure).getByText('Unavailable')).toBeInTheDocument();
    expect(within(figure).queryByText('0')).toBeNull();
  });

  it('omits a trend it cannot compute rather than printing 0%', async () => {
    stubApi();
    renderOwner();
    const figure = (await screen.findByText('Active today')).closest('.owner-figure');
    /* "No change" and "not enough history to say" are different things to put
       in front of somebody. */
    expect(within(figure).queryByText(/vs last week/)).toBeNull();
  });

  it('keeps a real but tiny share visible, so it cannot read as unavailable', async () => {
    stubApi({
      a: analytics({
        events: {
          state: 'ok', windowDays: 30,
          events: [
            { name: 'A', label: 'Busy', description: '', total: 1240, trend: null },
            { name: 'B', label: 'Rare', description: '', total: 12, trend: null },
          ],
        },
      }),
    });
    const { container } = renderOwner();
    await screen.findByText('Rare');

    /* 12 against 1,240 is a one-percent bar — a sub-pixel sliver that renders as
       no bar at all, which is the state this card uses to mean "not read". Both
       events must draw one; the stylesheet's `min-width` is what keeps the
       second visible. */
    expect(container.querySelectorAll('.owner-usage-fill')).toHaveLength(2);
  });

  it('draws no bar for an event that is genuinely zero, and still shows the zero', async () => {
    stubApi({
      a: analytics({
        events: {
          state: 'ok', windowDays: 30,
          events: [{ name: 'A', label: 'Unused', description: '', total: 0, trend: null }],
        },
      }),
    });
    const { container } = renderOwner();
    await screen.findByText('Unused');

    /* Zero is a fact, and the figure carries it. A bar with a minimum width
       would turn "nobody used this" into a visible mark. */
    expect(container.querySelectorAll('.owner-usage-fill')).toHaveLength(0);
    /* Scoped to the usage row: `0` also appears in the infrastructure panel's
       failure counter, and an unscoped query would pass or fail on whichever
       the DOM happened to yield first. */
    const row = screen.getByText('Unused').closest('.owner-usage-row');
    expect(within(row).getByText('0')).toBeInTheDocument();
    expect(within(row).queryByText('Unavailable')).toBeNull();
  });

  it('draws no usage bar for an event it could not read', async () => {
    stubApi({
      a: analytics({
        events: {
          state: 'ok', windowDays: 30,
          events: [
            { name: 'A', label: 'Read', description: '', total: 10, trend: null },
            { name: 'B', label: 'Unread', description: '', total: null, trend: null },
          ],
        },
      }),
    });
    const { container } = renderOwner();
    await screen.findByText('Unread');

    /* A zero-length bar reads as "nobody uses this", which is a claim, not an
       absence of one. */
    expect(container.querySelectorAll('.owner-usage-fill')).toHaveLength(1);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });
});

describe('refreshing', () => {
  it('asks every provider for fresh data and disables itself while it runs', async () => {
    stubApi();
    renderOwner();
    await screen.findByText(/All systems operational/i);

    const button = screen.getByRole('button', { name: /refresh/i });
    await click(button);

    await waitFor(() => expect(api.fetchOwnerMonitoring).toHaveBeenCalledWith(true));
    expect(api.fetchOwnerAnalytics).toHaveBeenCalledWith(true);
    expect(api.fetchOwnerInfrastructure).toHaveBeenCalledWith(true);
  });

  it('keeps the existing figures on screen while refreshing', async () => {
    let release;
    stubApi();
    renderOwner();
    await screen.findByText(/All systems operational/i);

    api.fetchOwnerMonitoring.mockImplementation(() => new Promise(r => { release = r; }));
    await click(screen.getByRole('button', { name: /refresh/i }));

    /* A dashboard that blanks itself on every refresh cannot be watched during
       an incident, which is the only time anybody presses it twice. */
    expect(systemRow('Database')).toBeTruthy();
    expect(screen.getByRole('button', { name: /refreshing/i })).toBeDisabled();
    await act(async () => { release(monitoring()); });
  });

  it('does not poll on its own', async () => {
    vi.useFakeTimers();
    try {
      stubApi();
      renderOwner();
      await vi.advanceTimersByTimeAsync(0);
      const initial = api.fetchOwnerAnalytics.mock.calls.length;

      /* Ten minutes. Amplitude prices queries against an hourly budget and
         Upstash against a monthly command count; a tab left open overnight is
         how a free tier is spent by accident. */
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(api.fetchOwnerAnalytics.mock.calls.length).toBe(initial);
    } finally {
      vi.useRealTimers();
    }
  });
});
