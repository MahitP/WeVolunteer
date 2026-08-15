# 6. Certificate Verification Policy

## Specification

**Purpose.** Govern the one endpoint in WeVolunteer that discloses a minor's name to an
unauthenticated stranger, and tell verifiers what a certificate does and does not prove.

**Audience.** Split, and unusually so — **verifiers** (school offices, colleges, scholarship
committees, employers) need to know what they can rely on; **students** need to know what they
are handing over when they share a code.

**Required sections.** What a certificate is · how to verify · what the check shows and does
not show · what it proves and does not prove · why codes are safe to hand out · what happens
after account deletion · how long verification lasts · disputes · abuse.

**Decision resolved: certificates stay verifiable indefinitely.** That is now deliberate policy
rather than an unexamined default, which is what makes it defensible. The remaining obligation
is disclosure — a student must understand, before deleting, that their name persists. **This
couples to the age gate:** COPPA §312.10 forbids indefinite retention of a child's data, so
indefinite certificates are lawful only while no under-13 account can exist (re-audit R-01/R-02).

**The `[[NOT YET BUILT]]` block near the end is retained deliberately.** Certificate voiding is
scheduled later in this programme; the block holds the drafted text for when it ships and blocks
publication until then, which is correct — a document that offered the choice today would be
describing a feature that does not exist. Whoever ships voiding removes this marker and the twin
in [`04-data-deletion-policy.md`](/legal/data-deletion-policy) in the same pull request, and
updates the Privacy Policy paragraph that currently states plainly that no such option exists.

**One thing corrected in this pass.** "If a code does not work" listed an expired verification
period as a possible cause, in a document whose next section says certificates never expire. It
listed three causes; there are two.

**Code facts this document relies on** (all verified):
- `GET /api/certificates/verify/:code` — unauthenticated by design (`attendanceRoutes.js:243`)
- Codes are `WEV-XXXX-XXXX`, from `crypto.randomBytes(5)` — 40 bits (`certificates.js:60`)
- `verifyLimiter` rate-limits the endpoint (`app.js:561`)
- Grade is deliberately excluded from the response
- After deletion, `volunteer_name_snapshot` holds the **real** name and is served in preference
  to the live record — see R-02

---

## Draft

# Certificate verification

**Version 1.0 · Last updated 2026-08-06**

WeVolunteer issues a certificate when a student completes a volunteer event. Each certificate
has a code on it. Anyone holding that code can check the certificate is real.

This page explains how that works, for the people checking and for the students whose names
are on them.

## For schools, colleges, and employers

### How to verify

Go to the **Verify a certificate** page on WeVolunteer — the address is printed on the
certificate itself, next to the code — and enter the code printed on the certificate. It looks like `WEV-4K2P-9XQF`.

You do not need an account and you do not need to sign in.

### What you will see

| Field | Shown |
|---|---|
| Volunteer's name | Yes |
| Event name | Yes |
| Organizer | Yes |
| Hours credited | Yes |
| Date completed | Yes |
| Grade level | **No** |
| School | **No** |
| Email or contact details | **No** |
| Any other event the student did | **No** |

A code verifies **one certificate**. It is not a login and it does not open a record.

### What a verified certificate proves

It proves that **WeVolunteer's records say** this person was marked present at this event by
this organizer, and was credited these hours.

### What it does not prove

Please read this part.

- **We did not witness the volunteering.** Attendance was recorded by the organizer who ran
  the event. We store what they recorded.
- **We do not run background checks on organizers**, and approving an organizer account is not
  an endorsement of their organization.
- **We do not certify that the hours meet your requirements.** Whether these hours satisfy a
  graduation requirement, a scholarship rule, or a programme's criteria is entirely your
  decision.

If you need a stronger assurance, contact the organizer named on the certificate, or the
student's school.

### If a code does not work

Two reasons, and we cannot tell you which from the outside:

1. The code was typed wrong — check for confusable characters, and note codes are not
   case-sensitive.
2. The certificate is not genuine.

**"It expired" is not on that list.** Certificates do not expire and there is no verification
period to run out — see [Certificates stay verifiable indefinitely](#if-you-delete-your-account)
below. A code that fails was mistyped or was never issued by us.

If you believe you have been given a forged certificate, tell us at **security@wevolunteers.org**. We
take that seriously and we will investigate.

## For students

### Your name is on it

A certificate has your name on it, because that is what makes it worth anything. Anyone you
give the code to can look it up and see your name, the event, the organizer, and the hours.

They **cannot** see your grade, your school, your email, or anything else about you, and they
cannot see any of your other events.

### Codes cannot be guessed

Each code is randomly generated with 40 bits of randomness — roughly a trillion possibilities
— and the verification page is rate-limited, so nobody can sit and try codes until one works.

The only way someone sees your certificate is if **you gave them the code**. Treat it like any
other document with your name on it: share it with the people who need it.

### If you delete your account

**This is the part people do not expect, so please read it.**

Certificates you have already earned **keep your full name** so they can still be verified
after your account is gone. A certificate nobody can check is worthless, and a college that
verifies your hours in March needs it to still work if you closed your account in January.

So after you delete your account, anyone holding one of your certificate codes can still look
it up and see your name.

**Certificates stay verifiable indefinitely.** There is no expiry date. A certificate you earn
at fifteen is still checkable at thirty.

That is deliberate. A certificate that stops working is worthless precisely when someone
finally needs it — and the people who need old volunteer records are usually applying for
something years later. We would rather it still work.

The cost of that choice is the sentence above: **your name stays on it, permanently, and
deleting your account does not remove it.**

There is no option to void a certificate. We would like to add one, and cannot promise a date,
so the sentence above is the whole of the current position rather than a summary of it.

See the [Data Deletion Policy](/legal/data-deletion-policy).

### If your certificate is wrong

Tell the organizer first — they recorded the attendance and can correct it. If that does not
work, email **support@wevolunteers.org**.

Note that hours are a **snapshot**: once credited, they keep the value they had when you earned
them, even if the event is edited afterwards. That is deliberate, so that nobody's completed
record changes underneath them.

## How we protect this endpoint

Because verification is open to anyone, it is deliberately narrow:

- One lookup returns **one certificate**, found by an exact code match. There is no search, no
  listing, and no way to browse.
- Grade is excluded from the response even though it is in the database.
- The endpoint is rate-limited per device.
- Nothing about the person doing the checking is recorded beyond ordinary server logs.

If we ever detect systematic guessing, we will tighten the limits, and we will say so here.

## Misuse

Do not use verification to try to find out whether a particular person volunteers, to collect
students' names, or to test codes at scale. That is a breach of the
[Terms of Service](/legal/terms-of-service) and we will block it.

Questions: **support@wevolunteers.org**
