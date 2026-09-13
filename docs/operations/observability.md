# Observability: traces, metrics and logs

Three signals, one Better Stack source, one credential — and one hard
constraint that shapes every decision below: **this must cost nothing.**

Better Stack's free plan does not refuse traffic past its inclusions, it bills
for it. So "stay inside the free plan" is not a preference expressed in a
runbook; it is an engineering requirement enforced in code, and most of this
document is about where those enforcement points are.

### How to read this document

Claims are labelled by where they come from, using the same scheme as
[`betterstack.md`](betterstack.md), because "the budget stops it" and "the budget
probably stops it" are not the same sentence:

| Label | Means |
|---|---|
| **[proven]** | A test in this repository asserts it, and mutation testing has shown that test failing when the behaviour is removed. |
| **[measured]** | Observed on this machine, with the command recorded so it can be repeated. |
| **[documented]** | Better Stack's or OpenTelemetry's own documentation says so. Not verified here. |
| **[inferred]** | A reasonable reading. Nobody has checked. |
| **[owner action]** | Needs a decision or a credential only the account owner has. |

Unlabelled statements describe this repository's own code and can be checked by
reading it.

---

## 1. The architecture, and why it is a split

```
                    ┌──────────────────────────────────────┐
   application      │                                      │
   errors, audit ──▶│  telemetry.js → telemetrySink.js     │──▶  POST /
   access log       │  (field allowlist, redaction)        │     Better Stack
                    ├──────────────────────────────────────┤     HTTP ingestion
   HTTP requests    │  OpenTelemetry SDK                   │
   Express layers ─▶│  scrub → tail sample → batch         │──▶  OTLP /v1/traces
   business ops     │                                      │
                    │  metrics: histograms + counters      │──▶  OTLP /v1/metrics
                    └──────────────────────────────────────┘
```

**Logs stay on the existing sink. Traces and metrics are OpenTelemetry.**

Four architectures were considered. The deciding facts:

- OpenTelemetry JavaScript marks **Traces Stable, Metrics Stable, Logs
  Development** [documented — opentelemetry.io/docs/languages/js, read
  2026-08-27]. A Development signal may change its API in a minor release.
- The thing OTel logs would replace is `telemetry.js`, which holds this
  application's reviewed field allowlist, its redaction pass, its
  "an id is rejected rather than truncated" rule, and the decision — reviewed
  twice against realistic PII — that Better Stack may hold exactly what
  `error_events` may hold.

Trading a reviewed privacy boundary for tidiness, in exchange for a signal whose
own project calls it unstable, is not an improvement. So the split is by
maturity **and** by what each signal is actually good at.

### What each signal is for

| Signal | Population | Answers |
|---|---|---|
| **Logs** | every error, every refusal, 5% of successes | *what exactly happened to this one request* |
| **Traces** | every failure, every slow request, 2% of the rest | *why was this request slow — which stage* |
| **Metrics** | **all** requests, aggregated | *how much, how slow, how often failing* |

That division is why the trace sample rate can be as low as 2% without losing
anything: latency for the whole population is carried by the metrics histogram,
which is on a separate and much larger allowance, and every failure is carried by
both the logs and the tail sampler.

### The overlap, stated plainly

An HTTP request produces **both** a log record (sometimes) and a span
(sometimes). That is deliberate duplication, not an oversight:

| Existing | New | Decision | Why |
|---|---|---|---|
| `http.request` log record | HTTP server span | **keep both** | The log is the *guaranteed* record — every 4xx/5xx, always, with `role` and `userHash`. The span is a *sampled structural* record with no user fields at all. Different populations, different allowances, different questions. |
| request timing (in the log) | `http.server.request.duration` histogram | **add metric** | The log is sampled, so it cannot produce a percentile. The histogram covers 100% at fixed cost. This is the single biggest win in the change. |
| `error.recorded` log | span `recordException` | **keep both** | The log record is the durable, redacted, queryable one. The exception on the span is what makes the trace show *where* in the waterfall it happened. |
| `security.action` audit pulse | *nothing* | **log only** | Deliberate. The audit pulse sends an action name and nothing else; it is not given a span, a metric label, or any new field. See §6. |
| database timing | `wev.db.operation.duration` (transaction granularity) | **add metric** | See §5 for why transactions and not statements. |

