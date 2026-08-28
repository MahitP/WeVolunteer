# Better Stack: telemetry and the MCP server

> **Traces and metrics are documented separately**, in
> [`observability.md`](observability.md). This document covers the LOG wire —
> `telemetrySink.js`, the HTTP ingestion API, the field allowlist — and the MCP
> operator tooling. The OpenTelemetry half shares this source and this token but
> is a different pipeline with different failure modes and its own cost
> controls, and merging the two documents would bury both.
>
> The short version of the split: OpenTelemetry JavaScript marks Logs
> "Development" while Traces and Metrics are Stable, so the reviewed log
> boundary described below was kept rather than replaced.
>
> **The MCP questions in §7 below are now answered.** They were the three
> unknowns about `X-MCP-Tools-Only`, and `bin/betterstack-mcp-audit.mjs` settled
> all of them against the live service on 2026-08-29: the header is honoured
> (111 tools unfiltered, 8 with the allowlist), it **fails closed** (an
> unmatched name grants nothing rather than voiding the header), an entry names
> a category rather than one tool (`monitors` also admitted `monitor`, but not
> `create_monitor`), and an invalid token is refused with 401. None of the eight
> granted tools mutates anything. Re-run the audit after any Better Stack
> change.

Two separate things that share a vendor, and the distinction matters:

- **Telemetry** is how the *product* reports on itself — a batched HTTPS POST
  from `server/telemetrySink.js`. Optional, off by default, and never required
  to serve a request.
- **The MCP server** is how a *person* (or Claude Code) queries what was
  reported. It is an operator tool. The application does not use it and must
  not, exactly as with [`resend-mcp.md`](resend-mcp.md).

### How to read this document

Claims here are labelled by where they come from, because "the allowlist blocks
that" and "the allowlist probably blocks that" are not the same sentence and the
difference decides what an operator can rely on:

| Label | Means |
|---|---|
| **[proven]** | A test in this repository asserts it, and the test has been shown to fail when the behaviour is removed. |
| **[documented]** | Better Stack's own documentation says so. Not verified here. |
| **[inferred]** | A reasonable reading of the docs or the code. Nobody has checked. Treat as a guess. |
| **[owner action]** | Cannot be settled from this repository. It needs a decision or a credential only the operator has. |

An unlabelled statement describes this repository's own code and can be checked
by reading it.

---

## 1. Creating the source

In Better Stack: **Telemetry → Sources → Connect source**, platform
**JavaScript · Node.js**. Name it for the deployment (`wevolunteer-production`),
not for the app, so a second environment does not land in the same stream.

It gives you two values:

| Value | Looks like | Goes in |
|---|---|---|
| Source token | `<24 random characters>` | `BETTERSTACK_SOURCE_TOKEN` |
| Ingesting host | `s1315908.eu-nbg-2.betterstackdata.com` | `BETTERSTACK_INGESTING_HOST` |

The token is a **write credential for your log stream**. Anyone holding it can
fill the account with junk and exhaust the ingestion quota. It belongs in
`/etc/wevolunteer/wevolunteer.env` (mode 0600, root-owned) and nowhere else —
never in the repository, never in a `VITE_`-prefixed variable, which would
compile it into the browser bundle and publish it.

## 2. Environment variables

All optional. With the first two unset, telemetry is off and the application
logs to the journal exactly as it always has.

| Variable | Default | Purpose |
|---|---|---|
| `BETTERSTACK_SOURCE_TOKEN` | unset | Source token. Both this and the host are required before anything is sent. |
| `BETTERSTACK_INGESTING_HOST` | unset | Ingesting host. A bare host or a full URL both work. |
| `TELEMETRY_SAMPLE_RATE` | `0.05` | Fraction of **successful** requests logged. Errors, 4xx/5xx and slow requests are always logged. |
| `TELEMETRY_SERVICE_NAME` | `wevolunteer` | The `service` field, when one account receives several deployments. |
| `APP_RELEASE` | `server/package.json` version | The `release` field. Set to a commit SHA if you deploy from one. |

Per environment:

