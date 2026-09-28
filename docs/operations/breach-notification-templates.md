# Breach notification templates

Companion to [`breach-response.md`](breach-response.md). That runbook says what to
do and in what order; this holds the words, so they are chosen calmly rather than
at 2am by somebody who has been awake since the alert fired.

> **Corrected 2026-09-28.** An earlier version of this warning said notification
> content "is partly prescribed by statute". **That was wrong**, and it was the
> assumption that made these templates look legally risky. Checked twice against
> the official text of N.J.S.A. 56:8-163 as amended by P.L. 2019, c.95: the
> statute regulates *delivery method* and *timing*, and prescribes **no content
> whatsoever** for the notice to individuals.
>
> That changes what these are. **The wording below cannot be non-compliant,**
> because there is no content standard to fail. Choosing it well is a drafting
> and duty-of-care exercise, not a legal one.
>
> **What is still open, and it is narrow:** whether the notification duty is
> triggered at all. That turns on the single question in
> [`breach-response.md`](breach-response.md) §0 — whether bcrypt-hashed passwords
> take the `users` table outside the statutory definition of "personal
> information". **Until counsel answers it, assume the duty applies and send.**
> Over-notifying is not an offence; under-notifying is.
>
> Where a template says `[[…]]`, that is a value **the incident** supplies. Not a
> legal question — those are all in §0 now. **Do not invent one under time
> pressure**, and do not leave one bracketed in something you send.

---

## 0. Before you send anything

Three checks, in this order. Each has cost somebody a worse incident than the
one they started with.

1. **§3.1 of the runbook has happened.** New Jersey State Police first, before
   any disclosure to an affected individual. If that has not happened, stop here
   — sending a notice first is the sequencing error the runbook opens with.
2. **The five answers from §2.3 are written down.** Every template below is
   assembled from them. If you cannot fill a template, you do not yet know
   enough to notify, and saying something vague to buy time will be read as the
   final account of what happened.
3. **Somebody who is not you has read it.** Not for approval — for the sentence
   that means something different to a parent than it did to the person who
   wrote it.

**Do not** speculate about cause, name an individual as responsible, promise a
finding the investigation has not reached, or say "no evidence of misuse" unless
you have actually looked for evidence of misuse and can say how.

---

## 1. Guardian of an affected student

The primary notice. Sent to the guardian, not the student, for anyone under 18 —
through whatever channel the district's agreement specifies (Posture A) or the
address on the account (Posture B).

Plain language throughout. A parent reading this on a phone should understand in
the first two sentences whether their child is affected and what they have to do.

> **Subject:** About your child's information on WeVolunteer
>
> Dear `[[GUARDIAN NAME]]`,
>
> I am writing to tell you about a security incident affecting your child's
> account on WeVolunteer, the volunteering platform used by `[[SCHOOL OR
> DISTRICT]]`.
>
> **What happened.** On `[[DATE DISCOVERED]]` we found that `[[WHAT HAPPENED, IN
> ONE SENTENCE, WITHOUT JARGON]]`. We believe this began on `[[DATE BEGAN, OR
> "a date we are still working to establish"]]`.
>
> **What information was involved.** `[[LIST THE ACTUAL FIELDS — for example:
> your child's name, school email address, date of birth and grade. Name the
> categories from §5 of the runbook that are genuinely in scope. Do not write
> "certain personal information".]]`
>
> `[[IF MESSAGES OR REPORTS WERE IN SCOPE, SAY SO EXPLICITLY AND SEPARATELY.
> These are the most sensitive things the platform holds and burying them in a
> list is the kind of thing that is later read as concealment.]]`
>
> **What information was not involved.** WeVolunteer does not hold Social
> Security numbers, driver's licence or State ID numbers, or any payment or bank
> details. None of those could have been involved, because none of them exist in
> our systems.
>
> `[[ADD anything else you can rule out WITH CONFIDENCE for this specific
> incident — but the sentence above is always true and is verified against the
> data inventory in breach-response.md §5. It is worth leading with, because it
> is the first thing most parents fear.]]`
>
> **What we have done.** `[[CONTAINMENT, IN CONCRETE TERMS — sessions ended,
> credentials rotated, the route closed. Past tense for what is done; do not
> list what you intend to do as though it were finished.]]`
>
> **What you should do.** `[[ONLY ACTIONS THAT ACTUALLY HELP FOR THE DATA
> INVOLVED. If passwords were not in scope, do not pad the notice with
> "change your password" — it manufactures the feeling of a response and
> teaches people to ignore the instruction when it matters. If the email
> address was exposed, warning about messages that impersonate the school is a
> real and specific instruction.]]`
>
> **Who to contact.** Mahit Pulavarthi, platform owner — `privacy@wevolunteers.org`.
> We will answer every question we can, and say so when we cannot yet.
>
> I am sorry this happened. Your child trusted this platform with their
> information and we did not protect it as we should have.
>
> `[[NAME]]`
> `[[ROLE]]`, WeVolunteer

---

## 2. The district

Posture A only, and within the DPA's window — commonly **24 hours from
discovery**, but read the clause rather than trusting that number. This is a
factual report to a counterparty who has their own obligations running from the
moment they receive it, so it is dense where the guardian notice is plain.

