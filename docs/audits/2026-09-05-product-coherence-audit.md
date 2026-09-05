# WeVolunteer — Product, Architecture and Coherence Audit

**Date:** 2026-09-05
**Scope:** the whole product, across all four non-`main` branches
**Audit target:** `origin/main` (see §2 — the checked-out `main` was not the application)

---

## 1. Executive summary

WeVolunteer is a **mature, unusually well-engineered product**, and the honest
headline of this audit is that most of what a coherence review normally finds
has already been found and fixed here — by this team, deliberately, with the
reasoning written down beside the code. `/events` → `/discover` carries its
query string so `?event=` deep links keep working. `/events/:id/edit` used to
render a blank form that *published a second event*, and is now a redirect.
`isPublicPath` is derived from the route table because a hardcoded second copy
once made every new public route unreachable. `internalLinks.test.js` exists
because two consent links 404'd inside a consent flow. The codebase does not
merely work; it argues.

That raises the bar for what counts as a finding, and it changes where the real
problems are. They are not in the features. **They are in the seams between a
finished feature and the rest of the product, and specifically in the places
where an existing guard was scoped to one half of the codebase.**

### The biggest problem found

**Three finished features ended in a 404, and the same blind spot hid all
three.** `internalLinks.test.js` — the guard that exists precisely to catch a
link pointing at no route — scans `src/` for `href=`/`to=` attributes. Every
destination the *server* hands a person is written differently: a `link:` field
on notification content, or a `${APP_URL}/…` template literal in `email.js`. So
the two surfaces through which the product mails and notifies people were
outside the only guard that checks destinations exist.

The most serious consequence: **every administrator invitation this platform has
ever sent ended on "Page not found."** `/accept-invitation` was declared in none
of the three route tables. Everything either side of that screen was finished —
hashed single-use tokens, a seven-day expiry, address and verification checks,
promotion and audit in one transaction, and every failure collapsed to one
answer so the endpoint cannot be used to probe for a live invitation. Only the
page in the middle did not exist. The only way to become an administrator was a
hand-written HTTP request.

Fixed, with a guard that now covers server-emitted destinations. §12.

### The second theme: reachable ≠ discoverable

A cluster of complete, capability-gated, audited server features have **no user
interface at all**. Badge administration is the clearest case: four endpoints —
define, list, award by hand, revoke — validated, transactional, audited, and
unreachable except by `curl`. The revoke endpoint's own comment says it exists
because attendance can be un-marked while the badge earned on those hours stays
on the profile; that correction path is real, built, and cannot be performed.
§3, findings 4–7.

### Overall readiness

The **student and organizer experiences are genuinely good** and would ship as a
commercial product. The dashboards answer "what do I do next", explain
automation in plain language ("Signing up doesn't earn hours…"), warn before
irreversible acts, and offer withdrawal. The **administrator experience is the
weak half**: its onboarding was broken end to end, its hub omitted one of its
own areas, and several of its powers have no screen. The **partner role is
unfinished and honest about it** — but the product still offers it as a persona
the owner can preview, described as a "read-only participation view" that does
not exist.

---

## 2. Branch analysis

### The finding that reframes everything: the checked-out branch was not the application

Local `main` was at `c170a26`, **2 commits behind `origin/main` and 3 ahead**.
Those two upstream commits were merged PRs #7 and #8 — roughly **29,500 lines**
covering the entire organization membership experience (share links,
invitations, join requests, membership policy, public club pages) and the legal
re-consent notice system. Local `main`'s three "ahead" commits were already
contained in `origin/main`'s tree via PR #8's squash.

An audit run against the checked-out branch would have been an audit of an
application nobody has. **`origin/main` is the canonical trunk.** `main` was
merged to it as the first act of this audit; the resulting tree is
byte-identical to `origin/main`, so nothing was lost in either direction. Two
conflicts, both mechanical.

### The four branches

| Branch | vs `origin/main` | Files | State | Verdict |
|---|---|---|---|---|
| `mahit/wevolunteer-legal-notifications-banner-aa4769` | 5 commits, **0 tree difference** | 46 | **Merged** — tree identical to `origin/main` | **Historical.** Landed as PR #8. Keep as a reference; nothing to recover. |
| `claude/owner-center-certificate-upgrade-7eef59` | 11 commits | 77 | Unmerged, coherent, appears complete | **Highest-value merge candidate.** |
| `claude/wevolunteer-production-architecture-89e97f` | 12 commits | 43 | Unmerged, coherent | **Merge for the safety guards alone.** |
| `claude/wevolunteer-perf-scaling-ad3613` | 47 commits | 101 | Unmerged, largest, most conflict-prone | **Merge last, deliberately.** |

All three unmerged branches forked from `fe0dae6`, **before** PR #7 and #8
landed. None has seen the 29,500-line organization change.

### Branch difference map

Only rows where the branches actually differ are listed. Fabricating a
difference would be worse than omitting one.

