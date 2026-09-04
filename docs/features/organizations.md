# Organizations: public handles, invitation links, membership, and the page

How a club is found, how it is shared, who gets into it, and where each of those
decisions is enforced. Written for whoever has to change this next.

Shipped 2026-09-03 (migration 062) and extended 2026-09-04 (migration 063). The
design that preceded the first half is in
`docs/superpowers/specs/2026-09-03-organization-share-links-design.md`, including
the ideas that were rejected and why; §13 below records what the second half
refused.

## 1. The invariants

Everything else follows from these, and none of them is obvious from the schema.

**The invitation link is an address, not a credential.** It opens
`publicOrganization` — the club's own advertisement — and, on a club whose
`join_policy` is `invite`, it makes a Join press succeed. It grants no session,
no capability, and it never makes anybody a member by itself. Membership is
always an explicit act by a signed-in account.

**A handle identifies; a link authorises.** The canonical address
`/organizations/@robotics` is readable, printable and guessable *by design* — it
is the club's name — and it carries no joining authority whatsoever. The
invitation link is the credential. Confusing the two would make a club's front
door a password anybody can read off a poster. §2 sets this out in both
directions.

**The token is resolved at the moment of the act, from the request body.** Never
in a query string, never cached against a session, never turned into a grant that
outlives the request. That is the only reason rotating or switching off a link
takes effect on the next request rather than whenever a page happens to reload.
It is also why the join route asks `openingLinkId(db, thisOrganization, token)`
rather than "did this token resolve to something": a Chess Club link must not
open the Robotics Club — and the same call is what says which link to count the
use against.

**An invitation has no credential at all.** It names a user, and only that user's
session can accept it. §5 explains why that is stronger than the hashed-token
design `admin_invitations` uses, and why invitation-by-email was refused.

**`joinAffordance` is computed on the server, once.** Seven states, decided
against the policy, the membership row, an active ban, the organization's status
and the caller's capability. The page renders the answer and computes no policy
of its own. The single exception — that a tab is holding a token, which the
server cannot know because the token never reaches a GET — is resolved in
`OrganizationPage` and **not** in `JoinAction`, because the sentence under the
button has to agree with the button. When it was decided inside the component,
the control said Join while the line beneath told the reader to go and ask
somebody for a link.

**The unauthenticated projection is an allowlist in its own function.**
`publicOrganization`, never `formatOrganization` behind a flag. Two functions
rather than an argument, for the same reason `canManage` and `canHelpRun` are two
functions: the narrow answer keeps its own name, so a field added to the wide
serializer cannot become public by somebody forgetting an argument.

## 2. The public handle

A club's canonical address is `/organizations/@robotics`. It is the club's
`slug` column with an `@` in front — the same arrangement `users.username` and
`/users/@alice` already use, and for the same reason: one stored spelling, two
written ones, and a unique index that can see they are the same.

**The handle identifies. The invitation link authorises.** That separation is the
whole of the design and it is worth stating in both directions:

| | invitation link | public handle |
|---|---|---|
| what it is | a credential | an address |
| guessable | no — 32 random bytes | **yes, by design** — it is the club's name |
| works when unlisted | yes | no |
| makes a Join succeed at an `invite` club | yes | **never** |
| revocable | yes | no (it can be changed, which is not the same thing) |

A handle that granted joining authority would be a password anybody can read off
a poster. `joinAffordance` therefore never sees one: the public endpoint resolves
a handle and returns a projection, and a Join arriving with nothing but a handle
is judged by `join_policy` alone.

### Renaming no longer moves the address

It used to: a rename recomputed the slug, and the settings form promised as
much. That was defensible while the slug was a private convenience and became
wrong the moment it was the thing a club prints on a flyer. It was also already
breaking three things:

- Stored notification payloads bake `/organizations/@<slug>` into rows that
  outlive the rename, so every historical notification for a renamed club
  dead-linked.
- `pendingInvite` keys a remembered invitation on the slug, so a rename between
  opening a link and finishing signup silently dropped the token.
- `?organization=<slug>` filters on the portfolio and certificate pages are the
  kind of URL people bookmark.

Freezing it fixes all three. The cost is that name and handle can diverge, which
is why the handle became editable in the same change: an address you cannot
change and did not choose is worse than one that moves.

### Reserved segments, and a bug that had already shipped

`/organizations/new` is a real page, and `slugify` happily returned `new` for a
club called "New". Such a club was created with a permanently unreachable page —
the router matched the literal first — and nothing reported it. `RESERVED_HANDLES`
is **derived** from `CLIENT_ROUTE_PATTERNS` rather than typed out, so it cannot
go stale the day somebody adds `/organizations/settings`, and `uniqueSlug`
repairs a derived handle that would be refused (`New` → `org-new`) before the
collision loop rather than after.

The canonical `@` form makes the collision class impossible by construction
anyway. The list is belt and braces, and it is what keeps a club created before
this change reachable.

### A handle must not be able to impersonate an id

The rules above were, for a while, satisfied by an organization's own id. `org-`
plus a `crypto.randomUUID()` is **exactly 40 characters**, starts with a letter,
and is lowercase alphanumerics separated by single hyphens — and this module's
comment claimed the letter-first rule ruled ids out. It did not.

