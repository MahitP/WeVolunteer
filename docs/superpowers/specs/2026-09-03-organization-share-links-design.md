# Organizations: share links, membership policy, and a first-class page

Date: 2026-09-03
Status: design, approved for implementation

## 1. What exists today, and what it is missing

Organizations already have real substance. `organizations` carries identity
(name, derived slug, description, tags, emoji or uploaded logo, avatar colour,
`allow_replies`, `status`), `organization_members` carries a three-rank scoped
membership (`member` / `student_organizer` / `manager`), `organization_bans`
carries standing exclusions with appeals, and `organization_announcements`
carries the club's own notices. Authorization is the existing capability kernel
plus an ownership check: `organization.manage.own` + `canManage`,
`organization.post.create` + `canHelpRun`, `organization.join` for membership,
`organization.moderate` as the administrator bypass.

Three things are missing, and they are the whole of this work:

1. **There is no way to hand somebody a link to a club.** Slugs are derived from
   the name and every organization route requires a session and
   `directory.read`, so an organizer cannot put a club on a flyer, in a group
   chat, or in an email to a parent.
2. **Membership has exactly one mode.** `POST …/membership` inserts a `member`
   row for anybody who is not banned. A club that wants to vet who joins, or to
   admit only people it invited, cannot say so.
3. **The page reads as a CRUD detail view.** Five stacked `.card` sections in
   source order, a 22px avatar, and a primary action that is one of four
   ternaries inside the header row.

The certificate share link is the proven pattern to model on. A certificate code
is a *stored random bearer value* — `crypto.randomBytes`, never derived from ids
— checked at a single unauthenticated, rate-limited endpoint that discloses only
what the printout itself would. `server/tokenDigest.js` goes one step further for
credentials that live in a table: 32 bytes from `randomBytes`, and only the
SHA-256 digest is stored, so a copy of the table holds nothing usable.

## 2. Architecture

Four ideas carry the whole feature.

**A share link is an address, not a credential for membership.** Holding it lets
you *see a public projection* of the organization and, where the club has said
so, lets your Join press succeed. It never makes you a member by itself and it
never widens what you can read beyond the public projection. Membership is
always an explicit act by a signed-in account.

**The token is verified at the moment of the act, not at page load.** The join
request carries the token in its body and the server re-resolves it then. That
is what makes rotation and revocation instant: there is no window in which a
page loaded under an old link still holds a grant.

**Policy is two columns on `organizations`, and the vocabulary lives in one
module.** `join_policy` answers "who may become a member"; `invite_policy`
answers "who may hand out the link". Neither is a new authorization system —
both are read by handlers that already ask `canManage` / `canHelpRun` /
`can(principal, …)`.

**The public projection is a separate serializer with an allowlist, served by a
separate endpoint.** `formatOrganization` keeps serving signed-in readers
unchanged. `publicOrganization` names, field by field, what a stranger with a
link may see. Two functions rather than a flag, for the reason `canManage` and
`canHelpRun` are two functions: the narrow answer keeps its own name, so a route
added next year cannot get the wide one by forgetting an argument.

## 3. Database

One migration, `062_organization_membership_policy.js`. Additive on both
engines: two columns and two new tables, no rebuild, so no guard set is required
(§8.3). It carries a `postgres.up`, and `server/db/postgresSchema.js` is
regenerated with `node bin/generate-postgres-schema.mjs`.

### 3.1 `organizations` — two columns

```
join_policy   TEXT NOT NULL DEFAULT 'open'
invite_policy TEXT NOT NULL DEFAULT 'helpers'
```

`join_policy` ∈ `open` | `invite` | `request`. `invite_policy` ∈ `helpers` |
`members`.

**No CHECK constraint**, following `045_event_audience` for the same reason:
SQLite cannot add one by `ALTER`, and the alternative is rebuilding
`organizations` — every column, every index, every foreign key pointing at it —
to constrain a three-valued field. Adding a CHECK on PostgreSQL only would put
a constraint on migrated databases that fresh ones (built from the generated
DDL) do not have, which is worse than none. The vocabulary is validated where it
is written, in `validateOrganization`, and every reader treats an unrecognised
value as the safest branch: anything that is not exactly `'open'` or
`'request'` is read as `invite` on the *server* (fail closed for joining), and
anything that is not exactly `'members'` is read as `helpers` (fail closed for
sharing).

