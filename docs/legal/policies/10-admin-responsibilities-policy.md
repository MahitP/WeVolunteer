# 10. Admin Responsibilities Policy

## Specification

**Purpose.** Constrain the most powerful role in the system. Administrators can see every
account, every application, and — when a report is filed — private messages between minors.
Nothing currently limits that except good character.

**Audience.** Internal. Administrators and super-admins, plus any partner or counsel who will ask
"who can see my students' data, and what stops them looking?"

**Required sections.** Who may be an admin · the core rule · what you may look at ·
what you may never do · reports and messages · mandated reporting · corrections · audit ·
access review · leaving · consequences · acknowledgement.

**Decisions resolved.** The operator is a sole proprietor — Mahit Pulavarthi, doing business as
WeVolunteer — so every administrator answers to that person and to nobody else. There is no
district layer and no school administrator layer, which is exactly why the written rule below is
load-bearing.

**Resolved.** The approver is the platform operator, who is the only person holding
`admin.create`. The register lives at `docs/operations/administrator-register.md` in the source
repository — deliberately outside the application's own database, so that a database which is
broken, restored from an old backup, or tampered with is not also the only record of who had
access to it. The access review is quarterly, and immediately whenever anyone's role changes.

**Guardian contact.** WeVolunteer holds no guardian contact details and nothing collects any. Two
places in this document implied an administrator could notify a guardian; both now say what is
actually possible.

**Why this is a policy and not a code change.** Most controls in this codebase are enforced by
`authz.js`. This one cannot be: an administrator's job *requires* broad read access, so the
only available control over *why* they look is a written rule plus an audit trail. That makes
the written rule load-bearing rather than decorative.

**Supporting code facts:** `admin_audit_logs` exists and `recordAudit` is used consistently;
`audit.read` is an admin capability; `error.read`, `analytics.platform`, `admin.create`, and
`impersonation.start` are `SUPER_ONLY`; `capability.grant` is deliberately prevented from
granting super-only capabilities (`userCapabilities.js`).

---

## Draft

# Administrator responsibilities

**Version 1.1 · Last updated 2026-08-06**

You have been given an administrator account on WeVolunteer. You can see almost everything in
it, including information about children.

This document is what you agree to in exchange.

## Who may hold this role

Administrator accounts are granted only to **WeVolunteer's named operators**, by
**the platform operator**, who is the only person able to do it — granting an administrator
account requires the `admin.create` capability, and only the operator holds it. The operator is
also accountable for the register below. So the answer to "who let this person in?" is always the
same one person, and only where that person's job actually requires it. There is no
district and no school administrator layer — everyone with this access answers to WeVolunteer
alone, which is exactly why the rules below are written down.

There is a **register of current administrators** at
**`docs/operations/administrator-register.md` in the WeVolunteer source repository**, which
anyone with access to the repository can read. It is deliberately kept there rather than in the
application's own database: a database that is broken, restored from an old backup, or tampered
with must not also be the only record of who had access to it. The repository is version
controlled, so every addition and removal keeps its own date and author. If you are not on it,
you should not have the access.

## The core rule

> **Look at a student's information only when a specific task requires it.**

Curiosity is not a task. Neither is checking on someone you know, looking up a name you
recognised, or browsing to see how the platform is being used. Every one of those is misuse of
the role, and every one of them is visible in the audit log.

If you cannot name the task, close the page.

## What you may do

- Investigate a report or a complaint
- Correct a record a student or organizer has raised
- Approve or decline an organizer application
- Investigate a genuine safety concern
- Perform maintenance or debugging that requires it
- Respond to a lawful request from the authorities

## What you may never do

- Look up a student out of personal interest — including a relative, a neighbour, or someone
  you know from school
- Share what you see outside the platform, including with colleagues who have no need for it
- Copy student data into a spreadsheet, an email, or a personal device
- Use student contact details for anything other than the task in front of you
- Change hours or attendance without a documented reason
- Delete or edit an audit record
- Give anybody more access than their job needs
- Discuss an identifiable student in a channel not intended for it

## Private messages

Students' private messages are readable by an administrator **only** when:

1. Someone has reported the conversation, **or**
2. A safety concern requires it, **or**
3. The authorities have made a lawful request

