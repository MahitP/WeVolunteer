# The Owner Center

`/owner` — one page that answers *is WeVolunteer healthy, and what needs my
attention?* It reads the services this deployment already runs on and links out
to each of them. It is not a replacement for any of those products, and it is
deliberately not a control panel: **nothing on it writes anything, anywhere.**

## How to read this document

Claims are labelled by where they come from, following the convention
[`betterstack.md`](betterstack.md) established — "the free plan covers that" and
"the free plan probably covers that" are not the same sentence, and the
difference decides what an operator can rely on.

| Label | Means |
|---|---|
| **[proven]** | A test in this repository asserts it, and the behaviour is exercised rather than assumed. |
| **[documented]** | The vendor's own documentation says so, read on the date given. Not verified against a live account here. |
| **[inferred]** | A reasonable reading of the docs or the code. Nobody has checked. |
| **[owner action]** | Cannot be settled from this repository. It needs a credential or a decision only the account owner has. |

---

## 1. How to get there

**Dashboard → Admin (rail) → Owner Center.** Two clicks, no URL typing.

The Owner Center is a tile on the administrative hub at `/admin/moderation`,
beside Audit trail, Errors and Platform Impact. That is where every other
owner-only page already lives, and the rail deliberately carries one
administrative entry rather than seven — see the note on the `moderation` entry
in `src/App.jsx`'s `NAV` table, which records that decision and lists the pages
it moved off the rail.

