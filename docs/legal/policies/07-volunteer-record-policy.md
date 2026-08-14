# 7. Volunteer Record Policy

## Specification

**Purpose.** Define what a service-hour record is, who may create or change one, how errors
are corrected, and how selection works — so that a record used for graduation decisions has a
documented chain of custody.

**Audience.** Students and guardians (whose graduation may depend on it); schools (who rely on
it); organizers (who create it).

**Required sections.** What a record is · how hours are created · the separation of check-in
from crediting · the snapshot rule · who can change what · corrections and disputes · how
selection works, including Auto Select · retention · what happens on deletion · your rights.

**Decisions required.** DECISION 5 (retention).

**Why this document exists.** Service hours are the highest-stakes data in the product: they
can affect whether a student graduates. The engineering invariants protecting them are already
strong and well-documented in code — this document makes them a *promise to the user* rather
than an internal convention, and gives a student a route when a record is wrong.

**Verified code invariants underpinning this document:**
- Credited hours are never stored on a user; derived as `SUM(hours_awarded) WHERE present = 1`
- Every change is appended to `hours_ledger`
- Check-in credits nothing; confirmation is separate
- An existing credit keeps its original value permanently — never re-priced when a slot is edited
- Attendance writes touch only volunteers named in the request, so a partial submission cannot
  mark anyone absent
- `npm run verify:hours` checks ledger/attendance parity and exits non-zero on mismatch

---

## Draft

# How volunteer records work

**Version 1.1 · Last updated 2026-08-06**

Your volunteer record is the list of events you attended and the hours you were credited. It
may matter for graduation, scholarships, or college applications, so this page explains exactly
how it is built and what to do if it is wrong.

## What a record is made of

| Piece | What it means |
|---|---|
| **Application** | You asked to volunteer. Status: pending, accepted, waitlisted, declined, or withdrawn |
| **Attendance** | The organizer marked whether you were actually there |
| **Hours credited** | How many hours you were given for being there |
| **Certificate** | A shareable confirmation of a completed event |

## How hours get onto your record

Three separate steps, deliberately:

1. **You are accepted** to a shift. This credits nothing.
2. **You check in** at the event. **This also credits nothing.** Checking in records that you
   arrived; it does not decide your hours.
3. **The organizer confirms attendance and hours** afterwards. *This* is the step that credits
   you.

Splitting check-in from crediting is on purpose: turning up and being credited are different
facts, and an organizer needs to be able to confirm what actually happened after the event
rather than at the door.

## Your total is calculated, never stored

Your hours total is **worked out fresh every time it is shown**, by adding up the hours from
every event where you were marked present.

This means nobody — not an organizer, not an administrator, not us — can type a number into
your total. The only way to change it is to change an attendance record, and every one of those
changes is written to a permanent ledger.

We run an automated check that the ledger and the attendance records agree. If they ever
disagree, that is treated as a defect, not a rounding difference.

## Credited hours are a snapshot

Once hours are credited, **they keep the value they had when you earned them.** If the
organizer later edits the shift — changes its length, renames it, adjusts the schedule — your
already-credited hours do not move.

This is deliberate. A record of what you did should not change months later because somebody
edited a form.

## Who can change what

| Who | Can |
|---|---|
| **You** | Apply, withdraw, view your record, download it. **You cannot change your own hours** |
| **The organizer of that event** | Mark attendance and credit hours **for their own events only** |
| **Administrators** | Correct records, with every action written to an audit log |
| **Anyone else** | Nothing |

An organizer cannot see or touch a record from someone else's event.

## If your record is wrong

**Step 1 — Tell the organizer.** They recorded it and they can fix it. Most problems are a
forgotten confirmation and take a minute.

**Step 2 — If that does not work**, email **support@wevolunteers.org** with the event, the date, and
what you think is wrong. We will look at the recorded attendance and the ledger.

**Step 3 — We respond within 10 business days** and tell you what we found, whether we changed
anything, and why.