`'open'` is the default because it is what every existing organization already
does. A NULL would be a third state meaning "unspecified" that every reader
would have to interpret.

### 3.2 `organization_share_links`

```
organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE
token_hash      TEXT NOT NULL UNIQUE
created_at      TEXT NOT NULL
created_by      TEXT REFERENCES users(id) ON DELETE SET NULL
rotations       INTEGER NOT NULL DEFAULT 0
```

**Why a table and not two columns on `organizations`.** Every organization query
in the product selects `o.*` — `ORG_SELECT`, the directory search, the "mine"
listing. A secret on that row would be loaded into memory by all of them and
kept out of responses only by `formatOrganization` remembering not to name it.
In its own table the digest is never selected by any existing query, so no
existing endpoint can leak it even if somebody adds a `...row` spread. This is
the argument `059_event_search_index` makes for keeping derived bookkeeping off
`events`, applied to a credential.

`organization_id` is the primary key, so **one live link per organization**.
Rotation is an `UPDATE` (the old digest ceases to exist, which is the whole of
revocation); switching the link off is a `DELETE`. `UNIQUE(token_hash)` gives
the lookup its index for free, exactly as `certificates.code` does.

Rejected: multiple named links, per-recipient tokens, expiry. See §12.

### 3.3 `organization_join_requests`

```
id              TEXT PRIMARY KEY
organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
user_id         TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE
status          TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','withdrawn'))
created_at      TEXT NOT NULL
decided_at      TEXT
decided_by      TEXT REFERENCES users(id) ON DELETE SET NULL
```

A new table created fresh on both engines, so it *does* get its CHECK.

```
CREATE UNIQUE INDEX idx_org_join_requests_live
  ON organization_join_requests(organization_id, user_id) WHERE status = 'pending'
CREATE INDEX idx_org_join_requests_queue
  ON organization_join_requests(organization_id, status, created_at)
CREATE INDEX idx_org_join_requests_user
  ON organization_join_requests(user_id, status)
```

The partial unique index is the *database's* guarantee that there is at most one
live request per person per organization — the same idiom, for the same reason,
as `idx_org_bans_active`. "No duplicate active requests" is a relational fact and
is not left to a read-then-write check in JavaScript.

`withdrawn` covers both "the student cancelled it" and "they became a member by
another route, so nobody needs to decide it any more". One value rather than two,
because the manager queue only ever reads `pending` and no surface distinguishes
the two ways a request stopped being live.

**No `message` column.** A free-text note written by a minor, read by club
managers and copied into an email, is a disclosure this feature does not need in
order to work. Name and rank are what a manager decides on.

## 4. Server modules

- **`server/organizationPolicy.js`** (new, imports nothing but the vocabularies)
  — `JOIN_POLICIES`, `INVITE_POLICIES`, `normaliseJoinPolicy`,
  `normaliseInvitePolicy`, and `joinAffordance(org, { membership, ban, hasValidToken })`
  returning the one canonical description of what a viewer may do:
  `{ action: 'join'|'request'|'invite_required'|'pending'|'member'|'banned'|'unavailable', … }`.
  One function, so the server's answer and the client's rendering cannot drift —
  the client renders what the server says, exactly as `viewer.canPost` already
  works.
- **`server/organizationShareLinks.js`** (new, takes `db` as a parameter) —
  `issueShareLink`, `rotateShareLink`, `revokeShareLink`, `shareLinkFor`,
  `resolveShareToken`. Uses `issueToken()`/`hashToken()` from
  `server/tokenDigest.js` unchanged.
- **`server/organizationJoinRequests.js`** (new, `db` as a parameter) —
  `requestToJoin`, `withdrawRequest`, `pendingRequests`, `decideRequest`. Every
  state transition is a conditional `UPDATE … WHERE id = ? AND status = 'pending'`
  and reports `changes === 0` as a conflict.
- **`server/organizations.js`** — gains `publicOrganization(row, { upcoming })`,
  the public allowlist serializer, and `canInvite(db, orgId, userId, { policy, hasModerate })`.