---

## 2. The free-plan budget

**Better Stack free plan inclusions** [documented — betterstack.com/pricing, read
2026-08-27]:

| | Included | Retention | Beyond it |
|---|---|---|---|
| Logs | 3 GB/month | 3 days | billed: $0.10/GB ingest (EU), $0.05/GB/month retained |
| Traces | 3 GB/month | 3 days | same as logs |
| Metrics | 30 GB/month | 30 days | billed: $0.50/GB/month (EU) |

**Nothing here is a hard cap.** Exceeding an inclusion produces a bill, not a
refusal. That is the entire reason §3 exists.

### Traces — the arithmetic

Sized for 50,000 requests/day, ~6 spans/request, ~500 bytes/span:

| Configuration | Per month | Against the 3 GB allowance |
|---|---|---|
| No sampling | ~4.5 GB | **150% — over, by ordinary operation** |
| 2% + all failures | ~135 MB | 4.4% |
| 2% at **10× traffic** | ~1.35 GB | 45% |
| At the daily span budget, every day | ~3 GB | 100% — the ceiling equals the allowance |

The last row is the design point: the worst case the application can produce is
*equal to* the free plan, not past it.

### Metrics — the arithmetic

~150 active series × 13 values per histogram series ≈ 1,950 values ≈ 78 KB per
export; × 60s interval × 30 days ≈ **3.4 GB/month**, or ~11% of the included
30 GB. That number does not move when traffic does — only cardinality moves it,
which is why cardinality is guarded rather than trusted (§4).

### Logs — unchanged

5% success sampling plus every error, at ~1 KB/record: roughly 75 MB/month
against the 3 GB allowance. Unchanged by this work.

---

## 3. The three cost controls, and what happens when each engages

#### Tail sampling — `server/observability/tailSampler.js`

Spans are held until their **root** ends, then the whole trace is kept or dropped
together. Kept unconditionally: a recorded exception, any 5xx, anything slower
than 1s. Everything else at `OTEL_TRACE_SAMPLE_RATE` (default 0.02).

Head sampling cannot do this — it decides before the request has done anything,
so a 2% head rate keeps 2% of failures. This is what lets the rate be low
[proven].

*Cost:* spans are recorded before being dropped, so the CPU is spent either way.
Tail sampling trades CPU for money. Given that the $0 constraint is the hard one
and the measured CPU cost is 0.03ms/request (§8), that is the right way round.

#### The daily span budget — `server/observability/spanBudget.js`

A rolling 24-hour ceiling, default 200,000 spans. A rate times unexpected traffic
is still unbounded; this is the bound that does not care why the traffic arrived.

**When it is reached** [proven]:

- trace sampling drops to zero for the remainder of the window;
- one line is written to the journal, once, not once per refusal;
- refusals are counted on the `wev.telemetry.traces` metric (`refused_budget`);
- **metrics and log telemetry are unaffected** — different allowances;
- **the application is unaffected** — requests are served normally, every error
  is still logged, and metrics still describe the whole population.

The budget is consumed **all-or-nothing per trace**: a trace that does not fit is
refused entirely, because exporting four spans of a six-span trace produces a
waterfall that reads as an application bug rather than a truncated export.

#### Bounded memory — four separate limits [proven]

| Bound | Value | On breach |
|---|---|---|
| buffered traces | 500 | oldest trace evicted whole |
| spans per trace | 100 | further spans refused |
| unrooted trace age | 60s | swept and dropped |
| batch queue | 2,048 | SDK drops, counted |

Worst case held in memory is 500 × 100 spans, and reaching it needs 500
concurrent requests each producing 100 spans on a service whose own drain timeout
is 15 seconds.

---

## 4. Cardinality

The one thing about metrics that can actually cost money. Guarded three ways
[proven]:

- **No instrument takes an identifier as a label.** No user id, no event id, no
  request id, no trace id.