| Area | `origin/main` | owner-center | production-arch | perf-scaling | Recommended final state |
|---|---|---|---|---|---|
| Certificates | Modal (`CertificateModal`) | **Page** at `/certificates/:code`, share dialog, **server-side PDF** (`certificatePdf.js`, `pdfWriter.js`) | — | — | Take owner-center's. A certificate is a document; a dialog cannot be linked, printed cleanly, or bookmarked. |
| Owner/ops console | none (`GET /api/admin/system/status` has **no UI**) | **`/owner` Owner Center**, `owner.console` SUPER_ONLY, + hub tile | — | — | Take owner-center's. It fills a gap that exists on trunk today. |
| Vendor integrations | — | Real Better Stack, Amplitude, Upstash, Pinecone adapters + provider cache | — | — | Take. Verified against live accounts per its commits. |
| Production DB safety | — | — | **`productionDatabaseGuard.js`** — refuses a dev/preview process pointed at the production database; **`schemaSourceGuard.js`** | — | **Take urgently.** See finding 1 — this repo's own test suite currently connects to production. |
| CSRF | `sameSite: lax` only | — | **`csrfGuard.js`** — closes sibling-subdomain CSRF before the domain split | — | Take before any domain split. |
| Backup / restore | `bin/backup.sh` (SQLite `.backup`) | — | **PostgreSQL backup + *proven* restore**, off-host upload (R2) | — | Take. Trunk's backup does not apply on PostgreSQL. |
| Health checks | single `/health` | — | **liveness split from readiness** | — | Take. |
| Secret scanning | pre-commit | — | **built-bundle scanner**, with a test proving the scanner works | — | Take. |
| Query performance | baseline | — | — | **~20 commits**: events pagination, notifications broadcast, certificates, appeals, admin dashboard, applications | Take, after re-measuring against the post-PR#8 schema. |
| Rate limiting | process-local (approximate) | — | — | **Distributed via Redis**, leader leases for 4 periodic sweeps | Take. Trunk's limiter is shared approximately (a known constraint). |
| Realtime | polling | — | — | **Socket.IO adapter seam**, dormant + tested | Take the seam; it is inert. |
| Load testing | — | — | — | **HTTP load test + measured numbers** | Take. |
| Organizations | **full experience (PR #7/#8)** | absent | absent | absent | Trunk's. This is the merge hazard: three branches predate it. |
| Legal re-consent | **notices + acceptance modal (PR #8)** | absent | absent | absent | Trunk's. |

### Merge conflicts, measured

Not estimated — computed with `git merge-tree` against `origin/main`:

- **owner-center:** conflicts in `CHANGELOG.md`, `a11y/harness/{fixtures,routes,walk}.mjs`, `server/redis.privacy.test.js`. Mechanical.
- **production-architecture:** conflicts in `CHANGELOG.md`, `a11y/harness/routes.mjs`. Nearly clean.
- **perf-scaling:** conflicts in `server/app.js`, `server/db/postgresSchema.js`, `server/migrations/index.js`, `server/services/notificationService.js`. **These are real semantic conflicts.** PR #8 added migrations 062–064 and rewrote `notificationService`; the perf branch changed both.

### Recommended branch strategy

1. **production-architecture first.** Nearly clean, and it contains the guard that stops a dev process reaching the production database — a hazard that is live today (finding 1).
2. **owner-center second.** Mechanical conflicts; delivers the certificate page, the Owner Center, and the integrations.
3. **perf-scaling last, and rebased rather than merged.** Its migration and `notificationService` conflicts need a human deciding intent, and its performance numbers were measured against the pre-PR#8 schema — migrations 062–064 added tables and indexes that change them. Re-measure before trusting the documented figures.

Do not delete or archive any branch. The perf branch's `docs/operations/postgres-scale-measurements.md` and the production branch's `docs/operations/oracle-zero-cost-deployment.md` are the only records of that work.

### Regressions found between branches

None. No branch removes a feature another branch has, and no fix appears to have
been lost in a merge. The three unmerged branches are **additive and disjoint**
from PR #7/#8 — which is why they still merge at all after 29,500 lines landed
on trunk.

---

## 3. Complete findings

Ordered by priority. Each is classified using the taxonomy requested.

---

### [CRITICAL] 1. The test suite and every privileged CLI connect to the production database

**Category:** Technical Inefficiency / Data Exposure · **User:** developer, operator · **Branch:** `origin/main` (environmental) · **Status: NOT FIXED — needs your decision**

**Current behavior.** This checkout's `.env` contains `DATABASE_ENGINE=postgres`
and a live Supabase `DATABASE_URL` with credentials. `npm test` fails 7 tests in
`server/tooling.privilegedDbPath.test.js`, all of the form "*fails closed on
`DATABASE_ENGINE=postgres` with no `DATABASE_URL`*". They fail because
`DATABASE_URL` **is** set, so the privileged scripts do not fail closed — they
connect. The failure output prints:

```
Database: <production-host>:5432/postgres (postgres, 64 migrations applied)
```

Verified identical on a clean tree (`git stash`), so this pre-dates this audit
and is not caused by any change here.

**Why this is a problem.** `bin/grant-ownership.mjs`, `bin/make-admin.mjs`,
`bin/suspend-account.mjs`, `bin/reset-2fa.mjs`, `bin/revoke-ownership.mjs`,
`bin/bootstrap-owners.mjs` and `bin/clear-stale-tfa-secret.mjs` all default to
this database. Every one mutates accounts. Running `npm test` on this machine
opens connections to the database holding **real minors' PII**. The tests are
correct; the environment is wrong. The only thing standing between a mistyped
CLI argument and a production account change is that the scripts happen to
prompt.

**What a professional application would do.** Keep production credentials out of
the development `.env` entirely, and make a dev/test process pointed at
production refuse to boot.

**Recommended change.** Two steps, in order:
1. Remove `DATABASE_URL` and `DATABASE_ENGINE=postgres` from `.env`. Put them in
   an operator-only file loaded explicitly (`--env-file=.env.production`) for the
   one command that needs them. `docs/operations/database-credential-rotation.md`
   already describes rotation; this is the same argument one step earlier.
2. **Merge `claude/wevolunteer-production-architecture-89e97f`**, whose
   `server/db/productionDatabaseGuard.js` refuses a preview or dev process
   pointed at the production database. That branch already solved this.

Because the credentials have been sitting in a file that `npm test` reads,
**treat them as exposed and rotate them.**

**Files:** `.env`, `server/tooling.privilegedDbPath.test.js`, `bin/*.mjs`,
`server/db/productionDatabaseGuard.js` (on the production-arch branch).
**Complexity:** low for step 1; step 2 is a branch merge.

---

### [CRITICAL] 2. Administrator onboarding dead-ended at "Page not found" — FIXED

**Category:** Broken Feature / Incomplete Workflow · **User:** admin, owner · **Branch:** `origin/main` · **Status: FIXED and verified**

**Current behavior (before).** `sendAdminInvitationEmail`
(`server/email.js:725`) links to `${APP_URL}/accept-invitation?token=…`.
`/accept-invitation` was declared in **none** of `APP_ROUTES`,
`SIGNED_OUT_ROUTES` or `PUBLIC_ROUTES`, and was absent from
`server/clientRoutes.js`. Git history confirms it **never existed** — the only
occurrences of the string in `src/` are an analytics *redaction test fixture*,
which is to say the repository contains a test proving it scrubs tokens from a
link that leads to a 404.

Everything else in the chain was complete and tested: `PendingInvitations.jsx`
creates/lists/revokes; the token is `sha256`-hashed and never shown to its
creator; seven-day expiry; single-use; address must match and be verified; every
failure answers identically; promotion and audit in one transaction.

**Why this is a problem.** The feature's entire purpose is to hand somebody
authority over a platform used by children, and it could not be completed
through the product at all. Two further links compounded it — see finding 3.

**Recommended change / what was done.** Built `/accept-invitation` in
`PUBLIC_ROUTES`. Design decisions and their reasons:
- **Acceptance is a button, not an effect on mount.** The token is single-use;
  a mail prefetcher or corporate URL scanner must not burn it. The email itself
  promises "nothing happens unless you accept".
- **Nothing is shown about the invitation.** There is no preview endpoint,
  deliberately — one would answer "a live invitation exists for this token" to
  anybody guessing.
- **No `?returnTo=`.** `utils/pendingInvite.js` argues against introducing a
  general redirect primitive; a signed-out reader is told to sign in and re-open
  the emailed link, which is what the email already instructs.
- **Signed out on success**, because the endpoint bumps `token_version` by
  design — with the reason stated on screen, so a deliberate re-authentication
  does not read as the account breaking seconds after promotion.

**Verified in a running instance** against a scratch demo database: refused from
the wrong address *without consuming the token*; accepted from the right one;
role change, invitation consumption and the `ADMIN_INVITE_ACCEPTED` audit row
all landed. Passed the `security-review` gate (ENGINEERING_GUIDE §3.2) with no
findings.

**Files:** `src/views/AcceptInvitation.jsx` (new), `src/routes/index.jsx`,
`src/utils/api.js`, `server/clientRoutes.js`. **Complexity:** medium.

---

### [HIGH] 3. Two more links pointed at `/admin`, which is not a route — FIXED

**Category:** Broken Feature · **User:** admin, operator · **Status: FIXED**

**Current behavior (before).** The administrative pages are
`/admin/moderation`, `/admin/appeals`, `/admin/roster`, `/admin/audit-logs`,
`/admin/legal`, `/admin/impact`. The bare `/admin` prefix has never been
declared. Two things linked to it:

1. `ADMIN_PROMOTED` (`server/services/notificationContent.js:1134`) — **the
   notification a person receives at the moment they become an administrator.**
   The first thing a new administrator pressed was "Page not found".
2. `server/alerting.js:286` — the *"Backups are not running"* email, which fires
   when the database holding every student's service record has no copy
   anywhere. The one link in it was dead.

**Recommended change / what was done.** Both point at `/admin/moderation`, the
hub that indexes every administrative area — the right landing place for "you
now have access to these", because it explains what the new role reaches rather
than dropping somebody into one arbitrary corner of it.

---

### [HIGH] 4. Badge administration has no user interface at all

**Category:** Disconnected Feature · **User:** admin · **Status: NOT FIXED — recommended**

**Current behavior.** Four complete endpoints in `server/routes/badgeRoutes.js`,
all gated on `event.moderate`, all with validation, transactions and audit rows:

| Endpoint | What it does | UI |
|---|---|---|
| `GET /api/admin/badges` | list including inactive | **none** |
| `POST /api/admin/badges` | create/update a definition | **none** |
| `POST /api/admin/badges/award` | award by hand | **none** |
| `DELETE /api/admin/users/:userId/badges/:badgeId` | revoke | **none** |

`GET /api/badges` (the catalogue) is also uncalled — `BadgesPage` reads
`/api/users/:id/badges` instead.

**Why this is a problem.** Badges are user-visible on every profile, have a
dedicated `/profile/badges` page, and a `badgeOrder` utility. Nobody can define
one, award one, or take one back through the product. The revoke endpoint's own
comment states the case: attendance can be un-marked — `finalizeAttendance`
revokes hours — and *the badge earned on those hours stays on the profile that
also shows the corrected record.* There is a real correction path, it is built,
and it is unreachable. The same comment notes there is no way to undo a manual
award made to the wrong student.

The code is written as if a UI exists. `POST /api/admin/badges` returns
`{ error, field: 'criteria_type' }` — a field-level error shape whose only
consumer would be a form.

**What a professional application would do.** Any platform with achievements has
an admin console for them, because the failure modes (a badge nobody can earn, a
badge on the wrong record) are visible to end users and unfixable without one.

**Recommended change.** A **Badges** tile on the Admin hub → `/admin/badges`,
with: the definition list (including inactive), a create/edit form driven by
`BADGE_CRITERIA_TYPES` from `badgeService` (do not restate the vocabulary), a
manual award control, and revoke with a reason. The `field` in the 400 response
is what a form should focus. Roughly the size of `AdminRoster`.

**Files:** `server/routes/badgeRoutes.js`, `server/services/badgeService.js`,
`src/views/ModerationCenter.jsx` (tile), new `src/views/AdminBadges.jsx`.
**Complexity:** medium. **Dependencies:** none — the API is finished.

---

### [HIGH] 5. Message search is implemented, bug-fixed, and cannot be invoked

**Category:** Disconnected Feature · **User:** student, organizer · **Status: NOT FIXED — recommended**

**Current behavior.** `GET /api/messages/search`
(`server/routes/messageRoutes.js:456`) searches **message bodies** across the
caller's conversations, scoped by `conversation_participants`, case-insensitive
across both engines, limit 50. Nothing calls it.

What the UI has instead is a **client-side filter over already-loaded
conversation metadata** (`ConversationList.jsx:22-41`, placeholder "Search
conversations…"). So a student can filter thread names and cannot search what
was actually said.

**Why this is a problem.** The endpoint carries a fixed bug whose comment reads:
*"a member could search their messages, match nothing from a friend, and
reasonably conclude the search was broken rather than that it had never
looked."* Someone changed an inner join to a left join to fix a search nobody
can perform. Meanwhile the search box that *does* exist silently answers a
narrower question than users will assume — type a remembered phrase and get
nothing.

**Recommended change.** Wire the existing box to the endpoint above a debounce,
and label the two result groups distinctly ("Conversations" / "Messages"). The
response already returns `{ message, event_id, event_title, sender_name }`,
which is enough to render a result row that navigates to the thread. Do not add
a second search surface.

**Files:** `src/components/messages/ConversationList.jsx`, `src/views/Messages.jsx`,
`src/utils/api.js`. **Complexity:** low–medium.

---

### [MEDIUM] 6. A student-roster CSV export with no UI, behind a moderation capability

**Category:** Disconnected Feature + permission-boundary concern · **User:** admin · **Status: NOT FIXED — needs your decision**

**Current behavior.** `GET /api/admin/reports/export`
(`server/routes/adminRoutes.js:962`) returns a CSV of **every active student**:
id, name, **email**, school, join date, credited hours. It is gated on
`report.resolve` and has no UI.

**Why this is a problem.** Two separate things:
1. **No UI** — an export built for administrators that no administrator can run.
2. **The capability does not match the data.** `report.resolve` is the
   *moderation* capability — "resolve the reports people file". It now also
   grants a bulk download of every student's email address. The path name says
   `reports/export` and the payload is the student roster, so the mismatch is
   baked into the name. Note the contrast: `audit.read` was deliberately made
   SUPER_ONLY and ungrantable on the reasoning that a trail of what
   administrators do is not for administrators to read about each other. A bulk
   PII export deserves at least that much thought.

**Recommended change.** Decide the intended audience first, then either (a) move
it behind a capability that means "export the roster" and surface it on
`/admin/roster` where the roster already lives, or (b) delete it. Do not surface
it under `report.resolve` as-is.

**This is a security-relevant capability change**, so per ENGINEERING_GUIDE §3.2
it needs the `security-review` skill — which is why this audit reports it rather
than changing it.

---

### [MEDIUM] 7. `GET /api/admin/system/status` has no UI on trunk

**Category:** Disconnected Feature · **User:** owner · **Status: NOT FIXED — fixed by a branch**

Returns SMTP configuration, live mail health, provider delivery outcomes,
notification queue depth and backup status, gated on `analytics.school`. No
screen reads it. **`claude/owner-center-certificate-upgrade-7eef59` builds
exactly this screen** (`/owner`, with a hub tile). Recommendation: merge that
branch rather than build a second one.

---

### [MEDIUM] 8. The Admin hub omitted one of its own administrative areas — FIXED

**Category:** Information Architecture · **User:** owner · **Status: FIXED and verified**

**Current behavior (before).** `ModerationCenter`'s heading claims to list *"the
administrative areas this account can open"*, and listed eight. `/admin/legal` —
the Legal Center editor, where the documents everyone on the platform is held to
are written and published — was not among them. The only way in was **Settings →
Help → "Edit Legal Center"**, beside About Us.

**Why this is a problem, and why no test saw it.** When six pages came off the
navigation rail they were all moved onto the hub, and `App.navGroups.test.jsx`
asserts each of the six is still offered there. But it reads a hand-maintained
list of the pages that *moved* — and `/admin/legal` never moved, because it was
never on the rail. The route's own comment says the `/admin/` prefix "puts it
where the other owner-only pages already are"; that was true of the path and
false of the product.

**What was done.** A Legal Center tile on the hub, and a guard **derived from
`APP_ROUTES`** rather than from history: any route under `/admin/` must be
indexed by the hub or explicitly excused with a reason. The Settings entry
stays — two doors into one room is normal; no door from the room that indexes
every other room is not.

**Verified in the running app:** the owner sees 9 tiles including Legal Center;
an ordinary administrator sees 4 and no Legal Center (`legal.edit` is SUPER_ONLY
and ungrantable).

---

### [MEDIUM] 9. The location prompt appears on pages where location means nothing

**Category:** UX Friction / Misplaced Feature · **User:** all · **Status: NOT FIXED — recommended**

**Current behavior.** `AppNotices` mounts `LocationPrompt` at the shell level, so
*"See how far away opportunities are — Share your location to sort by distance
and filter to what is nearby"* renders above **every** page. Observed live on
the Admin hub, where it is the largest element above the fold, and it appears on
Messages, Settings and Notifications too.

**Why this is a problem.** On those pages, accepting the offer changes nothing
visible. An offer that recurs (it is remembered per tab, not for ever) on pages
where it cannot pay off trains people to dismiss the notice slot — which is the
same slot that carries **legal change notices**. `AppNotices`'s own priority
ladder is careful about exactly this ("the shape that makes the notice slot feel
like a place things pile up").

**Recommended change.** Gate the location tier on whether the current route
actually consumes location — Discover, Calendar, and the dashboards that show a
next shift with travel time. Keep it in `AppNotices` and keep the ladder; add a
route condition to the lowest tier only. `AppNotices` already owns the decision,
so this is one predicate, not a restructure.

**Files:** `src/components/notifications/AppNotices.jsx`,
`src/contexts/LocationContext.jsx`. **Complexity:** low.

---

### [MEDIUM] 10. The partner role has no coherent experience, but is offered as a persona

**Category:** Incomplete Workflow · **User:** partner · **Status: NOT FIXED — needs your decision**

**Current behavior.** `partner` holds `['analytics.public', 'event.view',
'geocode.use', 'persona.preview.exit']`. Consequences:
- No `DASHBOARD_NAV` entry, so **no Dashboard rail item**.
- `PAGE_META.partner.dashboard` reads *"Partner accounts do not have a dashboard
  yet"* — the page a partner lands on after signing in.
- Rail reduces to **Discover**, plus Profile in the account menu. No
  Notifications (`self.read`), Messages, Calendar or Welly.
- `authz.js` states plainly that `analytics.public` "stays registered and still
  reads nothing… that surface has not been designed."

Meanwhile the Admin hub's persona preview offers the owner **"Partner —
read-only participation view"**, which describes a surface that does not exist.

**Why this is a problem.** The codebase is honest in its comments and the product
is not. An owner previewing as partner is shown a dead end labelled as a feature.

**Recommended change.** Pick one and commit:
- **(a) Finish it** — build the `analytics.public` figures page and give partner
  a dashboard. Justified only if real partner organizations are in the pilot.
- **(b) Shelve it honestly** — remove Partner from the persona-preview list and
  say in the role's own copy that partner accounts are not yet enabled. Keeps
  every capability and role definition intact; costs one array entry.

**Recommendation: (b)**, unless a partner organization is already onboarding.
Offering a preview of an undesigned surface is worse than not offering the
preview.

---

### [LOW] 11. "Organizations" means two different things 40px apart on Discover

**Category:** Consistency Problem · **User:** student · **Status: NOT FIXED — recommended**

**Current behavior.** Discover has a top-right button labelled
**"Organizations"** → `/organizations` (*the clubs you belong to*), and directly
beneath it a scope tab row `Everything · Opportunities · People ·
**Organizations**` (*filter these search results to clubs*). Same word, two
destinations, adjacent.

**Why this matters here specifically.** This is the exact fault the team already
fixed once: the rail label was changed from "Opportunities" to "Discover"
because "Opportunities" was "simultaneously the name of the whole destination
and of one of the four scope tabs inside it." The reasoning was applied to one
label and not to the other instance of it on the same page.

**Recommended change.** Rename the button to what it opens — **"My clubs"** (or
"Your organizations"), matching `OrganizationsHome`'s subject. Leave the scope
tab alone; "Organizations" is correct for a filter over search results.

**Files:** `src/views/BrowseEvents.jsx`. **Complexity:** trivial.

---

### [LOW] 12. One act, two names: "Release" and "Can't make it"

**Category:** Consistency Problem · **User:** student · **Status: NOT FIXED — recommended**

Giving up a confirmed shift is **"Release"** in the event modal's shift list and
**"Can't make it"** on the student dashboard. Same action, same endpoint
(`application.withdraw`). "Can't make it" is the better label — it is what the
student is thinking, and "Release" reads as jargon borrowed from the seat model.
Unify on "Can't make it".

**Files:** `src/components/EventShiftsTab.jsx`, `src/views/VolunteerDashboard.jsx`.

---

### [LOW] 13. Two dead provider buttons on every sign-in

**Category:** UX Friction · **User:** first-time user · **Status: NOT FIXED — your call**

The login screen renders **"Microsoft — not set up on this site"** and **"Apple
— coming soon"** as disabled buttons above the working options. The first is
developer-facing phrasing in the product's most-viewed screen; the second
promises a date that does not exist. A first-time user counts four sign-in
options and finds two are decoration.

**Recommended change.** Render only configured providers. If the intent is to
signal a roadmap, one line of text below the working options costs less
attention than two disabled buttons above them.

**Files:** `src/components/auth/ProviderButtons.jsx`.

---

### [LOW] 14. `GET /api/issues/categories` is dead code

**Category:** Redundancy · **Status: NOT FIXED — recommended deletion**

The endpoint exists so "the form cannot drift from what the server accepts". The
form does not call it: `src/issueReports.js` re-exports `ISSUE_CATEGORIES`
directly from `server/issueReports.js`, which is a *stronger* guarantee —
compile-time rather than runtime. The endpoint is a solved problem's leftover.
Delete it, or record why it is kept.

---

### Also verified and **not** findings

Worth recording, because each looked like a defect and is not:

- **`error.raed`** in `server/authz.js` — a *deliberate* typo, asserted by three
  tests and documented in `docs/legal/09-ROADMAP.md` as an intentional guard
  proving `can()` refuses unknown capabilities even for the wildcard role.
- **"Recruit" vs "Discover"** — the organizer's page heading differs from the
  rail label. Deliberate and documented in `PAGE_META`: a persona title naming
  what an organizer comes to *do*. Not an oversight.
- **`/__errors`** — DEV-only error gallery, already exempted in
  `internalLinks.test.js` with its reason.
- **`?verify=`, `?reset=`, `?emailchange=`, `?event=`** root query links from
  email — all four are handled (`SessionProvider.jsx`, `App.jsx`). Only
  `/accept-invitation` and `/admin` were broken.
- **`event:<id>` notification links** — a custom scheme resolved client-side by
  `Notifications`, `NotificationsBell` and `utils/notifications.js`. Works.
- **The demo login shortcuts' unnamed buttons** — they do carry text; the
  accessibility tree simply nests it.

---

## 4. Navigation audit

### Current

**Primary rail** (single table, capability-filtered — a good design):
`Dashboard · Discover · Calendar · Messages · Welly · Admin`
**Secondary:** `Notifications` (also the header bell), `Profile` (account menu only)
**Account menu:** Profile · Notifications · Settings · Sign Out
**Admin hub** (`/admin/moderation`): 9 tiles after this audit's fix.

### Problems

1. **`/admin/legal` was not on the hub.** Fixed.
2. **No administrative *badge* destination exists.** Finding 4.
3. **A student's own record is spread across five destinations**, none in the
   rail or the account menu: `/hours`, `/certificates`, `/portfolio`,
   `/profile/badges`, `/profile`. All are reachable from dashboard and profile
   buttons, and each has a documented reason to exist. But there is no single
   answer to "where is my volunteering record", and the account menu — the
   control every product uses for "things that are mine" — offers none of them.
4. **The location prompt occupies the notice slot everywhere.** Finding 9.

### Recommended

Two changes only. The rail is deliberately restrained and should stay that way.

- **Account menu:** insert **"My hours"** (`/hours`) above Settings. It is the
  student's own record, it is the most common non-task destination in the
  product, and the menu is where people look for it. Do **not** add it to the
  rail — the rail is for next-step navigation and the primary tier is
  intentionally capped.
- **Admin hub:** add **Badges** when finding 4 is built. The new derived guard
  will require it.

Everything else stays. The rail's six primary entries, the declared
primary/secondary split, and `accountOnly` on Profile are all well-reasoned and
should not be disturbed.

---

## 5. Feature map

| Feature | Current location | Ideal location | Branch | Retain? |
|---|---|---|---|---|
| Event discovery + people + clubs | `/discover` | unchanged | trunk | yes |
| Event creation | `/events/new`, button on Discover | unchanged | trunk | yes |
| Event management, applicants, attendance | `EventModal` tabs | unchanged | trunk | yes |
| Auto Select / Equalizer | organizer surfaces | unchanged | trunk | yes |
| Hours ledger + close-out | dashboard + `/hours` | unchanged | trunk | yes |
| Certificates | `/certificates` + **modal** | **`/certificates/:code` page** | owner-center | replace |
| Badges (student view) | `/profile/badges` | unchanged | trunk | yes |
| **Badges (administration)** | **API only** | **`/admin/badges` + hub tile** | none | **build** |
| Organizations, invites, join requests, share links | `/organizations/*` | unchanged | trunk (PR #7/#8) | yes |
| Messages | `/messages` | unchanged | trunk | yes |
| **Message body search** | **API only** | **the existing search box** | none | **connect** |
| Notifications | `/notifications` + bell | unchanged | trunk | yes |
| Legal Center (read) | `/legal`, `/legal/:slug` | unchanged | trunk | yes |
| Legal Center (edit) | `/admin/legal` — Settings only | **hub + Settings** | trunk | **fixed** |
| Legal re-consent notices | `AppNotices` | unchanged | trunk (PR #8) | yes |
| Welly | `/welly` | unchanged | trunk | yes |
| Moderation, appeals, audit, errors, impact | Admin hub | unchanged | trunk | yes |
| Admin roster + invitations | `/admin/roster` | unchanged | trunk | yes |
| **Admin invitation acceptance** | **nothing (404)** | **`/accept-invitation`** | none | **fixed** |
| **Platform/service health** | **API only** | **`/owner` Owner Center** | owner-center | **merge** |
| **Student roster CSV** | **API only** | `/admin/roster`, re-gated | none | decide |
| Partner participation view | does not exist | — | none | decide |

---

## 6. User journey audit

### Student — strong

`Signup → dashboard → Discover → event detail → select shifts → apply → notified
→ attend → organizer confirms → hours credited → history`

Friction found: **very little.** The dashboard leads with the next shift, states
hours against a goal, and explains the automation unprompted ("Signing up
doesn't earn hours. After a shift, the organizer marks who attended…"). The event
detail names the decision-maker ("Jordan Whitfield decides who gets each spot,
and you'll be notified either way"), shows per-shift state (Full / Select /
You're confirmed), and offers withdrawal. Empty states carry a next action.

Gaps: no single home for their own record (§4); cannot search message bodies
(finding 5); "Release"/"Can't make it" inconsistency (finding 12).

### Organizer — strong

`Login → dashboard → New event → applicants → select → attendance → close out`

The dashboard opens with **"Needs your decision — 1 application waiting"** and
**"Ready when you are — 1 finished event with hours not closed out"**, the
latter stating irreversibility before the click ("Closing them out makes them a
permanent part of each volunteer's record, which cannot be undone"). Events
table with Active/Completed tabs; volunteer list with a downloadable ledger.
"New event" is a button on Discover rather than a rail entry — a deliberate,
documented choice that puts it where an organizer already is.

Gaps: none material found.

### Administrator — the weak half

`Invitation email → 404` was the journey. After this audit:
`invitation → accept → signed out → sign in → 2FA enrolment wall → Admin hub → 9 areas`

The 2FA wall immediately after promotion is **correct** and explains itself.
Remaining gaps: no badge administration (4), no roster export UI (6), no service
health on trunk (7).

### Partner — a dead end

`Login → "Partner accounts do not have a dashboard yet"`, rail of one entry.
Finding 10.

---

## 7. Feature connection audit

**Orphaned server features (no UI):**
`GET/POST /api/admin/badges` · `POST /api/admin/badges/award` ·
`DELETE /api/admin/users/:userId/badges/:badgeId` · `GET /api/badges` ·
`GET /api/messages/search` · `GET /api/admin/reports/export` ·
`GET /api/admin/system/status` · `GET /api/issues/categories` (redundant)

**Destinations that did not exist:** `/accept-invitation` (emailed),
`/admin` (notification + alert email). **All fixed.**

**Routes with no rail entry but properly linked contextually:** `/hours`,
`/certificates`, `/portfolio`, `/organizations`, `/checkin/:eventId`,
`/report-issue`, `/appeals/new`, the two agreements, and every `/admin/*` page.
This is fine — a rail entry is not the only legitimate door.

**Not orphaned, despite appearances:** `/users/:handle*` and
`/organizations/invite/:token` are linked via template literals that a naive
scan misses.

---

## 8. Edge case audit

| Case | Handled? | Notes |
|---|---|---|
| Zero events / zero history | **Yes** | Empty states name a next action |
| Full shift | **Yes** | Per-shift "Full", capacity shown |
| Confirmed → withdraw | **Yes** | Two labels for it (finding 12) |
| Attendance un-marked, hours revoked | **Partly** | Hours return; the **badge earned on them stays**, and cannot be revoked through the product (finding 4) |
| Badge awarded to the wrong student | **No** | No UI to undo |
| Invitation: wrong address | **Yes** | Refused, token *not* consumed — verified live |
| Invitation: expired / reused / revoked | **Yes** | One identical answer, by design |
| Invitation: no session | **Yes** | Now explains what to do (was a 404) |
| Newly promoted admin | **Yes** | 2FA wall, self-explaining |
| Owner without 2FA | **Yes** | Hard wall |
| Suspended account on a public route | **Yes** | Page renders, server refuses (`SUSPENDED_ALLOWED`) |
| Legal document changed materially | **Yes** | Blocking acceptance modal, priority-ordered |
| Zero platform owners | **Yes** | Boot warning + `bin/grant-ownership.mjs` |
| Offline | **Yes** | `OfflineOverlay` covers the signed-out shell too |
| Deleted accounts in exports | **Yes** | Tombstones excluded |
| Partner signing in | **No** | Finding 10 |
| Dev process pointed at production DB | **No on trunk** | Finding 1; guard exists on a branch |

---

## 9. Consistency audit

**Inconsistent:**
- "Release" vs "Can't make it" — same act (finding 12).
- "Organizations" button vs "Organizations" tab — same word, two destinations (finding 11).
- Location prompt shown where location is inert (finding 9).
- Link-target guarding: `src/` was guarded, server-emitted links were not. **Fixed.**
- Hub indexing: pages that *moved* to the hub were guarded; pages *born* under
  `/admin/` were not. **Fixed.**

**Consistent and good:** capability naming across rail, route and server;
one notice slot with a declared priority ladder; `EmptyState` everywhere;
confirmation before irreversible acts; error copy that names a cause and a next
step; `ActionsMenu` for contextual actions; the derived-not-restated pattern
(`isPublicPath`, `navSectionsFor`, `SELF_PROFILE_CAPS`, `clientRoutes`).

---

## 10. Terminology map

| Concept | Canonical term | Notes |
|---|---|---|
| A posted volunteer slot | **Opportunity** (browsing) / **Event** (owning) | Deliberate split, documented at `/events/new`. Sound. |
| A time block within an event | **Shift** | Consistent |
| A person volunteering | **Volunteer** (organizer's view) / **Student** (platform's view) | Appropriate to audience |
| Requesting a spot | **Apply** / **Sign-up** | Both appear; acceptable |
| Giving up a spot | **Release** / **Can't make it** | **Inconsistent** — unify |
| Being chosen | **Selected** / **Confirmed** | "Confirmed" is the student-facing term |
| A club | **Organization** | "My clubs" recommended for the *possessive* case (finding 11) |
| Discovery surface | **Discover** | Organizer heading is "Recruit" — deliberate |
| Admin area | **Admin** | Unified from "Moderation Center" |

---

## 11. Professional-app comparison

**Already does well** — better than much of the category:

- **Automation is explained, not just performed.** Auto Select, Equalizer, hours
  crediting and close-out each carry plain-language copy where the user meets
  them. Most volunteer platforms leave selection feeling arbitrary.
- **Irreversibility is stated before the click**, not after.
- **Role-appropriate dashboards** that open with the next decision.
- **Recovery paths exist** — withdraw, appeals, close-out corrections, ban
  appeals with a promised reply window shown to the reviewer.
- **Privacy is designed in**, not bolted on: an allowlist profile serializer, no
  crawlable index of minors, error reports storing route *patterns*, a
  deliberate refusal to give partners `directory.read`.
- **Compatibility for shipped URLs** — redirects that carry query strings.

**Missing or handled poorly**, judged against what the use case actually needs
(not against feature checklists):

- **Administrator onboarding** was the worst gap in the product and is now fixed.
- **No admin console for achievements** — a platform that awards them needs one.
- **Message search** promises less than the backend delivers.
- **Service health** invisible on trunk (a branch fixes it).
- **One home for "my record"** — the thing a student most wants to show a
  counsellor is spread over five pages.

Deliberately **not** recommended, though comparable products have them: activity
feeds, gamified streaks, public leaderboards, in-app chat beyond messaging,
recurring-event templates. None is justified by a school volunteering programme's
use case, and each would enlarge a product whose current restraint is a strength.

---

## 12. Implementation summary

**Branch:** `main` (now synced to `origin/main`).
**Commits:** `bbdf4bc` (trunk merge), `5594d9d` (the fixes).

### What changed

| File | Change |
|---|---|
| `src/views/AcceptInvitation.jsx` | **new** — the administrator-invitation acceptance screen |
| `src/views/AcceptInvitation.test.jsx` | **new** — 10 tests |
| `src/routes/index.jsx` | declared `/accept-invitation` in `PUBLIC_ROUTES` |
| `src/utils/api.js` | `acceptAdminInvitation(token)` — token in the body, not the URL |
| `server/clientRoutes.js` | allowlisted the literal `/accept-invitation` |
| `server/services/notificationContent.js` | `ADMIN_PROMOTED` link `/admin` → `/admin/moderation` |
| `server/alerting.js` | backup-failure email link `/admin` → `/admin/moderation` |
| `server/serverLinks.test.js` | **new guard** — validates every notification `link:` and every `${APP_URL}` email link against the route table |
| `src/views/ModerationCenter.jsx` | Legal Center tile on the Admin hub |
| `src/App.navGroups.test.jsx` | **new guard** — every `/admin/*` route must be hub-indexed; Legal tile owner-only |
| `src/headingLevels.test.js`, `src/pageTitleCoverage.test.js` | standalone-route exemptions, with reasons |

### Both new guards were proven, not assumed

Each defect was reintroduced and the guard watched to fail:
- `link: '/admin'` restored → *"/admin — notification link at
  server/services/notificationContent.js:1154"*
- `/accept-invitation` removed from the allowlist → *"/accept-invitation —
  emailed URL at server/email.js:725"*
- Legal tile removed → *"these administrative pages are reachable only by typing
  the URL: ['/admin/legal']"*

An existing guard also caught a genuine gap in this work —
`pageTitleCoverage.test.js` required a `tabForPath` branch for the new route —
which was resolved as an exemption with the reason recorded, because the page
renders outside the shell in both session states.

### Verification

- **`npm test`** — 9,662 passed, 122 skipped. **9 failures, all pre-existing and
  environmental** (finding 1), confirmed identical on a stashed clean tree.
- **`npm run lint`** — clean.
- **`npm run build`** — green; `AcceptInvitation` code-splits into its own chunk.
- **`npm ci`** — not re-run; no dependency or lockfile change was made.
- **Live walkthrough** on a scratch SQLite demo database (never `pilot.db`):
  student, organizer, administrator and owner surfaces; a real invitation minted,
  refused from the wrong address without consuming the token, then accepted —
  with the promotion, the consumption and the `ADMIN_INVITE_ACCEPTED` audit row
  all verified in the database.
- **`security-review` skill** (ENGINEERING_GUIDE §3.2, mandatory for
  authorization-adjacent diffs) — **no findings.** It independently confirmed the
  token-in-URL channels are closed: helmet's default `Referrer-Policy:
  no-referrer`, the pre-existing `?token=` analytics redaction rules, query
  strings dropped before error-report pattern matching, access logs stripping
  the query, and no cross-origin link or resource on the new page.

### Remaining concerns

- Finding 1 is the most urgent item in this document and needs an operator, not
  a patch.
- The three unmerged branches drift further from trunk every day; the perf
  branch's conflicts are already semantic.
- Findings 4, 5, 6, 9, 10 are recommended but unbuilt — deliberately. Each is a
  feature or a policy decision rather than a missing connection, and building
  them hurriedly at the end of an audit would be worse than specifying them.

---

## 13. Decisions that genuinely need you

**1. The production credentials in `.env`** (finding 1)
Options: (a) move them to an operator-only env file **and rotate them**, then
merge the production-architecture branch for its boot guard; (b) leave as-is.
**Recommendation: (a).** `npm test` currently opens connections to a database
holding real minors' PII, and seven tests fail *because* the safety they assert
is not present. Rotate on the assumption of exposure — the file is read by a
command developers run casually.

**2. Merge order for the three unmerged branches** (§2)
Options: (a) production-architecture → owner-center → perf-scaling (rebased);
(b) a different order; (c) leave them.
**Recommendation: (a).** It front-loads the safety guards, takes the mechanical
conflicts before the semantic ones, and leaves the branch whose measurements
need redoing for last.

**3. Build badge administration?** (finding 4)
Options: (a) build `/admin/badges`; (b) leave the endpoints unreachable.
**Recommendation: (a).** Four working endpoints, and a real correction path — a
badge earned on hours that were later revoked — that currently cannot be
performed at all.

**4. Who may export the student roster?** (finding 6)
Options: (a) re-gate behind a roster-export capability and surface it on
`/admin/roster`; (b) delete the endpoint; (c) surface it under `report.resolve`
as-is.
**Recommendation: (a).** Not (c): `report.resolve` means "resolve moderation
reports", and it should not also mean "download every student's email address".

**5. Partner: finish or shelve?** (finding 10)
**Recommendation: shelve honestly** — remove Partner from the persona-preview
list and say the role is not yet enabled — unless a partner organization is
already onboarding, in which case build the `analytics.public` surface.