- **`server/organizationLimiters.js`** (new) — `shareTokenLimiter`, mounted on
  every route that consumes a token, and `joinRequestLimiter`.

## 5. API

### 5.1 Modified

| Route | Change | Authorization |
|---|---|---|
| `GET /api/organizations/:key` | adds `joinPolicy`, `invitePolicy`, `viewer.affordance`, `viewer.joinRequest`, `viewer.canInvite`, `viewer.canReviewRequests`, `shareLink.exists`. Members list becomes member/manager-only (§8). | unchanged: `directory.read` |
| `PATCH /api/organizations/:key` | accepts `joinPolicy`, `invitePolicy`. Setting `joinPolicy` to `invite` mints a link in the same transaction if none exists. Audited. | `organization.manage.own` + `canManage` |
| `POST /api/organizations/:key/membership` | accepts `{ shareToken? }`; enforces `join_policy`. `request` → 409 `request_required`. `invite` without a valid token for *this* organization → 403 `invite_required`. | `organization.join`, + `shareTokenLimiter` |

### 5.2 New

| Route | Purpose | Authorization |
|---|---|---|
| `GET /api/organizations/:key/share-link` | the current link, plaintext token included | `organization.join` + `canInvite` (i.e. `invite_policy`) |
| `POST /api/organizations/:key/share-link` | mint or rotate; returns the token once | `organization.manage.own` + `canManage` |
| `DELETE /api/organizations/:key/share-link` | switch the link off | `organization.manage.own` + `canManage` |
| `GET /api/public/organizations/invite/:token` | **unauthenticated** public projection | none; `shareTokenLimiter` |
| `POST /api/organizations/:key/join-requests` | ask to join | `organization.join` + `joinRequestLimiter` |
| `DELETE /api/organizations/:key/join-requests/mine` | withdraw your own | `organization.join` |
| `GET /api/organizations/:key/join-requests` | the pending queue | `organization.manage.own` + `canManage` |
| `POST /api/organizations/:key/join-requests/:id/decision` | accept or reject | `organization.manage.own` + `canManage` |

`GET` never mints. A `GET` that created a credential would put it in browser
history and expose it to anything that speculatively prefetches links — the
argument the check-in code route already makes for being a `POST`.

Reviewing requests is **manager-only**, not `canHelpRun`. Deciding who is
admitted discloses a queue of named students and is a standing decision about
membership; `canHelpRun` exists for posting and putting events up, and its own
header argues against widening the dangerous question by an option.

Rate limiting mirrors `verifyLimiter`, including its wording rule: the refusal
must never read as a verdict on the link.

```
app.use('/api/public/organizations/invite', shareTokenLimiter);   // 20 / 15 min, successes counted
```

Successes are counted deliberately: a successful resolution is exactly what an
enumeration attempt looks like from outside.

## 6. Share-link lifecycle

**Creation.** A manager either switches "Who can join?" to *Invitation only* —
which mints a link in the same transaction, because a policy that requires a
link and has none is a club nobody can join — or presses **Share** and then
**Create link**. 32 bytes from `crypto.randomBytes`; only the SHA-256 digest is
stored. The plaintext is returned once, in that response, and never again from
any endpoint other than `GET …/share-link` to a principal `invite_policy`
allows.

**Sharing.** `/organizations/invite/<64 hex chars>`. The URL carries no
organization id, no slug and no name, so it is not a route to enumeration and it
does not leak which club it belongs to before it is resolved.

**Opening.** `GET /api/public/organizations/invite/:token` — one indexed
equality lookup on the digest. Any failure (no such token, revoked, archived
organization) answers an identical 404, so the endpoint cannot be used to tell a
retired link from one that never existed.

**Joining.** The client presents the token in the body of
`POST …/membership`. The server re-resolves it and requires that it belongs to
*this* organization. A token for the Chess Club does not open the Robotics Club.

**Rotation and revocation.** Rotating overwrites the digest; the previous link
stops resolving on the next request. Revoking deletes the row. **Existing
members are unaffected in both cases** — membership is a row in
`organization_members`, and the link was only ever the door. The confirmation
dialog says exactly this, because the manager's likely fear is that they are
about to remove their own club.