That mattered because `loadOrganization` resolved a key with
`slug = ? OR id = ?`. An organizer could read any club's id off the directory
payload, set their own handle to it, and shadow that club on every id-addressed
path: the notification and audit links this feature deliberately keeps working
would land the victim's own members on the attacker's page, and on an `open`
club their Join press would put them on a stranger's roster.

Two locks now, and the second one was got wrong once before it was got right:

1. **A handle equal to any organization's id is refused**, by asking the
   database rather than by matching a pattern. `validateHandle` also refuses a
   UUID-shaped value without a round trip, which covers every id
   `createOrganization` mints — but *not* the short readable ids the demo seed
   uses (`org-robotics`), and that is the shape that found the gap. A pattern
   has to be kept in step with however ids are minted next; the database check
   does not.
2. **`organizationByKey` asks the ID namespace FIRST.** Handle-first was tried
   and hands the attacker exactly what they wanted, because their chosen handle
   wins over the victim's assigned id — verified against a running server, where
   `/api/organizations/org-robotics` resolved to the club that had claimed that
   string rather than to the club whose id it is. Ids are assigned by the
   system; handles are chosen by people, and a value somebody typed must never
   override an identifier the system minted.

The two namespaces are only ever ambiguous on the **bare** path.
`/organizations/@<x>` is resolved as a handle and never as an id, because the
`@` is what says which namespace is being addressed. So a club that chose a
colliding name loses its bare address and keeps its canonical one — which is
the right way round for the harm to fall.

`organizations.handleCollision.test.js` asserts both locks, and asserts the
resolution order against a collision written **straight into the column**,
bypassing every validator: that is the property that has to hold even if a
handle gets in by some route the validators do not cover.

### What the public route accepts is wider than what a manager may choose

`validateHandle` governs the *choice*. It is stricter than what is already in the
column: `slugify` predates it and could return `hq`, `2024-team` or sixty
characters, and migration 063 does **not** rewrite existing slugs — rewriting
them would break the links those clubs have already handed out, which is the
whole reason renaming stopped moving the address.

So the public route does not gate on it. It bounds the length and lets
`publicOrganizationByHandle` — which can only ever return a row that exists — be
the authority. Gating on the stricter rules meant such a club could turn its page
on, watch the Share dialog offer the address with a Copy button, and have every
visitor answered 404: fail-closed, so nothing leaked, and the product simply lied
to the manager about whether their page was public.

## 3. Visibility, which is a second axis

`join_policy` answers *who may become a member*. `visibility` answers *who may
look*. Two enums, not one, because the useful combination is precisely the one a
single enum cannot express: **findable, with a door** — a `public` club whose
`join_policy` is `invite`, which is what a school club actually asks for.

| | `public` | `unlisted` |
|---|---|---|
| `/organizations/@handle` with no session | the projection | 404 |
| invitation links | work | work |
| signed-in directory and search | listed | listed |
| members and managers | no difference | no difference |

Two values, not three. "Members only" would be a third that changes nothing a
manager can observe: an unlisted club is already invisible to a stranger, and to
a signed-in non-member it is exactly as visible as the directory already makes
it.

**An unlisted club and a club that does not exist answer identically** — same
status, same body. Handles are guessable, so a distinguishable refusal would
turn the endpoint into a directory of every club that chose not to be listed,
including which schools have one.

`normaliseVisibility` fails closed towards *not* publishing: only the exact
string `'public'` opens a club, so a typo, a NULL from an unmigrated row, or a
value from a future version can only ever publish less.

### The asymmetry between the migration and creation

Migration 063 backfills every existing club to `unlisted`. `createOrganization`
writes `public` explicitly. That is deliberate and it is the privacy argument:

- Every club that already existed was created when the page required a session.
  Nobody running one agreed to publish it.
- A club created today is created in a product that offers a public page, by
  somebody looking at the setting.

The column's `DEFAULT` is `'unlisted'`, so the value is stated at creation
rather than inherited.

Both halves of that have now been wrong once, in opposite directions, which is
worth recording because the shape of the mistake is the same both times —
**a setting the product offers, and a write that does not carry it**:

- First the value was left to the column default, so every new club was
  `unlisted` while the constant, the form and the API all said `public`.
- Then it was hard-coded to the constant, so `createOrganization` wrote
  `'public'` and *discarded the creator's choice*. An organizer could tick
  "Only people signed in", save, and get a club whose page a stranger could
  read — with the Share dialog then advertising the address to every member.
  The same call dropped `joinPolicy` and `invitePolicy`, so a club created
  "Invitation only" was joinable by anybody.

`createOrganization` now takes all three, defaulted to the constants so `bin/`
scripts and the demo seed keep getting the product's defaults without naming
them, and normalised on the way in so a caller that skipped
`validateOrganization` cannot write outside the vocabulary.

## 4. Membership policy

`organizations.join_policy` ∈ `open` | `invite` | `request`.
`organizations.invite_policy` ∈ `helpers` | `members`.

| Setting | What a student sees | Where it is enforced |
|---|---|---|
| `open` | **Join** | `POST …/membership` |
| `invite`, no link | **Invitation required**, disabled, with one sentence saying how to get one | `POST …/membership` → 403 `invite_required` |
| `invite`, with link | **Join**, token in the body | `tokenOpens` inside the handler |
| `request` | **Request to join** → **Request sent** | `POST …/join-requests`; a direct join is 409 `request_required` |

