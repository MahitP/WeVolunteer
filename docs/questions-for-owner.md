# Questions for the Owner

Raised 2026-08-07. **Work continued past every one of these** under the stated
assumption — none blocked implementation, and each is cheap to reverse.

Supersedes `docs/audits/questions-for-owner.md`, whose five questions have all been
answered by the Q1–Q5 decisions.

---

## Q-A · Should a CLI ownership change be attributable to a person?

**Question.** `admin_audit_logs.admin_id` is a foreign key to `users`, and migration 019
added a trigger refusing to delete any account that has written an audit row. So the column
must hold a real account — and a shell operator is not one. Both ownership scripts therefore
record the **subject** as the actor, which read alone says "this person granted themselves
ownership".

**Why it matters.** Ownership is the most consequential change the platform can undergo, and
its audit row currently misattributes it. The details line states the truth explicitly
(`method=CLI`, `operator=<login>@<host>`, and a note saying the actor is the operator, not
the subject), so the record is not misleading to anyone who reads it — but the structured
`admin_id` field is still wrong, and that is the field a future query would group by.

**Current assumption.** Implemented as above: correct in the prose, wrong in the column,
with the discrepancy stated in the row itself.

**Recommended option.** A reserved `system-cli` user row, seeded by migration, referenced by
every `bin/` script that mutates privilege. It keeps the foreign key honest, makes CLI
actions groupable in the Audit Explorer, and costs one row that exists only to be pointed at.

**Alternatives.** (a) Leave it — the prose carries the truth. (b) Drop the foreign key, which
would let any string go in the column and lose the deletion protection 019 added. (c) Add a
nullable `actor_note` column, which is the same information in a place nothing reads.

---

## Q-B · Should the Impact Dashboard be public?

**Question.** It is currently behind sign-in (`analytics.impact`, held by every role). Three
of the four stated purposes — marketing, grants, community trust — are about people who do
not have accounts.

**Why it matters.** A grant reviewer will not create an account, and a link that asks them to
is a link they do not open. But publishing to unauthenticated visitors changes the threat
model: today a reader is a known account; tomorrow they are anybody, including somebody
correlating a small figure against what they know about a specific school.

**Current assumption.** Authenticated only. The suppression threshold is already applied
server-side, so this is a gate change rather than a rewrite.

**Recommended option.** A separate public route showing **only** the four community totals —
volunteers, hours, events, organizations — with no breakdowns at all. Totals over the whole
population identify nobody; it is the categories and months that carry risk, and they are the
part a grant reader least needs.

**Alternatives.** (a) Keep it private and export a PDF for grant applications. (b) Publish the
whole page, raising `MIN_BUCKET` from 5 to something like 15. (c) Publish behind an
unguessable link, which is security by obscurity and would end up in a search index.

---

## Q-C · Should the event category list be widened?

**Question.** The impact brief names Education, Food Security, Environment and Healthcare as
example categories. The real taxonomy is `School | 5K | Food Pantry | Fundraiser | Other`,
enforced by a CHECK constraint on `events.category`.

**Why it matters.** "Where the effort went" is the section that tells a community what it
needs, and the current five do not describe need — `5K` is a format and `Other` is a shrug.
Roughly half of real events land in `Other`, which is where a category system goes to die.

**Current assumption.** The impact module reports whatever categories exist and needs no
change when they change. Nothing was widened: redefining a product taxonomy silently is not a
call to make while the owner is asleep.

**Recommended option.** Widen to a need-based list (Education, Food Security, Environment,
Health, Community, Animals, Seniors, Other) in a migration that maps the existing five
forward — `Food Pantry` → `Food Security`, `School` → `Education`, `5K` and `Fundraiser` →
`Community`. Existing events keep a meaning rather than being dumped into `Other`.

**Alternatives.** (a) Leave it. (b) Add free-form tags alongside categories, which gives
richer data and a much harder aggregation problem. (c) Widen without mapping, which converts
every existing event to `Other` and loses the history the dashboard is built on.

---

## Q-D · How long should the owner accounts stay password-less?

**Question.** Both owner accounts were created with a bcrypt hash of a discarded random
value. Nobody can sign in until each owner completes a password reset.

**Why it matters.** The reset link goes to the address on the account and expires. If neither
account is claimed, the platform has two owners nobody can use — and `bin/grant-ownership.mjs`
is the only way to make another.

**Current assumption.** Claim them at your convenience; nothing depends on it yet.

**Recommended option.** Claim both within the week, set distinct passwords, and confirm
sign-in works before relying on either. Then rotate on a schedule — an owner account is the
only one on this platform nobody else can lock out.

**Alternatives.** (a) Claim one and leave the master account dormant as a break-glass
credential, which is defensible but means its reset path is untested when you need it. (b)
Connect both to OAuth instead of a password.

---

## Q-E · Should `bin/make-admin.mjs` write an audit row?

**Question.** It promotes an account to `admin` and records nothing. Every in-product
administrative action writes an audit row; this one does not.

**Why it matters.** Administrator promotion is the second most consequential privilege change
on the platform, and it is currently the only one that leaves no trace.

**Current assumption.** Unchanged — it is blocked on the same actor-identity problem as Q-A.

**Recommended option.** Fix it together with Q-A: once `system-cli` exists, every `bin/`
script that mutates privilege writes a row through it, and this stops being a special case.

**Alternatives.** (a) Attribute it to the target, as the ownership scripts do. (b) Remove the
script and require `POST /api/admin/users/:id/promote`, which is audited and step-up
protected — but needs an existing owner, so it cannot be the bootstrap path.