**No expiry.** A club's link goes on a flyer, a QR code, a printed handbook and
a pinned message. A link that lapses silently breaks all of them and produces
the same "this link is not valid" screen as a revoked one, which teaches people
that the product is unreliable. Rotation and revocation are the honest controls,
they are explicit, and they are attributable. Every mint, rotation and
revocation is written to the audit trail
(`ORGANIZATION_SHARE_LINK_CREATED` / `_ROTATED` / `_REVOKED`), with labels added
to `src/views/auditFormat.js` so the Audit Explorer does not render them in raw
SCREAMING_SNAKE.

## 7. Membership lifecycle

**Open.** Signed-in, holds `organization.join`, not banned, organization active
→ `POST …/membership` inserts `ON CONFLICT DO NOTHING`. Unchanged from today.

**Invitation only.** The organization is still listed in browse and search — §17
of the brief, and the right call: discovering a club and being allowed into it
are different questions, and a club that vanishes from search looks broken
rather than private. A visitor without a link sees the page and an
`Invitation required` state that explains it. A visitor with a link sees an
ordinary **Join**, and the token travels with the press.

Possession of the link grants *permission to join*, not membership. It is the
simpler and safer of the two models the brief asks about: nobody becomes a
member of anything by opening a URL a friend pasted, a preview crawler cannot
join a club, and the token is checked server-side at the moment of the decision.

**Request to join.** `POST …/join-requests` inserts a `pending` row. The
partial unique index makes a second concurrent submission a unique violation,
which the handler reports as the same idempotent success as the first — pressing
twice is not an error worth an error page. Managers see the queue; accepting is
one transaction that flips the request to `accepted`, inserts the membership row,
recomputes helper capabilities via `syncOrganizerCapabilities`, writes the audit
row, and dispatches the notification. Rejecting flips it to `rejected` and
notifies. The student sees `Request pending` and can withdraw.

**Race conditions, and where each is actually settled**

| Situation | Settled by |
|---|---|
| Two managers accept the same request | `UPDATE … WHERE id = ? AND status = 'pending'`; the loser sees `changes === 0` → 409 `already_decided`. Membership insert is `ON CONFLICT DO NOTHING`. |
| Student submits two requests at once | `idx_org_join_requests_live` (partial unique). The violation is caught and answered as success. |
| Student is admitted while a manager rejects | Both are conditional updates on the same row inside a transaction; exactly one wins, and the membership insert is idempotent either way. |
| Student joins by link while a request is pending | Join succeeds; the same transaction resolves the pending request to `withdrawn`. |
| Link rotated mid-join | The token is resolved inside the join handler, so the request either used the live digest or is refused. There is no cached grant. |
| Link revoked mid-join | Same. |
| `open` → `invite` | The next tokenless join is refused. Members already in stay in. |
| `request` → `open` | Pending requests remain decidable and the Join button starts working; accepting a request for somebody who has already joined is a no-op. |
| Manager removes their last co-manager, then themselves | Unchanged — the existing three-way last-manager guard. |

Every multi-statement path runs through `runInTransaction`, and the audit row is
written inside it, so "admitted but not recorded" is not a reachable state.

## 8. Privacy

WeVolunteer holds minors' data, and this feature creates the platform's first
unauthenticated view of an organization. The projection is therefore an
allowlist, written out field by field in `publicOrganization`.

**Public, to a holder of a valid link, with no session:** name, slug, emoji or
uploaded logo, avatar colour, description, tags, member *count*, event *count*,
`joinPolicy`, `status`, and the title, date and category of up to three upcoming
opportunities.

**Never public:** any member's name, handle, avatar, rank or hours; the founder's
name; the organization id; announcements and their replies; event *locations*
(where named minors will physically be, at a stated time, published to an
unauthenticated audience); bans; appeals; join requests; hours totals; the token
digest.

**Two tightenings to existing behaviour**, both of which this work makes it
impossible to keep ignoring:

1. **The roster becomes member-visible.** Today any signed-in account with
   `directory.read` reads up to 100 members of any organization, each through
   `profileSummary`. That is the club's roster of children shown to somebody with
   no connection to the club. Non-members now receive the count; members,
   managers and moderators receive the list. Nothing about the serializer
   changes, so no field that a profile would have withheld becomes visible to
   anybody.