Possession of a link is **permission to join**, never membership. Nobody joins a
club because a friend pasted a URL, and a preview crawler cannot join anything.
In `request` mode the link does not bypass the approval — it is an address and
nothing more.

**An invitation-only club is still findable.** Discovering a club and being
allowed into it are different questions (§17 of the brief). It stays in browse
and in directory search, and a visitor without a link is told they need one. A
club that vanished from search would read as broken rather than as private, and
that is also the assumption managers most often make about the setting — which is
why the settings screen says so explicitly.

`invite_policy` governs **sharing only**. Creating a link, replacing it and
switching it off are always `canManage`, because replacing one stops every copy
already handed out from working.

**No CHECK constraint on either column.** SQLite cannot add one without
rebuilding `organizations`, and adding it on PostgreSQL alone would leave a
migrated database constrained while a fresh one — built from the generated DDL —
is not. `validateOrganization` refuses a value outside the vocabulary, and every
reader normalises: an unrecognised join policy is read as `invite` and an
unrecognised invite policy as `helpers`. Both fail closed, so a wrong value can
only ever make the product stricter.

## 5. Direct invitations, and why they carry no credential

`admin_invitations` is the in-repo precedent for inviting somebody: a random
token, stored as a SHA-256 digest, mailed out, and redeemable only by a
signed-in account whose **verified email address matches the one invited**. That
last rule is the load-bearing one — the mail is not the authority, the address
is, so a forwarded or intercepted invitation confers nothing.

Organization invitations take that to its conclusion. If the authority is the
identity of the person invited, a bearer token is not a second factor: it is a
redundant credential that can leak, be logged, be shoulder-read, or sit in a
mailbox after the invitation is revoked. So **there is no token**. An invitation
names `invited_user_id`, and the only thing that can accept it is a request whose
authenticated principal *is* that user. That is strictly stronger than the admin
flow, and it needs no verified-email check to get there, because there is
nothing to redeem.

### Why not invite by email address

Considered, and refused. Three arguments, in the order that decided it:

1. **It would be an enumeration oracle over the platform's most private field.**
   `profileSerializer.js` puts `email` in `PRIVILEGED_FIELDS`, and directory
   search deliberately cannot match on it. A form that takes an address and
   answers *anything* — "already a member", "sent", or a different latency — is
   the first place on this platform where a semi-trusted actor could act on an
   address they were never shown. `/api/auth/forgot-password` is written with one
   frozen response on every path precisely to avoid this, and an invitation form
   cannot be: an inviter has to be told whether their invitation went.
2. **The actor is not comparable to an owner.** `admin.create` is owner-only and
   step-up gated. A club's `invite_policy` may be `'members'` — any student in
   the club. Copying a design justified by its caller being the most-trusted
   account on the platform onto its least-trusted one is how the reasoning gets
   lost.
3. **The population is minors.** A club manager who can send mail from the
   platform's SPF/DKIM-passing domain, with club branding, to an arbitrary
   address, is a phishing capability. `server/email.escaping.test.js` exists
   because that concern was found live once already.

The recruiting case email would serve — getting somebody with no account into a
club — is already served, better, by a share link: a URL a human chooses how to
send, naming no address, with the platform never mailing a stranger on a club's
behalf.

### An invitation admits, whatever the join setting says. A link does not.

`joinAffordance` takes these as **two** inputs, and they look interchangeable:

| | what it is | admits on `open` | on `request` | on `invite` |
|---|---|---|---|---|
| `isInvited` | a row naming this person, created by a manager | yes | **yes** | yes |
| `hasInvite` | a live share link for this club | yes | **no** | yes |

The asymmetry is the point. A club that invited somebody *by name* has already
made, about that individual, the decision a request exists to ask for — making
them queue up behind it as well would be the club overruling itself. A share
link is an ADDRESS somebody passed on and says nothing about who is holding it,
so on a request-to-join club it must not admit: that club's whole point is that
a human approves each member, and a link that bypassed the approval would make
the setting decorative.

Written as one `hasInvite` for a while, which made the invitation feature inert
on a `request` club — the invitee was told to send a request, their Accept press
was answered `request_required`, and the invitation sat pending against the
club's outstanding list until it lapsed. Widening it to fix that broke the other
half instead; the route test caught it, which is the reason both directions are
now asserted.

Neither overrides the four states that come first: membership, a ban, an
archived club, and a request already pending.

### Every path onto the roster re-checks the ban

There are three, and for a while only two did:

| Path | Ban re-checked |
|---|---|
| `POST …/membership` | yes, at the moment of the act |
| `POST …/join-requests` | yes, so the queue cannot be filled by a banned person |
| `POST …/join-requests/:id/decision` with `accept` | **added** |

Banning does not retire a pending request, so a queue could hold a row for
somebody since banned with nothing marking them, and accepting re-admitted them
with the ban still live. The check runs **before** `decideRequest` writes the
status: after it, an early return would commit a request marked `accepted` with
no membership row behind it — a worse state than the bug, and one no later read
could tell from a real acceptance. Refusing leaves the request answerable, which
is what the response tells the manager.

Accepting a request also retires any invitation the same person was holding,
exactly as joining does.

