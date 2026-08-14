# 2. Terms of Service

## Specification

**Purpose.** Establish the contract: what WeVolunteer provides, what users may and may not
do, who bears which risk, and how disputes are resolved.

**Audience.** All users — students and organizers. Guardians read it, but they are not a party
to it and no mechanism asks them to be. School staff evaluating adoption read it too.

**Required sections.** Acceptance and capacity · eligibility and age · account rules ·
acceptable use · user responsibilities (student and organizer, separately) · service hours
disclaimer · events happen offline · intellectual property · suspension, termination and
appeals · disclaimers · limitation of liability · indemnity · changes · dispute resolution
process · governing law and venue · contact.

**Decisions resolved.**
- **Operator** — a sole proprietorship. Mahit Pulavarthi, doing business as WeVolunteer. Named
  in exactly one place in the draft (the operator block under the title) so that a future
  conversion to an LLC, corporation, or nonprofit is a version bump that edits one block.
- **Posture** — independent platform. No school or district is a party to these terms, operates
  the platform, controls accounts, or indemnifies the operator. Any surviving sentence implying
  otherwise is a defect.
- **Age** — 13 and over, grades 9–12 or equivalent. Enforced server-side
  (`accountValidation.js`, `MINIMUM_AGE = 13`) on every signup path including Google.
- **Guardian consent** — **there is none, and none will be built.** No guardian email is
  collected, no confirmation link is sent, nothing is verified, and no guardian is notified of
  anything. The draft says so in plain words instead of implying a protection that does not
  exist. Do not reintroduce guardian-consent language into this document; it would be a
  misrepresentation about an available protection, which is the FTC Act §5 shape.
- **Governing law and venue** — New Jersey law, Middlesex County venue (the operator is in
  South Brunswick, Middlesex County). **Needs owner confirmation** before publication.

**Resolved for the v1.0 release.** The liability cap is $100, with the reasoning kept in the text
(the service is free, so "fees paid" would be a disguised zero, and a modest cap is likelier to be
enforced than an aggressive one) — counsel should confirm the figure, but the section is
publishable with it and was not publishable blank. The postal address is deliberately NOT printed:
service of paper correspondence is arranged on request, because the only address that exists today
is residential and publishing it would expose the person who suspends accounts to the people whose
accounts get suspended. The archive promise is resolved by this being v1.0. Counsel should still
confirm the no-arbitration choice and the New Jersey venue; that is tracked outside the document
rather than printed in it.

> **This is still the one document in the set that most benefits from a lawyer reading it
> before it goes live.** The draft below is complete and internally consistent, and the three
> clauses counsel will go to first — limitation of liability, indemnity, and dispute resolution
> — are drafted conservatively on purpose.

**The structural point counsel will raise, and the honest answer.** A minor's agreement to a
contract is generally **voidable**. This document is therefore not a reliable liability shield
against student users, and with no district agreement and no guardian acknowledgement behind
it, nothing else in the stack is either.

That is a **decision, not an oversight**: the platform will not build guardian verification, so
the residual exposure is accepted and managed by the things that do exist — a hard age floor, a
narrow data footprint, an honest liability section that does not overreach, real enforcement
(suspension, blocking, applicant-scoped messaging), and disclosure written to be understood by
a fourteen-year-old. §10 of `../00-COMPLIANCE-AND-RISK.md` should be read alongside this.

---

## Draft

# WeVolunteer Terms of Service

**Version 1.0 · Last updated 2026-08-06**

> **THE OPERATOR — the only place in this document that names the legal entity.**
> WeVolunteer is operated by **Mahit Pulavarthi, a sole proprietor doing business as
> WeVolunteer**, based in South Brunswick, Middlesex County, New Jersey. Everywhere else this
> document says "we," "us," or "WeVolunteer," it means that person. If the operator later
> becomes an LLC, a corporation, or a nonprofit, this block changes and almost nothing else
> does.

These terms are an agreement between you and us about how you use WeVolunteer. We have kept
them as short and as plain as we can. Where a sentence has to be precise for legal reasons,
we say what it means first.

## 1. Agreeing to these terms

By creating an account or using WeVolunteer, you agree to these terms.

