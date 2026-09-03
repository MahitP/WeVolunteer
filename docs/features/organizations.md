# Organizations: invitation links, membership policy, and the page

How a club is shared, who gets into it, and where each of those decisions is
enforced. Written for whoever has to change this next.

Shipped 2026-09-03. Migration 062. The design that preceded it is in
`docs/superpowers/specs/2026-09-03-organization-share-links-design.md`, including
the ideas that were rejected and why.

## 1. The four invariants

Everything else follows from these, and none of them is obvious from the schema.

**The invitation link is an address, not a credential.** It opens
`publicOrganization` — the club's own advertisement — and, on a club whose
`join_policy` is `invite`, it makes a Join press succeed. It grants no session,
no capability, and it never makes anybody a member by itself. Membership is
always an explicit act by a signed-in account.

**The token is resolved at the moment of the act, from the request body.** Never
in a query string, never cached against a session, never turned into a grant that
outlives the request. That is the only reason rotating or switching off a link
takes effect on the next request rather than whenever a page happens to reload.
It is also why the join route asks `tokenOpens(db, thisOrganization, token)`
rather than "did this token resolve to something": a Chess Club link must not
open the Robotics Club.

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

## 2. Membership policy

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

## 3. Why the token is stored verbatim

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

## 4. Schema

Migration 062, additive on both engines. Two columns and two tables, no rebuild,
so none of the ENGINEERING_GUIDE §8.3 guard set applies.

```
organizations
  join_policy    TEXT NOT NULL DEFAULT 'open'
  invite_policy  TEXT NOT NULL DEFAULT 'helpers'

organization_share_links
  organization_id  PK → organizations ON DELETE CASCADE
  token            NOT NULL UNIQUE          -- supplies the lookup index
  created_at, created_by → users ON DELETE SET NULL, rotations

organization_join_requests
  id               PK
  organization_id  → organizations ON DELETE CASCADE
  user_id          → users ON DELETE CASCADE
  status           CHECK IN ('pending','accepted','rejected','withdrawn')
  created_at, decided_at, decided_by → users ON DELETE SET NULL

  UNIQUE (organization_id, user_id) WHERE status = 'pending'   -- idx_..._live
  INDEX  (organization_id, status, created_at)                 -- the queue
  INDEX  (user_id, status)                                     -- the student's view
```

`organization_id` is the share link's **primary key**, so there is one live link
per club: rotation is an `UPDATE` with no window in which the club has no link,
and switching off is a `DELETE`. Nothing needs to tell two links apart.

`idx_org_join_requests_live` **is** the "no duplicate active requests" rule. It
is partial so a declined student may ask again in March, and the whole history
survives. `withdrawn` covers both "the student cancelled" and "they got in by
another route, so nobody needs to decide it" — `decided_by` staying NULL is what
says nobody did.

## 5. API