### A decline is final for the inviter, not for the invitee

`inviteUser` refuses when the person has already declined. The partial unique
index stops a second *pending* invitation; without this rule a member could
decline-invite-decline-invite indefinitely, which is harassment with a queue
behind it. `canManage` does not bypass it either — bypassing is the vector.

A declined person is not shut out: they can still join with a link, or send a
request if the club takes them, and the refusal message says so. It is the tap on
the shoulder that stops.

Withdrawing is different. That is the club changing its own mind, so it costs the
club nothing and the same person may be invited again.

## 6. Why the token is stored verbatim

Every other bearer value in this schema is hashed — `password_reset_tokens`,
`admin_invitations`, `checkin_tokens` — and migration 048 renamed those columns
precisely so a later edit could not quietly write plaintext back. **This one is
different, and it is a requirement rather than a convenience.**

A club's invitation link is a standing address. It goes on a flyer, a QR code and
a pinned message, and the club has to be able to read it back for as long as it
is in circulation. A digest makes that impossible: the only way to see the link
again would be to replace it, which breaks every copy already handed out.
`certificates.code` is the in-repo precedent, for a value of strictly higher
sensitivity — it discloses one named minor's service record and it is stored
verbatim, because a student has to be able to re-print it.

What the value is worth is the other half. This token authorizes reading the
club's own advertisement and making a Join press succeed on an `invite` club. It
grants no session, no capability and no membership. Somebody who has read
`organization_share_links` already has `organizations` beside it.

Encrypting it under `TFA_ENCRYPTION_KEY` (the shape migration 027 uses for TOTP
secrets) was considered and rejected: at-rest protection for a low-value token,
at the cost of a differently-named key becoming load-bearing for a feature it is
not named for, plus a failure mode where a key change makes every club's link
unreadable while still resolvable.

**Do not "fix" this by hashing it.** The table it lives in is its own, so no
existing query selects it, and `formatOrganization` cannot leak it by accident.

## 7. Schema

Migration 062 was additive on both engines. Migration 063 is not: it **rebuilds**
`organization_share_links`, because 062 made `organization_id` the primary key —
which *was* the constraint "one link per club" — and SQLite cannot drop a primary
key.

```
organizations
  join_policy    TEXT NOT NULL DEFAULT 'open'       -- 062
  invite_policy  TEXT NOT NULL DEFAULT 'helpers'    -- 062
  visibility     TEXT NOT NULL DEFAULT 'unlisted'   -- 063, backfilled

organization_share_links                            -- 063 rebuild
  id               PK                               -- moved off organization_id
  organization_id  → organizations ON DELETE CASCADE
  token            NOT NULL UNIQUE                  -- supplies the lookup index
  label            NOT NULL                         -- "General" for carried rows
  created_at, created_by → users ON DELETE SET NULL
  expires_at       NULL = never lapses (the default)
  revoked_at       NULL = live; set rather than DELETEd
  uses             NOT NULL DEFAULT 0
  last_used_at     a DATE, not a timestamp

  INDEX (organization_id, revoked_at)               -- the club's links

organization_join_requests
  id               PK
  organization_id  → organizations ON DELETE CASCADE
  user_id          → users ON DELETE CASCADE
  status           CHECK IN ('pending','accepted','rejected','withdrawn')
  message          NULL — the optional note (063)
  created_at, decided_at, decided_by → users ON DELETE SET NULL

  UNIQUE (organization_id, user_id) WHERE status = 'pending'   -- idx_..._live
  INDEX  (organization_id, status, created_at)                 -- the queue
  INDEX  (user_id, status)                                     -- the student's view

organization_invitations                            -- 063
  id               PK
  organization_id  → organizations ON DELETE CASCADE
  invited_user_id  NOT NULL → users ON DELETE CASCADE
  invited_by       → users ON DELETE SET NULL
  message          NULL — the optional note
  status           CHECK IN ('pending','accepted','declined','revoked','expired')
  created_at, expires_at, resolved_at

  UNIQUE (organization_id, invited_user_id) WHERE status = 'pending'
  INDEX  (organization_id), INDEX (invited_user_id)
```

**There is no token column on `organization_invitations`, and no email column.**
Both absences are the design, not an omission — see §7.

### What the rebuild had to prove

ENGINEERING_GUIDE §8.3 requires the full guard set for a destructive rebuild of a
table with children. `organization_share_links` has none, but the guards that
matter here are the ones about *its own* rows, because a rebuild that silently
dropped a club's live link would be indistinguishable from somebody having
revoked it — no error, no log, a flyer that stopped working:

- the column probe (`PRAGMA table_info`) makes the rebuild re-runnable;
- an explicit column list, never `SELECT *`;
- row counts before and after, with a throwing mismatch check;
- `PRAGMA foreign_key_check` afterwards;
- every carried row keeps its **token** — asserted value by value in
  `migrations.organizationPublicIdentity.test.js`, because a changed token is a
  broken link — and is labelled `General`, since `label` is NOT NULL.

On PostgreSQL the same shape is a `DO $$ … $$` block that probes `pg_index` and
`pg_constraint` to move the primary key, plus `ADD COLUMN IF NOT EXISTS`. Neither
engine's half is a translation of the other; both are asserted, on a live
PostgreSQL, in `migrations.postgres.test.js`.