WeVolunteer is an **independent platform**. **Your school has not agreed to these terms for
you, and cannot.** No school or district runs WeVolunteer, controls your account, sets these
rules, or stands behind them. This is between you and us.

**If you are under 18 — read this part carefully, because it is not the usual sentence.** We
ask you to read these terms with a parent or guardian before you create an account, and we mean
it. But be clear about what we do and do not do:

- We **do not** ask for a parent or guardian's email address.
- We **do not** send anyone a link to confirm that you may sign up.
- We **do not** check that a guardian read this, or that one exists.
- There is **no guardian approval step**, and we are not building one.

So nothing stops you signing up without telling anyone. We are telling you that plainly rather
than printing "a guardian must agree" and quietly not checking — a promise nobody verifies is
worse than no promise. What that means in practice is that the responsibility for reading and
understanding this sits with you, which is part of why we have kept it short.

If you do not agree, do not create an account. If you already have one and you stop agreeing,
you can delete it at any time.

## 2. Who can use WeVolunteer

- You must be **13 or older**. WeVolunteer is built for students in grades 9–12 or the
  equivalent, and **it is not for children under 13**.
- We ask your date of birth when you sign up and refuse to create an account for anyone under
  13. That check runs on our servers, not just in your browser, and it applies however you sign
  up — including with Google. We will not tell you how close you were, because that would just
  be telling you which year to type instead.
- You must give accurate information when you sign up. Your name and grade are shown to
  organizers who need to know who is volunteering, so a false one is not a harmless joke.
- One account per person. Do not share your account or sign in as someone else.
- Organizer accounts require approval before they can post events. **Approval is not a
  background check** — see section 7.

## 3. Your account

You are responsible for what happens on your account, so keep your password to yourself. Tell
us straight away at support@wevolunteers.org if you think someone else has got into it.

For certain sensitive actions — deleting your account, changing your password or email,
connecting or disconnecting a sign-in provider, and downloading your data — we will ask you
to prove it is you again, even though you are already signed in. This is deliberate and we
are not going to remove it.

## 4. What you may not do

This is the acceptable-use section. Do not:

**To other people**

- Harass, bully, threaten, or intimidate anyone
- Post or send anything sexual involving a minor, ever, in any form
- Comment on another user's body or appearance, or ask anyone for photos
- Ask a student to keep a conversation secret from their parents, guardians, or teachers
- Ask a student for private contact details — phone number, home address, social media handles
- Offer anyone money, gifts, alcohol, vapes, or drugs
- Ask to meet a student alone, anywhere, for any reason

**With information**

- Lie about your identity, age, grade, school, or role, or impersonate anyone
- Share another person's private information — their contact details, address, photo, or
  schedule — without their permission
- Use a student's contact details for anything other than the event you received them for
- Use certificate verification to find out whether a particular person volunteers, to collect
  students' names, or to try codes at scale

**With the service itself**

- Claim volunteer hours you did not work, or help anybody else do so
- Create more than one account, or create an account to get around a block or a suspension
- Try to influence an Auto Select draw, a leaderboard position, or an hours total by any means
  other than volunteering — including coordinating with an organizer to record hours that were
  not worked
- File reports you know to be false, or use the Report button to harass someone
- Scrape, bulk-download, or automate access to WeVolunteer; use bots or scripts against it; or
  resell access to it
- Try to break, overload, probe, or get around the security of the service, or access an
  account, event, or record you were not given access to
- Use WeVolunteer to advertise, recruit, sell, or fundraise for anything unrelated to a
  volunteer event
- Post anything illegal

The [Community Guidelines](/legal/community-guidelines) explain what these look like in
practice, and they are part of these terms. Breaking them is breaking these terms.

## 5. What you are responsible for

Everyone is responsible for the rules in section 4. Beyond that, the two roles carry different
obligations, because they hold different amounts of other people's information.

### 5.1 If you are a student volunteer

- **Be accurate.** Your name, grade, and school are how an organizer knows who is coming.
- **Turn up, or say you cannot.** If you are accepted and something changes, withdraw or tell
  the organizer. Repeatedly signing up and not appearing takes a place from someone else.
- **Do not claim hours you did not work,** and do not ask an organizer to credit them.
- **Look after other students' information.** If you learn another volunteer's contact details
  through an event, they are for that event.