- **Route labels are the Express pattern only.** A path with a digit run
  (`/api/events/42`), a query string, or an unreasonable length is refused and
  bucketed as `other` — those are shapes a real URL has and a pattern does not.
- **A hard cap of 60 distinct route labels per process.** The 61st and everything
  after becomes `other`. Even if every guard above were defeated, the label space
  is finite.

Status is recorded as a **class** (`2xx`/`4xx`/`5xx`), never the exact code —
a threefold series reduction for no lost answer. Business operations come from a
closed set; anything else is `other`.

---

## 5. What is traced, and what is not

### Automatic

| Instrumentation | Status | Note |
|---|---|---|
| `instrumentation-http` | on | Server spans. `/health` and OTLP ingest paths excluded. |
| `instrumentation-express` | on, **middleware spans off** | Middleware layers are ~12 spans/request of sub-millisecond bars. The two things worth naming are named by hand instead. |
| `instrumentation-pg` | on, `enhancedDatabaseReporting: false` | Produces spans only when `DATABASE_ENGINE=postgres`. Set explicitly so that inlining parameter values becomes a deliberate edit. |

### Manual — four operations, chosen not sprayed

`event`-level CRUD is *not* instrumented: it is already covered by the HTTP span
and its route. What gets a span is work that automatic instrumentation cannot
name and that somebody will ask about:

| Span | Where | Why it earns one |
|---|---|---|
| `autoselect.run` | `services/autoSelect.js` | Draw, weighting, write and apply — four database stages behind one organizer-visible outcome. |
| `attendance.finalize` | `attendance.js` | Where service hours become real. Everything downstream is derived from it. |
| `search.discover` | `search/discoverSearch.js` | Leaves the machine. "The search was slow" and "Pinecone was slow" are different findings. |
| `transaction` (metric only) | `db/connectionContext.js` | See below. |

### Why the database metric is at transaction granularity

The production engine is `node:sqlite`, for which **no OpenTelemetry
instrumentation exists**. Per-statement timing would have to be hand-rolled into
the connection proxy — an allocation and two clock reads on each of 656
`db.prepare` call sites, against statements that complete in microseconds. The
proxy's own indirection was measured at 1.4% and judged worth it; this would be a
multiple of that, for a number whose useful form the HTTP histogram already
carries.

It would also mean wrapping the object `prepare()` returns, and
`connectionContext.js` records what happened last time this proxy stopped
returning exactly what the connection returns: six tests broke *silently*.

A transaction is the right granularity instead — it is where the contention and
the rollbacks are, it happens once per mutating request, and it means the same
thing on both engines.

### Welly

**Welly is not traced, because Welly does not run on the server.** It is
browser-side inference through `@wllama/wllama`; there is no server-side Welly
operation to instrument. No prompt, no model output and no conversation content
appears in any signal, and no allowlisted attribute could carry one.

---

## 6. Privacy and security

### The finding that shaped this work

Automatic instrumentation is the feature and the hazard. **Measured**, on these
package versions, for a request to `/api/events/42?email=…&q=123+Maple+St`,
`instrumentation-http` records by default:

| Attribute | Contains |
|---|---|
| `url.query` | the query string, verbatim — email address, street address, anything a search box put there |
| `url.path` | the real path, ids and slugs included |
| `client.address` | the client's IP address |
| `network.peer.address` | the same again |
| `user_agent.original` | the client's User-Agent |

Every one of those is something `telemetry.js` deliberately refuses to send, on a
population that is mostly minors. **A naive OpenTelemetry integration would have
started shipping minors' IP addresses and query strings to a vendor, by default,
with no code written to make it happen.**

### The response: an allowlist, applied first in the chain

`spanAttributes.js` holds an allowlist — not a denylist, because a denylist ships
the next new attribute a dependency adds and nobody finds out. It runs **before**
the tail sampler, so no buffer downstream ever holds an unredacted value, and it
**fails closed**: a span that cannot be scrubbed is not exported [proven].

It covers span **events** as well as attributes, because `recordException` writes
an error's message and stack trace into an event and neither has been near the
attribute allowlist.

