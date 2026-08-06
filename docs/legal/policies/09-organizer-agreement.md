# 9. Organizer Agreement

## Specification

**Purpose.** Bind every adult who receives a minor's contact details to a written, auditable
set of obligations before they receive any. This is the highest-value document in the set:
it is the only thing standing between "an organizer got a student's email" and "an organizer
got a student's email and owes nothing to anyone."

**Audience.** Adults applying for organizer accounts — school staff, community nonprofit
staff, parent volunteers. Written to be genuinely read, because an agreement nobody reads
protects nobody.

**Required sections.** Who this binds · what you get access to · purpose limitation ·
confidentiality · no onward disclosure · deletion after the event · contact rules · event
safety · mandated reporting · accurate hours · what we may do · term and termination ·
acknowledgement.

**Decisions resolved.**
- **Counterparty** — Mahit Pulavarthi, a sole proprietor doing business as WeVolunteer, named in
  exactly one place in the draft (the operator block in §1) so a future change of legal form
  edits one block and a version number.
- **Posture** — independent platform. No district imposes terms here and none supersedes this
  agreement. An organizer's own employer or school may impose stricter rules on the organizer,
  which is a different thing and is addressed in §1.
- **Messaging scope** — applicants only, and it is **enforced in code**, not merely promised:
  `eligibleRelationship()` refuses a conversation with a student who has not applied to one of
  your events (covered by `server/messaging.applicantScope.test.js`). §6 now states the rule
  directly instead of carrying a branch.
- **Guardian contact** — WeVolunteer holds **no guardian contact details at all** and no
  mechanism collects any. §10 previously implied we could notify a student's guardian; it now
  says what we can actually do.

> **Needs counsel review.** Also needs a product change: acceptance must be **recorded** —
> version, timestamp, identity — and gated on `organizer.approve`. An agreement that is
> published but not accepted is a blog post.

**Implementation requirement.** Add an `organizer_agreements` table (`user_id`,
`version`, `accepted_at`, `ip`), block the `organizer.approve` transition until a row exists
for the current version, and re-prompt when the version changes. Without this the document has
no legal effect.

---

## Draft

# WeVolunteer Organizer Agreement

**Version 1.0 · Last updated 2026-08-06**

You are applying to post volunteer events for students. Most of those students are minors.
This agreement sets out what you may do with what you learn about them.

It is short. Please actually read it — you will be asked to confirm you did, and that
confirmation is recorded.

## 1. Who this binds

> **THE OPERATOR — the only place in this document that names the legal entity.**
> WeVolunteer is operated by **Mahit Pulavarthi, a sole proprietor doing business as
> WeVolunteer**, based in South Brunswick, Middlesex County, New Jersey. That person is the
> other party to this agreement. Everywhere else this document says "we," "us," or
> "WeVolunteer," it means that person. If the operator later becomes an LLC, a corporation, or a
> nonprofit, this block changes and almost nothing else does.

This is an agreement between you personally and the operator named above. If you are acting
for an organization, it binds that organization too, and you confirm you are allowed to agree
on its behalf.

WeVolunteer is an **independent platform**, not a school district service. If you are also
acting for a school or an employer, their rules apply to you as well — and where theirs are
stricter, follow theirs. But no school stands behind this agreement: it is between you and us.

## 2. What you get access to

Once approved, and only for events **you** create, you can see:

- The **names and contact details** of students who apply
- Their **grade level**
- Anything they chose to put on their profile
- Their attendance and the hours you credit them

You cannot see applications to anyone else's events, and you should not try.

**Most of these students are 13 to 18 years old.** Everything below follows from that.

## 3. You use it only to run the event

Student contact details are given to you for one purpose: running the event they applied to.

You **will not**:

- Add them to a mailing list, newsletter, or CRM
- Use them to recruit for anything else — another event, a job, a programme, a cause
- Use them for fundraising or donation requests
- Copy them into a personal address book or phone
- Use them after the event is over

## 4. You keep it confidential

You will not share a student's name, contact details, grade, school, or attendance with
anyone who does not need it to run this event — including other organizers, colleagues,
your own organization's other departments, and your family.

If you must share within your organization to run the event (for example, giving a shift
supervisor a check-in list), share only what that person needs, and make sure they are bound
by the same rules.

## 5. You delete it afterwards