If we correct a record, the correction is logged. We do not silently edit history.

**We will not add hours you did not work**, even if you ask nicely, and even if the organizer
asks. That is the whole point of the record being worth something.

## How volunteers get chosen

Organizers pick volunteers in one of two ways, and you should know which you are dealing with.

### By hand

The organizer reviews applications and chooses. Their reasons are theirs; ask them if you want
to know.

### Auto Select

Some organizers use a computer draw called **Auto Select**. Here is exactly how it works — we
publish it because there is no reason to hide it:

- Every applicant gets a **weight** based mainly on their **total credited hours**.
- The formula is `weight = 1.5 + 8.5 / (1 + 0.005 × hours)`.
- A student with **0 hours gets weight 10.0**. A student with **200 hours gets about 5.8**. A
  student with **500 hours gets about 4.0**. The weight keeps falling but never reaches zero.
- Spots are drawn at random, with higher-weighted students more likely to be drawn.
- Whoever is not drawn becomes the waitlist, in draw order.

**In plain terms: if you have volunteered less, you get a better chance.** That is intentional.
It stops the same few students taking every opportunity and shuts out everyone else.

#### Turning up matters a little, and only a little

Since version 1.3 the draw also looks at whether you turned up to shifts you were accepted for.
It is a **small** adjustment, and we have deliberately made it hard for it to matter much:

- Your weight is multiplied by a number between **0.95 and 1.03**. That is the whole range.
- **If we have no record of you either way, the multiplier is exactly 1.0** — a volunteer the
  system knows nothing about is neither helped nor harmed.
- The rate is **smoothed**, so a small number of shifts barely moves it. One shift attended out
  of one is not treated as a perfect record, and **one missed shift out of two is a small dip,
  not a verdict**. It takes a real pattern to move the number far.
- **A shift your organizer never confirmed does not count against you.** If nobody recorded
  whether you were there, it is left out of the calculation entirely — it is not counted as an
  absence.
- Shifts you **withdrew from in time** are not counted against you either, and neither is an
  event that was **cancelled**.

**Hours still come first.** The guarantee we hold ourselves to, and test on every build: below
200 credited hours, a **50-hour difference in hours outweighs any possible difference in
attendance**. You cannot climb the draw by being reliable instead of by needing hours.

**What Auto Select never uses:** your grade, your school, your name, your profile, your bio,
your skills, your hobbies, your gender, your friends, the organizations you have joined, any
hours you logged yourself from outside WeVolunteer, or anything else about who you are. Only
your credited hours and whether you turned up.

**Every draw is recorded** — including the random seed — so any draw can be re-run and checked
afterwards. If you think a draw went wrong, email **support@wevolunteers.org** and we will
reconstruct it.

You will always be told whether an event used Auto Select.

## How long records are kept

| What | How long |
|---|---|
| **Attendance and credited hours** | **Indefinitely** |
| **The hours ledger** | **Indefinitely** — it is what proves the hours are right |
| **Certificates** | **Indefinitely** — see the [Certificate Verification Policy](/legal/certificate-verification-policy) |
| Applications | 3 years after the event |

**Why indefinitely.** People come back for a service record years after they earned it — for a
college application, a scholarship, a job. A record that expires is not a record. This is the
one place where we have deliberately chosen to keep something forever, and we would rather say
so plainly than bury it in a schedule.

## If you delete your account

Your **verified hours and attendance stay**, attached to a shortened version of your name (for
example, "Alex R.").

They are your service record, and deleting them could cost a student the hours they needed to
graduate in the same year they closed their account. The full explanation — including what
happens to your certificates, which is the part most people do not expect — is in the
[Data Deletion Policy](/legal/data-deletion-policy). **Please read it before deleting.**

## Your rights over your record

- **See it** — any time, in the app
- **Download it** — Settings → Download my data, as a complete file
- **Correct it** — the process above
- **Ask how a decision was made** — including any Auto Select draw
- **Complain** — **privacy@wevolunteers.org**, acknowledged within 10 business days
