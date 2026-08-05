# 4. Data Deletion Policy

## Specification

**Purpose.** Describe *exactly* what happens when an account is deleted — including the parts
that are not deleted — precisely enough that no student is surprised afterwards.

**Audience.** A student at the moment they are about to click Delete, and a guardian or
regulator checking whether the promise matches the behaviour.

**Required sections.** What deletion does · what is removed · what is kept and why · the
certificate exception · timing · what you cannot undo · guardian requests · school district
requests · how to ask questions.

**Decisions resolved.** Hours and certificates indefinite · messages 3 years · audit logs 1 year
· anonymised shells purged after 3 years. **Still open:** whether a grace period precedes
anonymisation (re-audit Q9 — the "When it happens" section below currently promises none).

> **This document describes a behaviour that has a known problem (R-02).** Deletion currently
> writes the student's *real, pre-anonymisation* name into `certificates.volunteer_name_snapshot`,
> and the public unauthenticated verification endpoint serves that snapshot in preference to
> the live record. The name therefore survives deletion permanently, with no expiry and no
> revocation path.
>
> Indefinite retention is now a deliberate decision, which resolves half of R-02. The other half
> — disclosure and a revocation path — remains. The draft below is written **honestly against
> current behaviour**; the "Choose what happens to your certificates" section describes the void
> option, which **does not exist yet** and must be deleted before publication until it does.

---

## Draft

# What happens when you delete your account

Deleting your WeVolunteer account is permanent. This page explains exactly what goes and what
stays, because some things stay, and you should know which before you decide — not after.

## The short version

- Your profile, messages, notifications, and preferences are **removed**.
- Your name is **scrambled** to a first name and last initial everywhere it remains.
- Your **verified volunteer hours and attendance stay**, because they are your school record.
- **Certificates you already earned keep your full name on them**, so schools can still check
  them. This is the part most people do not expect.
- You cannot undo any of it.

## What is removed

When you delete your account, we permanently delete:

- Your profile picture, bio, and school
- Your notification preferences and saved events
- Your notifications
- Any connected sign-in provider (for example, Google)
- Any password reset or email verification links that were still live
- Your ability to sign in — immediately, everywhere, on every device

Your name is replaced with a first name and last initial (for example, "Alex R."), and your
email and username are replaced with values that cannot be used to contact or identify you.

## What is released

If you had upcoming shifts, you are **withdrawn** from them straight away. Your spot opens up
for someone else, and the organizer sees the withdrawal — the same as if you had pulled out
yourself. Nobody is left holding a place for an account that no longer exists.

## What is kept, and why

### Your volunteer hours and attendance

**These stay.** They are the record of service you actually performed, and schools rely on
them for graduation requirements, scholarships, and awards. If we deleted them, a student who
closed their account in June could lose the hours they needed to graduate in the same year.

They stay attached to your scrambled name, not your full one.

**These are kept indefinitely.** That is a deliberate choice: people come back for their
service record years later, and a record that expires is not a record. See the
[Volunteer Record Policy](07-volunteer-record-policy.md).

### Your certificates

**Certificates you have already earned keep your full name on them.**

This is the most important sentence on this page, so here it is again in detail:

A certificate exists so somebody else — a college, a scholarship committee, an employer — can
check that you really did the hours. That check works by looking up a code printed on the
certificate. For it to keep working after you leave, the certificate has to keep the name that
is printed on it.

So when you delete your account, we save a copy of your name onto each certificate you
earned. Anyone holding one of your certificate codes can still look it up and see your name,
the event, the organizer, and the hours.

They **cannot** see your grade, your school, your email, or anything else. Codes are random
and cannot be guessed, and lookups are rate-limited. But the name stays.

**This lasts indefinitely.** There is no expiry. We have chosen to keep certificates verifiable
forever, because a certificate that stops working is worthless exactly when someone needs it —
usually years later, for a college or a job.

We are telling you this plainly rather than burying it, because it is the one part of deleting
your account that is genuinely permanent and genuinely public.

#### Choose what happens to your certificates

[[NOT YET IMPLEMENTED — see R-02. Remove this section until the code supports it.]]

When you delete your account you can choose:

- **Keep them verifiable** — your name stays on your certificates so schools can still check
  them. Choose this if you have used, or might use, these hours for anything.
- **Void them** — your name is removed and the certificates stop working. Anyone who checks
  one is told it has been withdrawn. Choose this if you would rather not be findable.

**Voiding cannot be undone**, and any certificate you already handed to a school will stop
verifying.

### Messages you sent

Messages you sent to other people stay in **their** conversations, shown from your scrambled
name. We cannot delete them without deleting part of someone else's record of a conversation
they took part in.

### Comments

Comments you posted on events stay, shown from your scrambled name.

### Administrator logs

A record that an account was deleted, and when, is kept in our audit log for
**1 year**. It contains no personal details beyond the account identifier. This exists so
that misuse of an administrator account can be traced later.

## When it happens

Immediately. There is no waiting period and no grace period, which also means **there is no
window in which you can change your mind**.

Signing back in is impossible the moment deletion completes, on every device.

## Before you delete — please do this first

**Download your data.** Settings → Download my data gives you a complete copy of everything
we hold, including your hours and certificates. Once your account is gone we cannot produce
it for you.

Export archives are available for **7 days**, then deleted automatically. Download it before
you delete.

## If you are an organizer

You cannot delete your account while you are running active events. Close them, cancel them,
or hand them to another organizer first. This is not us being difficult — deleting an
organizer mid-event would strand the students who signed up.

## Guardians

If you are the parent or guardian of a student under 18, you can ask us to delete their
account.

Email **wevolunteer.platform@gmail.com**. We will verify who you are and your relationship to
the student, ask for no more documentation than we actually need, acknowledge within **10
business days**, and complete within **45 days**.

**Your school cannot do this for you.** WeVolunteer is independent — ask us directly.

We tell the student when their account is deleted at a guardian's request.

## Schools and organizations

Schools and community organizations that use WeVolunteer **cannot delete a student's account or
records.** They do not control your account and they are not the operator. Only you, or your
guardian if you are under 18, can ask for that — and you ask us.

## Questions

Ask **before** you delete, not after: **wevolunteer.platform@gmail.com**. We would much rather answer a
question than reverse something we cannot reverse.