- **Local development** — leave unset. Logs go to the terminal. Set them only to
  test the integration, and point them at a scratch source, never production's.
- **Tests** — refused outright. `resolveTelemetryConfig` returns disabled when
  `VITEST` is set, before it looks at any token, so a suite cannot ship fixture
  data into a real account even if a developer's shell exports one. A test that
  needs the transport sets `WEV_TELEMETRY_TEST_SINK=1` and points the host at a
  local stub.
- **Staging** — its own source. Sharing production's makes both unreadable.
- **Production** — set in the systemd environment file. Confirm the boot line:

  ```
  [telemetry] Better Stack enabled.
  [telemetry] Better Stack disabled (not_configured). Logs stay local.
  ```

  The reason is named — `not_configured`, `bad_host`, `insecure_host`,
  `test_environment` — because "the dashboard is empty" has several causes and
  guessing between them wastes an afternoon.

## 3. How WeVolunteer sends telemetry

Through Better Stack's [HTTP ingestion API][http-api]: `POST` to the ingesting
host with `Authorization: Bearer <token>` and a JSON array of records.

**`@logtail/node` was considered and not used.** It brings five packages plus a
types package to make one HTTPS POST, and the failure semantics below are the
whole point of this integration — bounded queue, swallowed errors, hard timeout,
no unhandled rejection. Obtaining those by wrapping a third-party client is more
code than the POST, and leaves the guarantee resting on somebody else's retry
loop. The format, endpoint, auth scheme and `dt` semantics are Better Stack's,
used as documented. The reasoning is recorded in full at the top of
`server/telemetrySink.js`.

Records are queued in memory, flushed every 2s or every 50 records, and drained
during graceful shutdown (a bounded loop, not a single batch — a busy server can
be holding several hundred).

**One request is in flight at a time** [proven]. Without that interlock a burst
started a concurrent POST per fifty records, so five thousand records meant a
hundred simultaneous requests, each holding a socket and a batch — and the queue
stayed near empty throughout, which meant the 500-record cap never engaged and
the drop counter never moved. Serialised delivery turns a slow endpoint into
queue pressure instead, which is what the cap is for. It costs throughput (fifty
records per round trip); the four sources below do not come close to that.

**Telemetry is sampled, not guaranteed** [proven]. Records are dropped
oldest-first when the queue is full, a failed batch is discarded rather than
retried, and the shutdown drain stops early under any of three bounds:

| Bound | Value | Why |
|---|---|---|
| passes | queue cap ÷ batch size, + 2 | terminates even while `enqueue` is still being called |
| deadline | 5s over the whole drain | systemd's `TimeoutStopSec` defaults to 90s and `SHUTDOWN_TIMEOUT_MS` is operator-configurable; an unreachable endpoint could otherwise cost 55s and push a restart into `SIGKILL`, discarding the cleanup the shutdown exists to do |
| first failure | stops on the first failed pass | a failed batch is discarded, not retried, so later passes could only spend a timeout each discarding records that were already lost |

If any records were dropped, the drain says so once, on stdout, at shutdown. The
journal remains the complete local record; Better Stack is the sampled one. Do
not build a compliance or audit process on it — `audit_log` is the record.

One difference from the database worth stating: `error_events` keeps at most 100
occurrences per fingerprint per hour, while telemetry emits one record per
occurrence. The **fields** are identical — that is the rule below — but the
**volume** is not, so a runaway error loop costs ingestion quota where it would
not cost database rows. The queue drops oldest-first when full, so it costs no
memory. A flood that would create new error *groups* is stopped earlier, by the
500-group client ceiling in `errorReporter.js`, before telemetry is reached. The deployment is a long-lived systemd
service (`deploy/wevolunteer.service`), so an in-process queue is appropriate;
nothing here spawns a process or adds anything for systemd to supervise.

### The four sources, and only these four

There are nearly 400 `console.*` calls in `server/`. **None of them go to Better
Stack** — routing prose written over a year by people who were not thinking
about a telemetry boundary would ship whatever any of it happens to interpolate.
Telemetry is fed from four choke points that already carry structured, redacted
data:

| Event | From | Carries |
|---|---|---|
| `http.request` | the access-log middleware in `app.js` | method, route **pattern**, status, duration, outcome, request id, role, user hash |
| `error.recorded` | `recordError` in `errorReporter.js` | source, error type, redacted message, redacted stack, route pattern, fingerprint, status, request id, role, user hash |
| `lifecycle.*` | `server.js`, `shutdown.js` | boot, shutdown, outcome |
| `security.action` | `recordAudit` in `auditLog.js` | the audit **action name** only |

Adding a fifth means adding it to the allowlist in `server/telemetry.js`, which
is where the decision belongs.

## 4. What is deliberately never sent

The rule, and it is one line:

> **Better Stack may hold exactly what `error_events` may hold, and nothing
> more.**

That bar is not invented for telemetry. ENGINEERING_GUIDE §6.10 sets it for the
error table — the one store deliberately fed by "the code paths most likely to
be holding somebody's data at the moment they broke", on a population that is
mostly minors. Reusing it means the privacy question has already been reviewed
twice by people probing it with realistic PII.
`server/telemetry.betterstack.test.js` asserts the rule as a property.

**Blocked by construction** — these cannot enter a record, because
`server/telemetry.js` copies from an **allowlist** of field names and everything
else is dropped in silence:

- passwords and password hashes
- JWTs, session cookies, `Authorization` headers, bearer tokens
- API keys, source tokens, `JWT_SECRET`, `TFA_ENCRYPTION_KEY`
- TOTP secrets and recovery codes
- database credentials and connection strings
- request bodies and response bodies — no field exists for either
- headers of any kind, cookies of any kind
- raw user ids, names, email addresses, phone numbers, addresses
- IP addresses
- query strings and full URLs

**Reduced rather than blocked**, because debugging needs something:

| Instead of | It sends | Why |
|---|---|---|
| a user id | `userHash`, a one-way digest | Answers "how many distinct people hit this" without naming any of them. |
| a URL | `route`, the Express **pattern** | `/api/events/:id`, never `/api/events/evt-1?q=alice@school.org`. A real URL carries search terms and addresses. |
| an error message | the message after `redactMessage` | Strips emails (Unicode-aware), JWTs, bearer tokens, certificate codes, connection-string credentials, phone numbers and long digit/hex runs. |
| a stack trace | the stack after `redactStack` | Rewrites absolute paths that can carry a username; keeps the first `node_modules` frame and drops its internals. |

**Known limit, stated so nobody assumes otherwise.** §6.10 is explicit that
redaction does **not** cover personal names, street addresses, IP addresses or
dates of birth. There is no pattern for a name. The real control is upstream —
*do not interpolate user data into an error message* — and every `throw new
Error(...)` in `server/` was checked against that at v1.2c. The redactor is the
second line, not the first.

### Why this is a different call from `alerting.js`

`server/alerting.js` sends **no message, no stack, no route, no user hash**, and
says why: an alert lands in a mailbox this application does not control and
*will* be forwarded.

Better Stack is a different kind of destination — the operator's own
access-controlled account under a processing agreement, in the same category as
the database host and the mail provider, not a distribution list. So it gets the
database's bar rather than the mailbox's. **If that account is ever shared more
widely, this decision is the one to re-examine.**

## 5. Correlating a failure end to end

Every response carries `X-Request-Id`, set by the first middleware in `app.js`.
An inbound one is deliberately ignored — it is unauthenticated and would let
anyone collide with somebody else's trace.

```
browser        ApiError.requestId          ← read from X-Request-Id
   ↓
crash report   POST /api/errors/report     ← sends requestId
   ↓
backend        error_events.context.requestId
   ↓
Better Stack   http.request + error.recorded, same requestId
```

So one id in Better Stack returns the access record and the error record, and
`fingerprint` joins both to the group in the in-app error dashboard.