### `last_used_at` is a date

Declared as one and stored as one. With a single use on a link — the common case
for a club inviting a handful of people — a full timestamp is a per-student
record of the hour a named child joined, readable by anybody who can read the
club's links. "Used this week" is what a manager acts on.

## 8. API

| Route | Authorization |
|---|---|
| `GET /api/organizations/:key` | `directory.read` — roster now member/manager/moderator only |
| `PATCH /api/organizations/:key` | `organization.manage.own` + `canManage`; mints a link when switching to `invite`; audited |
| `POST /api/organizations/:key/membership` | `organization.join` + `joinAttemptLimiter`; accepts `{ shareToken? }` |
| `GET /api/organizations/:key/share-links` | `organization.join` + `canInvite`; a manager gets all of them, anybody else the one primary link |
| `POST /api/organizations/:key/share-links` | `organization.manage.own` + `canManage`; audited |
| `PATCH /api/organizations/:key/share-links/:linkId` | `organization.manage.own` + `canManage`; rename, expiry or `{rotate:true}` |
| `DELETE /api/organizations/:key/share-links/:linkId` | `organization.manage.own` + `canManage`; audited |
| `GET /api/public/organizations/invite/:token` | **none** — `shareTokenLimiter` |
| `GET /api/public/organizations/:handle` | **none** — the canonical public page |
| `POST /api/organizations/:key/join-requests` | `organization.join` + `joinAttemptLimiter`; accepts `{ message? }` |
| `DELETE /api/organizations/:key/join-requests/mine` | `organization.join` |
| `GET /api/organizations/:key/join-requests` | `organization.manage.own` + `canManage` |
| `POST /api/organizations/:key/join-requests/:id/decision` | `organization.manage.own` + `canManage` |
| `GET /api/organizations/:key/invitations` | `organization.manage.own` + `canManage` |
| `POST /api/organizations/:key/invitations` | `organization.manage.own` + `canManage` + `joinAttemptLimiter`; `{ userId, message? }` |
| `DELETE /api/organizations/:key/invitations/mine` | `organization.join` — the invitee declines |
| `DELETE /api/organizations/:key/invitations/:invitationId` | `organization.manage.own` + `canManage` |

Reviewing requests is **manager-only, not `canHelpRun`**. Admitting somebody is a
standing decision about who is in the club, and the response is a list of named
students a Student Organizer has no need for.

**Reading a link is `invite_policy`; deciding what the links ARE is `canManage`.**
A club that chose "any member may share" is saying its students may pass a URL
on. It is not saying any member may regenerate it and stop every printed copy
working, and nobody choosing the first thing is choosing the second.

**Inviting a named person is `canManage` too**, and deliberately not
`invite_policy`. Handing an address out has a human in the middle, aimed at
somebody they are already talking to. Reaching into another person's
notifications and naming them in the club's records is a decision about the
roster.

**There is no accept endpoint.** Accepting an invitation *is* joining, so the
Accept press goes through `POST …/membership` — which already holds the
capability check, the ban check, the affordance, the capacity and the
transaction. A second route that also created memberships would be a second
implementation of all of it, and the one that drifts is always the newer one.

`GET` never mints. A GET that created a credential would put it in browser
history and hand it to anything that speculatively prefetches — the argument
`POST /api/applications/:id/checkin-code` already makes.

`DELETE …/join-requests/mine` and `DELETE …/invitations/mine` take no identifier,
so neither can be pointed at somebody else's. That is stronger than checking
ownership.

Every link-scoped route matches on `(id, organization_id)` and never on `id`
alone. A handler that trusted the id would let a manager of one club revoke
another club's link — asserted directly in
`organizations.shareLinkAdversarial.test.js`.

### Rate limits

`ORG_INVITE_RATE_LIMIT` (default **120** / 15 min, per device, Redis-backed) on
the public endpoint only. Successes count — a successful resolution is what
enumeration looks like from outside. 120 rather than `verifyLimiter`'s 20 because
the expected shape is a teacher putting a link on the board and thirty students
opening it in one lesson from one school address.

`ORG_JOIN_RATE_LIMIT` (default **20** / 15 min, per **account**) on both join
paths. Keyed on the account and not the address, and this is the only limiter
those routes carry: `shareTokenLimiter` is address-keyed, and mounting it here
would refuse the students at the back of that same class. Both are documented in
`deploy/wevolunteer.env.example`.

## 9. Privacy

Three audiences, decided explicitly.

**Public — a holder of a valid link, or anybody at all if the club chose
`visibility = 'public'` — with no session:** name, handle, slug, mark, colour,
description, tags, member count, event count, `joinPolicy`, and up to three
upcoming opportunities by title, date and category. That is the whole of
`publicOrganization`, and it is an allowlist: the field list is asserted exactly
in three test files, so a column added to `organizations` cannot reach an
unauthenticated reader by being added to the table.

**Signed-in, not a member:** the above, plus `invitePolicy`, `visibility`, the
member *count*, the club's events, and the affordance. Not the roster.

**Members:** the roster through `profileSummary`. **Managers:** additionally
per-member hours within this club, the request queue with its notes, the
outstanding invitations, the ban list, the appeal queue, and the links with
their labels, states and join counts.