- **Tell an adult where you are going.** Before you go somewhere to volunteer, especially
  somewhere new, tell a parent, guardian, or another adult you trust. This is not boilerplate;
  it is the actual advice, and it is the main thing we cannot do for you.
- **Report what worries you.** You will not get in trouble for reporting something that turns
  out to be nothing. See the [Youth Safety Guidelines](/legal/youth-safety-guidelines).

### 5.2 If you are an organizer

Organizer accounts carry obligations student accounts do not, because organizers receive
minors' contact details. The full set is in the
[Organizer Agreement](/legal/organizer-agreement). These are the commitments at the level of
these terms, and they bind you from the moment your organizer account is approved:

- **Protect student information.** Names, email addresses, grade levels, and attendance you
  receive through WeVolunteer are confidential. Do not share them with anyone who does not need
  them to run the event in front of you — including other organizers, colleagues, other
  departments of your own organization, and your family.
- **Use contact details only for the event they came from.** No mailing lists, no newsletters,
  no CRM, no recruiting for anything else, no fundraising, no personal address book, and no use
  after the event is over. Delete any copy you made outside WeVolunteer within **30 days** of
  the event finishing.
- **Communicate appropriately, and on the platform.** Message students through WeVolunteer,
  about the event they applied to. Do not move a conversation to text, personal email, or a
  social app — on-platform messages can be reviewed if there is ever a problem and a message
  from your personal phone cannot. Never ask a student to keep a conversation from their
  parents, guardians, or teachers. Never comment on a student's appearance and never send
  anything sexual.
- **Record attendance and hours accurately.** The hours you credit become part of a student's
  record and may count toward graduation, a scholarship, or a college application. Record what
  actually happened. Do not round up as a favour and do not withhold hours a student earned as
  a punishment. If you make a mistake, tell us — do not quietly adjust it later.
- **Follow the safety rules.** At least two adults present at all times; never alone with a
  single student, at any point, for any reason; and the permissions, insurance, and supervision
  your activity actually requires. See the
  [Youth Safety Guidelines](/legal/youth-safety-guidelines).
- **Never misuse a student's contact information** — not to recruit, not to solicit, not to
  contact them about anything other than the event they applied to, and not after it ends.
- **Report suspected harm to a child yourself.** New Jersey law requires *any person* with
  reasonable cause to believe a child has been abused or neglected to report it immediately to
  the Division of Child Protection and Permanency at **1-877-NJ-ABUSE**
  (N.J.S.A. 9:6-8.10). Telling us instead does not discharge that duty. Tell us as well, so we
  can act on the platform.
- **Do not represent that WeVolunteer has vetted you.** We have not.

Breaking any of these is grounds for removing your organizer account, and for anything
involving a risk to a student we will act first and explain afterwards.

## 6. Volunteer hours are a record, not a promise

This matters, so it is its own section.

- Service hours in WeVolunteer are recorded by the **organizer who ran the event**, based on
  attendance they marked. We store what they recorded. We do not independently witness that
  you were there.
- **We do not guarantee that any school, college, employer, or organization will accept these
  hours** for a graduation requirement, an award, a scholarship, or anything else. That is
  entirely their decision.
- Certificates confirm what our records say. They are not a legal attestation and they are
  not issued by a school.
- If your hours are wrong, tell the organizer first. If that does not resolve it, contact
  support@wevolunteers.org. Once hours are credited we do not re-price them if the event is later
  edited — a credit is a snapshot of what was true when you earned it.

## 7. Events happen in the real world

WeVolunteer helps you find and apply to volunteer events. **We do not run the events.**

The organizer is responsible for the event: supervision, safety, insurance, permissions, and
following the law. We do not check organizers' insurance, run background checks on them, or
inspect their venues. Approving an organizer account means an administrator looked at it —
nothing more. **No school or district does this for us either** — we are independent, so no one
else has checked.

Before you go somewhere to volunteer, especially somewhere new, tell a parent or guardian
where you are going. This is not legal boilerplate; it is the actual advice.

If something at an event makes you uncomfortable or unsafe, leave, and then tell us at
admin@wevolunteers.org and tell an adult you trust. See the
[Youth Safety Guidelines](/legal/youth-safety-guidelines).