> **Subject:** Security incident notification — WeVolunteer — `[[DATE]]`
>
> `[[DISTRICT CONTACT NAME]]`,
>
> This is formal notice under `[[CLAUSE REFERENCE FROM THE DPA]]` of a security
> incident affecting `[[DISTRICT NAME]]` student data held by WeVolunteer.
>
> | | |
> |---|---|
> | Discovered | `[[DATE AND TIME, WITH TIMEZONE]]` |
> | Believed to have begun | `[[DATE, OR "under investigation"]]` |
> | Contained | `[[DATE AND TIME, OR "ongoing — see below"]]` |
> | Students affected | `[[COUNT]]` of `[[TOTAL]]` |
> | NJ State Police notified | `[[DATE, TIME, CHANNEL, PERSON SPOKEN TO]]` |
>
> **Nature of the incident.** `[[FACTUAL. What was accessed, by whom if known,
> through what route.]]`
>
> **Data categories in scope.** `[[FROM §5 OF THE RUNBOOK. Be exact about
> messages, reports and audit logs — a district's own obligations differ by
> category.]]`
>
> **Containment and preservation.** `[[WHAT WAS DONE, AND WHAT EVIDENCE IS
> PRESERVED AND WHERE. The district may need to rely on this evidence.]]`
>
> **Guardian notification.** `[[SENT / SCHEDULED FOR / AWAITING YOUR
> DIRECTION — the agreement may reserve this to the district, in which case say
> so and do not send §1 until they confirm.]]`
>
> **Open questions.** `[[WHAT YOU DO NOT YET KNOW. A district that discovers an
> unknown later, having been given a confident account now, will reasonably
> stop trusting the account.]]`
>
> Our contact for this incident is Mahit Pulavarthi, platform owner,
> `privacy@wevolunteers.org`, reachable at `[[NUMBER]]`.

---

## 3. Affected adult — organizer, staff or administrator

Shorter, because an adult can act on their own behalf and does not need the
guardian framing. Same rules about speculation.

> **Subject:** Security incident affecting your WeVolunteer account
>
> `[[NAME]]`,
>
> On `[[DATE DISCOVERED]]` we found that `[[ONE SENTENCE]]`. Your account was
> affected.
>
> **Involved:** `[[FIELDS]]`.
> **Not involved:** `[[ONLY IF CERTAIN]]`.
> **Done so far:** `[[CONTAINMENT]]`.
> **What we ask of you:** `[[SPECIFIC ACTIONS, OR "nothing — we have already
> ended your sessions and you will be asked to sign in again"]]`.
>
> `[[IF THIS PERSON HELD ADMINISTRATIVE CAPABILITY, SAY WHAT THAT MEANT IN
> SCOPE — whose records their access reached. They are entitled to know what was
> done in their name, and they may be the fastest route to establishing what
> actually happened.]]`
>
> Questions to Mahit Pulavarthi, `privacy@wevolunteers.org`.

---

## 4. Holding statement

For the hour where something is known publicly and the assessment is not
finished. The only honest holding statement says what is true now, commits to a
next update, and meets that commitment.

> We are aware of a security incident affecting WeVolunteer and are
> investigating. We notified `[[AUTHORITY]]` on `[[DATE]]`. We are contacting
> anyone whose information was involved directly. We will post an update by
> `[[SPECIFIC TIME, NOT "shortly"]]`.

**A holding statement that is not followed by the promised update is worse than
silence.** Put the next update in the calendar before sending this.

---

## 5. What every one of these needs, in one list

For checking a draft written under pressure against something written calmly.

- [ ] The State Police notification happened first, and is recorded.
- [ ] Every `[[…]]` is filled, or its paragraph is deleted — not left bracketed
      and not guessed.
- [ ] The data categories named are the ones actually in scope, field by field.
- [ ] Messages and safety reports, if in scope, are called out separately.
- [ ] Containment is in the past tense only where it is actually done.
- [ ] The requested actions would genuinely help for this data.
- [ ] No cause is asserted that the investigation has not established.
- [ ] No individual is named as responsible.
- [ ] A named person and a working address to reply to.
- [ ] Somebody other than the author has read it.
- [ ] A copy is filed with the incident record, with the time it was sent.

---

## 6. Still open

Carried from R-07, so that finishing this file is not mistaken for finishing the
item:

- **~~Attorney review of the wording.~~ Resolved by research, not by review.**
  N.J.S.A. 56:8-163 prescribes no notice content, so there is no content standard
  for this wording to fail. What remains for counsel is one question about
  whether the duty is triggered at all — `breach-response.md` §0 — and it does
  not block drafting or, on the "assume it applies" rule, sending.
- **~~`[[NAMED PERSON]]`~~ Done 2026-09-28.** Mahit Pulavarthi, platform owner,
  in all four templates and in `breach-response.md` §3. **No deputy yet**, which
  is the part still missing: one name removes the ambiguity but not the single
  point of failure.
- **A real phone number.** `[[NUMBER]]` in the district template is the one
  placeholder above that is neither incident-specific nor answered. A district
  counterpart with a 24-hour clock needs to be able to reach a human by voice.
- **The rehearsal.** Still the cheapest test of whether these can actually be
  filled in from the runbook's own five answers. Templates that cannot be
  completed from §2.3 are the wrong templates.
