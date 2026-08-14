# 8. Youth Safety Guidelines

## Specification

**Purpose.** State the safety rules that govern contact between adults and minors on the
platform, tell every audience how to report harm, and commit WeVolunteer to a response.

**Audience.** Deliberately all four at once — students, guardians, organizers, admins — with
a clearly signposted section for each. Splitting it into four documents would mean a student
never reads the organizer rules, and the organizer rules are what protect the student.

**Required sections.** The promise · rules for adults · rules for everyone · how to report ·
what happens after a report · mandated reporting · in-person event safety · what we cannot do
· contacts including crisis lines.

**Decisions resolved.** Organizer↔applicant messaging is intentional and stays. Reports go to
contact@wevolunteers.org. The operator is a sole proprietor, so "we" is one person and the
draft does not imply a safety team. **No guardian consent step exists and none is being built** —
the "For parents and guardians" section says so rather than letting a reader assume it.

**Still open — one item, marked in the draft as blocking publication.** The hours one person can
commit to reading the safety inbox. It has to be a commitment one person can keep, because it is
one person. The "within one business day" promise it used to gate has been removed rather than
published against a blank: the draft now says a safety report is sent to us the moment it is filed
(which is true — `SYSTEM_ALERT` is a mandatory notice and cannot be silenced by a preference), that
everything else is a target rather than a guarantee, and that the 24-hour hotlines are the right
route for anything urgent.

> **Needs counsel review** on the mandated-reporter procedure specifically. New Jersey is a
> universal mandated-reporter state (N.J.S.A. 9:6-8.10): *any person* with reasonable cause to
> believe a child has been subjected to abuse must report immediately to DCP&P. Getting the
> phrasing wrong here — for example implying that reporting internally satisfies the duty —
> would be worse than saying nothing.

**Code dependencies flagged by this document.**
- ~~Messaging has no applicant check~~ — **incorrect, withdrawn.** `eligibleRelationship()`
  enforces the applicant rule at its `relationship.length === 0` branch. It was untested, and is
  now covered by `server/messaging.applicantScope.test.js`. Rule 1 below is enforced, not
  aspirational.
- ~~No suspension, no organizer removal, no blocking exists~~ — **all three now ship.**
  Suspension (`POST /api/admin/users/:id/suspend`) ends every session immediately via a
  `token_version` bump; it works on approved organizers and preserves their volunteers'
  attendance. Blocking (`POST /api/blocks/:userId`) is student-initiated and closes existing
  conversations, not just new ones. Covered by `routes.suspension.test.js` (21) and
  `blocking.test.js` (16).
- **Still not built:** message redaction, and reporting anything other than a conversation.
  Nothing below claims either.
- "A report reaches a human within one business day" requires a monitored inbox with stated hours.

---

## Draft

# Staying safe on WeVolunteer

**Version 1.1 · Last updated 2026-08-06**

WeVolunteer connects students with adults who run volunteer events. That is the point of it,
and it is also the thing we have to be most careful about. This page explains the rules,
how to report a problem, and what we do when you do.

**If someone is in immediate danger, call 911.**

---

## For students

### What adults on WeVolunteer are allowed to do

An organizer running an event you applied to can message you about **that event** — when it
starts, what to bring, whether you got a place.

### What adults are not allowed to do

No adult on WeVolunteer should ever:

- Ask you for your phone number, home address, or social media so you can talk somewhere
  private
- Ask you to keep a conversation secret from your parents, guardians, or teachers
- Send you anything sexual, or ask you for photos
- Comment on your appearance or your body
- Offer you money, gifts, alcohol, vapes, or drugs
- Ask to meet you alone, anywhere, for any reason
- Tell you that you will lose a volunteer place if you do not do something
- Message you about anything that is not the event

**If any of this happens, it is not your fault, you are not in trouble, and you should tell
someone.** Use the Report button, and tell a parent, guardian, or teacher.

### You can block someone

You do not need permission, and you do not have to explain why. Blocking stops that person
messaging you straight away — in conversations you already have, not just new ones.

Two things we want you to know:

- **Blocking does not cost you anything.** You stay on the event, you keep your place, and you
  keep every hour you have earned. You should never have to choose between feeling safe and
  your service record.
- **Organizers cannot block you.** Blocking only works in one direction, on purpose, so it can
  never be used to stop you speaking up about an adult.

Blocking is not the same as reporting. If somebody has done something wrong, please report it
too — blocking protects you, reporting protects the next student.

### Trust the feeling

If a conversation makes you uneasy and you cannot say exactly why, that is reason enough to
report it. You do not need proof. You do not need to be sure. We would much rather look at
fifty reports that turn out fine than miss the one that was not.

### At an event

- Tell a parent or guardian where you are going and when you will be back — every time.
- Volunteer alongside other people. If you turn up and you are the only volunteer with one
  adult, that is a reason to leave.
- Keep your phone with you and charged.
- If you feel unsafe, leave. You do not owe anyone an explanation and you will not lose your
  hours for the part you did.
- Tell us afterwards: security@wevolunteers.org.

---

## For organizers

Accepting an organizer account means accepting these rules. They are also in the
[Organizer Agreement](/legal/organizer-agreement), which you sign.

### Contact

1. **Message students only about events they have applied to.** Do not use WeVolunteer to
   contact a student who has not applied to something you run.

   *The platform enforces this — you will not be able to open a conversation with a student who
   has not applied to one of your events.*
2. **Keep it on the platform.** Do not move a conversation with a student to text, a personal
   email, Instagram, Discord, Snapchat, or anywhere else. On-platform messages can be
   reviewed if there is a problem; a DM on your personal phone cannot.
3. **Never ask a student to keep anything from their parents.**
4. **Never meet a student one-to-one.** Another adult is present, always.

### Their information

5. Contact details you receive are **for running that event only**. Do not copy them into a
   personal address book, a mailing list, or another system.