Proven on the actual wire bytes [proven]: a real request through the real
application, with an email address, a street address, a secret, a cookie and a
User-Agent, produces an OTLP payload containing **none of those values and none
of those attribute keys**.

### Inbound trace context is refused

`propagation.js` injects but does not extract. A client-supplied `traceparent`
would let anyone (a) collide with somebody else's trace, and (b) set the sampled
flag and thereby **choose this application's sampling rate from outside** — a
telemetry amplification attack that spends the span budget and then the
allowance. An unauthenticated header must not be able to move a bill [proven].

### Secrets

- One credential, `BETTERSTACK_SOURCE_TOKEN`, shared by all three signals. There
  is no second token to drift.
- It travels in an `Authorization` header only, never in a URL or a payload
  [proven].
- The resource is built **explicitly** — no host, OS or process detectors. Those
  add `host.name` (which in a school district can name a building) and
  `process.command_line` (which can carry whatever an operator put on it).
- `bin/pre-commit-secret-scan.sh` now catches `BETTERSTACK_SOURCE_TOKEN=<value>`.
  It is anchored on the variable name, not the token's shape: a Better Stack
  token is ~24 characters of plain base62 with no vendor prefix, and matching
  that shape alone would fire constantly. Self-tested in both directions — it
  blocks a realistic token and passes the `.env.example` placeholder.

---

## 7. Reliability

Every guarantee `telemetrySink.js` established for the log wire is preserved and
extended to the trace wire [proven]:

| Failure | Behaviour |
|---|---|
| Better Stack returns 500 | Requests served normally. Batch discarded. |
| Connection refused | Requests served normally. |
| DNS failure | Requests served normally. |
| Endpoint never answers | Requests served normally; queue bounded; memory bounded. |
| 5,000-operation burst against a dead endpoint | Process healthy, heap bounded. |
| Shutdown while the endpoint hangs | Returns within its deadline; process exits. |
| Repeated shutdown | Second call is a no-op; nothing exported twice. |
| SDK fails to start | Logged once; application boots; logging continues. |

### Shutdown

```
SIGTERM → stop listener → stop workers → close sockets → drain requests (15s)
        → release lock → close database → stop index worker
        → drain log telemetry (5s)  → flush traces + metrics (5s)  → exit
```

The telemetry epilogue costs **at most 10 seconds** even with Better Stack
completely unreachable, which on top of the 15s in-flight drain leaves headroom
under systemd's default 90s `TimeoutStopSec`.

The OTel deadline is enforced by a race in `shutdownOtel`, **not** delegated to
the SDK. `BatchSpanProcessor.shutdown()` is bounded per *export attempt*, and the
exporter retries up to five times — "bounded per attempt" is not "bounded", and
`shutdown.js` is explicit about the consequence: a vendor outage during a deploy
that pushes past `TimeoutStopSec` turns a graceful stop into a `SIGKILL`,
discarding exactly the cleanup the sequence exists to perform.

### Trace context and the access log

`logHttpRequest` runs inside `res.on('finish')`, which raised a fair question:
does the OpenTelemetry context still exist there, or is every access-log record
written without a trace id?

**Measured, in a real process: it survives**, and the ids at `finish` are the
same ones as in the middleware body [proven]. So the highest-volume log this
application produces is joinable to its trace.

Worth recording because the harness says otherwise: under Vitest **both**
captures come back empty — in the middleware body as well as the listener — for
the same vite-node reason the Express spans go missing. Read there it looks
exactly like a broken correlation, and the honest response was to assert it in
the subprocess suite rather than to soften it into something that passes.

### The ESM problem

**Measured:** with the SDK registered the ordinary way, a request through Express
produced exactly **one** span. `instrumentation-express` patches CommonJS through
`require-in-the-middle`, and an ESM `import 'express'` never goes through
`Module.prototype.require`.

The documented fix is a CLI flag (`--import
@opentelemetry/instrumentation/hook.mjs`). **Rejected**: it puts a load-bearing
flag in both `package.json` and the systemd unit, and losing either gives a
server that starts, serves, reports traces, and is quietly missing every Express
span.