**Never public:** any member's name, handle, avatar, rank or hours; the founder's
name; the organization id; announcements and replies; **event locations**; bans;
appeals; requests; hours totals; the token.

Event locations are excluded deliberately: an event's location is where named
minors will physically be at a stated time, and a share link has no business
publishing that outside the platform. The title and the date are the club
advertising itself.

**Two tightenings to existing behaviour.** The roster was returned to every reader
holding `directory.read` — a named list of children in a club the reader has
nothing to do with. Every row went through `profileSummary`, which is the wrong
question: the *list* is the disclosure and no per-field allowlist can answer it.
Non-members now get the count.

**The request note and the invitation note.** A request may carry up to 300
characters the student chose to write, and an invitation up to 300 a manager
wrote. Both are read only by this club's managers — the queue and the
outstanding list are manager-only routes — and neither reaches a roster, a
notification body or an email. Both are stored **verbatim** and rendered as text
in JSX, which React escapes; there is no sanitiser, because stripping would
mangle a child's `<3` while providing no protection escaping does not already
give.

Neither is a message. Written once, not editable, not repliable, and gone when
the request or invitation is resolved. `message.send` is a capability with a
Report button and a conversation behind it, and a club's front door is not the
place to build a second one without either.

**What a link records.** `uses` and `last_used_at`, incremented when somebody
*joins* through it — not when somebody opens it. A view counter on an
unauthenticated endpoint is a write on every anonymous request, and it is
inflatable; a join is authenticated, deliberate and non-repeatable. Nothing
per-visitor is stored: no row per use, no address, no referrer, no session. A
count and a date, which cannot be turned back into who came from where. The join
count is managers-only.

**Who invited you is not disclosed to you.** The club invites, not the individual
member who pressed the button. `viewer.invitation` carries the note and the
expiry and no inviter, because naming them would make a decline an answer to a
classmate rather than to a club — which is exactly the pressure a thirteen-year-old
should not be under. A decline notifies the club not at all, for the mirror
reason: a queue of "so-and-so said no" is how a club's managers end up
discussing it with them.

Notification bodies are minimal for the reason `FRIEND_SIGNED_UP` gives: they are
copied into email, which leaves the building. "Priya Patel asked to join Chess
Club" and nothing else. A rejection carries no reason — the alternative is
inviting a manager to type a judgement about a named minor into a message that
gets emailed.

## 10. Concurrency

| Situation | Settled by |
|---|---|
| Two managers accept the same request | `UPDATE … WHERE id = ? AND organization_id = ? AND status = 'pending'`; the loser sees `changes === 0` → 409 |
| A student presses Request twice, or five times at once | `ON CONFLICT (organization_id, user_id) WHERE status = 'pending' DO NOTHING`, then re-read |
| A student joins while a request is pending | The join transaction retires the request to `withdrawn` |
| A link is rotated or revoked mid-join | The token is resolved inside the handler; there is no cached grant |
| `open` → `invite` | The next tokenless join is refused; existing members are untouched and are never asked for a link |
| `request` → `open` | Pending requests stay decidable; accepting somebody who has already joined is a no-op |
| Two managers invite the same person at once | `ON CONFLICT (organization_id, invited_user_id) WHERE status = 'pending' DO NOTHING`; one 201, one 409 |
| Accept and withdraw race | `UPDATE … WHERE status = 'pending'`; whichever lands first stands, the other reports `already_resolved` |
| Two managers revoke the same link | `UPDATE … WHERE revoked_at IS NULL`; one `true`, one `false`, and the timestamp is the first one's |
| A link is rotated while somebody joins through it | The membership and the answer agree, and the use is counted only if the join succeeded — both inside one transaction |
| An invitation lapses between page load and Join | Refused: `invitationStands` computes expiry rather than waiting for a sweep |

**One PostgreSQL trap, worth remembering.** `requestToJoin` originally let the
insert throw and caught the unique violation. That is correct on SQLite and a trap
on PostgreSQL: a constraint violation aborts the surrounding transaction, so the
re-read after it fails with "current transaction is aborted" — inside the
transaction that also notifies the managers. It failed **once** in a full
`test:postgres` run and passed every time the file ran alone, because a conflict
needs two presses to genuinely overlap. Naming the conflict target avoids the
exception on both engines with no savepoint.

## 11. The page

One information architecture, five readers. What changes is which sections have
content and what the plate offers.

```
the invitation   why this club is suddenly joinable    (only if you were invited)
the plate        who this club is, and the one thing you can do about it
opportunities    what you could sign up for            ┐ left column
the noticeboard  what the club has said                │
members          who is in it                          ┘
your service     what you personally have done for it  ┐ right rail
about            who started it, and how it admits     ┘
manage           invitations, requests, bans, appeals  (managers, separate band)
```

The invitation banner sits **above** the plate, because it is the reason the
page looks the way it does to that reader: an invitation-only club showing a
Join button makes no sense until you know somebody asked you. It carries the
note, the date it lapses, Accept, Decline — and the sentence saying what
declining costs, which is that the club cannot ask again. That was in the toast
afterwards, beside a ghost button a thirteen-year-old can mis-tap.

