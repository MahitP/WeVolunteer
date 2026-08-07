# Evidence access review — who can read a student's private messages

**Date:** 2026-08-07 · **Scope:** `report.evidence.read` and
`GET /api/admin/reports/:id/evidence` · **Outcome:** step-up added; two questions
recorded for the owner.

---

## The question

An ordinary administrator — not the platform owner — can read the private message
bodies a safety report preserved. The previous audit flagged this as the most
invasive power on the platform and recommended a dedicated review before changing
anything. This is that review.

## What is actually exposed

`GET /api/admin/reports/:id/evidence` returns, for one report:

| Field | Content |
|---|---|
| `body` | The full message text, frozen at the moment the report was filed |
| `sender_id`, `sender_name` | Who sent it, with a snapshot name if the account is gone |
| `created_at` | When the message was sent |
| `captured_at` | When the report froze this copy |

Scope is one report's `report_evidence` rows. There is no endpoint that returns a
conversation, a person's message history, or evidence across reports. Rows are
immutable at the database (triggers, migration 013) and exempt from the retention
sweep (`PRESERVED_TABLES`), so evidence outlives both the messages it copied and
the accounts involved.

## Why the capability exists

Deciding a harassment report means reading what was said. Without it a moderator
either suspends a student on a reporter's summary or does not act — and the Youth
Safety Guidelines promise action. The capability is deliberately **split** from
`report.resolve` so a per-user grant can create a triage helper who sorts the
queue and never reads a body; that split is the reason it is a separate name.

## Who holds it

`admin` and `super_admin`. Not organizers, not students, not partners.

**It is not owner-only, and should not be.** On a one-to-two-person moderation
team the administrator *is* the moderator. Restricting evidence to the owner would
mean either the owner reads every report — becoming the bottleneck the split above
exists to avoid — or administrators decide reports without seeing them, which is
worse for the student on both sides of the report.

## What was already right

- **Logged twice, in one transaction with the read.** `admin_audit_logs` for the
  operational trail, `moderation_actions` for the durable one. The second is not
  redundant: audit rows are swept at 365 days, a suspension is appealable years
  later, and "who read my child's messages" is exactly the question asked after
  the year is up.
- **The reported party is the audit subject**, not the reporter, because the
  question the row answers later is whose messages were read.
- **Fetched only on request.** The report detail view does not prefetch, because
  the server logs a disclosure on every call and prefetching would manufacture
  records of reads nobody performed.

## What was wrong

**The read was the cheapest consequential action on the platform.**

Every action in the step-up registry was about the actor's *own* account:
deleting it, changing its password or address, connecting a provider, exporting
its data. Downloading your own data archive required a fresh verification.
Reading a child's private messages required a session.

The accountability was in place; the **deliberation** was not. Nothing stood
between an idle click on "Show the messages" and the messages.

## What changed

`report.evidence` is now a registered sensitive action, bound to `reportId`.

- `requireAAL2('report.evidence')` refuses early.
- `spendChallenge(db, req, 'report.evidence', { reportId: report.id })` is the
  first statement inside the same transaction as the two log writes, so the grant
  is consumed atomically with the record of its use. A gate with no spend leaves
  the grant replayable and every functional test still passes — guard 5 fails the
  build on it.
- The binding is bound to the row **fetched from the database**, not to what the
  client sent. One verification opens one report; without that, a moderator who
  verified once would hold a five-minute key to every child's messages, which is
  strictly worse than the position this replaced.

Cost during an incident: one password entry per report per five minutes.

### A bug this surfaced

`adminRoutes.js` never handled `ChallengeNotSpent`, so a mis-bound, expired or
replayed grant fell through to the generic catch and returned **500**. That
affected the pre-existing administrator promote and revoke flows too. Since
`useStepUp` re-prompts on `code: 'reauth_required'`, a moderator whose
verification had simply lapsed saw a server error with no way forward. All three
handlers now use `refuseReauth`, the shape the account and privacy routes have
always used.

## Not changed, with reasons

**Evidence remains readable for a report in any status.** A resolved report can be
reopened, appealed years later, or escalated to a district, and each needs the
evidence. Restricting reads to open reports would break appeal review — the one
process a suspended student has.

**Content is already minimal.** The endpoint returns the rows one report
preserved. There is nothing to trim without breaking the decision it supports.

**No rate limit was added.** The step-up is a stronger constraint than a rate
limit: it costs a fresh credential per report rather than throttling volume, and
every read is on two records. A limit could be added if reads are ever observed
in volume, and the audit trail is what would show that.

---

## For the owner

Both recorded in `docs/questions-for-owner.md`.

1. **The Youth Safety Guidelines say the read is logged; they do not say it now
   requires re-verification.** The promise got stronger and the published text
   has not caught up. Legal documents are pinned by content hash — editing the
   published version would invalidate every acceptance record — so this is a
   version bump, which is an owner decision.

2. **Whether administrators should hold this at all** is ultimately a staffing
   question rather than a technical one. The recommendation above assumes a small
   team where the administrator is the moderator. If the team grows to the point
   where triage and adjudication are different people, the per-user grant
   mechanism already supports withholding `report.evidence.read` from triage
   staff — the capability was split for exactly that.