`otel.js` calls `module.register()` **in process** instead, before `app.js` is
evaluated. Same effect, nothing to forget. Verified in a real `node` subprocess —
Vitest cannot test this, because vite-node loads modules itself and the hook
never sees them (`observability.production.test.js` explains this at length).

---

## 8. Performance [measured]

```
node bin/otel-overhead.mjs 3000
```

On this machine (Node 24.14.0, darwin), three configurations of the same app:

| Workload | telemetry off | telemetry on (2%) | delta |
|---|---|---|---|
| no-op handler, mean | 0.068 ms | 0.099 ms | **+0.031 ms** |
| realistic ~5 ms handler, mean | 5.122 ms | 5.163 ms | **+0.8%** |
| realistic, throughput | 195.2 req/s | 193.7 req/s | −0.8% |
| heap delta over 2,000 requests | 24.26 MB | 24.28 MB | negligible |
| shutdown flush, healthy endpoint | — | 2.6–2.8 ms | — |

Stable across repeated runs (+0.029 to +0.031 ms). The honest number is the
**absolute** one: telemetry costs about 30 microseconds per request. Against a
handler that does nothing that is +45%; against a handler that does real work it
is under 1%. Report the second.

---

## 9. Environment variables

Names only. Values belong in `/etc/wevolunteer/wevolunteer.env` (mode 0600).

| Variable | Default | Purpose |
|---|---|---|
| `BETTERSTACK_SOURCE_TOKEN` | unset | Shared by all three signals. Required. |
| `BETTERSTACK_INGESTING_HOST` | unset | Required. Bare host or full URL. |
| `WEV_OTEL_ENABLED` | on | `false` turns off traces and metrics only, leaving logs on. |
| `OTEL_TRACE_SAMPLE_RATE` | `0.02` | **Cost control.** Failures and slow traces are kept regardless. |
| `OTEL_TRACE_DAILY_SPAN_BUDGET` | `200000` | **Hard ceiling.** `0` disables tracing, keeping metrics. |
| `WEV_OTEL_DIAG` | unset | `debug` turns on the SDK's own logging. Very loud. |
| `TELEMETRY_SERVICE_NAME` | `wevolunteer` | `service.name`, shared with the log records. |
| `APP_RELEASE` | package version | `service.version`, shared with the log records. |
| `WEV_OTEL_TEST_SINK` | unset | Test-only opt-in. See §10. |

**Operator tooling only — the application never reads these.** Used by
`bin/betterstack-live-check.mjs` to read telemetry back out:

| Variable | Purpose |
|---|---|
| `BETTERSTACK_API_TOKEN` | Telemetry API token. Reads source *configuration*. |
| `BETTERSTACK_QUERY_HOST` | ClickHouse HTTP host, e.g. `eu-central-1a-connect.betterstackdata.com` |
| `BETTERSTACK_QUERY_USERNAME` | From Integrations → SQL API |
| `BETTERSTACK_QUERY_PASSWORD` | Shown once at creation; not recoverable |

Three distinct credentials, and they are not interchangeable: the **source
token** writes telemetry, the **API token** reads configuration, and the
**ClickHouse connection** reads telemetry.

**Standard `OTEL_*` variables are deliberately not the configuration surface.**
The exporters are configured explicitly in code, so a stray
`OTEL_EXPORTER_OTLP_ENDPOINT` in somebody's shell cannot redirect this
application's telemetry somewhere else, and cannot bypass the test gate.

---

## 10. Development, test and production

**Development** — off. Leave the credentials unset; every SDK call is a no-op.
To exercise the pipeline locally, point `BETTERSTACK_INGESTING_HOST` at a local
collector or a stub; plain HTTP is allowed outside production and refused in it,
because the token rides in the header.

**Test** — refused outright [proven]. `resolveOtelConfig` returns disabled when
`VITEST` is set, checked **before** any credential is read, so a developer with
production credentials exported cannot ship spans from a test run. A suite that
needs the transport sets `WEV_OTEL_TEST_SINK=1` and points at `127.0.0.1`.

**Production** — confirm two boot lines:

```
[telemetry] Better Stack enabled.
[otel] Traces and metrics enabled (sampling 0.02, budget 200000 spans/day).
```

