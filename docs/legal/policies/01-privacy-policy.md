# 1. Privacy Policy

## Specification

**Purpose.** Tell students and guardians exactly what WeVolunteer collects, why, who sees
it, how long it is kept, and how to get it changed or removed — accurately enough that a
regulator reading it alongside the database finds no daylight between them.

**Audience.** Primary: students aged 13–18. Secondary: guardians, school administrators
evaluating the platform, and regulators. The primary audience is the one that sets the
reading level.

**Required sections.**
1. Who is responsible for your information (controller identity — differs by posture)
2. What is collected, split into *given by you* vs *created by using the app*
3. Why each category is collected (purpose limitation)
4. Who can see it, by role
5. What WeVolunteer does not do
6. How long it is kept — **required in the notice by COPPA §312.10**
7. Your choices and rights, with the mechanism for each
8. Guardians: how to ask questions and make requests
9. The age policy, and the plain statement that no guardian consent step exists
10. Third parties and subprocessors
11. Security
12. Changes to this notice
13. How to contact a human

**Decisions resolved.**
- **Controller identity** — Mahit Pulavarthi, a sole proprietor doing business as WeVolunteer.
  Named in exactly one place in the draft (the operator block under the title) so that a future
  conversion to an LLC, corporation, or nonprofit edits one block and a version number.
- **Posture** — independent platform. No school or district is a controller, a joint controller,
  or an operator of anything described here.
- **Minimum age** — 13, enforced server-side on every signup path
  (`accountValidation.js`, `MINIMUM_AGE = 13`; migration 008).
- **Retention periods** — filled in throughout and enforced by
  `server/workers/retentionWorker.js` and `sweepErrors` in `server/errorReporter.js`. Hours and
  certificates are indefinite by deliberate decision; everything else has an end date.
- **Guardian consent** — **there is none and none will be built.** No guardian email is
  collected, no confirmation is sent, nothing is verified, and no guardian is notified of
  anything. The draft discloses that in plain words. Do not reintroduce language implying
  otherwise.
- **Contact** — privacy@wevolunteers.org, monitored by the operator.

**Still open — one item, marked in the draft as blocking publication.** The production hosting
provider and the country the database sits in. The email-sending provider is resolved: Resend is
primary and Gmail is the fallback, and both are named in the table. The policy-archive
promise is resolved by this being v1.0 — there are no superseded versions yet, so the draft says
so and offers previous versions on request once there are any.

**Relationship to existing code.** This superseded `src/views/PrivacyNotice.jsx` as the
*source of truth*, and that view has now been deleted — `/privacy` redirects here, so there is
one privacy page again. Its architecture is worth remembering rather than keeping: factual
sections are hard-coded because they are engineering facts; operator-specific facts (the entity
name, the postal address, the vendor names) arrive as configuration and the page declares itself
incomplete until they do. This draft supplies the text those config values should hold. There are
no district-specific facts — that branch is gone.

**PENDING CORRECTION — analytics is now asked for. Staged here, deliberately not applied.**

Line ~189 of the published body reads "is **off unless you switch it on** in Settings →
Privacy, **we never prompt you to**, and you can". The clause "we never prompt you to"
became false on 2026-09-28, when a consent prompt shipped: `analytics_consent` starts
`null`, nothing ever asked, and every production account sat at `null` — so the feature was
reachable only by somebody who already knew it existed. "Nobody found the switch" is not
"everybody declined".

The replacement clause, ready to drop in:

> is **off unless you switch it on**, we ask once shortly after you sign in and never
> again, and you can

**Why this has not been applied.** This document has an acceptance row, and it belongs to a
student — a minor who read this page and agreed to it on 2026-09-14. Rewriting the words
underneath somebody's consent is a decision about a consent record, not an edit. The
machinery agrees and does not merely advise: migration 070 refuses to clear any
`(slug, version)` with an acceptance, and `syncLegalDocuments` then blocks the boot rather
than republishing over it. Verified on 2026-09-28 by planting an acceptance row and watching
it refuse.

