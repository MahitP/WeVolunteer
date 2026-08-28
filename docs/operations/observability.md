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

Run on **2026-08-28** against source `WeVolunteer` (id `2716518`, platform
`open_telemetry`, cluster `eu-central-1a`, table `wevolunteer_2`), using a
freshly rotated source token. Re-runnable:

```
node --env-file-if-exists=.env bin/betterstack-live-check.mjs
```

### PROVEN — demonstrated against the real account

| Check | Evidence |
|---|---|
| The rotated source token is valid | `POST /` → **HTTP 202 Accepted** |
| Better Stack accepts our OTLP traces | `POST /v1/traces` → **HTTP 200 OK** (protobuf + gzip, bearer token) |
| Better Stack accepts our OTLP metrics | `POST /v1/metrics` → **HTTP 200 OK** |
| The source is configured for OpenTelemetry | API reports `platform: open_telemetry` |
| Retention is on free-plan terms | API reports `logs_retention: 3`, `metrics_retention: 30` |
| Ingestion is not paused | API reports `ingesting_paused: false` |
| The application boots with telemetry on | `[telemetry] Better Stack enabled.` / `[otel] Traces and metrics enabled (sampling 0.02, budget 200000 spans/day).` |
| Logs delivered under real traffic | 494 requests; `telemetrySink`'s `warnOnce` never fired |
| Traces **and metrics** delivered under real traffic | Re-run with `WEV_OTEL_DIAG=debug`: 518 SDK diagnostic lines, `OTLPExportDelegate items to be sent` for both signals, **zero** export-failure lines |
| `WEV_OTEL_DIAG=debug` does not leak the credential | Verbose log searched for the literal token and for `Authorization`/`Bearer`: all absent |
| Graceful shutdown flushes both pipelines | SIGTERM → full sequence → **exit 0 in 2.4s** |
| The token never appears in output | server log searched for the literal token: absent |

The 494 requests were deliberately minimal, and read-only apart from one login
and three client error reports:

| Count | Request | Result |
|---|---|---|
| 400 | `GET /api/events` authenticated | 200 |
| 20 | `GET /api/events?search=…` (Discover) | 200 |
| 20 | `GET /api/events` unauthenticated | 401 |
| 40 | `GET /api/events/tags` | 200 |
| 10 | `GET /api/does-not-exist-*` | 404 |
| 1 | `POST /api/auth/login` | 200 |
| 3 | `POST /api/errors/report` | 202 |

**Neither the sample rate nor the span budget was changed to make the run
visible.** At 2% the expected yield is roughly ten traces; the connectivity
check reaches the pipeline deterministically by using its own always-keep rule
for errors instead of turning a cost control off.

**Why the run was done twice.** The first pass claimed "no delivery failure"
on the strength of the server log — but `otel.js` calls `diag.disable()` unless
`WEV_OTEL_DIAG=debug`, so OTel export failures during that run would have been
**silent**, and the absence of errors proved nothing about traces or metrics. It
proved only that the LOG sink was healthy, which has its own `warnOnce`. The run
was repeated with diagnostics on to get evidence rather than an inference.

That asymmetry is worth remembering when diagnosing: the log wire reports its own
failures to the journal by design; the OTLP wire does not, unless asked.

### OWNER ACTION — the half that needs the dashboard

Acceptance at the ingest boundary is what can be proven from here. That the
records are *queryable* needs a read path, and the v1 query API was
decommissioned in August 2024; the current one requires a ClickHouse connection
credential that does not exist on this account (`GET /api/v1/connections`
returned an empty list). Creating one is an account change and was not done
unasked.

To confirm, search the source for either nonce printed by the live check, or for
`event:lifecycle.live_check`.

### The stale ingesting host — a real finding

The host supplied for this work, `s2708227.eu-central-1a.betterstackdata.com`,
belonged to the **previous** source, which no longer exists. Rotating the
credential had created a NEW source (`2716518`) with its own host,
`s2716518.eu-central-1a.betterstackdata.com`. Configuration has been corrected
to the authoritative value read back from the API.

Both names resolve to the same two addresses (`195.63.225.49/50`) and posting to
the old one with the new token still returned 202/200, so Better Stack evidently
routes by bearer token rather than by hostname and nothing was lost. That is a
convenience, not a contract: **take the ingesting host from the source itself
after any rotation**, because a value that merely happens to work is not a value
to configure.

### Live Tail will show empty `url`, `path` and `client_ip` columns

The source's default live-tail pattern is:

```
{message} {span.attributes.http\.url AS url}
          {span.attributes.http\.target::truncate(40) AS path}
          {span.attributes.http\.client_ip AS client_ip}
```

Those three attributes are exactly the ones `spanAttributes.js` strips — the
full URL with its query string, the real path, and the client IP address. So
those columns will be blank, and **that is the privacy control working, seen
from the dashboard**, not a broken integration.

Do not "fix" it by allowlisting those attributes. Edit the live-tail pattern
instead; `http.route`, `http.request.method` and `http.response.status_code` are
present and are what this application deliberately sends.

---

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

Stated plainly, because the labels above are worthless if this section is empty
when it should not be. Two entries here were resolved by the live run on
2026-08-28 and have moved to §12; what is left is what is genuinely still open.

- **[owner action] That the records are QUERYABLE has not been checked from
  here.** Better Stack returned 202/200 and the source is configured correctly,
  which proves acceptance at the ingest boundary — the thing that was previously
  entirely unproven. Reading the rows back needs a ClickHouse connection
  credential that does not exist on the account, and creating one is an account
  change. Confirm in the dashboard by searching for the live-check nonce.
- **[inferred] The ~500 bytes/span figure** behind the budget arithmetic in §2
  is still an estimate. The observed OTLP payloads were ~330 bytes for a
  one-span request before gzip, but a single span carries the whole resource
  block, so that overstates the marginal cost of a span in a full batch and the
  true figure needs a populated account to measure. The daily span budget bounds
  the worst case regardless of what it turns out to be — which is exactly why
  the ceiling is counted in spans rather than in bytes.
- **[inferred] Free-plan usage figures cannot be read from here.** The API
  exposes source configuration (retention, platform, pause state) but not
  consumption against the allowance. The usage page needs account access.
- **[proven, but narrow] Express instrumentation** is proven in a subprocess
  running a two-route Express app, not the full application. The mechanism under
  test — module patching and import order — is identical, and the full
  application has now been observed booting with the SDK enabled and serving 494
  live requests without a delivery failure; but no assertion has been made
  against an Express span produced by the real route table.
- **[not tested] PostgreSQL.** No server was available, so the PostgreSQL
  application and migration suites did not run, and `instrumentation-pg` has
  never produced a span outside its own tests. Production runs SQLite today, so
  this gates the engine migration rather than this integration.