Both name their reason when off — `not_configured`, `bad_host`,
`insecure_host`, `disabled_by_operator`, `test_environment` — because "the
dashboard is empty" has several causes and guessing between them wastes an
afternoon.

---

## 11. Troubleshooting

| Symptom | Look at |
|---|---|
| No traces in Better Stack | The `[otel]` boot line and its reason. Then the span budget on `wev.telemetry.traces`. |
| Traces, but no Express spans | The ESM hook. `otelSnapshot().esmHook`. Under a bundler or a loader that bypasses Node's ESM loader, the patch does not apply. |
| A specific slow request has no trace | Expected at 2%. Failures and >1s requests are always kept; an ordinary 300ms request usually is not. Use the metrics histogram for the population view and the log record for that request. |
| Traces stopped part-way through the day | The daily span budget. Check `budget_remaining` on `wev.telemetry.traces`, and the journal for the one-line warning. |
| Better Stack bill is not $0 | Check `OTEL_TRACE_SAMPLE_RATE` first — it is the one knob that turns this into a paid service. Then metric cardinality: a new label carrying an identifier. |
| Live Tail shows blank `url`, `path`, `client_ip` | Expected, and it is the privacy control working — see §12. Those attributes are stripped. Edit the source's live-tail pattern to use `http.route`, `http.request.method`, `http.response.status_code`. |
| Nothing arrives after rotating the token | Check the ingesting host. Rotating by creating a NEW source gives a NEW host, and the old one is stale — see §12. Read the authoritative value off the source itself. |
| Metrics missing after a restart | The reader exports every 60s and once on shutdown; a process that died without a clean stop loses at most one interval. |

---

## 12. Live verification against the real Better Stack account

Source `WeVolunteer` (id `2716518`, table `wevolunteer_2`, team `583346`,
cluster `eu-central-1a`). Re-runnable at any time:

```
node --env-file-if-exists=.env bin/betterstack-live-check.mjs
```

### [PROVEN] The numbers match the traffic exactly

A 494-request run, queried back out of Better Stack afterwards:

| Route | Class | Stored | Sent |
|---|---|---|---|
| `/api/events` | 2xx | **420** | 400 reads + 20 Discover |
| `/api/events` | 4xx | **20** | 20 unauthenticated |
| `/api/events/tags` | 2xx | **40** | 40 |
| `/api` | 4xx | **10** | 10 × 404 |
| `/api/errors/report` | 2xx | **3** | 3 |
| `/api/auth/login` | 2xx | **1** (120.6 ms — bcrypt) | 1 |

Plus: the run's unique nonce found in 3 log records; spans named
`GET /api/events` and `request handler - /api/events` with no router noise;
`wev.db.operation.duration`, `wev.http.refusals`, `wev.telemetry.sink` and
`wev.telemetry.traces` all present.

### [PROVEN] Correlation

An INNER JOIN on `trace_id` over stored data matched a log record to its spans —
`Live verification synthetic client error …` ↔ `POST /api/errors/report` **and**
`request handler - /api/errors/report`, trace `89f74cc7…`.

Correlation exists for the **sampled subset**, by design. An error *log* is
written unconditionally; its *trace* is ordinary traffic sampled at 2% unless
the request itself 5xx'd, was slow, or recorded an exception. An error log with
no trace is normal, not a broken join.

### [PROVEN] Three defects the live query found

Ingestion returning 202/200 proved none of these. Each was found only by reading
the data back.

**1. Express was never instrumented.** 31 of 31 automatic spans came from
`instrumentation-http`; every trace was one span named `GET`. ES modules are
loaded graph-wide before any are evaluated, so an in-process `module.register()`
cannot instrument a statically imported `express` — and `server.js` imports
`app.js` statically. Fixed with the `--import` preload (§7).

**2. Router-layer spans were 88% of trace volume.** Express names a span for
every layer it walks looking for a match, so span count scaled with the size of
the route table, not with the request: 196 spans per 494 requests, 168 of them
`router - /api/...` for routes nobody called. Excluding `ExpressLayerType.ROUTER`
took the same workload to 23.

**3. The HTTP histogram was empty, and the metric was duplicated.**

