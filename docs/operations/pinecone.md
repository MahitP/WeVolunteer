# Pinecone: semantic Discover

Two separate things that share a vendor, and the distinction matters as much as
it does for Better Stack:

- **The search index** is how the *product* finds opportunities by meaning. The
  server talks to Pinecone's REST API directly. Optional, off by default, and
  never required to serve a request.
- **The Pinecone MCP** is how a *person* (or Claude Code) inspects the index. It
  is an operator tool. **The application does not use it and must not.**

### How to read this document

Same labelling as [`betterstack.md`](betterstack.md), because the same problem
applies — "the free tier allows this" and "the free tier probably allows this"
are not the same sentence:

| Label | Means |
|---|---|
| **[proven]** | A test in this repository asserts it, and it has been shown to fail when the behaviour is removed. |
| **[documented]** | Pinecone's own documentation says so, read on the date given. Not verified against a live account here. |
| **[inferred]** | A reasonable reading. Nobody has checked. |
| **[owner action]** | Needs a credential or a decision this repository does not have. |

**No live Pinecone account was available while this was built.** Every limit
below is `[documented]`, every behaviour is `[proven]` against a local stub that
speaks the same endpoints, and the first run against a real index is an
`[owner action]`. That distinction is maintained throughout rather than blurred.

---

## 1. The free tier is the architecture

Read from Pinecone's documentation on **2026-08-26** for the **Starter** plan
[documented]:

| Limit | Starter | Where it shows up in this design |
|---|---|---|
| Serverless indexes per project | 5 | Why environments share one index and separate by *namespace* |
| Index storage per org | 2 GB | Comfortable: ~50,000 events is a small fraction |
| Namespaces per serverless index | 100 | The abundant resource, so it carries the environment split |
| Read units / month / org | 1,000,000 | Why browsing never calls the vendor |
| Write units / month / org | 2,000,000 | Why unchanged events are never re-sent |
| Embedding tokens / month / model | 5,000,000 | **Why the content hash exists** |
| Rerank requests / month / model | **500** | **Why reranking is off by default** |
| Inference rate | 100/s, 2,000/min | Not a constraint at this scale |
| Filterable metadata / record | 40 KB | We use a few hundred bytes, deliberately |
| Record id length | 512 chars | `event:<uuid>` is ~44 |
| Upsert batch carrying text | 96 records | `UPSERT_BATCH_SIZE` is 90 |
| Region | **must be `us-east-1`** on Starter | Not configurable in practice |
| Projects / users per org | 1 / 2 | Worth knowing before inviting anyone |

Two of those did most of the shaping:

**500 reranks a month is about sixteen a day.** A reranker in the default search
path would exhaust the month in an afternoon of ordinary use by one class, and
then start returning 429s. So reranking here is opt-in, budgeted and counted.

**5,000,000 embedding tokens** is generous until something re-embeds the corpus
on every sync. That is what `event_search_index.content_hash` prevents, and it is
the single most important number in this integration.

---

## 2. Architecture

```
PostgreSQL / SQLite  ← authoritative, always
        │
        │  a write marks one row dirty, in the same transaction
        ▼
event_search_index   ← the outbox (migration 059)
        │
        │  a background worker drains it, off the request path
        ▼
     Pinecone        ← derived state, may be stale, may be wrong
        │
        │  a query returns CANDIDATE IDS and nothing else
        ▼
  the existing SQL query  ← every filter, every scope, every rule
        │
        ▼
   the Discover response
```

**Pinecone proposes; the database disposes.** No fact from Pinecone is ever
displayed. A candidate id is fed back through `buildEventWhere` alongside every
filter the caller sent, so an event that has been cancelled, filled, re-dated or
deleted since it was indexed is removed by the same predicates that have always
removed it [proven — the integration suite has the stub name a cancelled event, a
deleted event and an event outside the caller's category filter, and asserts none
of them reach the response].

### Why the read path is one OR

The entire read-path integration is a widened text predicate in
`server/eventQuery.js`:

```sql
((title/description/location/organizer LIKE …) OR e.id IN (@sem0, @sem1, …))
```

