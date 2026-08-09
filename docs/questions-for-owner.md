# Questions for the Owner

Updated 2026-08-07 (second autonomous run). **Work continued past every one of these**
under the stated assumption; each is cheap to reverse.

**Resolved since the last version** — no action needed:

| Was | Now |
|---|---|
| Q-A · CLI audit actor | **Done.** Migration 022 seeds a reserved `system-cli` account; all four privileged CLI commands record against it with `method=CLI` |
| Q-E · `make-admin.mjs` auditing | **Done.** It wrote nothing at all; it now writes `ADMIN_PROMOTED_CLI` in the same transaction as the promotion, through the shared mechanism |
| Q-D · owner bootstrap | **Done and verified.** Both accounts exist, hold no usable password, and appear on the roster with "Never" for last sign-in. See Q-1 below for the one thing left |

---

## Q-1 · Claim the two owner accounts

**Question.** Neither bootstrap owner has set a password yet. Both hold a bcrypt hash of a
discarded random value, so nobody can sign in as either.

**Why it matters.** The reset link goes to the address on the account. Until both are
claimed, the platform has two owners nobody can use, and `bin/grant-ownership.mjs` is the
only way to make another.

**Current behaviour.** The accounts are `super_admin`, verified, active, and visible on the
Admin Roster showing "Never" for last sign-in — which is exactly what an unclaimed account
looks like.

**Recommendation.** Claim both this week via "Forgot password", confirm sign-in works, then
rotate on a schedule. An owner account is the only one nobody else can suspend or demote.

**Alternatives.** (a) Claim one and keep the master account as a break-glass credential — 
defensible, but its reset path is then untested when you need it. (b) Connect both to OAuth
instead of a password.

**Implemented meanwhile.** Nothing depends on this; every other feature works.

---

## Q-2 · ~~Should the event taxonomy become impact-oriented?~~ — ANSWERED 2026-08-07

**Owner's answer: organizer-created tags. No fixed taxonomy.** This supersedes the
recommendation below, which proposed a curated tag vocabulary.

**BUILT 2026-08-08.** `event_tags(event_id, tag, label)` many-to-many, `events.category`
kept and untouched, normalisation on `tag` (lower-cased, `#` stripped, whitespace
collapsed) with `label` preserving the organizer's spelling — so `#NHS`, `#nhs` and
`# NHS` are one concept that still renders the way its author wrote it. Filtering is
server-side in the browse query, OR within the tag facet and AND with every other
filter. See `server/eventTags.js` for the model and the limits.

Two parts of the caution above are NOT yet addressed, deliberately, and are the
follow-up work:

- **Impact aggregation still reads `events.category`, not tags.** Nothing regressed —
  the dashboard is exactly as honest as it was — but the "where the effort went"
  improvement this answer was originally about has not been taken. When it is, tag
  buckets must carry the same five-volunteer suppression every other breakdown uses.
- **Tags are not suppressed anywhere yet**, because nothing aggregates them yet.
  A tag is currently only ever shown on the event its own organizer put it on, which
  discloses nothing about who volunteered.

Original analysis kept below for the record.

### Original

**Question.** The taxonomy is `School | 5K | Food Pantry | Fundraiser | Other`, enforced by a
CHECK constraint. The impact brief asks for need-oriented categories — Education, Food
Security, Environment, Healthcare, Youth & Families, Senior Services, Animal Welfare,
Disaster Relief, Arts & Culture, Community Services, Civic Engagement.

**Why it matters.** "Where the effort went" is the section meant to tell a community what it
needs, and the current five cannot: `5K` is a format, `Fundraiser` is a mechanism, and `Other`
is a shrug that a large share of real events land in. A grant reader cannot use it.

**Current behaviour.** The Impact Dashboard reports whatever categories exist and needs no
change when they change. Nothing was widened — redefining a product taxonomy while nobody is
awake is not a call to make autonomously.

**Recommendation — a tag table, not a wider enum.** The brief itself asks for "a flexible
tagging architecture that can expand later", and an enum cannot be that.

1. New `event_tags` table (`event_id`, `tag`), many-to-many, so one event can be Education
   *and* Youth & Families — which is true of most school events and unrepresentable today.
