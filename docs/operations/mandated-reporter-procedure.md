# Mandated-reporter procedure

**Status: DRAFT. Not yet reviewed by an attorney. No administrator has yet been briefed on
it** — and R-03 asks for both. Being briefed is what makes this real; a procedure an admin
has not read does not help the child it exists for.

**If you are reading this because of something you just saw, go to §2 now.**

---

## 1. Why this exists, and why it is short

R-03 is the highest-scored open finding in the risk register (ORANGE, 15). Its reasoning is
worth restating, because it is the whole justification for this file:

> Private adult-to-minor messaging is the single highest child-safety surface in any youth
> product. Organizers are adults. Students are minors. Conversations are private, with no
> guardian view and no keyword monitoring. Every control this platform has — reporting,
> muting, suspension, organizer approval — is **reactive**: it works once somebody reports.
>
> New Jersey is a **universal mandated-reporter state** (N.J.S.A. 9:6-8.10): *any person*
> with reasonable cause to believe a child has been abused must report **immediately**.
> Your admins will at some point read a report that triggers that duty, and right now
> nothing tells them what to do.

This file is that missing thing. It is short on purpose. A procedure somebody has to search
during the worst ten minutes of their year has failed before it starts.

> **Attorney review required.** The statutory citation is taken from the risk register.
> Whether a given situation meets the legal threshold is a judgement this document does not
> make and cannot make for you. **When in doubt, report** — §3 explains why that instruction
> is safe.

---

## 2. What to do

### The duty is yours, personally, and it is immediate

In New Jersey the obligation falls on **the person who has the reasonable cause** — not on
the organisation, not on a committee, and not on whoever is senior. You do not need proof.
You do not need to investigate first. You do not need permission.

### Step 1 — Report to the State. Now.

**New Jersey Child Abuse Hotline: 1-877-NJ-ABUSE (1-877-652-2873).** Staffed 24 hours.
This number is already published to students in the Youth Safety Guidelines.

**If a child is in immediate danger, call 911 first.**

Have ready, as far as you know it: who the child is, who the concern is about, what you saw
and where, and when.

### Step 2 — Preserve, do not investigate

Do **not** message either party to ask what happened. Do not warn the person. Do not delete
the conversation. You may destroy evidence, and you may alert somebody who then destroys it.

The report snapshot already preserves the content — `conversation_reports` stores
`reported_name_snapshot` and the message bodies at the moment of reporting, so a later
deletion does not erase what was reported. Leave it alone and let it work.

### Step 3 — Protect the child on the platform

Only after Step 1. Suspending first alerts the adult that something is happening.

- `user.suspend` on the account of concern.
- Muting (`muted_until`) if suspension is not yet warranted but contact should stop.

### Step 4 — Posture A: tell the district

The district has its own duties — the Anti-Bullying Bill of Rights carries same-day
notification to the principal, investigation within one school day, and completion within
ten. Those are **the district's** obligations, and the district cannot meet them if the
platform is the only place that knows.

### Step 5 — Write down what you did

Date, time, the hotline reference if given, what you observed, what you did on the platform.
Store it where the Admin Responsibilities Policy requires. **Not** in a comment on the
report — this record may need to go to people who should not see everything in the queue.

---

## 3. "What if I am wrong?"

Report anyway. This is the only part of this document that is an instruction rather than a
procedure, and it is the part most likely to be ignored under pressure.

New Jersey's statute is written around *reasonable cause to believe*, not certainty, and
it exists because the alternative — everyone waiting to be sure — is how children are
failed. The Youth Safety Guidelines already say this to students in almost the same words:

> "You do not need proof. You do not need to be sure. We would much rather look at fifty
> reports that turn out fine than miss the one that was not."

That applies to you too. An unnecessary call costs an hour. The other mistake does not
have a price you can pay back.

---

## 4. What triggers this, in practice

Not an exhaustive list, and not a threshold test. If something is not here and you are
uneasy, §3 applies.

- An adult moving a student to off-platform contact — phone, personal email, social media,
  "let's talk somewhere else".
- Requests for secrecy, or for photographs.
- An adult arranging to meet a student alone.
- Anything sexual, in any direction, involving a minor.
- A student disclosing harm at home or elsewhere — the duty is not limited to harm that
  happened here.
- Gifts, money, or favours to an individual student.

The Organizer Agreement prohibits most of these explicitly, so a breach is both a policy
violation and, potentially, this. **They are not alternatives.** Handling it as a policy
matter does not discharge the reporting duty.

---

## 5. Where this connects

| | |
|---|---|
| Published to students | Youth Safety Guidelines (policy 8) — the hotline is already there |
| Binds administrators | Admin Responsibilities Policy (policy 10) — **currently accepted by nobody; see the launch checklist** |
| Binds organizers | Organizer Agreement (policy 9) — gated: 8 capabilities withheld until accepted |
| The queue this arrives through | `docs/operations/report-triage.md` |
| Safety contact | `security@wevolunteers.org` |

---

## 6. Briefing record

R-03 asks that **every admin be briefed**, not merely that the document exist. Until a name
and date appear below, that half is unmet.

| Administrator | Briefed on | By |
|---|---|---|
| *(none yet)* | — | — |