The tile is filtered by `owner.console`, so an ordinary administrator opening the
same hub sees Reports, Appeals, Organizer requests and Community impact and no
Owner Center. Typing `/owner` anyway lands on the platform's own refusal screen,
which names the page ("This account does not have permission for the Owner
Center") rather than 404-ing — see `denialDetail.js`.

## 2. Who can open it

`owner.console`, which is in `SUPER_ONLY` (`server/authz.js`). Three consequences,
and all three are deliberate:

- **Owner only.** A student, an organizer, a partner and an *ordinary
  administrator* are all refused, at the API, on every one of the four endpoints
  [proven — `server/routes.owner.test.js`, and the four rows added to
  `authz.matrix.test.js`].
- **Ungrantable.** `can()` checks `SUPER_ONLY` *before* it consults per-user
  grants, and `userCapabilities.js` refuses to store a grant naming one. "Let the
  person who watches the dashboards see the dashboards" is an extremely
  reasonable-sounding grant; what it would actually hand over is an operational
  map of a service holding minors' records. That conversation has to happen as a
  role change [proven].
- **The route guard is not the boundary.** `src/routes/index.jsx` names the same
  capability and the tile on the Admin hub is hidden by it, but both are UX.
  `server/routes/ownerRoutes.js` is the boundary and re-checks per request.

## 3. What it shows, and where each figure comes from

| Section | Source | Needs a credential? |
|---|---|---|
| Systems, application, database | this process and this database | No |
| Errors (24h, trend, open problems) | `error_events` / `error_groups` in this database | No |
| Email, notification queue, backups, hours ledger | this process | No |
| Telemetry pipeline | `telemetrySink.js`'s own counters | No |
| Uptime monitors, incidents | Better Stack Uptime API | Yes |
| Active users, new users, feature usage | Amplitude Dashboard REST API | Yes |
| Redis health and latency | Upstash, via the existing client | Uses the existing Redis credentials |
| Vector search health | Pinecone, via the existing client | Uses the existing Pinecone key |

**The local half always works.** `GET /api/owner/health` contacts nothing
[proven], so the page still answers on the day every vendor is unreachable —
which is the day it matters.

**The error trend is read locally on purpose.** Better Stack holds the same
records (`errorReporter.js` writes both), but the local copy is exact where the
vendor's is sampled, retained for 30 days where the free plan keeps 3, and
available when the network is not. The other reason is in
`server/integrations/betterstack.js`: the ClickHouse credentials that could query
the vendor are documented in `.env.example` as operator tooling that **the
application never reads**, and quietly making the server a fourth reader of them
would make that written boundary worthless.

Counts only — no message, no stack, no fingerprint, no route [proven]. The
evidence lives at `/errors`, behind `error.read`, and a second surface disclosing
it under a different capability is how one of the two ends up with weaker rules.

## 4. Configuration

Everything below is **optional**. With none of it set the Owner Center still
renders, reports the local half in full, and shows each integration as *Not
configured* with the variable that would switch it on.

### 4.1 Better Stack — uptime monitors and incidents

```
BETTERSTACK_UPTIME_API_TOKEN=
```

Better Stack issues **separate credentials per surface**, and this repository now
holds three that are not interchangeable:

| Variable | Reads / writes | Used by |
|---|---|---|
| `BETTERSTACK_SOURCE_TOKEN` | writes telemetry | the application |
| `BETTERSTACK_API_TOKEN` | reads source *configuration* | `bin/betterstack-live-check.mjs` |
| `BETTERSTACK_UPTIME_API_TOKEN` | reads monitors and incidents | the Owner Center |

Create it in Better Stack → **API tokens** → *Team-based tokens* → Uptime (a
global token also works and reaches more; prefer the team-scoped one) [documented,
2026-09-02].

Endpoints used, and nothing else:

- `GET https://uptime.betterstack.com/api/v2/monitors?per_page=50`
- `GET https://uptime.betterstack.com/api/v3/incidents?resolved=false&per_page=10`
- `GET https://uptime.betterstack.com/api/v3/incidents?per_page=10`

**Free-plan position.** The free tier includes 10 monitors and 1 status page
[documented, 2026-09-02]. Nothing here asks for a paid capability — no
availability SLA summaries, no report exports, no on-call schedules. Whether the
Uptime **API** is included on the free plan is **[owner action]**: Better Stack's
pricing page does not list API access per tier. If this account's plan refuses,
the card says so and offers the dashboard link, and nothing else on the page is
affected — which is why the integration was built to degrade rather than to be
depended on.

### 4.2 Amplitude — usage

```
AMPLITUDE_API_KEY=
AMPLITUDE_SECRET_KEY=
AMPLITUDE_REGION=us     # or `eu`
```

**These are NOT `VITE_AMPLITUDE_API_KEY`.** That one is public by design — Vite
inlines it into the browser bundle and it is a write key for ingestion. Reading
data back needs the project's API key *and* its **secret** key, which together
can read every event in the project. They have no `VITE_` prefix, are read only
by `server/integrations/amplitude.js`, and never appear in a response [proven].

Find them in Amplitude → **Settings → Projects → *your project* → General**.

Endpoints used:

- `GET /api/2/users?start=&end=&m=active&i=1`
- `GET /api/2/users?start=&end=&m=new&i=1`
- `GET /api/2/events/segmentation?e=&start=&end=&m=totals&i=1` — once per event
  in `server/analyticsEvents.js`

**Free-plan position.** The Starter plan is free for 10,000 monthly tracked users
and 2 million events [documented, 2026-09-02]. Amplitude's own documentation does
**not** state a plan floor for the Dashboard REST API, and community answers say
the endpoints are reachable "under any plan type" — that is somebody else's
sentence about somebody else's account, so this repository does not build on it
**[owner action]**. If the API refuses, the card reads *Not available on your
Amplitude plan* and offers the dashboard link. Nothing in WeVolunteer depends on
it answering.

**Query cost is a real budget.** Amplitude prices Dashboard API calls as
`(days) × (conditions) × (query type cost)` against an hourly allowance, with at
most 5 concurrent requests [documented]. Every request the Owner Center makes is
a single unsegmented, ungrouped 30-day series — the cheapest shape the API has.
Behind the five-minute cache, an owner refreshing all afternoon costs twelve
query sets an hour.

**The events it asks about** are the ones this application actually sends. The
list is `server/analyticsEvents.js`, imported by both the client that tracks them
and the server that queries them, so a typo cannot make a chart read zero. Every
event is a bare verb with no properties — see the privacy rule in that file.

### 4.3 Upstash and Pinecone

No new configuration. Both use the credentials the application already has, and
both cards render as *Not configured* when it does not — a supported, unalarming
state, since every caller of each has a local fallback.

The Redis card adds **one PING per minute at most**, cached. Upstash's free plan
allows 500,000 commands a month (see [`upstash.md`](upstash.md)); an owner leaving
the page open all day spends about 1,440 of them, under 0.3%. Uncached it would
be one command per render, which is the shape that turns a status page into a
load generator.

The Pinecone card calls `describe_index_stats`, a control-plane read that is not
billed in read units and does not touch the 500-reranks-a-month ceiling that is
the binding constraint on that account (see [`pinecone.md`](pinecone.md)).

### 4.4 One tuning knob

```
OWNER_PROVIDER_TIMEOUT_MS=6000
```

How long a third party has to answer before its card reads *Took too long to
answer*. Deliberately far above `redisConfig.js`'s 800 ms and for the opposite
reason: there, a caller has a correct answer available without Redis and waiting
is strictly worse than falling back; here there is no fallback except
"unavailable", and these are aggregation APIs that legitimately take a second.

## 5. What happens when something is not working

Every integration reduces every failure to one word at its own boundary
(`server/integrations/providerResult.js`). The page renders a sentence per word:

| State | The card says | What it means |
|---|---|---|
| `not_configured` | Not configured | Nothing is set up. Neutral, not red. |
| `unauthorized` | Credentials refused | The token was rejected — rotated or revoked. |
| `forbidden` | Not permitted | Valid token, insufficient scope. |
| `plan_restricted` | Not available on your plan | The account's plan does not include the query. |
| `not_found` | Nothing to read | The service answered; nothing is set up on it. |
| `rate_limited` | Rate limited | Asked to slow down. |
| `timeout` | Took too long to answer | No response inside the deadline. |
| `unavailable` | Unable to reach service | The request did not get through. |
| `bad_response` | Unexpected answer | A 200 we could not parse. |

**Nothing from the wire reaches the page.** No response body, no request URL, no
header, no upstream error text — a 401 body has been observed to echo back a
credential prefix, and a 500 body is arbitrary text from somebody else's server
that would otherwise land in the DOM [proven — several cases in
`server/integrations.test.js` and `server/routes.owner.test.js` feed exactly that
back and assert none of it survives].

**A failed refresh does not erase the last good answer.** If a provider fails and
a success from the last fifteen minutes is remembered, that value is served with
`stale: true` and the reason. `not_configured` is the one state that never falls
back — an operator who has just revoked a credential must not still see
live-looking figures [proven].

## 6. Cost control

- **No polling.** There is no timer. Data is fetched on open and on the refresh
  button, and nothing else [proven]. A dashboard left open in a tab overnight is
  how a free tier is spent by accident.
- **Cached per provider**: monitors and incidents 60s, Amplitude 5 min,
  infrastructure 60s.
- **Deduplicated.** Two simultaneous readers make one request. Deduplication is
  not an optimisation here — two in-flight requests to one endpoint is the shape
  that turns a rate limit into an outage.
- **Refresh bypasses the cache, never the deduplication.** Holding the button
  down produces one request per provider in flight, not one per press.

## 7. What it deliberately does not do

- **No writes to any vendor.** No acknowledging an incident, no resolving one, no
  creating or pausing a monitor, no editing a dashboard. Silently closing an
  incident nobody actually fixed is not a recoverable mistake on a platform whose
  incidents concern minors' data — the same reasoning `betterstack.md` §7 records
  for the MCP allowlist.
- **No Redis administration.** No `FLUSHDB`, no key browsing, no key deletion.
  The one destructive control anybody would actually want here — "clear the rate
  limits, I locked myself out" — would also clear every credential-stuffing
  counter on a service used by children.
- **No Pinecone reindex button.** Reindexing is `npm run pinecone:reindex`, an
  operator command with a terminal to print progress into. Behind a web button it
  is an expensive, long-running job one misclick away.
- **No fabricated figures and no decorative controls.** A number that could not be
  read renders *Unavailable*; an unread event draws no bar. Every button acts, and
  everything the API cannot do is an external link that says so.

## 8. What has actually been verified, and what has not

Recorded because "the integration is implemented" and "the integration has been
seen to work" are different claims, and this table is the difference.

| Integration | Credentials in this deployment | Verified against the live service |
|---|---|---|
| **Upstash** | present | **Yes**, 2026-09-02. `fetchRedis()` reached the real database: reachable, breaker closed, ~420 ms round trip. |
| **Pinecone** | present | **Yes**, 2026-09-02. `fetchVectorSearch()` read the real index (`wevolunteer-discover-v1`, namespace `development`, 6 records). |
| **Better Stack** | none set | **No.** No Better Stack variable is set in this deployment — the source token included — so telemetry is off and the Uptime API cannot be reached. The transforms are covered against documented response shapes in `server/integrations.test.js`. |
| **Amplitude** | ingestion only (`VITE_AMPLITUDE_API_KEY`) | **No.** The read pair is not set, so the Dashboard API cannot be reached. Ingestion is configured and unaffected. |

The two unverified rows are **[owner action]** and are the only outstanding
setup: §4.1 and §4.2 say exactly which credential to create and where. Neither
blocks anything — both cards render "Not configured" and name their variable.

The frontend's rendering of live data was verified separately by driving the
page with payloads in the exact shape the server produces: monitors with a
down entry, an open incident, user counts with week-on-week trends, the
sparkline, and the feature-usage bars. Failure and stale rendering was verified
the same way — see §5.

## 9. When a vendor changes something

The endpoint shapes, auth schemes and plan positions above were read on
**2026-09-02**. If a card starts reading *Unexpected answer* after a vendor
release, the shape changed: the parsing lives in
`server/integrations/betterstack.js` and `server/integrations/amplitude.js`, each
in one function, and `server/integrations.test.js` covers the shape it expects.
Update the module, the test, and the date on this section together.