2. Keep `events.category` as-is, populated and constrained, so nothing that reads it breaks.
3. Backfill tags from existing categories: `Food Pantry` → Food Security, `School` →
   Education, `5K` → Community Services + Health, `Fundraiser` → Community Services, `Other`
   → untagged (deliberately: inventing a need for it would be fabricating the data the
   dashboard exists to report).
4. Impact reads tags when present and falls back to `category`, so the dashboard improves as
   organizers tag and never shows a gap.
5. Retire `category` from the UI once tag coverage is high; drop it only after.

**Alternatives.** (a) Widen the enum and map the five forward — simpler, but keeps one
category per event, which is the limitation causing the problem. (b) Free-text tags — richer
input, much harder aggregation, and a privacy hazard since organizers would type specifics.
(c) Leave it, and drop "community needs" from the dashboard's stated purpose.

**Implemented meanwhile.** The dashboard's category section is live and correct against the
real taxonomy. No migration was written.

---

## Q-12 · Activity-specific hours (NHS, clubs, school service) — DESIGNED, NOT BUILT

**Asked 2026-08-08. Recorded rather than implemented, because the architecture is
sound and one product/legal decision is genuinely yours.**

### What the audit found

Hours live in exactly one place: `attendance(slot_id, user_id, present, hours_awarded)`,
credited per SHIFT, and the authoritative total is derived on every read as
`SUM(hours_awarded) WHERE present = 1` (INV-001 — never stored). Every consumer
reads that same derivation: `server/hoursLedger.js`, the milestone ladder in
`server/milestones.js`, `badgeService`, certificates, the transcript, the data
export, and the Impact Dashboard.

There is **no existing concept that can carry a programme**. `events.category` is a
fixed five-value CHECK enum describing what an event IS, not who the hours count
for. Event tags (built 2026-08-08) are organizer free text for DISCOVERY and must
not be reused here — see Q-2 and the header of `server/eventTags.js`.

### Recommended architecture

**Put the programme on the ATTENDANCE row, not on the event and not on the user.**

    programs(id, name, slug, created_by, active, created_at)
    attendance.program_id  →  nullable FK, NULL meaning "General"

Three reasons it belongs there:

1. **The same event serves different programmes for different students.** One food
   drive is NHS hours for one volunteer and Key Club hours for another. On the
   event, that is unrepresentable; on the user, it cannot vary per shift.
2. **Hours stay authoritative and singular.** `SUM(hours_awarded) WHERE present = 1`
   is unchanged and remains the ONE total. A per-programme figure is the same sum
   with `GROUP BY program_id` — a breakdown of the authoritative number, never a
   second number that can disagree with it. This is the property that must not be
   given up, and it is why a `nhs_hours` column would be wrong.
3. **No migration per organisation.** `programs` is a table, so Key Club, Student
   Council and "Mrs Alvarez's tutoring group" are rows. NHS is an example, not a
   schema.

`NULL` rather than a seeded "General" row: a nullable column needs no backfill, so
every existing attendance row keeps its meaning, and "General" is a rendering
decision rather than a piece of data somebody could delete.

### The decision that is yours

**Who may assert that hours count toward an external organisation, and how it is
worded.** This platform cannot verify NHS's requirements, so it must not appear to
certify them. The honest split:

- an organizer marks an event's **eligible** programmes (a claim about intent);
- a student's record says **"Recorded as NHS hours"**, never "Approved by NHS";
- the transcript and certificate wording needs your sign-off, because that is the
  artefact a college or an adviser reads.

**Recommendation.** Build the schema above; let organizers nominate eligible
programmes; render "Recorded as — not verified by —" wording everywhere it
surfaces; and keep the platform-wide total exactly as it is. Do NOT let a tag
become a programme automatically.

**Implemented meanwhile.** Nothing. Hours remain a single undifferentiated total,
which is correct-but-less-useful rather than wrong, so shipping the tags and the
date picker first cost nothing here.

---

## Q-3 · ~~Should the Impact Dashboard have a public view?~~ — BUILT 2026-08-07, REVERSED 2026-08-08

**The owner's answer was no, and the premise was wrong rather than the build.**

"Public Community Metrics" was read as a page for strangers. It was not: the figures were wanted
as an internal view of how the programme is doing, for the platform owner. So the public surface
is REMOVED, not re-gated:

- `GET /api/public/impact` is deleted. `routes.adminImpact.test.js` asserts it 404s, because a
  route that still exists is a route somebody can still call.
- `/community` is gone from the route table and from the sign-in page's footer.
- The figures now live at `/admin/impact`, behind `analytics.platform` — SUPER_ONLY, so `can()`
  refuses it before it consults per-user grants and no capability grant can reach it.

**What the reversal changed about the payload.** The deliberately-small public shape was correct
for an audience of anybody at all, and it protected nobody once the audience became the one
account that can already read the roster and the audit trail. `/api/impact` has always served the
full payload to `analytics.impact`, which every signed-in role holds, so a super_admin could
already read all of it. The dashboard therefore serves the whole thing — including the month
series, which is the only figure that answers "is participation rising" and the reason the owner
wanted this at all. The per-bucket `MIN_BUCKET` suppression is untouched: it protects students
from being described individually and applies to this reader exactly as it does on `/api/impact`.

**What was dropped.** The availability floor that refused to publish anything below five
volunteers. That floor was about a stranger reading a page about four named children; telling the
owner of a four-volunteer programme "not published yet" about their own platform was a bug
wearing a privacy argument.

Original analysis kept below for the record. Note that its threat model — "a reader is a known
account today, and would be anybody tomorrow" — is the thing that turned out not to apply.

### Original

**Question.** It is behind sign-in (`analytics.impact`, held by every role). Three of its four
stated purposes — marketing, grants, community trust — are about people without accounts.

**Why it matters.** A grant reviewer will not create an account, and a link that asks them to
is a link they do not open. But publishing changes the threat model: today a reader is a known
account, tomorrow anybody, including somebody correlating a small figure against what they
know about a specific school.

**Current behaviour.** Authenticated only. Suppression below five volunteers is applied
server-side to every breakdown, so this is a gate change rather than a rewrite.

**Recommendation.** A separate public route showing **only the four community totals** —
volunteers, hours, events, organizations. Totals over the whole population identify nobody;
the categories and months carry the risk and are the part a grant reader least needs.

**Alternatives.** (a) Keep it private and export a PDF for applications. (b) Publish
everything with `MIN_BUCKET` raised from 5 to ~15. (c) Publish behind an unguessable link — 
security by obscurity, and it would end up indexed.

**Implemented meanwhile.** Nothing public. The suppression, the totals and the endpoint are
all in place, so the public variant is a route and a gate.

---

## Q-4 · ~~The Youth Safety Guidelines promise less than the platform now does~~ — RESOLVED 2026-08-07

**Resolved by the owner's decision to make legal content hashes advisory before launch.** The
blocker was never the wording: it was that editing a published document invalidated every
acceptance record, which made a one-sentence correction a legal decision. With
`LEGAL_HASHES_ENFORCED` false, documents stay at version 1.0 and the text can be corrected.

The sentence now reads: opening preserved messages requires the administrator to re-enter their
password at that moment, the permission to do it is separate from the permission to decide the
report, and each access is recorded against that specific report in a log that cannot be edited
or deleted. All three of those are true and tested.

Original question kept below for the record.

### Original

**Question.** The published text says reading a student's private messages "is the one
situation in which an administrator reads private messages, and it is logged." As of this run
it also requires a fresh identity verification bound to that specific report. The promise got
stronger; the text has not caught up.

**Why it matters.** The guidelines are what a parent or a district reads. Understating a
protection is better than overstating one, but a document that lags the product loses
authority the next time somebody checks it.

**Current behaviour.** Unchanged, deliberately. Published legal documents are pinned by
content hash and `syncLegalDocuments` throws if a published version's content changes —
editing the live text would invalidate every acceptance record on the platform. That makes it
a version bump, which is a legal decision.

**Recommendation.** Add one sentence at the next version bump: "Opening preserved messages
requires the administrator to re-enter their password, and each access is recorded against
that specific report." Ship it with the next scheduled legal revision rather than on its own.

**Alternatives.** (a) Leave it — the text is not false, only incomplete. (b) Bump now, which
means a re-acceptance flow for every user for one sentence.

**Implemented meanwhile.** The protection is live and tested
(`server/routes.evidenceStepUp.test.js`); only the wording lags.

---

## Q-5 · Should administrators hold `report.evidence.read` at all?