2. **Requests disclose only `profileSummary`.** A manager reviewing a queue sees
   exactly what the roster already shows them and nothing more — no grade, no
   school, no email, no free-text message.

Notification bodies are minimal for the same reason they are minimal for
`FRIEND_SIGNED_UP`: they are copied into email, which leaves the building.
"Priya Patel asked to join Chess Club" and nothing else.

## 9. Notifications

Three new kinds, integrated into the existing `notificationContent.js` registry
rather than a second system. None is a mandatory notice — none is an enforcement
action — so all three honour preferences and the global opt-out.

| Kind | Category | Recipient | Body |
|---|---|---|---|
| `ORGANIZATION_JOIN_REQUEST_RECEIVED` | `APPLICATION` | every manager | "<Name> asked to join <Org>." → the requests section |
| `ORGANIZATION_JOIN_REQUEST_ACCEPTED` | `ACCOUNT` | the student | "You are now a member of <Org>." → the org page |
| `ORGANIZATION_JOIN_REQUEST_REJECTED` | `ACCOUNT` | the student | "<Org> did not accept your request to join." no CTA |

`APPLICATION` for the manager-facing one because it is the same shape as
`NEW_APPLICATION`: somebody applied to a thing you run. `ACCOUNT` for the
student-facing outcomes, matching `ORGANIZATION_MEMBERSHIP_REMOVED`.

Dedupe keys are `org-join-request:<requestId>`, so a fan-out retried inside the
seven-day window cannot double-notify.

**Deliberately not added:** a notification when somebody joins an open
organization (noise, and nothing needs a decision); "invitation received" (there
are no per-person invitations); a separate "membership approved" (that is
`ACCEPTED`); anything about the share link (a manager who rotates it knows).
A rejection carries no reason, because the alternative is inviting a manager to
type a judgement about a named minor into a message that gets emailed.

## 10. Frontend

### 10.1 Routes

- `/organizations/:key` — unchanged in APP_ROUTES (`directory.read`), redesigned.
- `/organizations/invite/:token` — **new**, in `PUBLIC_ROUTES`. Three segments,
  so it cannot collide with `/organizations/:key`; the static `invite` segment
  outranks `/organizations/:key/edit` in the router's own ranking.
  Added to `CLIENT_ROUTE_PATTERNS` in `server/clientRoutes.js`, where the stored
  value is the *pattern* — so the token cannot survive matching, exactly as
  `/verify/:code` and `/appeal/:token` already rely on.
  It carries **no `requiredCap`**: `routeGating.guard.test.js` fails the build on
  a gate key written into `PUBLIC_ROUTES`, because there is no principal there
  for it to apply to and it would read as enforcement while enforcing nothing.

### 10.2 Signed-out → signed-in, without inventing a redirect

`OrganizationInvite` resolves the token, then branches:

- **Signed in** (`useSession()`): remember `{ slug, token }` and
  `navigate('/organizations/<slug>', { replace: true })`, so the page renders
  inside the shell with navigation, and the Join press carries the token.
- **Signed out**: render the public invitation page. **Join** opens
  `SignInToJoinDialog` — the shared `Modal`, so Escape, focus containment, focus
  restore and scroll lock come for free — offering *Log in* and *Create an
  account*.

Before navigating to `/login` or `/signup` the pending invite is written to
`sessionStorage` by `src/utils/pendingInvite.js`. After a successful sign-in or
signup, `handleLoginSuccess` in App.jsx takes it and navigates to
`` `/organizations/${encodeURIComponent(slug)}` ``.

**Why this and not a `returnTo`.** A `returnTo` is a general redirect primitive:
it accepts a path and goes there, and keeping it safe means maintaining a
validator forever. This is not one. The stored value is a *slug*, produced by our
own server in response to our own request, and it is interpolated into a fixed
path prefix. There is no input that can make it navigate anywhere but an
organization page — so there is nothing to validate and no open-redirect surface
to get wrong. It is also per-tab and same-origin, and every access is wrapped in
try/catch because `sessionStorage` throws in some privacy modes.