## 8. Who owns what

### The platform is ours

The WeVolunteer software, its design, its name and logo, and the text of these policies belong
to the operator named at the top of this document. Using WeVolunteer does not give you any
ownership of it or any licence to it beyond ordinary use of the service. Do not copy, resell,
rebrand, or reverse-engineer it, and do not use its name or logo to suggest we endorse you.

Nothing here stops you describing WeVolunteer, linking to it, quoting these policies, or
telling anybody what you think of us.

### What you post stays yours

You keep ownership of what you write and upload — your bio, avatar, comments, and messages.

By posting, you give us permission to store and display it as needed to run the service (for
example, showing your comment on an event page to other people at that event). It is a
permission to operate the platform and nothing more: we do not licence your content to anyone
else, we do not use it in advertising, and we do not sell it. That permission ends when you
delete the content or your account, except where we have said in the
[Data Deletion Policy](/legal/data-deletion-policy) that something is kept, and why.

### Material you upload

When you upload a file — an avatar, a photo, a document — you confirm that you made it or you
have the right to use it, and that it does not contain someone else's private information. Do
not upload a photo of another student without their permission.

We may remove content that breaks these terms or the Community Guidelines. Where we do, we
will tell you what was removed and why, unless telling you would interfere with a safety
investigation.

If you believe something on WeVolunteer infringes your copyright, email
legal@wevolunteers.org with a link to it, what it copies, and how to reach you. We will
look at it, and we will usually take the content down while we do.

## 9. Suspending or closing accounts

**Suspension.** We may suspend an account while we look into something. A suspension ends every
session that account has, on every device, immediately — not at the next sign-in. Your
volunteer hours and attendance are untouched by a suspension.

**Removal.** We may close an account that breaks these terms. Where we can, we will warn first
and explain what happened. For anything involving a risk to a student's safety, we will act
first and explain after.

**What we take into account.** What happened, whether it was deliberate, whether it has
happened before, and whether anyone was put at risk. The ladder of consequences is published in
the [Community Guidelines](/legal/community-guidelines), and anything on the "never" list there
skips it.

**Appeals.** If you think we got it wrong, you can submit an appeal directly through the
platform. Your appeal will always be reviewed by a different administrator than the one who
issued the original decision. If we were wrong, we say so and we undo it.

**Closing your own account.** You can do it whenever you like, from Settings. See the
[Data Deletion Policy](/legal/data-deletion-policy) for exactly what happens — including the
parts that are kept, which you should read before you decide rather than after.

## 10. What we do not promise

WeVolunteer is provided **as is**. In plain terms: we work hard to keep it running correctly,
but we cannot promise it will never be unavailable, never lose data, or never have a bug. To
the extent the law allows, we disclaim implied warranties of merchantability, fitness for a
particular purpose, and non-infringement.

We do not promise that any event will happen, that any organizer is suitable, or that you
will be selected for anything you apply to.

## 11. Limits on what we owe you

Read this section. It decides who carries a loss when something goes wrong, and it is written
to be honest rather than maximal.

### What we do not limit at all

Nothing in these terms limits or excludes our liability for:

- **death or personal injury** caused by our negligence;
- our own **fraud** or fraudulent misrepresentation;
- our **gross negligence or willful misconduct**;
- anything else the law does not allow us to limit or exclude.

We are saying this first, and plainly, because a sole proprietor cannot lawfully disclaim those
things in New Jersey or in most other states — and a document that pretends otherwise is less
likely to be enforced, not more.

### What we do limit

Subject to the section above, and to the extent New Jersey law allows:

- We are not liable for **indirect, incidental, special, or consequential** losses. For
  example: a scholarship you were not awarded, a place you did not get, or a requirement you
  did not meet, where WeVolunteer was not the direct cause.
- We are not liable for the **acts or omissions of an organizer, another user, or anyone else
  at an event.** We do not run events, supervise them, or vet the people running them, and we
  say so in section 7 rather than only here.
- We are not liable for what a **third party** does with information you chose to give it —
  including anyone you hand a certificate code to.