Read only the conversation in question, and only as much of it as the question requires. Do not
read adjacent conversations because they are there.

**Every access to a reported conversation is logged with your identity.** That is deliberate,
and it is as much protection for you as constraint on you.

## Reporting harm to a child

**New Jersey law requires any person with reasonable cause to believe a child has been abused
or neglected to report it immediately** to the Division of Child Protection and Permanency at
**1-877-NJ-ABUSE (1-877-652-2873)**. (N.J.S.A. 9:6-8.10.)

As an administrator you are more likely than most people to encounter this. So:

- **Call DCP&P yourself.** Escalating internally, filing a ticket, or telling your manager does
  **not** discharge your legal duty.
- **You do not need proof.** "Reasonable cause to believe" is a lower bar than certainty, and
  the law asks you to report a concern, not to investigate one.
- **Do not investigate it yourself.** Do not interview the student. Do not contact a suspected
  abuser. Preserve what you have and report it.
- **Then act on the platform** — suspend accounts, preserve records — and notify
  **security@wevolunteers.org**. Where a student may be at risk, also tell their school or
  guardian **if you can reach them**: WeVolunteer collects no guardian contact details, so DCP&P
  and the police are the routes that always work and the ones that must not be skipped.
- **Preserve everything.** Do not delete a conversation that is part of a report, even at a
  participant's request.

If you are unsure whether the threshold is met, **call and describe what you saw.** That is
what the hotline is for.

## Making corrections

When you change a student's record:

1. Record **why**, in the audit entry.
2. Tell the student, unless doing so would compromise a safety investigation.
3. Never adjust hours as a reward or a punishment — that is the organizer's and the record's
   business, not a lever.
4. Never delete a record to make a problem go away.

## The audit log

Administrator actions are written to `admin_audit_logs` and kept for **1 year**.

The log exists to be read. Someone reviews it — see below — and if your access pattern does not
match your tasks, you will be asked about it. That is the system working, not an accusation.

## Access review

The approver named under **Who may hold this role** reviews the administrator register and a
sample of the audit log every
**quarter, and immediately whenever anyone's role changes**, and:

- removes accounts for people who have changed roles or left
- checks that granted capabilities still match actual jobs
- follows up on access that has no matching task

Being removed at a review is routine and is not a disciplinary matter.

## Super-admin

A few capabilities are restricted to super-admin and cannot be granted to anyone else:
reading error reports, platform-wide analytics, creating administrators, and (in a future
release) impersonation. This is enforced in code, not by convention — `capability.grant`
deliberately cannot grant them, so that the ability to grant access can never become a route
to unlimited access.

**Impersonation does not exist yet.** When it does, it will require its own written procedure
before a single line of it ships: every impersonated action attributed to the real actor, the
impersonated user notified, messaging and deletion disabled while impersonating, a hard time
limit, and a recorded justification per session. If you are asked to use an impersonation
feature that does not have all five, refuse and escalate.

## When you leave

Your access is removed the same day your role ends. Before then:

- Hand over anything in progress
- Delete any local copies of student data you made for a task
- Do not take anything with you

Your confidentiality obligation does not end when your access does.

## If you get this wrong

Depending on what happened: retraining, removal of access, removal from the role,
notification to the affected student (and their guardian, where we can reach one — we hold no
guardian contact details, so that is not something to count on), and — for deliberate misuse of
children's information — referral to the authorities.

**Tell someone immediately if you make a mistake.** An administrator who reports their own
error is fixing a problem. One who hides it is creating a much larger one, and the audit log
means it will be found anyway.

## Acknowledgement

- [ ] I will look at student information only when a specific task requires it.
- [ ] I understand my access is logged and reviewed.
- [ ] I will not share student information outside the platform.
- [ ] I understand New Jersey law requires **me personally** to report suspected child abuse to
      DCP&P at 1-877-NJ-ABUSE, and that telling WeVolunteer instead is not enough.
- [ ] I will report my own mistakes promptly.

**Name:** *your name, from your account* · **Role:** *the administrator role you hold* ·
**Date and time:** *recorded when you accept* · **Version:** *1.0 — the version of this document
you were shown*

*These four values are filled in from your account and stored with your acknowledgement. They
are not blanks for you to type.*