### 10.3 The page

One information architecture, five states. Content and affordances change; the
skeleton does not.

**Masthead** (`OrganizationHeader`) — a brand-tinted band that is visibly *not*
another `.card`. Large logo, name in the display face (`text-wrap: balance`,
clamped to two lines so a 120-character name cannot push the action off screen),
a chip row carrying the tags and a join-policy pill, and a stat strip. The
primary action sits at the end on desktop and below the identity block on
mobile, full width.

The stat strip shows only figures the reader is entitled to, so it does not
promise a number the server withholds: **members** and **opportunities** to
everybody (both are already public counts), plus **your hours here** for a
member — their own record, which `viewer.hours` already carries — and the club's
total only for a manager, where `totals` already goes today. It is one component
reading what the payload contains, not four layouts.

**Primary action** (`JoinAction`) — renders `viewer.affordance` and nothing else.
The client holds no copy of the policy rule:

| affordance | control |
|---|---|
| `join` | **Join <name>** (primary) |
| `request` | **Request to join** (primary) |
| `pending` | **Request pending** (disabled) + *Withdraw request* in the menu |
| `invite_required` | **Invitation required** (disabled) + one line of explanation |
| `member` | a **Member** state pill; *Leave* moves into the actions menu |
| `banned` | the existing appeal flow, unchanged |
| `unavailable` | archived or ineligible, said plainly |

Leaving moves out of primary position deliberately: for a member, leaving is the
rarest and most destructive thing on the page, and it currently occupies the spot
a newcomer's Join occupies.

**Share** (`ShareOrganizationDialog`) — visible when `viewer.canInvite`. The
shared `Modal`. The URL in a read-only monospace field that selects on focus,
**Copy link**, and **Share…** rendered only when `navigator.share` exists — no
control that silently does nothing on a browser that lacks it, and
`navigator.clipboard` absence falls back to showing the URL in a toast, which is
what `PublicProfile` already does. Managers additionally get **Regenerate link**
and **Turn off link**, both behind `ConfirmDialog`, both saying in plain words
that current members stay members.

**Body**, two columns on desktop collapsing to one below the tablet breakpoint:
About · Your service (members) · Opportunities · Announcements (members) ·
Members (members).

**Manage** — one visually distinct panel below the member-facing content, so
administrative controls are unmistakably separate: *Requests* (new
`JoinRequestInbox`, rendering nothing at all when the queue is empty and the
policy is not `request`), then the existing banned-members and appeals cards.

**Settings** — `/organizations/:key/edit` gains `MembershipPolicyFields`: a
`<fieldset>`/`<legend>` radio group, each option a label plus one sentence of
consequence.

> **Who can join?**
> **Anyone** — Students can join straight away.
> **Invitation only** — Students need this organization's invitation link. It
> will still appear in search, and people without the link are told they need
> one.
> **Request to join** — Students ask, and a manager accepts or declines.
>
> **Who can share the invitation link?**
> **Managers and student organizers** (default) — **Any member**
>
> Creating, regenerating and switching off the link is always a manager's
> decision.

### 10.4 Accessibility

Semantic `<button>` and `<Link>` throughout; no clickable `<div>`. Every dialog
goes through the shared `Modal`, which `dialogSemantics.test.jsx` already
enforces. `<fieldset>`/`<legend>` for the two radio groups. The share dialog's
copy confirmation announces through the existing `Toasts` `role="status"`
region; failures use its `role="alert"` path. Focus indicators come from the
global `:focus-visible` rule and the `forced-colors` block, both of which
`focusIndicators.test.js` pins. The 44px target floor applies to the icon
controls. `OrganizationInvite` is the only new view with its own `<h1>` — it
renders outside the shell — and is added to the `STANDALONE` allowlist in
`headingLevels.test.js`. New CSS lives in
`src/components/organizations/OrganizationExperience.css` (the `EventHero.css`
precedent), uses only defined tokens (`tokens.test.js` scans `.css` too), and
declares no colour literals. Motion is behind `prefers-reduced-motion`.

### 10.5 Responsive