**What is proven, and the one link that is not.** The id on the response header
is the id that arrives at the vendor on the access record for the same request
[proven — `telemetry.correlation.test.js` reads it off a stub, and decoupling
the header from `req.id` fails it]. The error side is proven through the same
`recordError` the 500 branch calls, reached via the crash intake [proven].

Not proven end to end: the 500 branch's own `context: { requestId: req.id }`.
Nothing in this application can be made to return 500 on demand — a good
property, and an inconvenient one here — so no test drives that exact line. It
reads `req.id`, the same expression the header is written from, a few hundred
lines above in the same file [inferred, by reading].

**The id fields are not redacted, and that is deliberate** — redaction would eat
the hex run that is the whole point of a fingerprint. What protects them instead
is shape: at most 64 characters (a sha256 in hex is the longest id this system
produces), a restricted character class, and an explicit refusal of anything
JWT-shaped. An over-long value is **rejected rather than truncated**, because a
truncated id correlates with nothing anyway while a truncated JWT still carries
its readable claims [proven].

## 6. Frontend telemetry: deliberately not added

The browser does **not** talk to Better Stack, and should not. Four reasons:

1. **It would duplicate.** Client errors already reach the backend through
   `POST /api/errors/report` and are forwarded from there with `source:
   'client'`. A browser SDK would send the same crash twice.
2. **The token would be public.** A browser source token ships in the bundle,
   readable by anyone, and is a write credential for the district's log stream.
3. **It would bypass four defences.** `src/utils/errorReporting.js` caps reports
   per page load, breaks re-entrant reporting loops, de-duplicates, and never
   throws — all documented against specific failure modes. An SDK added beside
   it has none of them.
4. **CSP.** `connect-src` names each third-party host individually and on
   purpose. Adding a telemetry vendor widens the policy that protects a page
   handling minors' data, for a capability already covered.

If browser-side Real User Monitoring is ever genuinely wanted, that is a
separate decision with its own privacy review — not a side effect of adding
backend logging.

---

## 7. The MCP server

`https://mcp.betterstack.com` — remote, official, and **not** reimplemented
here. It is how a person or Claude Code queries the telemetry above.

The application does not use it. If it is not configured, not connected or
offline, WeVolunteer is unaffected — the same separation `resend-mcp.md` draws.

### Setup

The repository ships `.mcp.json` with the restricted, read-only configuration,
so the safe setup is the default one. Claude Code picks it up automatically and
prompts for browser OAuth on first use; the resulting token is stored by Claude
Code outside the repository.

To connect it by hand instead:

```bash
claude mcp add betterstack --transport http https://mcp.betterstack.com
```

Then restrict it, which the plain command above does not do:

```bash
claude mcp add betterstack --transport http https://mcp.betterstack.com \
  --header "X-MCP-Tools-Only: documentation,monitors,incidents,query,sources,errors,dashboards"
```

Authenticate as the Admin account, per the decision recorded below — and read
that section first, because it changes what the allowlist is doing.

**Never** add a Better Stack API token to `.mcp.json` or to any file in this
repository. OAuth exists precisely so there is no credential to commit. The
token-in-a-header form documented by Better Stack is for clients that cannot do
OAuth; Claude Code can.

### The role is Admin, so the header is now the whole boundary

**Decision, 2026-08-26: Claude Code authenticates here as a Better Stack Admin.**
That is the account owner's call and it is recorded rather than argued with, but
it inverts the design of everything below, so read this section before touching
the allowlist.

Ordinarily the boundary is the Better Stack **role**, because that is the part
Better Stack enforces server-side, and `X-MCP-Tools-Only` is only defence in
depth on top of it. With an Admin credential there is no server-side restriction
left to be in depth *of*: Admin reaches everything, including billing, team
membership and API tokens. **The header is now the only thing standing between
an assistant and every destructive tool Better Stack exposes.**

Two consequences follow, and neither is optional:

- The three open questions below stop being academic. They were "how much is
  this extra layer worth"; they are now "does the only layer work at all".
  **Run the audit before connecting** — see the next subsection.
- The allowlist must not be widened casually. Any entry added is an entry an
  Admin token can act through.

