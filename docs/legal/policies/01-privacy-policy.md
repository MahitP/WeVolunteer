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
9. Under-13 statement
10. Third parties and subprocessors
11. Security
12. Changes to this notice
13. How to contact a human

**Decisions required before publication.**
- **DECISION 1** — controller identity depends on posture
- **DECISION 2** — minimum age; the under-13 section cannot be written without it
- **DECISION 5** — retention periods; §312.10 makes this non-optional
- **DECISION 9** — the contact address

**Relationship to existing code.** This supersedes `src/views/PrivacyNotice.jsx` as the
*source of truth*, but that page's architecture is correct and should be kept: factual
sections are hard-coded because they are engineering facts; district-specific facts arrive
as configuration and the page declares itself incomplete until they do. This draft supplies
the text those config values should hold.

---

## Draft

# Privacy at WeVolunteer

**Last updated: [[DATE]]** · Applies to WeVolunteer version 1.2 and later

WeVolunteer helps students find volunteer work and keep track of their service hours. To do
that, it has to store some information about you. This page explains all of it.

We wrote this to be read, not to be survived. If anything here is unclear, that is our
problem and we want to hear about it: **wevolunteer.platform@gmail.com**.

## The short version

- We store your name, email, grade, and the record of volunteering you do.
- Your profile is **private unless you change it**.
- Organizers see your contact details **only** for events you applied to.
- We do not sell your information, show you ads, or use tracking cookies.
- You can download everything we have about you, any time, from Settings.
- You can delete your account — with one important exception about certificates, explained
  below, which we want you to read before you decide.

## Who is responsible for your information

**[[LEGAL_ENTITY_NAME]]** operates WeVolunteer and is responsible for your information.

WeVolunteer is an **independent platform**. Schools and community organizations can take part —
organizers post events, students volunteer — but **your school does not run WeVolunteer and
does not control your account.** If you want something corrected or removed, you ask us, not
your school.

Contact: **wevolunteer.platform@gmail.com**

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

**Administrators** at [[OWNER]] can see accounts, events, and applications across the
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

- Auto Select gives students with **fewer recorded hours a better chance**, on purpose, so
  that opportunities spread around instead of going to the same few people.
- It uses **only** your total credited service hours. It does not use your grade, your
  school, your profile, your bio, or anything about who you are.
- It is random within that weighting, and every draw is recorded so it can be checked later.

If you were not selected and you want to know why, ask the organizer. If you think a draw was
wrong, contact **wevolunteer.platform@gmail.com** and we will look at the recorded draw.

## What we do not do

- **We do not sell your information.** Not to advertisers, not to colleges, not to anyone.
- **We do not show you ads**, and we do not use your information to target ads anywhere else.
- **We do not use tracking cookies or third-party analytics.** See the
  [Cookie and Tracking Notice](05-cookie-and-tracking-notice.md).
- **We do not read your messages routinely.** An administrator reads a conversation only when
  somebody reports it, or when we are required to investigate a safety concern.
- **We do not record what is on your screen when something breaks.** When the app hits an
  error it sends us a diagnostic record. Before that record is stored, email addresses and
  security tokens are stripped out, you are recorded as a one-way scrambled code rather than
  a name, and the page address is stored as a pattern (`/events/:id`) rather than the real
  one.

## How long we keep things

| What | How long | Why |
|---|---|---|
| **Volunteer hours and attendance** | **Kept indefinitely** | This is your service record. People come back for it years later — for a college application, a scholarship, a job. Deleting it would destroy the thing WeVolunteer exists to build |
| **Certificates** | **Kept indefinitely** | So a college or employer can still verify one years after you earned it. See the [Certificate Verification Policy](06-certificate-verification-policy.md) — including what this means if you delete your account |
| Account and profile | While your account is open. After deletion, your details are replaced with a shortened name, and the remaining shell is deleted after **3 years** | |
| Applications | 3 years after the event | Long enough to resolve a dispute about a placement |
| Messages | **3 years** — longer if the conversation has been reported | Long enough to investigate a safety report, which often surfaces late. A reported conversation is never deleted on schedule, because that would destroy the evidence an investigation needs |
| Comments | Until the event is deleted | |
| Error diagnostics | 90 days | Long enough to fix a bug |
| Administrator audit logs | **1 year** | So misuse of an administrator account can be traced later |
| Data export archives | **7 days**, then deleted automatically | Already enforced in code |