Masthead: single column below 640px, stat strip wraps to two rows, action
full-width. Requests and roster rows stack their metadata rather than truncating.
The share dialog's URL field scrolls horizontally inside itself and never widens
the dialog. `resize_window` checks at 375, 768 and desktop.

## 11. Testing

**Server** — `organizationShareLinks.test.js` (mint / rotate / revoke; digest-only
storage; uniform 404; the digest absent from every organization response),
`routes.organizationShareLink.test.js` (the authorization matrix across manager,
student organizer, member, non-member and moderator under both invite policies),
`routes.organizationJoinPolicy.test.js` (all three modes; invite without a token;
a token belonging to another organization; a revoked token; a rotated token; a
banned holder of a valid token; archived), `routes.organizationJoinRequests.test.js`
(request, duplicate, withdraw, accept, reject, unauthorized decision, cross-org
request id, decision on an already-decided request),
`routes.publicOrganizationInvite.test.js` (projection contents field by field,
absence of every private field, rate limit, no roster),
`organizations.joinRequestConcurrency.test.js` (two concurrent accepts, two
concurrent requests — and the PostgreSQL variant, following
`application.postgresConcurrency.test.js`),
`migrations.organizationMembershipPolicy.test.js` (columns, defaults, both
indexes, the partial unique index, PostgreSQL parity).

**Client** — `OrganizationPage.states.test.jsx` (the five viewer states and the
seven affordances), `OrganizationInvite.test.jsx` (public render, signed-in
redirect, invalid token, pending-invite handoff),
`ShareOrganizationDialog.test.jsx` (clipboard-absent and `navigator.share`-absent
fallbacks, keyboard operation), `JoinRequestInbox.test.jsx` (empty, loading,
error, accept, reject), `pendingInvite.test.js` (throwing storage).

**Existing guards** are the acceptance criteria and none is relaxed:
`clientRoutes.test.js`, `internalLinks.test.js`, `pageTitleCoverage.test.js`,
`App.routeTable.test.jsx`, `routes.test.jsx`, `routeProps.guard.test.js`,
`authz.completeness.test.js`, `authz.matrix.test.js`,
`notificationContent.coverage.test.js`, `auditLabelCoverage.test.js`,
`db.postgresSchema.test.js`, `migrations.registry.test.js`, `tokens.test.js`,
`noHardcodedColors.test.js`, `headingLevels.test.js`, `dialogSemantics.test.jsx`,
`focusIndicators.test.js`, `touchTargets.test.js`.

## 12. Rejected, and why

- **Per-recipient email invitations.** A second delivery surface, an address the
  club types in, and a message that names a student — for a feature whose actual
  requirement is "hand somebody a link". `invite_policy` on the one link is the
  whole of "who may invite".
- **Multiple named share links per organization.** Nothing in the brief needs to
  tell two links apart, and the primary key is what makes rotation atomic.
- **Token expiry.** §6.
- **A `message` field on a join request.** §3.3.
- **A third invite tier (managers only).** The rank vocabulary already treats
  managers and student organizers as one tier for routine acts — that is what
  `canHelpRun` is — and sharing a link is more routine than posting an event.
  A third tier would be the only place in the product where a student organizer
  is trusted less than a manager for an everyday action.
- **Making the organization page itself reachable while signed out.** It would
  make every club's page, and its roster, world-readable by guessable slug. The
  public projection is reached only by presenting a random 256-bit token.
- **A `returnTo` query parameter.** §10.2.
- **Redis or Pinecone.** Membership, requests and tokens are durable relational
  state with uniqueness constraints and transactions. Redis is the rate-limit
  store and stays that. Organizations are not in the Pinecone index and this
  gives no reason to put them there.
- **A feature flag.** §13 is a better rollback than an env var that has to be
  wired through every new route.

## 13. Rollback

The migration is additive, so a code revert leaves a working database on both
engines: two unread columns and two unread tables.

Operationally, three statements undo the feature's effects without a deploy:

```sql
DELETE FROM organization_share_links;                 -- every link stops resolving
UPDATE organizations SET join_policy = 'open';        -- every club joinable again
UPDATE organization_join_requests SET status = 'withdrawn' WHERE status = 'pending';
```

Nobody loses a membership: `organization_members` is untouched by all three.