Three things stop the header being enough on its own, and each of them is a way
for it to be worth less than it looks:

1. Of the tokens in `.mcp.json`, only `monitors`, `monitor` and `incidents` come
   from Better Stack's own documented example [documented]. The rest are
   **[inferred]** from the tool categories in their docs — the tool list is not
   readable without authenticating, so this could not be confirmed here.
2. Whether an unrecognised token is ignored (safe — fewer tools) or voids the
   header (unsafe — every tool, including `remove_dashboard`) is **unknown**
   [owner action].
3. Whether a token matches a tool **name** exactly or a **category prefix** is
   **unknown** [owner action] — and it decides whether an entry admits one read
   tool or every tool in that category, writes included. Under prefix matching,
   `monitor` would admit `monitor_create` and `monitor_delete` beside
   `monitor_get`. That is why the singular `monitor` from Better Stack's own
   example is **not** in the shipped allowlist: if matching is exact its absence
   costs one lookup, and if matching is a prefix its presence hands an assistant
   the ability to delete an alerting monitor. Restore it once (3) is answered.

#### Ending all three, in about a minute

```bash
BETTERSTACK_API_TOKEN=… node bin/betterstack-mcp-audit.mjs
```

The script authenticates once and asks four times under different headers: the
unfiltered tool list, the configured allowlist, an allowlist of one nonsense
name, and an invalid bearer token. It reports which configured names matched
nothing, and which allowed tools have names suggesting they mutate.

It sends `initialize` and `tools/list` and nothing else — `rpc()` refuses any
other method outright, and a test asserts at the wire that nothing else was sent
[proven]. The token is read from the environment only (never a flag: an argument
is visible in `ps` and lands in shell history), and never appears in the output
[proven].

Record what it finds here with the date, moving each item from **[owner action]**
to **[proven]** — these are observations of a live service, and a service can
change.

Better Stack's roles, for the record and for anyone revisiting the decision:

| Role | Reaches | Trade-off |
|---|---|---|
| **Admin** ← *in use* | everything, incl. billing, org settings, API tokens | Nothing is withheld server-side. The allowlist header is the entire boundary. |
| **Team lead** / **Responder** | monitors, incidents, on-call, status pages, sources, dashboards, errors | The full workflow below — and can also modify and delete those things. |
| **Member** | log sources, live tail, dashboards, errors | Narrowest. **Cannot** reach monitors, incidents, on-call or status pages, so "are any monitors down?" stops working. Still permits dashboard edits. |

There is **no true read-only role** outside the Enterprise plan's custom roles,
which is the reason a lower role was not simply a free win — Member still edits
dashboards, and Responder still deletes monitors. Admin differs in degree rather
than in kind, and it keeps the monitor and incident questions working.

**What compensates, given the choice made:**

1. The allowlist stays as narrow as it can be while answering the questions in
   §7 — and the singular `monitor` stays OUT of it until question (3) is
   answered. Under Admin that entry is the difference between reading a monitor
   and deleting one.
2. The audit is run **before** first connection, not after, and its answers are
   recorded here.
3. `/mcp` is checked after connecting, to see which tools actually arrived
   rather than which ones were asked for.
4. If the audit shows the header **fails open**, the honest conclusion is that
   an Admin-authenticated MCP has no boundary at all. At that point either use a
   lower role for this connection or do not connect it — a header that a typo
   disables is not a control.

Nothing about this changes the application: the MCP is an operator tool and
WeVolunteer never calls it.

### Who can see what — this changes the privilege model

`error.read` is in `SUPER_ONLY` (`server/authz.js`): inside WeVolunteer, error
messages, stacks and route patterns are visible to **super administrators
only**.

The same records now also sit in Better Stack. So **anyone on the Better Stack
team can see them — including people who hold no WeVolunteer account at all.**
The Better Stack team roster is, in effect, an extension of this platform's
privilege model, and adding somebody to it grants error visibility that the
application itself reserves for its owner.

That is a decision worth making deliberately rather than discovering. Keep the
team small, review it when it changes, and remember §4's known limit: redaction
does not cover personal names, and a name can reach an error message through
free text nobody expected.