These periods are enforced by a job that runs every day and deletes what has aged out — they
are not just a statement of intent. Two exceptions are deliberate and are called out below.

**Two things are kept indefinitely, and we want to be straight about it:** your hours and your
certificates. That is a deliberate choice, because a service record that expires is not a
service record. Everything else has an end date.

If you would rather your certificates did not last forever, you can void them when you delete
your account — see the [Data Deletion Policy](04-data-deletion-policy.md).

## Your choices

| You want to… | How |
|---|---|
| See everything we hold | Settings → Download my data. You will be asked to confirm it is you |
| Fix something wrong | Settings → Profile for most things; email **wevolunteer.platform@gmail.com** for hours or attendance |
| Stop emails | Settings → Notifications. Security emails cannot be switched off |
| Hide your profile | Settings → Privacy. It is already private unless you changed it |
| Leave the leaderboard | Settings → Privacy. Takes effect immediately |
| Delete your account | Settings → Delete account. **Please read the [Data Deletion Policy](04-data-deletion-policy.md) first** — some things are kept |
| Complain | **wevolunteer.platform@gmail.com**. We will acknowledge within 10 business days |

## For parents and guardians

If you are the parent or guardian of a student under 18, you can ask to see what we hold
about your child, ask us to correct it, and ask us to delete it.

Email **wevolunteer.platform@gmail.com**. We will ask you to confirm who you are and your
relationship to the student — proportionate to what you are asking for, and no more
documentation than we actually need. We acknowledge within **10 business days** and respond
within **45 days**.

Because WeVolunteer is independent, **your school cannot do this for you.** Ask us directly.

[[PENDING — guardian consent mechanism, see re-audit Q2. Once built, add:
"When a student under 18 signs up, we ask for a guardian's email address and send you a link to
confirm. We will email you if your student's account is suspended, if a safety report involves
them, or if their account is deleted."]]

One thing to know: students aged 13 and over can also make these requests themselves, and we
will tell the student when an account change is made on their behalf.

## Students under 13

WeVolunteer is for students in grade 9 and above and **is not for children under 13**.

We ask your date of birth when you sign up and do not create accounts for anyone under 13.
That check runs on our servers, not just in your browser, and it applies however you sign up —
including with Google. We do not tell you how close you were, because that would just be
telling you which year to type instead.

If we find out we have information about a child under 13, we delete it promptly. If you think
a child under 13 has an account, email **wevolunteer.platform@gmail.com** and we will act on it.

This is also why we can keep hours and certificates forever: the law does not allow keeping a
child's information indefinitely, and the age check is what makes that promise a safe one.

## Other companies involved

WeVolunteer runs on a small number of outside services. Here is all of them:

| Service | What it receives | What it is for |
|---|---|---|
| **[[SMTP_PROVIDER]]** | Your email address and the message | Sending you notification and security emails |
| **Google** (only if you sign in with Google) | Your email address and basic profile | Signing you in. We ask Google for nothing else |
| **OpenStreetMap / Nominatim** | Event location text | Turning an event address into map coordinates. **Never anything about you** |
| **Open-Meteo** | Event coordinates | The weather forecast on an event page. **Never anything about you** |
| **CARTO** | **Your IP address**, when a map is shown | Loading the map images. It does not receive your name or account — see below |
| **[[HOSTING_PROVIDER]]** | Stores the database | Running the service |

Two of these are contacted by our servers, so they never see your device.

**CARTO is different and we want to be clear about it.** When a page shows a map, your browser
loads the map images directly from CARTO. That means CARTO can see your IP address and which
part of the map you looked at. It does **not** receive your name, email, or account. This only
happens on pages with a map. See the
[Cookie and Tracking Notice](05-cookie-and-tracking-notice.md).

### Your device location

Some screens can sort events by distance from you. Your browser will ask your permission
first. **Your coordinates never reach our servers and are never stored** — they stay in the
page while you are looking at it and are gone when you reload. Saying no costs you nothing but
the distance sort.

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
current version, and previous versions are kept at [[POLICY_ARCHIVE_URL]].

## Contact

**wevolunteer.platform@gmail.com** — monitored by [[ROLE_TITLE]]. We acknowledge within 10 business
days.