The Cookie and Tracking Notice carried the same false claim and WAS corrected the same day
(migration 070), because nobody has ever accepted it. That asymmetry is the rule working,
not an inconsistency.

**Apply this at launch**, in the same pass as the CARTO passage below, when the reset clears
the acceptance and the correction costs nobody their consent record. Both are on the launch
checklist.

---

## Draft

# Privacy at WeVolunteer

**Version 1.0 · Last updated 2026-08-06** · Applies to WeVolunteer version 1.2 and later

> **THE OPERATOR — the only place in this document that names the legal entity.**
> WeVolunteer is operated by **Mahit Pulavarthi, a sole proprietor doing business as
> WeVolunteer**, based in South Brunswick, Middlesex County, New Jersey. That person is
> responsible for the information described on this page. Everywhere else this document says
> "we," "us," or "WeVolunteer," it means that person. If the operator later becomes an LLC, a
> corporation, or a nonprofit, this block changes and almost nothing else does.

WeVolunteer helps students find volunteer work and keep track of their service hours. To do
that, it has to store some information about you. This page explains all of it.

We wrote this to be read, not to be survived. If anything here is unclear, that is our
problem and we want to hear about it: **privacy@wevolunteers.org**.

## The short version

- **You have to be 13 or older.** There is no parent or guardian approval step, and we do not
  check with anyone — the age rule is the control, and both of those facts are explained below.
- We store your name, email, grade, and the record of volunteering you do.
- Your profile is **private unless you change it**.
- Organizers see your contact details **only** for events you applied to.
- We do not sell your information, show you ads, or use tracking cookies.
- You can download everything we have about you, any time, from Settings.
- You can delete your account — with one important exception about certificates, explained
  below, which we want you to read before you decide.

## Who is responsible for your information

The operator named at the top of this page runs WeVolunteer and is responsible for your
information. One person, not a company and not a school.

WeVolunteer is an **independent platform**. Schools and community organizations can take part —
organizers post events, students volunteer — but **your school does not run WeVolunteer and
does not control your account.** If you want something corrected or removed, you ask us, not
your school.

Contact: **privacy@wevolunteers.org**

## What we collect

### Things you give us

| What | Required? | Why we need it |
|---|---|---|
| Name | Yes | So organizers know who is coming, and so your certificates say who earned them |
| Email address | Yes | To sign you in, and to send you things about your applications |
| Grade level | Yes | So organizers can find volunteers suitable for an event |
| Username | Yes | Your public name in comments |
| Password | Yes, unless you sign in with Google | Stored only as a **one-way hash** — we never see or store your actual password |
| School | No | Shown on your profile if you fill it in |
| Bio, avatar, skills | No | Shown on your profile if you fill them in |

### Things created as you use WeVolunteer

- Events you applied to, and whether each application was accepted, waitlisted, declined, or
  withdrawn
- Whether you attended, and the service hours credited to you
- Certificates issued for events you completed
- Messages you send through the app, and comments you post on events
- Your notification and email preferences
- Basic technical records needed to keep the service running and secure

### Things we deliberately do not collect

We do not collect your home address, phone number, date of birth beyond what an age check
requires, government ID, or any information about your race, religion, health, or family.
If a field ever asks you for something in this list, something has gone wrong — please tell
us.

## Who can see your information

**You** see everything on your own account, and can download a complete copy from Settings at
any time.

**Organizers** of an event see the name and contact details of students who applied to
**that event**, so they can pick volunteers and record attendance. They cannot see
applications to anybody else's events. Organizers agree in writing to use your details only
to run the event and not to keep or share them afterwards.

**WeVolunteer administrators** — the operator, and anyone the operator has given an
administrator account to — can see accounts, events, and applications across the
platform, because somebody has to be able to run it and answer problems. Administrator
access is logged. Looking at a student's record without a work reason is a misuse of the
role, not a perk of it.

**Other signed-in students** see only what your profile visibility setting allows. **Your
profile is private by default.** You have to turn sharing on; we will never turn it on for
you.