`http.server.request.duration` had **4 non-zero rows out of 2,742**, and **16
series where there should have been 8**. Two separate causes:

- *Cumulative temporality.* A cumulative datapoint is a running total, so the
  backend differences consecutive exports to recover an interval — and a process
  contributes nothing until it has exported twice. Most exports here are the
  single flush a short-lived process makes at shutdown, and WeVolunteer restarts
  on every deploy. Counters survived (an absolute value needs no predecessor);
  histograms did not. Now **delta** (§14 in `otel.js`), after which the same run
  reported exactly what it served — the table above.
- *A duplicate metric.* `instrumentation-http` emits its **own**
  `http.server.request.duration` carrying `http.response.status_code`,
  `url.scheme` and `network.protocol.version` — doubling the series count of the
  busiest instrument and reinstating the exact status-code cardinality
  `metrics.js` deliberately avoids. A View drops it; ours, with a bounded route
  label and a status *class*, is kept.

### [PROVEN] Live Tail shows safe, useful fields

The source's default pattern displayed `span.attributes.http.url`, `http.target`
and `http.client_ip` — the three attributes the scrubber strips, so those columns
were always blank. Rather than weaken the scrubber, the pattern was replaced via
the API with fields this application actually sends:

```
{level} {event} {message} {traceId} {http.request.method} {http.route} {http.response.status_code}
```

### Querying: a third credential

The source token **writes**; the Telemetry API token reads **configuration**;
reading **telemetry** needs a ClickHouse HTTP connection (Integrations → SQL
API) — free, team-scoped, revocable. Connection `403675` exists for verification
and is used only by `bin/betterstack-live-check.mjs`; the application never
reads it.

**Hot and cold storage are different tables.** Recent rows are in
`remote(t583346_wevolunteer_2_logs|_spans|_metrics)`; older rows are in
`s3Cluster(primary, t583346_wevolunteer_2_s3)` filtered by `_row_type`
(1 = logs, 3 = spans). Querying only `remote()` returns zero while the data sits
in the archive — a false negative that looks exactly like broken ingestion.
Always union both.

### The diagnostic asymmetry

`telemetrySink` reports its own delivery failures to the journal via `warnOnce`.
The OTLP exporters do **not** — `otel.js` calls `diag.disable()` unless
`WEV_OTEL_DIAG=debug` (verified not to print the token). "No errors in the
server log" is evidence about logs only.

---

## 12a. Dashboard

**`WeVolunteer — Production`** (id `1112289`), created through the API, eight
charts, every query verified to return real data:

| Chart | Answers |
|---|---|
| Requests per minute, by status class | traffic shape and error ratio |
| Average latency (ms), by route | which endpoint is slow |
| Server errors (5xx) | is anything failing right now |
| Requests refused (401/403/429) | auth or rate-limit spikes |
| Span budget remaining | how much trace budget is left today |
| Slowest routes (avg ms) | where to look first |
| Database transaction duration | is the database the problem |
| Telemetry pipeline: exported vs dropped | is observability itself healthy |

The two dashboards named `Tracing` and `OpenTelemetry collector` are Better
Stack's own auto-created templates. They expect a collector's self-metrics and
semantic-convention attributes this application deliberately does not send, so
they show "No data found" — that is the templates being wrong for this source,
not ingestion being broken. The dashboard above is the one to use.

## 12b. Alerts

Three, on the free plan, deliberately quiet:

| Alert | Condition | Window |
|---|---|---|
| Server errors (5xx) | any 5xx | 5 min |
| Average latency above 1s | avg > 1000 ms | 10 min |
| Telemetry dropped | any overflow/budget drop | 60 min |

No uptime monitor is configured: an uptime check needs a publicly reachable URL,
and WeVolunteer is not deployed to one from this repository. Add one against the
real hostname at deploy time — the free plan includes 10.

---

## 12c. Host heartbeats