Everything else — the filters, the sort, `COUNT(*) OVER ()`, LIMIT/OFFSET, the
serialiser — is the code that ran before this existed. There is no second read
path to keep in step, and no way for a candidate to arrive with fewer checks
applied. It is an OR rather than a replacement because the substring match is not
the weaker half: somebody typing `Chess` wants the event called Chess Club.

### Why there is no sparse index

Pinecone offers sparse indexes (`pinecone-sparse-english-v0`) and hybrid
retrieval, and they were considered and **not used** — the lexical half of hybrid
search already exists here, in SQL, and it is better than a second index would
be:

- it matches exactly, on the authoritative data, with no indexing lag;
- it already respects every filter and scope, because it *is* the filter query;
- it costs no storage, no write units and no second query per search;
- and it leaves the 5-index Starter allowance free for version bumps.

Adding a sparse index would have duplicated a working component, doubled the
write cost of every event, and required re-implementing the filters as metadata.
So the hybrid here is **dense Pinecone + SQL lexical, fused in the query**, which
is hybrid retrieval done with the right tool for each half.

---

## 3. Setup

```bash
# 1. Create a Pinecone account and an API key at https://app.pinecone.io
# 2. Put the key in .env (development) or /etc/wevolunteer/wevolunteer.env
PINECONE_API_KEY=pcsk_...

# 3. Create the index (idempotent; safe to re-run)
npm run pinecone:setup

# 4. See what a first backfill would cost, without sending anything
npm run pinecone:backfill -- --dry-run

# 5. Index the existing events
npm run pinecone:backfill

# 6. Check
npm run pinecone:stats
npm run pinecone:reconcile
```

Every command prints the database it opened. **Check it** — `bin/resolveDb.mjs`
records the incident where privileged scripts silently operated on a stale
database and reported success. Indexing the wrong one would fill Pinecone with
the wrong corpus and spend the monthly embedding allowance doing it.

The application **never provisions anything at boot**. An app that creates
infrastructure on startup creates it from every environment holding a key,
including a laptop pointed at production.

---

## 4. The index

| | |
|---|---|
| Name | `wevolunteer-discover-v1` (`PINECONE_INDEX`) |
| Type | Serverless, integrated inference (`/indexes/create-for-model`) |
| Embedding model | `llama-text-embed-v2` |
| Metric | cosine |
| Region | `aws` / `us-east-1` (forced on Starter) |
| Namespace | `NODE_ENV` by default — `production`, `staging`, `development` |
| Text field | `text` (`field_map.text`) |

**Why `llama-text-embed-v2`** and not `multilingual-e5-large`: an event is a
title, a category, a few tags and a paragraph or two — the structured-document
profile the llama model is built for. The multilingual model is the better choice
for messy multilingual corpora, and WeVolunteer has no internationalisation layer
at all: every string in `src/` is English. **If that changes, changing the
constant is not enough** — different model, different vectors, so it means a new
index version.

**Why integrated inference** rather than embedding in the application: records
are upserted as text and Pinecone embeds them, including the asymmetry between a
stored passage and a query, which is easy to get subtly wrong by hand. This
application never holds a vector and cannot drift between what it embedded at
write time and what it embeds at read time.

### Versioning

The version is in the index NAME. Three things invalidate every vector — the
model, the text that gets embedded, and the dimensionality — and none can be
applied in place: the old vectors stay, they are simply wrong, and search still
returns results that are quietly worse. A version in the name makes that
impossible to do by accident: bumping it points at an index that does not exist,
which fails loudly at setup and is fixed by a backfill, while the old index keeps
serving until the new one is ready.

`DOCUMENT_VERSION` is the smaller sibling: same vectors, different text choices,
rolled out through the ordinary sync rather than a second index. Bumping it
invalidates every content hash, so the next drain re-sends the corpus.

---

## 5. What is sent, and what is not

**Pinecone receives event listing content and nothing else.** Every field is
already visible to every authenticated user: `GET /api/events` applies no
per-viewer visibility filter, because eligibility (`events.audience`, bans) is
enforced when somebody *applies*, not when they browse.

**Embedded** — title, category, tags, organization name, location, description
(truncated to 1,200 characters).