**Anyone holding a certificate code** can check that certificate. The check shows the
volunteer's name, the event, the organizer, and the hours — the same things printed on the
certificate itself. It does **not** show your grade, school, email, or anything else. Codes
are random, and checking is rate-limited, so nobody can go fishing for names.

**The leaderboard** shows your name and total hours to other signed-in users. It is **off
until you turn it on**, and you can turn it off again whenever you like.

## How events choose volunteers

Some organizers pick volunteers by hand. Others use **Auto Select**, which is a computer
draw. You should know how it works:

- Auto Select gives students with **fewer credited hours a better chance**, on purpose, so
  that opportunities spread around instead of going to the same few people.
- It uses **two things and nothing else**: your total credited service hours, and whether you
  turned up to shifts you were accepted for. Hours come first by a wide margin; attendance is
  a small adjustment, and if we have no attendance record for you it counts neither for nor
  against you.
- It does **not** use your grade, your school, your profile, your bio, or anything about who
  you are. The exact formula, and the exact limits on how much attendance can matter, are
  published in the [Volunteer Record Policy](/legal/volunteer-record-policy#auto-select).
- It is random within that weighting, and every draw is recorded so it can be checked later.

If you were not selected and you want to know why, ask the organizer. If you think a draw was
wrong, contact **support@wevolunteers.org** and we will look at the recorded draw.

## What we do not do

- **We do not sell your information.** Not to advertisers, not to colleges, not to anyone.
- **We do not show you ads**, and we do not use your information to target ads anywhere else.
- **We do not use tracking cookies**, advertising pixels, fingerprinting or cross-site
  tracking of any kind.
- **We do not turn analytics on for you.** WeVolunteer has one optional analytics feature. It
  is **off unless you switch it on** in Settings → Privacy, we never prompt you to, and you can
  switch it off again at any time. Everything it collects is listed in the
  [Cookie and Tracking Notice](/legal/cookie-and-tracking-notice).
- **We do not read your messages routinely.** An administrator reads a conversation only when
  somebody reports it, or when we are required to investigate a safety concern.
- **We do not record your screen because something broke.** When the app hits an error it
  sends us a diagnostic record. Before that record is stored, email addresses and security
  tokens are stripped out, you are recorded as a one-way scrambled code rather than a name,
  and the page address is stored as a pattern (`/events/:id`) rather than the real one. The
  screen recording described in the Cookie Notice is a different thing entirely: it happens
  only if you switched analytics on, it is not triggered by errors, and the text on the page
  is hidden before it is sent.

## How long we keep things

| What | How long | Why |
|---|---|---|
| **Volunteer hours and attendance** | **Kept indefinitely** | This is your service record. People come back for it years later — for a college application, a scholarship, a job. Deleting it would destroy the thing WeVolunteer exists to build |
| **Certificates** | **Kept indefinitely** | So a college or employer can still verify one years after you earned it. See the [Certificate Verification Policy](/legal/certificate-verification-policy) — including what this means if you delete your account |
| Account and profile | While your account is open. After deletion, your details are replaced with a shortened name, and the remaining shell is deleted after **3 years** — unless you have volunteer hours or a certificate, which the shell has to outlive, or you are named in an open safety report, in which case it waits until that report is closed | The two exceptions are narrow and neither is open-ended: hours and certificates are the record the shell exists to support, and a report gets closed |
| Applications | 3 years after the event | Long enough to resolve a dispute about a placement |
| Messages | **3 years** — longer if the conversation has been reported | Long enough to investigate a safety report, which often surfaces late. A reported conversation is never deleted on schedule, because that would destroy the evidence an investigation needs |
| **Safety reports, and the messages saved with them** | **Kept indefinitely** | A report is the record of a decision we made about somebody's safety, and both the person who reported and the person reported are entitled to have it still exist if it is ever questioned. It is kept even if you delete your account, and it cannot be edited or deleted by anyone — including us. See the [Data Deletion Policy](/legal/data-deletion-policy) |
| Comments | Until the event is deleted — and an event named in an open safety report cannot be deleted until that report is closed | |
| Error diagnostics | The detailed record of one error: **30 days**. The summary of a problem we have already dealt with: **30 days**. The summary of a problem nobody has dealt with yet: **180 days**. A one-off glitch seen once from one browser: **7 days** | Long enough to find and fix a bug, and no longer. A problem nobody has fixed is still true, which is why its summary outlives the individual records |
| Administrator audit logs | **1 year** | So misuse of an administrator account can be traced later |
| Data export archives | **7 days**, then deleted automatically | Already enforced in code |

These periods are enforced by a job that runs every day and deletes what has aged out — they
are not just a statement of intent. Two exceptions are deliberate and are called out below.

**Three things are kept indefinitely, and we want to be straight about it:** your hours, your
certificates, and safety reports. The first two are a deliberate choice, because a service record
that expires is not a service record. The third is different, and worth explaining rather than
burying in a table.

A safety report is the only record of a decision somebody made about whether a student was safe.
If that decision is ever questioned — by you, by a parent, by a school, or by a court — the report
and the messages saved with it are what the answer rests on, and they protect the person who
reported at least as much as they protect us. A student who reports an adult and later deletes
their account should not thereby erase the record of what was done to them, and that is exactly
what used to happen. So a report survives the deletion of the account that filed it, the account
it was about, and the event it happened at. What survives is the report itself, the reporter's
name as it was at the time, and a copy of the messages that were saved with it — not your profile,
which is still removed and scrambled.

**Why safety reports have no end date, and why that is a decision rather than an oversight.**

Two things drive it. The first is the claim window: New Jersey gives someone who was a minor at
the time a very long time to bring a claim, and for claims about child sexual abuse it is longer
still. A report deleted inside that window destroys the record that protects the student who
filed it at least as much as it protects us.

The second is that safety evidence has to be unchangeable to be worth anything. The database
physically refuses to delete a report or to edit the messages saved with it — not "we have a
policy against it", but a rule the database enforces on every attempt, including ours. We
considered blanking the saved messages after a number of years and decided against it, because
the only way to do that is to make frozen evidence editable, and the party most motivated to
change a safety record is the party it is about.

So the report itself is kept for good, and we would rather say that plainly than publish a
number we would not honour. **What is kept is deliberately small:** what was reported, what we
decided, when, and the names as they were at the time. It is not your profile — a deleted
account is still anonymised and still removed on the schedule above — and it is not the whole
conversation. Everything in a reported thread that was not saved as evidence goes back on the
ordinary three-year clock once the report is closed.

Everything else has an end date.

**There is currently no way to make your certificates stop being verifiable.** We would like to
add an option to void them when you delete your account — removing your name and stopping the
codes working — but **it does not exist, and we cannot promise a date**, so the only accurate
thing we can tell you today is that a certificate you have earned keeps your full name on it,
permanently. The
[Data Deletion Policy](/legal/data-deletion-policy) explains exactly what that means. Please read
it before you delete, not after.

## Your choices

| You want to… | How |
|---|---|
| See everything we hold | Settings → Download my data. You will be asked to confirm it is you |
| Fix something wrong | Settings → Profile for most things; email **support@wevolunteers.org** for hours or attendance |
| Stop emails | Settings → Notifications. Security emails cannot be switched off |
| Hide your profile | Settings → Privacy. It is already private unless you changed it |
| Leave the leaderboard | Settings → Privacy. Takes effect immediately |
| Delete your account | Settings → Delete account. **Please read the [Data Deletion Policy](/legal/data-deletion-policy) first** — some things are kept |
| Complain | **privacy@wevolunteers.org**. We will acknowledge within 10 business days |

## For parents and guardians

If you are the parent or guardian of a student under 18, you can ask to see what we hold
about your child, ask us to correct it, and ask us to delete it.

Email **privacy@wevolunteers.org**. We will ask you to confirm who you are and your
relationship to the student — proportionate to what you are asking for, and no more
documentation than we actually need. We acknowledge within **10 business days** and respond
within **45 days**.

Because WeVolunteer is independent, **your school cannot do this for you.** Ask us directly.

One thing to know: students aged 13 and over can also make these requests themselves, and we
will tell the student when an account change is made on their behalf.

### What we do not do, and want you to know before you go looking for it

**There is no parent or guardian consent step on WeVolunteer, and we are not building one.**
Specifically:

- We **do not ask for a guardian's email address** at signup, or at any other point.
- We **do not send a guardian a confirmation link**, and no part of your account waits for
  a guardian's approval.
- We **do not verify** that a guardian saw these policies, or that one exists.
- We **do not notify a guardian** automatically about anything — not a suspension, not a safety
  report, not a deletion. If you have not given us your email address, we do not have it.

A student aged 13 or over can create an account, apply to events, and message an organizer
about them without anyone telling you. **What actually protects your student** is the hard age
floor, a private-by-default profile, an off-by-default leaderboard, organizers seeing contact
details only for events your student applied to, a Report button on every conversation, and
one-directional blocking that an adult cannot use against a student.

We would rather write that paragraph than print "a guardian must agree" and not check. If you
want to be involved, the way to do it is to ask your student to show you the app — and to email
us, which you can do at any time without their permission.

## Age: you must be 13 or older

WeVolunteer is for students in grades 9–12 or the equivalent. **The minimum age is 13, and it
is a hard floor.** There is no version of WeVolunteer for children under 13 and there is no way
to get an exception.

We ask your date of birth when you sign up and do not create accounts for anyone under 13.
That check runs on our servers, not just in your browser, and it applies however you sign up —
including with Google. We do not tell you how close you were, because that would just be
telling you which year to type instead.

If we find out we have information about a child under 13, we delete it promptly. If you think
a child under 13 has an account, email **privacy@wevolunteers.org** and we will act on it.

This is also why we can keep hours and certificates forever: the law does not allow keeping a
child's information indefinitely, and the age check is what makes that promise a safe one.

**The age check is the control, and it is doing the work a guardian consent step would do
elsewhere.** We do not ask a parent or guardian to approve a signup, and we do not check with
anyone — see [What we do not do](#what-we-do-not-do-and-want-you-to-know-before-you-go-looking-for-it)
above. We are telling you that on the same page as the age rule, on purpose, so that nobody
assumes a second layer that is not there.

## Other companies involved

WeVolunteer runs on a small number of outside services. Here is all of them:

| Service | What it receives | What it is for |
|---|---|---|
| **Resend** | Your email address and the message | Sending you notification and security emails. This is our main email provider |
| **Google** (Gmail) | Your email address and the message | The backup route for email, used only when Resend cannot deliver |
| **Google** (only if you sign in with Google) | Your email address and basic profile | Signing you in. We ask Google for nothing else |
| **Microsoft** (only if you sign in with Microsoft) | Your email address and basic profile | Signing you in. We ask Microsoft for nothing else |
| **OpenStreetMap / Nominatim** | Event location text | Turning an event address into map coordinates. **Never anything about you** |
| **Open-Meteo** | Event coordinates | The weather forecast on an event page. **Never anything about you** |
| **OpenRouteService** | Event coordinates, and your position blurred to about 110 metres | Working out a rough driving time to an event. It is told nothing that identifies you, and your position is never stored |
| **CARTO** | **Your IP address**, when a map is shown | Loading the map images. It does not receive your name or account — see below |
| **Amplitude** — **only if you switched analytics on** | How you use the app, and a recording of your screen with the text hidden | Finding what is confusing or broken. **Off unless you turn it on**; see the [Cookie and Tracking Notice](/legal/cookie-and-tracking-notice) |
| **Upstash** | A scrambled one-way code standing for your account or your network, and event weather and address lookups. **Never your name, email, messages, hours, or where you are** | Counting failed sign-in attempts so nobody can guess your password, and remembering weather and map lookups so we ask those services less often. See the note below this table |
| **Our hosting provider** — not yet chosen. See the note below this table | Stores the database | Running the service |

**About Upstash.** Upstash gives us a short-term memory that survives a restart. Two things go
in it, and nothing else.

The first is a counter of failed sign-in attempts. To count them without storing who you are, we
turn your account — or your network address — into a **scrambled one-way code** first. The code
cannot be turned back into your email or your address. Upstash sees the code and a number, and
both are deleted automatically within about fifteen minutes. It is what stops somebody sitting
there guessing your password.

The second is the weather forecast and the address lookups for **events**, so we do not have to
ask those services the same question repeatedly. Those are about places, not people. Your own
location is **never** sent to Upstash — the driving-time estimate deliberately does not use it,
for the reason given under [Your device location](#your-device-location) below.

Upstash never receives your name, your email address, your messages, your volunteer hours, or
your certificates. Those live in our own database. The Upstash servers we use are currently in
**India**; if we move them before launch we will update this row and the date at the top.

**About the hosting provider.** WeVolunteer has not launched yet and the company that will host
the production server has not been chosen. We are not going to name one here before it is true.
When it is chosen we will name it in this table, say which country the database is in, and update
the date at the top of this page. If you are reading this and that row still says "not yet
chosen", it means the service is not yet running anywhere that holds your information.

Most of these are contacted by our servers, so they never see your device at all. CARTO and
Amplitude are the two your browser talks to directly — CARTO whenever a map is shown, Amplitude
only if you switched analytics on.

**CARTO is different and we want to be clear about it.** When a page shows a map, your browser
loads the map images directly from CARTO. That means CARTO can see your IP address and which
part of the map you looked at. It does **not** receive your name, email, or account. This only
happens on pages with a map. See the
[Cookie and Tracking Notice](/legal/cookie-and-tracking-notice).

### Your device location

Some screens can sort events by distance from you, and an event page can show roughly how long
it takes to drive there. Your browser will ask your permission before any of that happens.

**Your coordinates are never stored** — not in our database, not in a log, not anywhere. There
is no column in WeVolunteer that holds a person's location. They stay in the page while you are
looking at it and are gone when you reload.

They do reach our servers, blurred, in two cases: rounded to about a kilometre to sort a list
by distance, and rounded to about 110 metres to ask a route planner for a driving time. Both are
used to answer the question and then discarded. Saying no costs you nothing but the distance
sort and that estimate.

## Security

- Passwords are stored as one-way hashes (bcrypt). Nobody at WeVolunteer can see your
  password.
- Before you delete your account, change your password or email, connect or disconnect a
  sign-in provider, or download your data, we ask you to prove it is you again — even though
  you are already signed in.
- Every permission is checked on our servers on every request, not just hidden in the app.
- Administrator actions are written to an audit log.
- Data export archives are never cached and are deleted after 7 days.

No system is perfectly secure. If something goes wrong that affects you, we will tell you.

## If there is a data breach

If information about you is exposed, we will notify the New Jersey State Police as state law
requires, then tell you what happened, what was affected, and what to do — as quickly as we
reasonably can.

Because WeVolunteer is independent, that notice comes from us directly — there is no school in
between, and you should not wait to hear it from one.

## Changes to this notice

If we change something that matters, we will tell you in the app before it takes effect —
not by quietly editing this page. The "last updated" date at the top always reflects the
current version.

**This is version 1.1.** The change from version 1.0 was to add **Upstash** to the list of other
companies involved, and to explain what it holds — a scrambled counter of failed sign-in
attempts, and event weather and address lookups. Nothing else changed, and nothing about what we
collect from you changed.

We keep every version we replace, and you can email **privacy@wevolunteers.org** for any previous
version and the dates it applied. Every version is stored with a content fingerprint, so a copy
you receive can be checked against the one your account accepted.

## Contact

**privacy@wevolunteers.org** — read by the operator personally. We acknowledge within 10
business days.

Being one person is the honest answer to "who monitors this?", and it is why we do not claim a
24-hour response. For anything urgent, the numbers in the
[Youth Safety Guidelines](/legal/youth-safety-guidelines) reach people who are awake.