Accept appears twice on that reader's page: once in the banner and once as the
plate's primary action, because an invitation makes the affordance `join` and
the plate renders the affordance. Considered and kept — giving the banner sole
ownership would mean adding an `invited` affordance to the server's vocabulary
for a cosmetic reason, and removing the plate's control would leave an invited
reader with no primary action. Both do the same reversible thing and both are
labelled unambiguously; what the banner adds is the Decline, which has no other
home.

The plate carries the club's mark on a ground of its **own colour** —
`avatar_color` has existed since migration 043 and tinted a 22-pixel circle. It
is used in exactly two places (the emblem and a 3px spine) and never as a filled
band: those eight values are pale in dark mode too, so a band would be a bright
slab. The emblem's glyph is `--neutral-900` and not `--ink` for the same reason: a
fixed pale ground takes a fixed ink, or it is near-white on near-white every
night.

The club's vital statistics sit **above** the name in `--font-mono` — the register
this application uses for figures and for a certificate code, which is what stops
the masthead reading as the event page's four info pills with different labels.

**Leaving is not the primary control.** A member's primary control is a state;
leaving moved into the actions menu, because it used to occupy the position a
newcomer's Join occupies.

### Five states, one page

| Reader | Plate offers | Sees |
|---|---|---|
| no account, `@handle`, public club | Join / Request, or nothing on an `invite` club | the public projection, standalone |
| no account, bare path | "This page needs an account" | nothing about the club — no lookup is made |
| signed in, not a member | Join / Request / "ask for the link" | the club, the count, the events |
| invited | a banner above the plate: the note, the expiry, Accept and Decline | as above, plus the reason it is joinable |
| member | "You are a member" | the roster, their own service record |
| manager | the same, plus Share and Settings | the manage band: invitations, requests, bans, appeals |

The bare-path asymmetry is the design. `/organizations/:key` is declared in
**both** `APP_ROUTES` and `PUBLIC_ROUTES`, separated by session rather than by
path — `shellWhenSignedIn` tells `isPublicPath` to stand down when there *is* a
session, so a member opening their club's public address still gets the shell,
their navigation and a Join their session can complete. Signed out, the `@` form
opens the projection and the bare form says the page needs an account, without
looking anything up. Looking the bare form up would quietly make every club's
page public, including the ones that never chose to be, and would make the page
an oracle for which clubs exist.

`routeGating.guard.test.js` Guard 4 asserts that `shellWhenSignedIn` is actually
honoured — that `isPublicPath` answers differently for the two sessions, and that
App.jsx passes the session at all. Without it the flag would be a comment and the
public view would take over every organization page for every member.

`OrganizationInvite` and `OrganizationPublic` share `PublicOrganizationView`, so
both render the same allowlisted projection. Sharing the renderer is what keeps
the **absent** half honest: the allowlist is only as good as the least careful of
its two renderers. What is not shared is the action, because that is exactly
where they differ — a link is a credential and a handle is not.

Both name the browser tab after the club through `useDocumentTitle`. They render
outside the shell, so `PAGE_META` — keyed by route — cannot name them, and every
tab said just "WeVolunteer". That is worst precisely here: this is a page somebody
was *sent*, and it is the tab they leave open while deciding whether to make an
account.

### The return-to, and why it is not one

Pressing Join with no account opens a dialog and, on either choice, writes
`{ slug, token }` to `sessionStorage` before navigating. After signing in,
`handleLoginSuccess` reads it once and navigates to `organizationPath(slug)`.

The token half is optional: somebody who arrived at a club's *public* address
holds no invitation, so the record is the slug alone, and the Join that follows
is judged by `join_policy` with nothing in hand.

This is **not** a `returnTo`. A `returnTo` accepts a path and goes there, and
keeping it safe means maintaining a validator for ever. What is stored here is a
slug this server produced, interpolated into a fixed prefix — so there is no input
that can make it navigate anywhere else, nothing to validate, and no
open-redirect surface to get wrong. It is per-tab, spent once, and every access is
wrapped, because `sessionStorage` throws rather than returning null in a private
window.

## 12. Rolling it back

**Migration 062 is additive; 063 is not.** A code revert to before 063 leaves a
database whose `organization_share_links` has an `id` primary key where the old
code expects `organization_id` — so reverting the code alone is not safe past
063, and that is the one thing to know about this feature operationally.

Reverting to *before 062* is safe from either point: the old code reads none of
these columns or tables.

Operationally, five statements undo the feature's effects with no deploy:

```sql
UPDATE organization_share_links SET revoked_at = datetime('now')  -- every link stops resolving
  WHERE revoked_at IS NULL;
UPDATE organizations SET join_policy = 'open';        -- every club joinable again
UPDATE organizations SET visibility  = 'unlisted';    -- no club has a public page
UPDATE organization_join_requests   SET status = 'withdrawn' WHERE status = 'pending';
UPDATE organization_invitations     SET status = 'revoked'   WHERE status = 'pending';
```

Nobody loses a membership: `organization_members` is untouched by all five. The
first is an `UPDATE` and not a `DELETE` on purpose — it is the same revocation a
manager performs, so the club's own record of which links worked survives being
switched off wholesale.

There is deliberately no feature flag — it would be a fourth thing to wire
through every new route, and these statements are a better answer.

## 13. The two soft limits, and why they stay soft