**Metadata** (filterable) — `status`, `category`, `audience`, `organizationId`,
`tags`, `startsAt`, `deadlineAt`, `documentVersion`. A few hundred bytes.

**Never sent** [proven]:

| | Why |
|---|---|
| The organizer's **name** | The one event field reliably naming a real person. Buys nothing: the SQL search already matches it exactly. |
| `instructions` | Meeting points, door codes, phone numbers. Shown only to accepted volunteers — the one long field that is *not* already public. |
| Any **user** data | No student, application, attendance, favourite or search history. No per-user vector. No user id. |
| Remaining **spots** | Changes on every application; would re-upsert an event dozens of times a day for a number SQL recomputes anyway. |
| `hours_closed_out_at` | A separate lifecycle from `status`, with no bearing on findability — and the field that must never be confused with `completed`. |

**Search queries are not logged to telemetry.** A search box on a school platform
is free text typed by a minor; the telemetry record carries duration, count and
outcome, never the query.

---

## 6. Synchronisation

| Event | What happens |
|---|---|
| Create | Row marked `pending` after commit → next drain upserts |
| Edit | Marked `pending` **inside the transaction** → next drain re-embeds if the hash changed |
| Status change | Marked `pending`; `cancelled` becomes a delete |
| Completion | Marked `pending` (status is indexed metadata) |
| Delete | **Removed immediately**, before the row goes — the bookkeeping row cascades away with it, so a queued deletion would have nothing left to find |

The worker drains every 15s (`PINECONE_SYNC_INTERVAL_MS`), one pass at a time,
and stops during shutdown. Nothing is lost by stopping mid-queue: the work is a
committed row, which is the entire reason the outbox is in the database.

### The content hash

`sha256(embedded text + metadata + document version)`. An event whose stored hash
matches is marked indexed and **not sent** [proven]. This is what makes the
backfill idempotent, makes `pinecone:reindex` affordable, and means an organizer
fixing a typo re-embeds one event rather than a district's corpus.

The test that proves it had to be written twice: the first version asserted that
a *second drain* sends nothing, which is only the queue doing its job — the hash
was never reached. A mutation test caught it. The current test marks the whole
corpus dirty (what `reindex` does) and asserts nothing is sent.

---

## 6b. Measured against the live service — 2026-08-28

Everything above was designed against Pinecone's documentation and tested
against a loopback stub. This section is what the real service actually did, on
a Starter account, index `wevolunteer-discover-v1`, 16 events.

| | |
|---|---|
| Index host | `…-sd4aq5c.svc.aped-4627-b74a.pinecone.io` |
| Dimension | **1024** (llama-text-embed-v2 default) |
| Ready on creation | yes; `setup` is idempotent — a second run reports "already exists" |
| Search latency, warm | **311–445 ms** (median 379) [proven] |
| Search latency, cold | **~3.2 s** on the first query after the index scales to zero [proven] |
| Backfill | 16 events, 16 upserted, 0 failed; ~111 embedding tokens |
| Re-run of backfill | 0 upserted [proven] |
| Full reindex after `markAllDirty` | 0 upserted, all unchanged [proven] |

**The cold start is why `SEARCH_TIMEOUT_MS` stays at 1200 ms.** Warm queries
finish in well under half of it. The first query after an idle period does not,
and is abandoned in favour of the database search — which is the designed
behaviour, not a defect: a student should not wait three seconds for a page that
the substring search can answer in eleven milliseconds. The next query is warm.
Raising the timeout to catch the cold start would make every genuinely slow
request pay for it.

### The similarity floor, and the defect that produced it

A vector index returns the K **nearest** records. It has no concept of "nothing
matched" — ask it about gibberish and it returns the least dissimilar events it
holds. Because the read path is `(… LIKE @q OR e.id IN (candidates))`, those
candidates satisfied the predicate by themselves, so **a search for something the
corpus does not contain returned the entire corpus**.

The stub could not reveal this: a stub returns exactly the hits a test names. It
appeared on the first live nonsense query.

Measured top-1 scores that fixed it:

| Query kind | Top-1 score |
|---|---|
| Relevant (5 queries) | 0.2585 – 0.5057 |
| Nonsense / off-topic (5 queries) | 0.0124 – 0.1058 |