Within **30 days** of the event finishing, delete any copy you made outside WeVolunteer —
spreadsheets, printouts, emails, notes on your phone. WeVolunteer keeps the record; you do
not need to.

If your own organization's rules require you to keep something longer, tell us what and why
at wevolunteer.platform@gmail.com before you do.

## 6. How you may contact students

- **Message students through WeVolunteer**, not through personal channels. On-platform
  messages can be reviewed if there is ever a problem. A text from your personal phone
  cannot.
- **Only about the event they applied to.** Do not contact a student who has not applied to an
  event you run. *The platform enforces this — you will not be able to open a conversation with
  a student who has not applied to one of your events.*
- **Never ask a student to keep a conversation private** from their parents, guardians, or
  teachers.
- **Never ask for personal contact details** — phone number, home address, social media
  handles.
- **Never send anything sexual, or comment on a student's appearance.** This should not need
  saying, and it is here because it does.

## 7. At your event

You are responsible for the event. WeVolunteer is not.

You confirm that:

- **At least two adults** will be present at all times.
- **No adult will be alone with a single student**, at any point, for any reason.
- You have the permissions, insurance, and supervision your activity requires.
- You will follow your organization's safeguarding policy and any district requirements.
- You will tell students clearly what to bring, wear, and expect.
- You will not ask students to do anything unsafe, or anything they did not sign up for.

## 8. Reporting harm

**New Jersey law requires any person with reasonable cause to believe a child has been
abused or neglected to report it immediately** to the Division of Child Protection and
Permanency at **1-877-NJ-ABUSE**. (N.J.S.A. 9:6-8.10.)

That includes you.

- Report to **DCP&P directly**. Telling WeVolunteer, or your manager, does not satisfy your
  legal duty.
- You do not need proof — "reasonable cause to believe" is enough.
- Do not promise a student you will keep something secret. You may not be able to.
- Also tell us at **wevolunteer.platform@gmail.com** so we can act on the platform.

## 9. Hours must be accurate

The hours you credit become part of a student's record and may count toward graduation, a
scholarship, or a college application.

- Record what actually happened. Do not round up as a favour, and do not withhold hours a
  student earned as a punishment.
- Mark attendance promptly, while you remember it.
- If you make a mistake, tell us — do not quietly adjust it later.
- Never credit hours for work that did not happen. This is the fastest way to lose an
  organizer account.

## 10. What we may do

We may:

- Review your events, messages, and attendance records if there is a report or a concern
- Ask you to correct or remove content
- Suspend or remove your organizer account
- Report conduct that puts a student at risk to the authorities — including DCP&P and the
  police — and tell the student's school or guardian where we are able to reach them

On that last point, so that nobody relies on something we cannot do: **WeVolunteer does not
collect guardian contact details.** We can always report to the authorities, and we can always
suspend an account. We can only reach a guardian if the student has told us how, or if a school
or the authorities put us in touch. Do not assume a guardian has been informed.

For anything involving a student's safety, we will act first and explain afterwards.


## 11. Approval is not a background check

**We do not run background checks on organizers.** Approving your account means an
administrator reviewed it — nothing more. You remain responsible for meeting whatever
screening your own organization, your district, or the law requires of you.

Do not represent to students or parents that WeVolunteer has vetted you.

## 12. Term and ending

This agreement starts when you accept it and continues while you have an organizer account.

Either of us can end it at any time. Sections 4 (confidentiality), 5 (deletion), and 8
(reporting) continue to apply after it ends.

If we update this agreement we will ask you to accept the new version. If you do not, your
organizer permissions pause until you do.

## 13. Acknowledgement

By accepting, you confirm:

- [ ] I have read this agreement.
- [ ] I understand that most students on WeVolunteer are minors.
- [ ] I will use student contact details only to run my own events, and delete my copies
      within 30 days.
- [ ] I will never be alone with a single student, and at least two adults will be present at
      my events.
- [ ] I understand that New Jersey law requires **me** to report suspected child abuse
      directly to DCP&P at 1-877-NJ-ABUSE.
- [ ] I will record volunteer hours accurately.
- [ ] I understand WeVolunteer has not run a background check on me.

**Accepted by:** *your name, from your account* · **Organization:** *the organization you gave
on your organizer application* · **Date and time:** *recorded automatically when you accept* ·
**Version:** *1.0 — the version of this document you were shown*

*These four values are filled in from your account and stored with your acceptance. They are
not blanks for you to type.*