| Route | Authorization |
|---|---|
| `GET /api/organizations/:key` | `directory.read` — roster now member/manager/moderator only |
| `PATCH /api/organizations/:key` | `organization.manage.own` + `canManage`; mints a link when switching to `invite`; audited |
| `POST /api/organizations/:key/membership` | `organization.join` + `joinAttemptLimiter`; accepts `{ shareToken? }` |
| `GET /api/organizations/:key/share-link` | `organization.join` + `canInvite` (the club's `invite_policy`) |
| `POST /api/organizations/:key/share-link` | `organization.manage.own` + `canManage`; audited |
| `DELETE /api/organizations/:key/share-link` | `organization.manage.own` + `canManage`; audited |
| `GET /api/public/organizations/invite/:token` | **none** — `shareTokenLimiter` |
| `POST /api/organizations/:key/join-requests` | `organization.join` + `joinAttemptLimiter` |
| `DELETE /api/organizations/:key/join-requests/mine` | `organization.join` |
| `GET /api/organizations/:key/join-requests` | `organization.manage.own` + `canManage` |
| `POST /api/organizations/:key/join-requests/:id/decision` | `organization.manage.own` + `canManage` |

Reviewing requests is **manager-only, not `canHelpRun`**. Admitting somebody is a
standing decision about who is in the club, and the response is a list of named
students a Student Organizer has no need for.

`GET` never mints. A GET that created a credential would put it in browser
history and hand it to anything that speculatively prefetches — the argument
`POST /api/applications/:id/checkin-code` already makes.

`DELETE …/join-requests/mine` takes no identifier, so it cannot be pointed at
somebody else's request. That is stronger than checking ownership.

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

## 6. Privacy

**Public, to a holder of a valid link, with no session:** name, slug, mark,
colour, description, tags, member count, event count, `joinPolicy`, and up to
three upcoming opportunities by title, date and category.

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
Non-members now get the count. And a request publishes `profileSummary` and
nothing more — no grade, no school, no email, and no message, because the request
deliberately carries none.

Notification bodies are minimal for the reason `FRIEND_SIGNED_UP` gives: they are
copied into email, which leaves the building. "Priya Patel asked to join Chess
Club" and nothing else. A rejection carries no reason — the alternative is
inviting a manager to type a judgement about a named minor into a message that
gets emailed.

## 7. Concurrency

| Situation | Settled by |
|---|---|
| Two managers accept the same request | `UPDATE … WHERE id = ? AND organization_id = ? AND status = 'pending'`; the loser sees `changes === 0` → 409 |
| A student presses Request twice, or five times at once | `ON CONFLICT (organization_id, user_id) WHERE status = 'pending' DO NOTHING`, then re-read |
| A student joins while a request is pending | The join transaction retires the request to `withdrawn` |
| A link is rotated or revoked mid-join | The token is resolved inside the handler; there is no cached grant |
| `open` → `invite` | The next tokenless join is refused; existing members are untouched and are never asked for a link |
| `request` → `open` | Pending requests stay decidable; accepting somebody who has already joined is a no-op |

**One PostgreSQL trap, worth remembering.** `requestToJoin` originally let the
insert throw and caught the unique violation. That is correct on SQLite and a trap
on PostgreSQL: a constraint violation aborts the surrounding transaction, so the
re-read after it fails with "current transaction is aborted" — inside the
transaction that also notifies the managers. It failed **once** in a full
`test:postgres` run and passed every time the file ran alone, because a conflict
needs two presses to genuinely overlap. Naming the conflict target avoids the
exception on both engines with no savepoint.

## 8. The page

One information architecture, five readers. What changes is which sections have
content and what the plate offers.

```
the plate        who this club is, and the one thing you can do about it
opportunities    what you could sign up for            ┐ left column
the noticeboard  what the club has said                │
members          who is in it                          ┘
your service     what you personally have done for it  ┐ right rail
about            who started it, and how it admits     ┘
manage           the controls, in a visibly separate band
```

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

`OrganizationInvite` renders the same masthead from the public projection, so
somebody arriving with a link sees the club presented the way a member does. A
signed-in reader is redirected to the real page with the token stashed.

### The return-to, and why it is not one

Pressing Join with no account opens a dialog and, on either choice, writes
`{ slug, token }` to `sessionStorage` before navigating. After signing in,
`handleLoginSuccess` reads it once and navigates to
`` `/organizations/${encodeURIComponent(slug)}` ``.

This is **not** a `returnTo`. A `returnTo` accepts a path and goes there, and
keeping it safe means maintaining a validator for ever. What is stored here is a
slug this server produced, interpolated into a fixed prefix — so there is no input
that can make it navigate anywhere else, nothing to validate, and no
open-redirect surface to get wrong. It is per-tab, spent once, and every access is
wrapped, because `sessionStorage` throws rather than returning null in a private
window.

## 9. Rolling it back

The migration is additive, so a code revert leaves a working database on both
engines: two unread columns and two unread tables.

Operationally, three statements undo the feature's effects with no deploy:

```sql
DELETE FROM organization_share_links;                 -- every link stops resolving
UPDATE organizations SET join_policy = 'open';        -- every club joinable again
UPDATE organization_join_requests SET status = 'withdrawn' WHERE status = 'pending';
```

Nobody loses a membership: `organization_members` is untouched by all three.
There is deliberately no feature flag — it would be a fourth thing to wire
through every new route, and these three statements are a better answer.