`MIN_SEMANTIC_SCORE` is **0.15**, in the gap, and is configurable via
`PINECONE_MIN_SCORE` because it is a measurement rather than a law — a different
corpus or embedding model moves it. Two regression tests pin it, and removing
the filter fails them.

## 7. Failure behaviour

| Failure | What a student sees |
|---|---|
| Not configured | Database search. The default. |
| Vendor down / 5xx | Database search [proven] |
| Vendor slow | Abandoned at 1.2s, database search [proven] |
| Malformed response | Database search [proven] |
| Upsert fails | Row stays queued, retried next drain, recovers by itself [proven] |
| Delete fails | Orphan reported by `reconcile` |

**Discover with no Pinecone is WeVolunteer as it shipped for a year.** Every
function in `server/search/` resolves; none throw.

---

## 8. Cost control

1. **Browsing never calls the vendor.** An empty query is a filter, not a
   question — and it is the page's most common state [proven].
2. **Short, quoted and sigil queries stay on SQL.** "ch" is somebody two
   keystrokes into "chess" [proven].
3. **Unchanged content is never re-embedded** (the hash) [proven].
4. **Metadata filters narrow the candidates** so top-K is not spent on the years
   of completed history a district accumulates.
5. **Reranking is off by default**, needs ≥4 words and ≥10 candidates, and stops
   at a monthly budget [proven].
6. **`top_k` is 60**, not 500. Every candidate is an id the database then has to
   hydrate.
7. **One request in flight** during sync; batches of 90.

`npm run pinecone:stats` reports what this process has actually spent, taken from
the `usage` block Pinecone returns on each response (`read_units`,
`embed_total_tokens`, `rerank_units`) rather than estimated from request counts —
a read unit measures data scanned, not calls made. The authoritative monthly
figure is in the Pinecone console; this is for spotting a runaway first.

---

## 9. Recommendations

`GET /api/events?recommended=true` — a **mode of the list endpoint**, not a
second one, so a suggestion is an ordinary listing in a different order and
cannot show anything a browse would not [proven].

It always answers in the envelope shape (`{ events, recommendation, pagination,
… }`), even without a `limit`. The bare-array response kept for pre-pagination
callers has nowhere to put the explanation, and a recommendation without its
"because you saved …" is just a list [proven].

Signals: favourites, applications, attendance. All of them already exist because
the product needs them; **no view, click or search is tracked for this**.

The taste profile is built *here*, from this database, and what crosses the
network is a paragraph of event text — words already in the index. **No user
identifier and no user history is ever sent to Pinecone.** There is no per-user
vector, which on a platform whose users are mostly minors is a deliberate refusal
rather than an oversight.

**Cold start** — a student with no history gets soonest-first open opportunities
with places left, explained as "popular right now", and **no vendor call is made
at all**. It deliberately does not guess from school or year group: that is a
stereotype dressed as personalisation.

Recommendations are always forced to `scope=listable` + `openOnly` — a suggestion
is an invitation to act. That is forced rather than defaulted, because
`parseEventFilters` defaults `scope` to `all` (the dashboards need history), and
inheriting that default meant a cold-start suggestion could offer an event
cancelled last spring. Found by a test, not by reading.

---

## 10. Welly

Welly's `search_opportunities` already calls `GET /api/events?q=`, so it inherited
semantic search with **no changes and no second vector implementation**. The only
edit was its sort: a question typed at an assistant is natural language almost by
definition, so it now asks for `relevance` — which degrades to `soonest` when
there are no candidates, and is therefore never worse than what it replaced.

---

## 11. The MCP server — development only

**Production**

```
WeVolunteer server → Pinecone REST API
```

**Developer tooling**

```
Claude Code → Pinecone MCP → Pinecone
```

They are not the same thing and must not become the same thing. The application
does not import, call or depend on the MCP.

The Pinecone MCP ships as an official Claude Code **plugin** (a local stdio
server), so it is already available and is **not** added to this repository's
`.mcp.json` — a project-scoped duplicate would mean two Pinecone servers with the
same tools and two places to get the configuration wrong. It authenticates with
`PINECONE_API_KEY` from the environment.