**Question.** An ordinary administrator can read the private message bodies a report
preserved. Full analysis in `docs/trust-safety/03-EVIDENCE-ACCESS-REVIEW.md`.

**Why it matters.** It is the most invasive read on the platform, and the population is mostly
minors.

**Current behaviour.** Held by `admin` and `super_admin`, now behind a step-up bound to the
report, logged to two trails in the same transaction as the read.

**Recommendation.** Keep it. On a one-to-two-person team the administrator *is* the moderator,
so owner-only would mean either the owner reads every report or administrators decide reports
without seeing them — worse for the student on both sides. This is a staffing question rather
than a technical one, and the capability is already split from `report.resolve` precisely so a
per-user grant can create a triage helper who never reads a body. That is the mechanism to
reach for if the team grows.

**Alternatives.** (a) Owner-only. (b) Restrict to reports assigned to the reader — closes
casual browsing but blocks the triage step that assigns them. (c) Time-box access to reports
opened in the last N days, which breaks appeal review.

**Implemented meanwhile.** Step-up added; capability unchanged.

---

## Q-6 · A stale database sits outside the repository — inspect and delete?

**Question.** There is a `pilot.db` one level *above* the repository, at
`New Projects/pilot.db`. It has 15 migrations and 14 users. The live database, at the
repository root, has 23 and 18. Should the stale one be deleted?

**Why it matters.** It is the physical evidence of a real bug, now fixed: the four
privileged CLI scripts resolved a relative `WEV_DB_PATH` against the working directory,
and `new DatabaseSync` creates an absent file, so a privileged command wrote a brand-new
empty database and reported success about it. Full analysis in
`docs/audits/04-PRIVILEGED-CLI-DATABASE-TARGET.md`.

Left in place, it is a loaded gun: anything that resolves a path slightly differently
finds a plausible-looking WeVolunteer database with real-looking rows in it.

**Current behaviour.** Untouched. It sits outside the repository, where this work has no
business writing, and deleting a database that might hold the only copy of something is
not a call to make autonomously.

**Recommendation.** Open it, confirm it holds nothing that is not also in the live
database — particularly any `hours_ledger` rows, since credited hours are the one thing
here that cannot be reconstructed — then delete it with `trash` rather than `rm`. Also
worth considering: change `.env` to an **absolute** `WEV_DB_PATH`. The fix makes a
relative value unambiguous, but an absolute one cannot be misread by a tool that has not
been fixed yet.

**Alternatives.** (a) Rename it to `pilot.db.stale-20260807` and keep it a while — safer,
and it stops anything finding it by accident. (b) Leave it; the resolver now refuses to
create databases and anchors relative paths, so nothing in the repository points at it.

**Implemented meanwhile.** The bug is fixed, the three properties are mutation-tested,
and every privileged script now prints which database it opened.

---

## Q-7 · Two `TFA_ENCRYPTION_KEY` lines in your local `.env`, with different values

**Question.** `.env` contains `TFA_ENCRYPTION_KEY` twice, on consecutive lines, holding two
*different* 32-byte keys. Which one do you want?

**Why it matters.** Node's `--env-file` is last-wins, so line 31 is the effective key. Any TOTP
secret encrypted while line 30 was effective would be permanently undecryptable — the affected
user could not sign in and would have to be reset with `bin/reset-2fa.mjs`.

**Current behaviour.** Harmless *today*: the active database has not yet run the migration that
adds the column, so no secret is encrypted under either key. That stops being true the first
time somebody enrols.

**Recommendation.** Delete line 30, keep line 31, and do it before anybody enrols. I did not edit
the file myself — it holds live secrets, and removing one is not a change to make on somebody's
behalf without them looking.

**Also worth knowing.** This key has no rotation path. Changing it makes every stored TOTP secret
undecryptable, and the only recovery is clearing each account's enrolment one at a time. The
`v1:` prefix on stored values anticipates versioned re-encryption, but nothing implements it. If
you want key rotation to be possible later, that is a small piece of work to do while there are
no enrolments to migrate.

**Implemented meanwhile.** `TFA_ENCRYPTION_KEY` is documented in `.env.example` and
`.env.production.example`, production refuses to boot without it, and development falls back to a
known insecure key with a warning rather than exiting.