- For everything else, taken together, our total liability to you is limited to
  **one hundred US dollars ($100)**. WeVolunteer is free, so a cap of "the fees you paid" would
  be a cap of nothing; a small real number is an honest limit rather than a disguised zero, and
  a modest cap is more likely to be enforced than an aggressive one.

### If you are under 18

If a court decides any part of this section cannot be applied to you because of your age, that
part simply does not apply to you and the rest of the section still does. We are not going to
argue that a minor waived something a minor cannot waive.

Some states do not allow some of these limits at all. Where that is true, the limit does not
apply to you and nothing else in this section changes.

> **Note for counsel, kept in the published version because it is honest rather than
> embarrassing:** this section is deliberately weaker than a standard consumer ToS. The
> carve-outs for gross negligence, willful misconduct, and personal injury are stated rather
> than buried in a "to the extent permitted" catch-all, because for a sole proprietor
> operating a platform used by minors they are not waivable in practice and an aggressive cap
> read to a jury in a child-safety case is worse than a modest one. Where this leaves the
> operator genuinely exposed is a matter of insurance, not drafting.

## 12. Indemnity

If you break these terms and that causes a third party to make a claim against us, you agree
to cover our reasonable costs.

**This section does not apply to users under 18.** We are not asking minors to indemnify us,
and we would not enforce it if we did. For organizers, who are adults and who receive minors'
contact details, it does apply.

## 13. Changes

We may change these terms. If a change matters, we will tell you in the app at least
**30 days** before it takes effect, and you can close your account if you do not agree. We
will not change them quietly.

A change that leaves you worse off — new collection, new sharing, a right taken away, a longer
retention period — gets a new major version and we ask you to accept it again. A clarification
gets a minor version and notice only.

**This is version 1.0 — the first published version, so there are no earlier ones yet.** When we
replace it we keep the version it replaced, and you can email
**legal@wevolunteers.org** for any previous version and the dates it applied. Every
version is stored with a content fingerprint, so a copy you receive can be checked against the
one your account accepted.

## 14. If we disagree

We would much rather fix a problem than argue about one, so:

1. **Tell us first.** Email legal@wevolunteers.org describing what happened and what
   you would like us to do. We will acknowledge within **10 business days**.
2. **We try to sort it out within 30 days.** Most things are a mistake, a missing record, or a
   misunderstanding, and they get fixed at this step.
3. **If that does not work,** either of us can take it to court — see section 15.

**There is no arbitration clause in these terms and no class-action waiver.** That is a
deliberate choice: forcing minors and their families into private arbitration over a free
service is not something we are willing to do, and courts increasingly disfavour it.
**Step 1 is not a precondition for anything that matters.** Nothing in this section stops you,
or requires you to wait, before calling 911, reporting suspected child abuse to DCP&P at
1-877-NJ-ABUSE, telling your school, or contacting the New Jersey Division of Consumer Affairs,
the Attorney General, or the FTC. This section is about disagreements over the service, not
about safety.

## 15. Which law applies

These terms are governed by the laws of the **State of New Jersey**, without regard to
conflict-of-laws rules. Any dispute that reaches a court goes to the state or federal courts
located in **Middlesex County, New Jersey**.

If you are a consumer somewhere whose own law gives you rights you cannot waive, this section
does not take them away from you.

## 16. Odds and ends

- If any part of these terms is unenforceable, the rest still stands.
- Not enforcing something once does not mean we give up the right to enforce it later.
- You may not transfer your account or your rights under these terms to anyone else. We may
  transfer ours if the operator's legal form changes — for example on becoming an LLC — and we
  will tell you if that happens.
- These terms, plus the policies they link to, are the whole agreement between us.

## 17. Contact

The operator named at the top of this document, at
**legal@wevolunteers.org**, which that person reads directly.

**If you need to send legal or regulatory correspondence on paper**, email that address and we
will give you a postal address for service. We do not print one here, and the reason is worth
stating: WeVolunteer is run by one individual rather than a company, so the only postal address
that exists today is a home address. Publishing the home address of the person who suspends
accounts, to the people whose accounts get suspended, is not a risk we are willing to take —
and it is not necessary, because service can be arranged on request. If the operator later
becomes an LLC, a business address will appear here instead.
legal@wevolunteers.org