**Its tool surface includes writes** — `upsert-records`, `create-index-for-model`
— and, being a stdio plugin rather than an HTTP server, it takes **no
tools-allowlist header**, so the `X-MCP-Tools-Only` mitigation used for Better
Stack has no equivalent here [inferred from the plugin being a local binary].
The practical mitigations:

1. Give it a key for a **non-production project** where possible [owner action].
2. Remember that `upsert-records` through the MCP writes records this
   application's bookkeeping does not know about — they will show up in
   `reconcile` as orphans.
3. Never use it to "fix" data. The database is authoritative; the repair for a
   bad index is `npm run pinecone:reindex`.

---

## 12. Operations

```bash
npm run pinecone:stats                        # counts, and this process's usage
npm run pinecone:backfill                     # index what is not indexed
npm run pinecone:backfill -- --dry-run        # what it would cost, sends nothing
npm run pinecone:reindex                      # re-send everything (after a bump)
npm run pinecone:reconcile                    # report drift
npm run pinecone:reconcile -- --remove-orphans
```

### Troubleshooting

**"This database has no event_search_index table."** Migration 059 has not run
against that database. Boot the server once, or check the path printed above the
message is the one you meant.

The pilot database was at migration **56** when this was first run live, so it
predates 057, 058 and 059 and cannot be indexed until it is migrated. 057 is a
destructive `events` rebuild with six guards; migrating a live database holding
real records is an operator decision with its own runbook, not something the
indexing tooling should do on its way past.

**A relative `WEV_DB_PATH` and the wrong database.** `.env` here says
`../pilot.db`, which is relative to `server/`. The `pinecone:*` npm scripts run
from the repository root, where the same string means one level ABOVE the
repository — and inside a git worktree it means `.claude/worktrees/pilot.db`.
`node:sqlite` creates a database that is not there, so the first live `setup`
silently created an empty one and would have reported a perfectly successful
backfill of zero events. `bin/pinecone-index.mjs` now resolves a relative value
against `server/`, the same rule `bin/resolveDb.mjs` uses, and prints the
absolute path it settled on. Check that line on every run.

**Search results are stale.** `npm run pinecone:reconcile`. If `missing` is
non-zero, `npm run pinecone:backfill`.

**`reconcile` reports orphans.** Check `PINECONE_NAMESPACE` first. A namespace
mismatch looks exactly like a namespace full of orphans, and
`--remove-orphans` on the wrong namespace deletes a working index.

**Nothing is being indexed.** `npm run pinecone:stats` — if `pending` is climbing
and `failed` is zero, the worker is not running (Pinecone disabled, or the
process was started without the key). If `failed` is climbing, the vendor is
refusing; the reason is in `event_search_index.last_error`.

**The monthly allowance is disappearing.** Almost always a re-embedding loop.
Check that `unchanged` is non-zero in a backfill: if every run reports everything
as `upserted`, the content hash is not matching and the cause is a field that
changes on every read.

---

## 13. Tests

Nothing in the normal suite requires a Pinecone account. `resolvePineconeConfig`
refuses to run from a test process unless `WEV_PINECONE_TEST_SINK=1` is set —
the same gate `telemetrySink.js` uses, for the same reason: a suite that talks to
a real vendor spends somebody's quota and writes fixtures into a production
index.

The integration suite points `PINECONE_INDEX_HOST` at a **loopback HTTP server**
that speaks the real endpoints, so the actual request path is exercised — the
ndjson body, the header names, the timeout, the response parsing — rather than a
mocked `fetch`.

| File | Covers |
|---|---|
| `search.eventDocument.test.js` | ids, embedded text, metadata, hash, the privacy omissions |
| `search.discoverSearch.test.js` | when to call the vendor, filters, fusion, the rerank budget |
| `search.eventQuery.test.js` | how candidates enter the SQL, the relevance sort, fail-closed |
| `search.integration.test.js` | create/update/delete/status, backfill, reconcile, outage, authorization, recommendations |
| `search.discoverSearch.test.js` (telemetry block) | that a student's search text never reaches the telemetry vendor |
| `BrowseEvents.relevanceSort.test.jsx` | the one control this adds, and its accessibility |
