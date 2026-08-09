# 4. Data Deletion Policy

## Specification

**Purpose.** Describe *exactly* what happens when an account is deleted — including the parts
that are not deleted — precisely enough that no student is surprised afterwards.

**Audience.** A student at the moment they are about to click Delete, and a guardian or
regulator checking whether the promise matches the behaviour.

**Required sections.** What deletion does · what is removed · what is kept and why · the
certificate exception · timing · what you cannot undo · guardian requests · what a school or
partner organization cannot do · how to ask questions.

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
> current behaviour**.
>
> **The "Choose what happens to your certificates" section is retained, marker and all.**
> Certificate voiding is scheduled to be built later in this programme, so the section is kept as
> the specification of what the text will say once it ships — not deleted and rewritten. Its
> `[[NOT YET IMPLEMENTED]]` marker is deliberate and **blocks publication of this document until
> the feature lands**, which is the correct behaviour: publishing a choice that does not exist
> would be a misrepresentation, and deleting the section would lose the drafted text. Whoever
> ships the feature removes the marker in the same pull request.
>
> Until then, the Privacy Policy carries the honest version of the same fact — that no way to
> switch off indefinite certificates exists today — and must be kept in step with this section
> when it changes.

---

## Draft

# What happens when you delete your account

**Version 1.0 · Last updated 2026-08-06**

Deleting your WeVolunteer account is permanent. This page explains exactly what goes and what
stays, because some things stay, and you should know which before you decide — not after.

## The short version

- Your profile, messages, notifications, and preferences are **removed**.
- Your name is **scrambled** to a first name and last initial everywhere it remains — with one
  exception: a safety report, and any messages saved with it, keep the words that were actually
  written, including names inside them. See "Safety reports" below.
- **A safety report you filed, or one filed about you, stays.** It is the record of a decision
  about somebody's safety and it survives account deletion.
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
[Volunteer Record Policy](/legal/volunteer-record-policy).

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

#### There is no way to switch a certificate off

We would like to offer you a choice here — keep your certificates verifiable, or void them so
your name comes off and the codes stop working. **That choice does not exist yet, and we cannot
promise a date for it.**

So the position today is the one described above, and it is the reason this page asks you to read
before you delete rather than after: a certificate you have already earned keeps your full name
on it, and deleting your account does not change that.

### Messages you sent

Messages you sent to other people stay in **their** conversations, shown from your scrambled
name. We cannot delete them without deleting part of someone else's record of a conversation
they took part in.

### Comments

Comments you posted on events stay, shown from your scrambled name.

### Safety reports

If you reported somebody, or somebody reported you, that report stays. So do the messages that
were saved with it at the time it was filed.

**What stays:** the report, what it said, the category it was filed under, your name as it was
when you filed it, and a copy of the messages saved with the report. Those messages are kept
word for word, which means a name written inside a message stays as it was written. We cannot
scramble it without changing what somebody actually said, and a record of an accusation that has
been quietly edited is not a record of anything.

**What does not stay:** your profile, your bio, your school, your photo, your other messages,
and your account. Those are removed exactly as described above. The report does not keep your
account alive and you cannot sign in.

**Why.** A report is the only record of a decision somebody made about whether a student was
safe. It protects you at least as much as it protects us. Before we changed this, a student who
reported an adult and then deleted their account had their own report destroyed along with the
account — their privacy right erasing the record of what had been done to them. The same was
true if the adult deleted the event: the report went with it.

**Who can see it.** Only an administrator, and only through the report. Reading the saved
messages is recorded in our logs every time it happens. Nobody can edit or delete a report or
the messages saved with it — that is enforced by the database, not by a rule we promise to
follow.

**How long.** Indefinitely today, and we say why, and what we are doing about it, in the
[Privacy Policy](/legal/privacy-policy#how-long-we-keep-things).

**If you delete your account while a report is open**, the account is deleted and scrambled
straight away, as always. The empty shell that is left behind is normally removed after three
years; if a report naming you is still open at that point, it waits until the report is closed,
so that a moderator looking at the report can still see the conversation it is about.

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