**And the roster is now editable through the same credential.** Admin reaches
team management, so if a team-management tool is among those the allowlist lets
through, an assistant holding that credential could add a member — which, by the
paragraph above, grants error visibility this application reserves for its owner.
No such tool is in the allowlist by name, but the allowlist is matched by a
mechanism nobody has verified yet (§7, question 3). This is the single most
consequential thing the audit settles, and the reason to run it before the first
connection rather than after.

### Which capabilities are enabled, and why

Better Stack exposes 100+ tools. The allowlist admits the **read-only
observability workflow** and nothing else.

**Enabled** — everything needed to investigate:

| Group | Answers |
|---|---|
| `monitors`, `monitor` | Is anything down? What is availability and response time? |
| `incidents` | What is open, what happened, what was the timeline? |
| `query` | Execute a query over logs, metrics and errors; render a chart. This is the workhorse. |
| `sources` | Which sources exist and what fields do they have — needed to write a query at all. |
| `errors` | Error-tracking applications, releases and error detail. |
| `dashboards` | Read existing dashboards and charts. |
| `documentation` | Search Better Stack's own docs, so query syntax can be looked up rather than guessed. |

**Deliberately excluded**, and this is the point of the allowlist:

- `remove_dashboard`, `remove_chart`, removing sections, variables and alerts
- removing monitors, heartbeats and status-page resources
- inviting team members, changing roles, removing members
- acknowledging, escalating, resolving and reopening incidents
- creating monitors, heartbeats, sources, cloud connections and applications
- updating error state

None of those are needed to diagnose a problem. An assistant that can delete the
monitoring while investigating an outage, or resolve an incident nobody has
actually fixed, is a worse position than having no assistant — and on a platform
whose incidents concern minors' data, silently closing one is not a recoverable
mistake.

Write access is a **deliberate future expansion**, not a default. If it is ever
wanted, widen the allowlist by the specific tokens needed, for the specific
task, and narrow it again afterwards.

> **Verify what actually came through — this is an owner action, not a
> nicety.** Run `/mcp` in Claude Code after connecting and read the tool list.
>
> - A group you expected is **missing** → the token name is wrong. Fix the token
>   rather than removing the header.
> - A tool from the excluded list is **present** → the header is not being
>   applied as assumed. Reduce the account's Better Stack role immediately; do
>   not widen the header to compensate.

### Useful questions

Read-only, and each maps onto a tool group above:

- "Show me errors from the last hour."
- "Are any production monitors currently down?"
- "Find the most common API errors today."
- "Show me the error rate for the last 24 hours."
- "Find HTTP 500 errors and summarise the likely cause."
- "What is the p95 duration of `/api/events` this week?"
- "Show every record with request id `<id>`." — the correlation trick from §5.
- "Which release did this error first appear in?"
- "Compare 4xx and 5xx counts before and after the last deploy."

### Runbook: a report of "the site is slow"

1. *"Are any production monitors currently down?"* — rules out an outage.
2. *"Show me p95 `durationMs` by route for the last hour."* — `http.request`
   carries `durationMs` and `route`, so this is one query.
3. Take the worst route. *"Show 5xx for that route in the last hour."*
4. Take a `requestId` from one of those and search it — that returns the
   `error.recorded` record with the redacted stack and the `fingerprint`.
5. Open the fingerprint in the in-app error dashboard (`super_admin`), which has
   the retained evidence and the occurrence counter.

Step 5 is where the detail lives. Better Stack narrows the search; the
access-controlled dashboard holds the evidence.

### What the MCP cannot do

- It cannot read anything WeVolunteer did not send. Everything in §4 is absent
  from the vendor entirely, not merely hidden.
- It cannot reach the database, the audit trail or the error dashboard.
- It cannot un-redact a message. Redaction happens before transmission.
- It cannot create the source or set the environment variables — §1 and §2 are
  the owner's, in the Better Stack dashboard and the systemd environment file.

[http-api]: https://betterstack.com/docs/logs/http-rest-api/