Telemetry above describes requests. It cannot describe a job that did not run,
a disk filling, or a service in a restart loop that is up whenever a probe
arrives. Those are covered by three Better Stack heartbeats — `BACKUP`,
`CF_REFRESH` and `HOST` — whose setup, thresholds and verification steps are in
`deploy/README.md` § Alerting. They use the free plan's heartbeat allowance (ten)
and send nothing about any user: the only body ever attached is the host check's
list of findings (a path, a percentage, a unit name).

## 13. Mutation testing

```
node bin/otel-mutation-check.mjs            # all 30, ~15 minutes
node bin/otel-mutation-check.mjs redaction  # by name
```

Every **[proven]** label in this document means a test asserts the behaviour
*and* that test has been shown to fail when the behaviour is removed. The
harness removes one guarantee at a time — the test gate, the sample rate, the
budget, each memory bound, each redaction rule, the shutdown deadline, the
cardinality caps, the propagation refusal, the ESM hook — and reports any that
the suite fails to notice.

**Current result: 30 of 30 caught** (re-run 2026-08-28).

The three added for the live work all target the configuration path, because
that is where a silent failure would have been invisible: `resolveOtelConfig`
and `startOtel` both defaulting to `process.env`, and the OTLP trace endpoint
path. The second of those SURVIVED when first written — no test proved the
default that `bootstrap.js` actually depends on — and the production suite was
changed to pass its configuration through a real `process.env` and call
`startOtel()` with no argument, which is the path that ships.

Two survived on the first run, and both were defects in the *tests*:

- The inbound-`traceparent` test searched the wire for the trace id as **hex**.
  OTLP encodes `trace_id` as 16 raw bytes, so the hex string could never have
  appeared whatever the code did — the assertion was unfalsifiable. Rewritten to
  search the raw bytes.
- The shutdown-deadline mutation had left the timeout branch in the race, so it
  had not actually removed the deadline. A faulty mutation is its own kind of
  false comfort, and is why the harness is in the repository rather than
  something that was run once.

---

## 14. What remains unproven

- **[NOT AVAILABLE] Free-plan usage figures.** The API exposes source
  configuration (retention, platform, pause state) but not consumption against
  the allowance. The usage page needs dashboard access.
- **[NOT AVAILABLE] PostgreSQL.** No test server, so the PostgreSQL suites did
  not run and `instrumentation-pg` has never produced a span outside its own
  tests. Production runs SQLite, so this gates the engine migration rather than
  this integration.
- **[INFERRED] Bytes per span.** §2's arithmetic assumes ~500 bytes and ~6
  spans/request. The live runs give a better anchor: after the router fix a
  494-request run produced 23 spans at 2% sampling, so the real figure is nearer
  2 spans/request — which makes the budget table pessimistic, the safe
  direction. A precise bytes-per-span number needs a populated month.
- **[OWNER ACTION] Uptime monitor.** Needs a publicly reachable URL, which this
  repository does not deploy. See §12b.
- **[OWNER ACTION] Alert delivery.** The three alerts exist and will fire; where
  they are *sent* is an account-level notification setting (email, Slack, phone)
  that is not part of a dashboard alert's definition. Confirm the team's
  notification channel in Better Stack.

---

## 15. Credential rotation

Three credentials, rotated independently.

**Source token** (writes telemetry). Better Stack → Sources → WeVolunteer →
Source token → rotate. Then update `BETTERSTACK_SOURCE_TOKEN` in
`/etc/wevolunteer/wevolunteer.env` (production) or `.env` (local) and restart.

**Critical:** if you rotate by *recreating the source*, the ingesting host
changes with it — the host encodes the source id (`s2716518…`). The old host
still returns 202/200, because Better Stack routes by bearer token, so a stale
host fails **silently and successfully**. After any rotation read the
authoritative value back:

```
curl -s -H "Authorization: Bearer $BETTERSTACK_API_TOKEN" \
  https://telemetry.betterstack.com/api/v1/sources/2716518 | grep ingesting_host
```

**Telemetry API token** (reads configuration). Better Stack → Settings → API
tokens. Used only by operator tooling.

**ClickHouse connection** (reads telemetry). Integrations → SQL API. The
password is shown once. Revoke and recreate to rotate; connection `403675` is
the one this repository's verification script uses.

None of the three is required for the application to serve a request.
