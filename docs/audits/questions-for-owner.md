# Questions for the Owner

Raised during the 2026-08-07 recovery audit. **Work continued past every one of these**
under the stated assumption; none blocked implementation. Each can be reversed cheaply if
the assumption is wrong.

---

## Q1 · Should a `super_admin` be creatable in code at all, even in demo mode?

**Question.** `server/db.js` now has `seedSuperAdmin()`, which inserts `user-super` /
`owner@wevolunteer.local` with the password `password123` and role `super_admin`. Should
this stay?

**Why it matters.** Until now the platform's strongest privilege-escalation defence was
that **no mechanism existed** — `bin/make-admin.mjs` only ever wrote `'admin'`, and no
route touched `users.role`. The security review recorded this as "enforced by absence of
mechanism, which is stronger than a permission check". A seeding function is a mechanism.
It is gated behind `DEMO_MODE` and the presence of the `user-admin` seed, and production
boot fails closed when `DEMO_MODE` is set with `NODE_ENV=production` — so the practical
exposure is low. The concern is that the invariant is now conditional rather than absolute,
and conditional invariants erode.

**Current assumption.** Keep it. Demo mode genuinely needs an owner account to demonstrate
owner-only screens, and the two gates are real.

**Recommended option.** Keep it, but add a boot assertion that refuses to start if a
`super_admin` seed row exists while `DEMO_MODE` is false. That converts the gate from
"we set the flag correctly" into an enforced invariant.

---

## Q2 · Who are the two real owner accounts?

**Question.** The ownership bootstrap needs two identities: yourself, and the WeVolunteer
Master Account. What email addresses should they bind to?

**Why it matters.** `bin/grant-ownership.mjs` is written and tested but has never been run,
so no `super_admin` exists in any real database. Ownership binds to a verified email
address and is deliberately not changeable through the product. Getting the address wrong
means a database edit to correct it.

**Current assumption.** Not assumed — the bootstrap has **not** been run. This is the one
item genuinely waiting on you, and it is the last step of M2 rather than a blocker for the
rest.

**Recommended option.** Provide both addresses when M2 is otherwise complete. Use an
address you control independently of the platform for the Master Account.

---

## Q3 · What actor should a CLI promotion be attributed to in the audit log?

**Question.** `bin/make-admin.mjs` promotes an account but writes **no audit record**.
Every in-product administrative action writes one. What identity should a command-line
action carry?

**Why it matters.** `admin_audit_logs.admin_id` is a foreign key to `users`, and a shell
operator has no user row. The options are a synthetic system principal, the target's own
id (wrong — it attributes the act to its subject), or leaving CLI actions unlogged (the
status quo, which means the single most privileged operation on the platform is the only
untraceable one).

**Current assumption.** Left as-is for now; recorded as P3-2 in the roadmap. Not fixed
silently, because inventing a principal identity is a schema-visible decision.

**Recommended option.** A reserved `system-cli` user row, seeded by migration, referenced
by every `bin/` script that mutates privilege. It keeps the foreign key honest and makes
CLI actions visible in the Audit Explorer alongside everything else.

---

## Q4 · Impact Dashboard — reduce, defer, or build as specified?

**Question.** The specification's community-impact metric counts distinct communities
served. As specified the count would be wrong, because the underlying data does not
distinguish a community from an organizer.

**Why it matters.** It is a **public** metric. A number that overstates reach is a claim
made to schools and families.

**Current assumption.** Deferred to M3 and not started. The audit records it as P2-1.

**Recommended option.** Build M3 with the metrics that are derivable and correct — hours,
volunteers, events, organizations — and omit the community count until there is a data
model that supports it. A smaller true number is worth more than a larger unsupportable
one.

---

## Q5 · Should `last_sign_in_at` be written on every sign-in?

**Question.** `issueSession` now performs an `UPDATE users SET last_sign_in_at` on every
session mint, wrapped in try/catch.

**Why it matters.** Sign-in is the hottest write path in the application, and this is an
unconditional write on a synchronous embedded database. The value's only consumer is the
Administrator Roster's "last seen" column.

**Current assumption.** Kept. At this platform's scale the cost is negligible, and the
try/catch means a failure cannot break sign-in.

**Recommended option.** Keep it, and revisit only if write contention ever appears. If it
does, coarsen to once per day per user rather than removing the column.