`SOFT_MAX_LIVE_LINKS` (10) and `SOFT_MAX_PENDING_INVITATIONS` (100) are checked
with a read followed by a write, so a concurrent burst can overshoot. Reviewed
deliberately at pre-launch hardening; advisory is the correct design, on four
grounds, each asserted in `organizations.softLimits.test.js`:

**1. Nothing in authorization reads either.** Who may create a link or send an
invitation is `requireCap('organization.manage.own')` and `canManage`. Neither
consults a count, so no security decision changes when a count is wrong.

**2. Overshoot is bounded and self-correcting.** Measured rather than reasoned
about: an eight-way burst against a club holding nine produced **seventeen**
live links, and the very next attempt refused every one. Each attempt re-reads,
so a burst of N overshoots by at most N and the breach does not compound.

**3. The bounds that matter are enforced properly, elsewhere.**

| Question the ceiling looks like it answers | What actually answers it |
|---|---|
| Can a manager spam one person with invitations? | `idx_org_invitations_live` — a partial UNIQUE index. One pending invitation per person per club, enforced by the **database** |
| Can they ask again after a no? | The decline-is-final rule in `inviteUser` |
| Can they blast a hundred people quickly? | `joinAttemptLimiter` — 20 per 15 minutes, keyed on the **account** |
| Can they mint links without bound? | `apiLimiter`, plus the ceiling itself: sustained creation requires sustained revocation, because the check re-reads |

**4. Exceeding either crosses no privilege boundary.** The actor is a manager of
that club, who can already hand the club's one link to any number of people. A
club briefly holding seventeen links it can see and revoke is not a state an
attacker gains anything from creating.

Hard enforcement would mean a lock held across a write, or a counter column with
its own drift problem. Neither is worth paying for the above — and the rule the
brief sets is the right one: do not harden merely because hard limits sound
safer.

**What was fixed instead.** The names now carry a `SOFT_` prefix, so a reader of
`if (count >= SOFT_MAX_LIVE_LINKS)` asks the right question about concurrency
rather than assuming the database is holding the line. Both constants state that
authorization does not read them. And the manager-facing copy stopped claiming a
constraint: "This organization has as many working links as it can have" became
the number the server actually applied.

## 14. What was considered and refused

Recorded so the next person does not have to re-derive it.

| Idea | Why not |
|---|---|
| Invitation by email address | §5 — an enumeration oracle over `PRIVILEGED_FIELDS`, a less-trusted actor than the admin flow's, and a phishing capability aimed at minors |
| A fourth join mode (`discoverable`) | §3 — visibility is orthogonal to admission, and folding them loses "findable, with a door" |
| A third visibility value ("members only") | §3 — changes nothing a manager can observe |
| A bearer token on an invitation | §5 — the identity *is* the authority, so a token is a redundant secret |
| Per-use rows for link analytics | §9 — a per-student trail through a club's recruitment; a count and a date answer the manager's actual question |
| Counting page views rather than joins | §9 — a write on every anonymous request, and inflatable |
| Forcing an expiry on links | The flyer on the wall in September must work in May. Optional, never imposed, and warned about at creation |
| A redirect table for old handles | Nothing needs one now that renaming does not move the address |
| A notification when an invitation is withdrawn | A student's first news of a club should not be that it changed its mind |
| A notification when an invitation is declined | A queue of "so-and-so said no" is how managers end up discussing it with them |
| Telling the invitee who invited them | Makes a decline an answer to a classmate rather than to a club |
| Sanitising the notes | Escaping already handles it; stripping mangles a child's `<3` |
| A legal/privacy update | §9 — the public projection discloses nothing the notice's "Who can see your information" section contradicts, and it makes no exhaustiveness claim. Account-to-account invitations are already covered. **This stops being true the moment a public page publishes a member's name or an event's location** |
| Rotating a club's links when the join setting tightens | A link on a printed flyer has to keep working; silently invalidating it is the worse failure. Both screens warn instead — see §9 |
| Filtering the invite search to people the server would accept | The directory endpoint has six other callers and no membership flag. The one refused case this component can already see — somebody it has an outstanding invitation for — is marked and unpickable; the rest refuse on the server with a sentence naming the person |
| A confirmation dialog on declining an invitation | It removes nothing the reader has. What it needs is the consequence *before* the press — that the club cannot ask again — and that is a sentence |

### The guards that keep the arguments above honest

Several of the claims in this document are load-bearing, so they are asserted
rather than trusted:

| Claim | What fails if it stops being true |
|---|---|
| The public projection discloses only the allowlist | `routes.organizationPublicPage.test.js` asserts the field list exactly, in three places |
| The visibility setting's disclosure sentence is complete | `organizations.publicDisclosureCopy.test.js` derives the projection's fields and fails on one the sentence does not account for |
| A public page carries no member and no event location | The same file, including inside the nested `upcoming` shape |
| An invitation carries no token and no email column | `migrations.organizationPublicIdentity.test.js` and `migrations.postgres.test.js` assert the ABSENCE on both engines |
| `shellWhenSignedIn` is honoured | `routeGating.guard.test.js` Guard 4 asserts `isPublicPath` answers differently for the two sessions, and that App.jsx passes the session at all |
| The public endpoints are rate-limited | `routes.organizationPublicPage.test.js` reads the mount out of `app.js` |
| An id cannot be claimed as a handle | `organizationHandles.test.js`, with the real id shape |
