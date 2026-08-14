# 11. Student Organizer Agreement

## Specification

**Purpose.** Bind a student who has been promoted to help run an organization to a written,
recorded set of obligations before they receive any other student's contact details. The
Organizer Agreement (document 9) does the same job for adults and does not reach these
accounts: it binds `organizer` accounts, and a Student Organizer is a `student`.

**Audience.** Students — typically 13 to 18 — whom an organization's manager has trusted to
post the club's notices, put its shifts up, and take attendance. They are not staff, they are
not employees, and most of them are minors themselves.

**Why this is a different document and not a second audience for document 9.** The Organizer
Agreement carries undertakings that do not apply here and would be false if accepted: it
assumes an adult ("most students on WeVolunteer are minors" is addressed to someone who is
not one), it assigns New Jersey mandated-reporter duties that a student does not carry, and it
promises event-day supervision arrangements ("at least two adults will be present") that a
student cannot make. Asking a fifteen-year-old to tick those boxes would produce a record of
undertakings nobody can perform, which is worse evidence than no record.

**Required sections.** Who this is for · what the rank lets you do · what you can see ·
purpose limitation · no sharing · what you must not do · honest hours · losing the rank ·
this is not a job · acknowledgement.

**Decisions resolved.**
- **Consent type** — `agree`. It is a set of undertakings given in exchange for access, which
  is a contract in substance whatever the reader's age. Document 1 (Privacy Policy) is
  `acknowledge` because you cannot meaningfully disagree with a disclosure; you can decline
  this, and declining is a real option — you stay an ordinary member.
- **Scope** — `student-organizer-onboarding`, a new scope value. Not `organizer-onboarding`:
  that scope drives `ORGANIZER_DOCUMENTS`, which the capability-withholding gate reads, and
  adding a second document to it would start demanding this agreement from every adult
  organizer. Spelled with the `-onboarding` suffix for the reason document 9's scope is —
  `student-organizer` alone is close enough to a role name to invite a role comparison.
- **Guardian consent** — not collected, and not implied. WeVolunteer holds no guardian contact
  details and no mechanism collects any (document 1, §Guardian contact). This agreement does
  not claim a parent approved anything, because no parent was asked.
- **Enforcement** — server-side, by withholding the four capabilities until an acceptance row
  exists at the current version. The screen is not the gate; `withheldCapabilitiesFor` is.
- **Length** — deliberately short. This is read by a fifteen-year-old on a phone, and the
  measure of it is whether they finish it.

**Implementation requirement.** Acceptance is recorded through the existing
`legal_acceptances` table by `recordAcceptances`, keyed on `(slug, version)`, so a version bump
re-arms the requirement. Promotion to `student_organizer` does not itself confer the
capabilities; `syncOrganizerCapabilities` grants them and the agreement gate withholds them
until accepted.

---

## Draft

# WeVolunteer Student Organizer Agreement

**Version 1.0 · Effective 2026-08-13**

> WeVolunteer is operated by **Mahit Pulavarthi, a sole proprietor doing business as
> WeVolunteer**, based in South Brunswick, Middlesex County, New Jersey. Everywhere this
> document says "we," "us," or "WeVolunteer," it means that person.

## 1. Who this is for

Someone who runs an organization on WeVolunteer has trusted you to help run it — as a
**Student Organizer**, or as a **manager** while you are still a student. Either way you can
now see and do things an ordinary member cannot, and this agreement is what you take on with
that.

You are still a student here. You are not staff, you are not an employee, and you are not
being paid. You can hand the rank back at any time by asking a manager to remove it, and you
stay an ordinary member of the organization.

If you are under 18, you can still accept this — it asks you to behave decently with
information, not to take on a legal or financial obligation.

## 2. What you can do

Inside the organization you were trusted in, and nowhere else, you can:

- Post announcements as the organization
- Create and edit that organization's events
- Manage who is accepted onto shifts on events you run
- Take attendance and credit volunteer hours for those events

If you are a **Student Organizer**, that is the whole of it. You cannot ban people, change
anyone's role, handle appeals, or archive the organization — those stay with the managers.

If you are a **manager**, you can do more than that, and more is expected of you. Everything
below still applies, and applies harder.

## 3. What you can see

To do the above you can see, for the events you run:

- The **names** and **usernames** of people who apply
- Their **grade** and **school**, where they chose to share it
- Whether they turned up, and the hours you credit them

You may also see **contact details** for people on your events, where WeVolunteer shows them
to you.

**Most of the people on this list are minors, and so may you be.** Everything below follows
from that.

## 4. You use it to run the event, and for nothing else

The information above is given to you for one reason: running your organization's events.

Do not use it to contact people about anything else. Not to invite them to something
unrelated, not to add them to a group chat, not to promote anything, not because you wanted
to talk to them.

## 5. You do not pass it on

Do not share what you can see with anyone who does not need it to run the same event.

That includes friends, group chats, social media, other students, and other organizations. It
includes screenshots. If you export or copy anything to run an event, delete your copy once
the event is over.

If someone asks you for another student's details, the answer is no. Send them to a manager.

## 6. What you must not do

- Do not look up people who have nothing to do with your events
- Do not use your access to settle an argument, exclude someone, or embarrass anyone
- Do not try to reach parts of WeVolunteer this rank does not give you
- Do not share your account or let anyone else use it
- Do not accept a place on your own event, or arrange for someone else to give you one

## 7. Hours have to be honest

When you credit hours, you are writing on someone's service record. Schools and programmes
read those records.

Credit the hours somebody actually worked. Do not inflate them for a friend, do not withhold
them from someone you dislike, and do not credit anyone who did not turn up. If you make a
mistake, tell a manager so it can be corrected.

## 8. You can lose the rank

A manager can remove Student Organizer from you at any time, for any reason, and your extra
access ends immediately.

If you misuse what you can see — sharing it, using it for something else, or crediting hours
dishonestly — you can lose the rank, and depending on what happened your account can be
suspended under the Community Guidelines.

## 9. This is not a job, and it is not a background check

WeVolunteer has not run a background check on you and does not vouch for you to anybody. Being
a Student Organizer is not employment, not a school position, and not a reference.

The organization's manager remains responsible for the organization. If something goes wrong
at an event, or anything makes you uncomfortable, tell a manager or a trusted adult. You are
not expected to handle it alone.

## 10. If you are worried about someone

You are not responsible for investigating anything. If you think somebody is being hurt or is
in danger, tell a trusted adult — a parent, a teacher, or the organization's manager. In an
emergency, call 911.

## 11. Acknowledgement

By accepting, you confirm:

- [ ] I have read this agreement.
- [ ] I understand I am trusted with other people's information, and that many of them are
      minors.
- [ ] I will use what I can see only to run my organization's events.
- [ ] I will not share anyone's information with people who do not need it, and I will delete
      any copies I make once the event is over.
- [ ] I will credit volunteer hours honestly.
- [ ] I understand what my role does and does not let me do, and I will not try to reach
      anything beyond it.
- [ ] I understand I can lose this rank if I misuse it.

**Accepted by:** *your name, from your account* · **Date and time:** *recorded automatically
when you accept* · **Version:** *1.0 — the version of this document you were shown*

*These values are filled in from your account and stored with your acceptance. They are not
blanks for you to type.*