6. Delete them when the event is over.
7. Do not share them outside your own organization at all — not with other organizers, not with
   another programme, not with anyone. Inside your organization, share only what a specific
   person needs to run this event (a shift supervisor's check-in list, for example), and make
   sure they are bound by the same rules. The
   [Organizer Agreement](/legal/organizer-agreement) §4 is the binding version of this rule.

### At your event

8. Two adults present, minimum, at all times.
9. Never be alone with one student.
10. Follow your own organization's safeguarding rules. WeVolunteer is independent, so no school
    or district is setting rules for you here — your organization's are the ones that apply.
11. If a student tells you something concerning, see **Mandated reporting** below. Do not
    promise to keep it secret — you cannot.

---

## For parents and guardians

Your student's account is theirs, but you have a right to understand it.

- Their profile is **private by default**. Nobody sees it unless the student changed that.
- The leaderboard is **off by default**.
- Organizers see their name and contact details only for events they applied to.
- Students can message organizers and other students through the app.
- Every conversation has a Report button.

Ask your student to show you the app. Ask who they are messaging. Ask where the event is and
who else will be there.

You can contact us directly at **security@wevolunteers.org** with any concern, and you do not need
your student's permission to do so.

### The part we would rather you heard from us

**There is no parent or guardian consent step, and there is no guardian verification.** We do not
ask for your email address, we do not send you anything to approve, and we do not notify you
automatically if your student is suspended, if a report involves them, or if they delete their
account. A student aged 13 or over can sign up on their own.

What stands in its place: a hard age floor of 13 checked on our servers, the private-by-default
settings above, organizers who only ever see contact details for events your student applied to,
a Report button everywhere, and blocking that works in one direction only so an adult can never
use it against a student.

We would rather tell you that than print "a guardian must approve" and not check. The
[Privacy Policy](/legal/privacy-policy) says the same thing in more detail, and it lists what you
can ask us for at any time.

---

## How to report something

**In the app** — every conversation, comment, and event page has a **Report** button. This is
the fastest route and it tells us exactly what you are reporting.

**By email** — **security@wevolunteers.org**. We review safety reports as soon as
reasonably possible. It is read by one person, so it is not monitored around the clock and there
is nobody covering it when that person is unavailable — we would rather tell you that than
publish hours we cannot hold to.

**Urgent safety concerns should go to emergency services or the resources below, not to us.**
**If someone is in danger now, call 911 — do not email us and wait for a reply.**

**Emergencies** — call 911. Do not wait for us.

**New Jersey child abuse hotline** — **1-877-NJ-ABUSE (1-877-652-2873)**, 24 hours, and you
do not have to give your name.

**988 Suicide & Crisis Lifeline** — call or text **988**, 24 hours.

**The hotlines above are anonymous. A report inside the app is not.** When you use the Report
button your name is attached, so that an administrator can come back to you with a question —
they can see it, and the person you reported never does. We do not tell them who reported
them, and trying to find out is itself grounds for removal.

If you want to raise something without us knowing who you are, use one of the hotlines above.

You will not get in trouble for reporting something that turns out to be nothing.

---

## What happens after you report

1. **It reaches a human.** Software sorts reports by how serious the reason you picked is, and
   anything a student reports about an adult is treated as urgent whatever reason they chose —
   that sorting decides how quickly we are told, and it is the only thing software decides. No
   software closes a report, decides what happened, or acts on an account.
2. **We look at what was reported** — including the messages in a reported conversation. This
   is the one situation in which an administrator reads private messages. Opening them requires
   the administrator to re-enter their password at that moment, the permission to do it is
   separate from the permission to decide the report, and each access is recorded against that
   specific report in a log that cannot be edited or deleted.
3. **We act.** Depending on what we find: a warning, removing content, suspending an account,
   or suspending an organizer permanently. A suspension ends every session that account has,
   immediately — not just the next sign-in.
4. **Where a student may have been harmed, we escalate immediately** — see below.
5. **We tell you what happened**, unless doing so would put someone at risk or interfere with
   an investigation.

If a report involves an immediate risk to a student, we act first and work out the process
afterwards.

---

## Mandated reporting

**New Jersey law requires any person who has reasonable cause to believe a child has been
subjected to abuse or neglect to report it immediately** to the Division of Child Protection
and Permanency, at **1-877-NJ-ABUSE**. (N.J.S.A. 9:6-8.10.)

This applies to everyone — organizers, administrators, teachers, volunteers, and us.

Three things follow from that, and they are the reason this section exists:

- **Reporting to WeVolunteer does not satisfy your legal duty.** If you have reasonable cause
  to believe a child has been abused, you must call DCP&P yourself. Telling us as well is
  good; telling us instead is not enough.
- **You do not need proof.** "Reasonable cause to believe" is a lower bar than certainty. The
  law asks you to report a concern, not to investigate one.
- **You cannot promise a student confidentiality about this.** If a student starts to tell
  you something serious, do not promise to keep it secret. Say that you may have to tell
  someone whose job it is to help.

WeVolunteer administrators follow the same rule and will report directly to DCP&P where the
threshold is met, in addition to any action taken on the platform.

---

## What we cannot do

We would rather be straight with you about our limits than let you assume protections that do
not exist.

- **We do not run background checks on organizers.** Approval means an administrator reviewed
  the account, not that anyone was vetted. No school or district vets them either — WeVolunteer
  is independent, so we are the only check, and this is what that check consists of.
- **We do not supervise events.** We are not there.
- **Muting a conversation only stops the notifications.** It does not stop the other person
  sending. If you want them to stop, **block** them — muting is for a conversation you still
  want, just not the alerts.
- **We do not read messages routinely.** We read a conversation when it is reported, or when
  we must investigate a safety concern. Nothing scans your messages in the background.
- **We cannot see anything that happens off the platform.** If a conversation moves to text or
  another app, we have no record of it and no ability to help. This is the single biggest
  reason to keep conversations here.

---

## Contacts

| Situation | Contact |
|---|---|
| Immediate danger | **911** |
| Child abuse or neglect (NJ) | **1-877-NJ-ABUSE** (1-877-652-2873) |
| Thoughts of suicide or crisis | **988** — call or text |
| Something wrong on WeVolunteer | Report button, or **security@wevolunteers.org** |
| A privacy question | **privacy@wevolunteers.org** |
| A trusted adult at school | Your counsellor, teacher, or principal — WeVolunteer is not run by your school, but they can still help you |
