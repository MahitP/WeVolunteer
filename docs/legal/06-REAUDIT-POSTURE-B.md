# Re-audit — independent platform (Posture B)

**Date:** 2026-08-05 (second pass) · **Supersedes the risk register in**
[`00-COMPLIANCE-AND-RISK.md`](00-COMPLIANCE-AND-RISK.md), which remains valid for the
statutory research and Posture A analysis.

**Decisions now authoritative:** independent platform (not a district vendor) · certificates
verifiable indefinitely · organizer↔applicant messaging intentional · hours indefinite ·
messages 1–3 years · audit logs 90 days–1 year · deleted accounts anonymised after a defined
period · privacy contact `wevolunteer.platform@gmail.com`.

---

## The headline

Choosing Posture B removed one set of problems and created a larger one.

**Removed:** FERPA. NJ P.L. 2019 c. 494 (probably). District DPA negotiation. The
Posture A branches in every document. That is real simplification.

**Created:** the district was silently doing four jobs in the Posture A design — vetting
organizers, holding the enforceable adult agreement, standing behind consent for minors, and
receiving safety escalations. **All four now fall on WeVolunteer, and none of them are built.**

Then a code re-verification found the thing that reorders the whole register:

> **An administrator cannot suspend, ban, or remove any user, cannot remove an approved
> organizer, cannot delete an abusive message, and cannot block a contact. None of these
> exist.** `user.suspend` is a registered capability that no route uses. `account_status =
> 'suspended'` is enforced at login but is never set by anything. `/api/admin/organizers/:id/deny`
> is deliberately scoped to `verified = 0` and its own error says *"Approved organizers cannot
> be deleted here."*

An admin who receives a credible grooming report today can mark the report resolved and delete
a comment. That is the entire response surface. On a platform whose deliberate design allows
adults to message minors, that is the launch blocker — not a document.

---

## Phase 1 — Every previous finding, re-evaluated

### Corrections to my own prior work

> ## ⚠️ R-03 was wrong twice, and is now withdrawn
>
> **Correction, 2026-08-05, made during implementation.** The paragraph below says the organizer
> path "never checks that the student applied." **That is false.** `eligibleRelationship()`
> refuses at its `relationship.length === 0` branch — an organizer cannot open a conversation
> with a student who has not applied to an event they host. I read the capability cascade
> (lines 77–99) and stopped before the relationship check that follows it.
>
> The rule was correct all along and merely **untested**, which is a real but much smaller
> problem, and is now closed by `server/messaging.applicantScope.test.js` (8 tests).
>
> **What the re-verification did find** is narrower and genuine: the organizer path answered
> `404 'Volunteer not found'` for an unknown id and `403 'Messaging unlocks…'` for a real
> student who had not applied. No conversation opened either way, but the pair of codes was an
> **existence oracle** — an organizer could walk arbitrary ids against an event they host and
> read off which belong to students. Fixed in `messaging.js`; staff keep the precise 404
> because `event.moderate` already grants a full user view.
>
> R-03's score of 20 (RED) was driven by "no applicant check" plus "no suspension." Only the
> second half was real. **R-03 is withdrawn; the enforcement half is tracked under R-20.**

**I overstated R-03.** I previously wrote that adults and minors "can exchange private
messages with no relationship constraint." That was wrong. `server/messaging.js` is
considerably more careful than I credited:

- Conversations are keyed on `(event_id, student_id, organizer_id)` — there is **no free-form
  DM** in this product.
- `eligibleRelationship()` (messaging.js:50) requires an organizer to **host the event**
  (line 85–87), and a student may only ever open a conversation about themselves (line 93).
- `computeConversationLifecycle()` makes conversations **read-only** once the event completes,
  with an explanatory banner.
- Messages are rate-limited per user.

~~The real gap is that the organizer path never checks that the student applied.~~
**Struck — this was my second error on the same finding.** The check is at
`relationship.length === 0`, immediately after the capability cascade I had been reading. The
constraint is genuinely "organizers and their applicants," exactly as the product decision
requires, and it now has 8 tests holding it there.

The lesson worth keeping: I asserted a negative ("there is no check") after reading only the
part of the function that would have contained a different check. A negative claim about code
needs the whole function read to the return, not the branch that looked relevant.

**I under-weighted the moderation surface.** I noted `conversation_reports` and `report.resolve`
existed and treated reporting as adequate reactive tooling. I did not check whether anything
could be *done* after a report. Nothing can.

**I described muting as a safety control.** `muted_until` on `conversation_participants` only
suppresses *notifications* (messageRoutes.js:187–188); setting `muted: true` writes
`9999-12-31`. The other person can still send. Any document implying mute protects a student is
wrong, and mine did.

### Disposition table

| ID | Finding | Action | Why |
|---|---|---|---|
| R-01 | Under-13 unmanaged | **ESCALATE** 15 → **20 RED** | Posture B removes district gatekeeping. Public signup makes under-13 registration near-certain over time, and COPPA now lands directly on you with no intermediary |
| R-02 | Deleted names in public certificates | **MODIFY** 16 → **12 ORANGE** | Indefinite verifiability is now a deliberate, documented policy, which fixes the "no stated period" half. Disclosure gap and absent revocation path remain. **Now coupled to R-01** — see below |
| R-03 | Adult↔minor messaging | **WITHDRAWN** — see the correction above | The applicant check exists and is enforced; it was only untested. Now covered by `messaging.applicantScope.test.js`. The enforcement half lives in R-20 |
| R-04 | Organizer agreement absent | **ESCALATE** 12 → **16 RED** | Posture A leaned on district vetting. There is no district. WeVolunteer is now the sole gate on which adults reach minors |
| R-05 | No guardian access path | **MODIFY** 12 → **12 ORANGE** | Contact address now exists, but the district route is gone — you must build the workflow yourself |
| R-06 | Auto Select undisclosed | **KEEP, reduce** 12 → **9 YELLOW** | FERPA and c. 494 recede; NJDPA thresholds unmet. Transparency issue persists on its own merits |
| R-07 | No breach procedure | **KEEP** 8 YELLOW | Unchanged in score, but you are now the sole notifier — no district to route through |
| R-08 | Uncontracted third parties | **KEEP** 9 YELLOW | Unchanged |
| R-09 | No published retention | **MODIFY** 8 → **6 YELLOW** | Decisions made. Now a writing task — with one live conflict, below |
| R-10 | Comments unmoderated by policy | **MODIFY** 9 → **12 ORANGE** | Comment deletion exists, but no suspension means repeat offenders cannot be stopped |
| R-11 | Admin visibility unconstrained | **ESCALATE** 9 → **12 ORANGE** | No district oversight layer. Admins are now accountable only to you |
| R-12 | Leaderboard consent | **KEEP** 6 YELLOW | Opt-in default is correct |
| R-13 | Analytics re-identification | **KEEP** 6 YELLOW | `analytics.school` on an independent platform still re-identifies small cohorts |
| R-14 | Telemetry claims drift | **KEEP** 6 YELLOW | Now more important: §5 is your primary exposure |
| R-15 | Impersonation (v2.0) | **KEEP** 10 ORANGE | Forward-looking, unchanged |
| R-16 | Accessibility | **MODIFY** 9 → **6 YELLOW** | **ADA Title II no longer applies** — no public entity. Title III is less definite and has no fixed deadline. A11Y-1 remains a genuine defect |
| R-17 | No Terms of Service | **ESCALATE** 12 → **16 RED** | Posture A had the district agreement carrying enforceability. Nothing carries it now, and a minor's assent is voidable |
| R-18 | CARTO tile CDN | **KEEP** 12 ORANGE | Unchanged |
| R-19 | `localStorage` on shared devices | **KEEP** 8 YELLOW | Unchanged |

### New findings

| ID | Finding | Sev | Lik | Score |
|---|---|---|---|---|
| **R-20** | **No user suspension or ban capability exists anywhere in the product** | 5 | 4 | **20 RED** |
| **R-21** | **No block feature** — a student cannot stop an adult from contacting them | 4 | 4 | **16 RED** |
| **R-23** | **Approved organizers cannot be removed** — `/deny` is scoped to `verified = 0` | 5 | 3 | **15 ORANGE** |
| **R-22** | **No message deletion or redaction** — abusive content cannot be removed | 4 | 3 | **12 ORANGE** |
| **R-27** | **No guardian consent mechanism** — structurally required now that no district stands behind minors' assent | 4 | 4 | **16 RED** |
| **R-24** | Display `name` is not unique; only `username` is. Impersonation by display name is trivial | 3 | 3 | **9 YELLOW** |
| **R-26** | No appeals mechanism for any enforcement action | 3 | 3 | **9 YELLOW** |
| **R-25** | Privacy contact is a personal Gmail address | 2 | 4 | **8 YELLOW** |
| **R-28** | Suspension message says *"Contact your school administrator"* — wrong operator model | 2 | 4 | **8 YELLOW** |

### The R-01 ↔ R-02 coupling — read this one

Two authoritative decisions now interact badly, and neither is wrong on its own.

- **Certificates and hours are retained indefinitely.**
- **Under-13 remains unresolved.**

The amended COPPA Rule §312.10 requires a written retention policy that **references a time
period** and forbids retaining children's personal information indefinitely. It has been fully
enforceable since 2026-04-22.

So: *indefinite retention of a child's name in a publicly-queryable endpoint* is squarely
contrary to the amended Rule — **if any under-13 user ever exists.** Today nothing prevents one.

This does not mean the retention decision is wrong. It means **the age gate is what makes the
retention decision lawful.** They are one work item, not two, and shipping the retention policy
without the age gate is the specific combination to avoid.

### Updated risk summary

| Level | IDs |
|---|---|
| **RED (16–25)** | R-01 (20) · R-20 (20) · R-04 (16) · R-17 (16) · R-21 (16) · R-27 (16) |
| **ORANGE (10–15)** | R-23 (15) · R-02 (12) · R-05 (12) · R-10 (12) · R-11 (12) · R-18 (12) · R-22 (12) · R-15 (10) |
| **YELLOW (5–9)** | R-06 · R-08 · R-24 · R-26 · R-07 · R-19 · R-25 · R-28 · R-09 · R-12 · R-13 · R-14 · R-16 |

**Six RED findings, up from one** (R-03 withdrawn on re-verification). Five of the six are
direct consequences of becoming an independent platform. That is not an argument against the
decision — it is the bill for it.

---

## Phase 2 — Open questions, with recommendations

### Q1 — Under-13 strategy · **BLOCKING**

**Why it matters.** COPPA now applies to you directly. Penalties are per-violation and the FTC
has publicly prioritised enforcement since the amended Rule took effect. Indefinite certificate
retention (your decision) is incompatible with §312.10 for any under-13 user.

| Option | Consequence |
|---|---|
| **A. Hard 13+ floor with a neutral age gate** | COPPA does not attach. Cheapest, fastest, standard |
| B. Permit under-13 with verifiable parental consent | Full §312.10 programme, VPC infrastructure, retention limits that contradict your certificate decision. Months of work |
| C. Leave it open | Uninsurable. Not a real option |

**Recommendation: A.** Neutral date-of-birth screen before any other field; hard block below
13; no retry with an edited date; remove `'N/A'` from self-service signup. Add a "we found an
under-13 account" deletion procedure.

**Tradeoff:** you lose middle-school volunteers. Given your product targets grades 9–12, that
is a small cost for removing your single largest statutory exposure.

### Q2 — Guardian consent for 13–17 · **BLOCKING**

**Why it matters.** A minor's contract assent is voidable. In Posture A the district agreement
carried enforceability; there is no district now. Without a guardian in the loop your ToS is
weak against exactly the users who make up most of your base, and you have no adult to notify
when something goes wrong.

| Option | Consequence |
|---|---|
| **A. Guardian email at signup for under-18; verified link; guardian gets safety notices** | Enforceable-ish, gives you a notification channel, low friction |
| B. Full VPC-grade verification | Heavy; disproportionate for 13–17 |
| C. Checkbox "my guardian agrees" | Near-worthless evidentially |
| D. Nothing | Current state |

**Recommendation: A.** Collect a guardian email for any user under 18, verify it with a link,
and record the acknowledgement with version and timestamp. Send the guardian: account created,
account suspended, safety report involving their student, and account deleted.

**Tradeoff:** signup friction and some students entering a friend's address. Imperfect, but it
gives you an adult contact for the incident where you will desperately want one.

### Q3 — Enforcement capability · **BLOCKING**

**Why it matters.** You cannot currently remove anyone from the platform. This is the gap that
turns any safety incident into an unmanageable one.

**Recommendation, minimum viable set:**
1. `POST /api/admin/users/:id/suspend` — sets `account_status = 'suspended'`, bumps
   `token_version` (kills live sessions), records reason + actor + audit row. **The login-side
   enforcement already exists**, so this is genuinely small.
2. Unsuspend, with the same audit treatment.
3. Extend organizer removal beyond `verified = 0` — a separate route that **suspends rather
   than deletes**, because `ON DELETE CASCADE` on an approved organizer would destroy students'
   attendance rows and credited hours. The existing `/deny` comment already identifies this
   hazard; respect it.
4. Message redaction: soft-delete with a tombstone, preserving the row for investigation.

**Tradeoff:** roughly a week of work. There is no cheaper option that leaves you able to
respond to a report.

### Q4 — Blocking · **BLOCKING**

**Why it matters.** A student who feels unsafe has no way to stop contact. Reporting depends on
a student trusting your response; blocking is the control they hold themselves. Every major
youth platform ships it because it is the one protection that works at 2am.

**Recommendation:** student-initiated block on a conversation. Blocked organizer cannot send in
that conversation and cannot open new ones with that student. Blocking **notifies moderators**
rather than being silent — a block against an adult is a safety signal, not a preference.
Organizers cannot block students (that would be a tool for silencing complaints).

**Tradeoff:** an organizer may legitimately need to reach a blocked student about a shift. Solve
with system notifications, which are not messages.

### Q5 — Moderator escalation · **BLOCKING**

**Recommendation:** a written two-tier procedure.
- **Tier 1 (standard):** rudeness, spam, off-topic. Warning → content removal → suspension.
  Response within 1 business day.
- **Tier 2 (safety):** anything sexual, grooming-shaped, threatening, or involving off-platform
  contact solicitation. **Immediate suspension pending review** — act first, review after.
  Preserve everything. NJ mandated report to DCP&P where the threshold is met.

Name one accountable person. On a platform this size that is you; write it down anyway, because
the procedure has to survive you being asleep.

### Q6 — Appeals

**Recommendation:** an email-based appeal to a stated address, reviewed by someone other than
the deciding admin where possible, answered within 5 business days, with the outcome and reason
in writing. Do not build a system for this — a documented inbox procedure is proportionate.

**Tradeoff:** at your scale "someone other than the deciding admin" may be impossible. Say so
honestly in the policy rather than promising independence you cannot deliver.

### Q7 — Certificate disclosure at deletion

Retention is decided. The disclosure is not.

**Recommendation:** replace *"may be preserved"* with the explicit statement, shown at the
moment of deletion: certificates keep your full name, anyone with a code can look it up, this
is permanent. Then offer the **void** option — the student trades verifiability for erasure.
Voiding is the release valve that makes indefinite retention defensible rather than absolute.

**Tradeoff:** a student who voids and later needs the hours has lost them. That is their
informed choice, and it is a better position than having no choice at all.

### Q8 — Privacy contact address

`wevolunteer.platform@gmail.com` works today and is better than nothing, but for a platform
holding minors' data it has three problems: it looks personal rather than institutional to a
worried parent; it has no shared access or continuity if you are unavailable; and Gmail's
consumer terms are a weak foundation for records you may need to produce.

**Recommendation:** `privacy@` on a domain you control, forwarding to a mailbox at least two
people can reach. Publish the Gmail only if the domain is not ready — and treat it as an
interim, not a decision.

### Q9 — "Anonymised after a defined period"

Your decision says deleted accounts are anonymised **after a defined period**. The code
anonymises **immediately**, and the deletion policy draft promises "no waiting period."

Three readings are possible and they are materially different: (a) immediate anonymisation,
purge later; (b) a grace period during which deletion is reversible; (c) anonymise immediately
and purge the anonymised shell after N years.

**Recommendation: (c), with N = 3 years**, plus an explicit **7-day grace period** before
anonymisation begins so that an account deleted in anger or by a compromised session can be
recovered. Note this reverses my earlier draft, which praised the absence of a grace period —
that was the right call for a district product with an IT desk behind it, and the wrong one for
a consumer platform where the user is alone.

**Tradeoff:** a grace period means the data still exists for 7 days after someone asked you to
delete it. Disclose the window precisely and it is defensible.

### Q10 — Organizer vetting

No district vets your organizers now. You approve them.

**Recommendation for launch:** identity verification (a real name and a verifiable
organisation), the signed Organizer Agreement, and a published statement that **you do not run
background checks** — stated plainly so no parent assumes otherwise. Longer term, consider
requiring organizers to attest to their own organisation's screening.

**Tradeoff:** background checks are expensive and slow, and doing them badly is worse than not
doing them, because it manufactures assurance you cannot stand behind.

### Q11 — Remaining smaller decisions

| Question | Recommendation |
|---|---|
| Legal entity | Form an LLC before public launch. Personal liability for a youth platform is not a position to be in |
| Governing law | New Jersey |
| Liability cap | Nominal ($100) — but see the ToS note; a derisory cap reads badly against a safety claim |
| Message retention: 1, 2, or 3 years | **3 years.** Investigations surface late; the longer window protects students more than it exposes you |
| Audit logs: 90 days or 1 year | **1 year.** 90 days is shorter than the time it typically takes to discover admin misuse |
| Display-name uniqueness | Do not enforce uniqueness; show `@username` alongside every display name instead |

---

## Phase 3 — Implementation gap analysis

**P0 = blocks public launch · P1 = should precede launch · P2 = shortly after · P3 = future**

### P0

| Priority | Issue | Current state | Required state | Effort | Risk if skipped |
|---|---|---|---|---|---|
| **P0** | No suspension capability | `user.suspend` unused; `account_status='suspended'` never set; login already blocks it | Suspend/unsuspend routes, `token_version` bump, reason, audit | **S** (~1 day — enforcement half exists) | Cannot remove a dangerous adult. Unmanageable incident |
| **P0** | Approved organizers cannot be removed | `/deny` scoped to `verified = 0` | Suspend-not-delete route for approved organizers (cascade would destroy hours) | **S–M** | An organizer who harms a student stays on the platform |
| **P0** | No block feature | Does not exist | Student-initiated conversation + contact block, notifying moderators | **M** | Student has no self-protection |
| **P0** | No age gate | `grade` accepts `'9'`–`'12'`, `'Adult'`, `'N/A'`; no DOB | Neutral DOB screen, hard 13+ block, `'N/A'` off self-service | **M** | Direct COPPA exposure; makes indefinite retention unlawful |
| ~~P0~~ | ~~Messaging permits any student~~ | **Withdrawn — the check exists.** Residual: a 403/404 existence oracle | Collapse both refusals for non-staff | **XS** | **DONE** — fixed and tested |
| **P0** | No guardian consent for under-18 | Nothing | Guardian email, verified, recorded; safety notifications | **M–L** | ToS unenforceable against most users; no adult to notify |
| **P0** | Organizer Agreement not recorded | Document drafted; no acceptance stored | `organizer_agreements` table; gate `organizer.approve` on it | **S–M** | Unaccepted agreement has no legal effect |
| **P0** | No ToS | Nothing | Attorney-drafted, published, accepted at signup | **M** (external) | No liability limit, no venue, no termination right |
| **P0** | Deletion copy overstates erasure | "may be preserved" | Explicit certificate-permanence statement + void option | **S** copy / **M** with void | FTC §5 deception — your primary exposure |
| **P0** | No moderator escalation procedure | Nothing written | Two-tier procedure, named owner, DCP&P step | **S** (writing) | Admins improvise during the worst hour |
| **P0** | No breach runbook | Nothing | NJ State Police first, then users; templates pre-drafted | **S** (writing) | Statutory sequence missed under pressure |

### P1

| Priority | Issue | Current state | Required state | Effort | Risk |
|---|---|---|---|---|---|
| **P1** | No message redaction | No delete path | Soft-delete + tombstone, row preserved | **M** | Abusive content stays visible |
| **P1** | Privacy/deletion/guardian request workflow | Address only | Documented intake, ID verification, 10-day ack / 45-day resolve, log | **S** | Requests dropped; §5 risk on published commitments |
| **P1** | Retention not implemented | Nothing purges | Jobs for messages (3y), audit (1y), anonymised shells (3y) | **M** | Published policy untrue |
| **P1** | Auto Select undisclosed | No UI mention | Badge + application-form explanation + decline reason | **S** | Undisclosed automated decisions about minors |
| **P1** | Suspension message names a school | "Contact your school administrator" | Platform-appropriate copy + appeal route | **XS** | Signals the wrong operator model |
| **P1** | A11Y-1 input contrast | 1.74:1 light / 1.15:1 dark | ≥3:1 both themes | **XS** | Real WCAG AA failure |
| **P1** | `PRIVACY_URL` defaults empty | Consent control does not render at all | Default `/privacy` | **XS** | **No consent is currently collected in a default build** |
| **P1** | CARTO tiles | Browser → third party | Click-to-load, then server proxy | **S** then **M** | Undisclosed third-party contact |
| **P1** | Appeals | Nothing | Documented inbox procedure, 5 business days | **XS** | Arbitrary enforcement |

### P2

| Priority | Issue | Current state | Required state | Effort |
|---|---|---|---|---|
| **P2** | Display-name impersonation | `name` not unique | Show `@username` beside every display name | **S** |
| **P2** | Analytics re-identification | No suppression | Suppress cells n<5 | **S** |
| **P2** | Telemetry redaction untested | Behaviour correct, no test | Regression test | **S** |
| **P2** | `localStorage` on shared devices | Caches account details | Move to `sessionStorage` or disclose prominently | **S** |
| **P2** | Remaining six policies | Drafted | Published | **S** |
| **P2** | Legal hub / design system | Designed | Built | **L** |
| **P2** | Rate-limit review for abuse | Message limiter exists | Review signup/report/application limits | **S** |

### P3

Certificate void mechanism (if not P0) · full accessibility AT testing · impersonation policy
before v2.0 · self-hosted map tiles · organizer background-check attestation · NJDPA threshold
monitoring · SOC2-style controls if districts start asking.

---

## Phase 5 — Product safety review

### Threat model

**Assets:** minors' identity and contact details · minors' physical location and schedule (an
event page states where a named student will be, at a known time) · the integrity of service
records · the platform's standing to be trusted with children.

**Adversaries, in priority order:**

**T1 — The predatory organizer.** Registers a plausible organisation, is approved, gains
messaging access to students. *Current defences:* organizer approval, event-scoped
conversations, read-only after event, reporting, rate limits. *Current gaps:* no background
check, no applicant restriction, **no suspension**, **no block**, no message removal, no
proactive detection. **This is the primary threat and the product cannot currently respond to
it.**

**T2 — The peer harasser.** Student-to-student via comments. *Defences:* comment deletion,
reports. *Gaps:* no suspension, no block, no repeat-offender tracking.

**T3 — The impersonator.** Registers under another student's or a real organisation's display
name. *Defences:* unique `username`, unique email, organizer approval. *Gaps:* display `name`
not unique and shown prominently.

**T4 — The hour fraudster.** Fake events crediting fake hours; or an organizer trading hours for
favours. *Defences:* hours derived not stored, ledger, `verify:hours` parity check, snapshot
immutability, audit log. *Gaps:* no anomaly detection; a colluding organizer is undetectable;
**no way to remove them once found**.

**T5 — The scraper.** Harvests student names via profiles, leaderboard, or certificate codes.
*Defences:* private-by-default profiles, opt-in leaderboard, 40-bit codes, `verifyLimiter`,
grade excluded from verification. **This one is genuinely well defended.**

**T6 — The account thief.** Takes a session on a shared school Chromebook. *Defences:* step-up
re-auth on all seven sensitive actions, `token_version`, `no-store` on exports,
`sessionStorage` for grants. *Gaps:* `localStorage` account cache; no session list; no "sign
out everywhere."

**T7 — The insider.** An admin browsing students out of curiosity. *Defences:* audit log,
capability separation, `SUPER_ONLY`. *Gaps:* no access review, no alerting, no policy in force.

### Safety recommendations

**Tier 1 — launch blockers (T1, T2)**
1. Suspension, with session invalidation.
2. Approved-organizer suspension that preserves attendance rows.
3. Student-initiated blocking that notifies moderators.
4. Applicant-relationship check on organizer messaging.
5. Written two-tier escalation with a named owner and the DCP&P step.
6. Persistent, non-dismissible report affordance in every conversation.

**Tier 2 — before scale**
7. Message redaction with tombstones.
8. Repeat-offender view: reports grouped by subject, not just by conversation.
9. Guardian safety notifications.
10. Keyword flagging for contact-solicitation patterns ("what's your number", "snap", "don't
    tell") — **as a moderator queue signal, not automated action**, and disclosed in the
    privacy policy because it is a form of automated review.
11. `@username` beside every display name.

**Tier 3 — maturity**
12. Organizer re-verification annually.
13. Anomaly detection on hour crediting.
14. Session list and "sign out everywhere."
15. Quarterly admin access review.

### Launch requirements — safety

Do not open public registration until all of these are true:

- [ ] An admin can suspend any account, including an approved organizer, and sessions die immediately
- [ ] A student can block an adult without needing anyone's permission
- [ ] A reported conversation can be preserved and its content removed from view
- [ ] Organizers can only message students who applied to their event
- [ ] A written escalation procedure exists and every admin has read it
- [ ] Anyone can report without an account, by email, and gets a human within 1 business day
- [ ] The DCP&P mandated-reporting step is written down and understood
- [ ] Under-13 cannot register
- [ ] A guardian email exists for every under-18 account

---

## Phase 6 — Launch roadmap

### Phase A — Immediate fixes (week 1)

| Task | Why | Effort | Depends on | Risk if skipped |
|---|---|---|---|---|
| Suspension routes + session kill | The single missing primitive behind every safety response | 1d | — | No incident response at all |
| Approved-organizer suspension | `/deny` explicitly excludes them; cascade would destroy hours | 1d | above | Dangerous adult stays |
| Applicant check on organizer messaging | Code currently exceeds your stated policy | 0.5d | — | Policy/code mismatch |
| `PRIVACY_URL` → `/privacy` | **No consent renders at all in a default build** | 0.25d | — | Zero consent collected |
| Fix "contact your school administrator" | Wrong operator model | 0.25d | — | Confusion at the worst moment |
| A11Y-1 input contrast | Real WCAG AA failure, one token | 0.25d | — | Accessibility defect |
| Write escalation + breach + mandated-reporter procedures | Cannot be authored during an incident | 1d | — | Improvisation under pressure |

### Phase B — Pre-launch compliance (weeks 2–4)

| Task | Why | Effort | Depends on | Risk if skipped |
|---|---|---|---|---|
| Age gate, 13+ hard floor | Largest statutory exposure; makes indefinite retention lawful | 2–3d | — | COPPA liability |
| Guardian email + verification for under-18 | Restores the enforceability the district used to provide | 3–5d | age gate | Voidable ToS, no adult contact |
| Blocking | Student self-protection | 2–3d | — | No 2am control |
| Organizer Agreement acceptance recorded | An unaccepted agreement is a blog post | 1–2d | — | No binding on adults |
| ToS drafted by counsel | Needs drafting, not review | external | entity formed | No liability limit or venue |
| Deletion copy + certificate void option | Closes the §5 gap | 1d / 2–3d | — | Deception exposure |
| Privacy/deletion request workflow | Published commitments must be operable | 1d | contact | Dropped requests |
| Publish Privacy, Deletion, Youth Safety, Organizer Agreement, Community Guidelines | | 1d | decisions | Nothing published |

### Phase C — Launch readiness (weeks 5–6)

| Task | Why | Effort |
|---|---|---|
| Message redaction | Remove abusive content | 2d |
| Retention jobs (messages 3y, audit 1y, shells 3y) | Published policy must be true | 2–3d |
| Auto Select disclosure in UI | Undisclosed automated decisions about minors | 1d |
| Appeals procedure documented | Enforcement must not be arbitrary | 0.5d |
| CARTO click-to-load | Reduce undisclosed third-party contact | 0.5d |
| Repeat-offender moderator view | Patterns matter more than incidents | 2d |
| Remaining policies published | | 1d |
| Full four-gate run + safety rehearsal | Practise one incident end to end | 1d |

### Phase D — Post-launch

Legal hub and design system · full AT accessibility testing · server-proxied tiles ·
`@username` display · analytics suppression · keyword flagging queue · session management ·
quarterly access review · annual policy review · impersonation policy before v2.0 · NJDPA
threshold monitoring.

---

## Phase 7 — Executive summary

### 1. Can WeVolunteer legally launch today?

**No.** Not to the public, and not with real students.

Not primarily because documents are missing — because **the platform cannot remove a dangerous
adult from itself.** Everything else on this list is ordinary pre-launch work. That one is a
structural inability to respond to the harm your product's core feature makes possible.

### 2. What specifically blocks launch

1. No suspension or ban capability (R-20)
2. Approved organizers cannot be removed (R-23)
3. No blocking (R-21)
4. No age gate — direct COPPA exposure, and it is what makes indefinite retention lawful (R-01)
5. No guardian consent — nothing carries enforceability now (R-27)
6. Organizer Agreement not accepted or recorded (R-04)
7. No Terms of Service (R-17)
8. Deletion copy materially understates certificate permanence (R-02)
9. No written escalation, mandated-reporter, or breach procedure (R-03, R-07)
10. Consent control does not render at all in a default build

### 3. Top 10 remaining risks

R-01 under-13 (20) · R-03 adult↔minor messaging without enforcement (20) · R-20 no suspension
(20) · R-04 unvetted organizers under no agreement (16) · R-17 no ToS (16) · R-21 no blocking
(16) · R-27 no guardian consent (16) · R-23 approved organizers unremovable (15) · R-02
certificate permanence undisclosed (12) · R-11 unconstrained admin visibility (12)

### 4. Top 10 engineering tasks

1. Suspension + session invalidation
2. Approved-organizer suspension preserving attendance
3. Student blocking
4. Age gate with neutral DOB screen
5. Guardian email verification for under-18
6. Applicant check on organizer messaging
7. `organizer_agreements` acceptance recording
8. Certificate void option at deletion
9. Message redaction with tombstones
10. Retention purge jobs

### 5. Top 10 policy decisions

1. Under-13: hard 13+ floor *(recommended)*
2. Guardian consent model *(verified email)*
3. Message retention: 1, 2, or 3 years *(3)*
4. Audit retention: 90 days or 1 year *(1 year)*
5. "Anonymised after a defined period" — which of three readings *(immediate anonymise, 7-day grace, 3-year purge)*
6. Legal entity *(LLC before launch)*
7. Governing law *(New Jersey)*
8. Liability cap
9. Institutional privacy address vs Gmail
10. Whether to background-check organizers, and what to publish about it

### 6. What I would do next as product owner

**Week 1, in this order.**

**Day 1 — build suspension.** Half the enforcement already exists: login blocks
`account_status = 'suspended'`. You are writing the route that sets it, plus a `token_version`
bump and an audit row. It is the highest safety return per hour in the entire backlog, and
until it exists every other safety conversation is theoretical.

**Day 2 — the applicant check and the `PRIVACY_URL` default.** Two small diffs. The first
makes the code match the policy you have already chosen. The second is genuinely alarming as it
stands: **a default build collects no privacy consent at all**, because the control is wrapped
in `{PRIVACY_URL && ...}` and the variable is empty by default.

**Day 3 — write the three procedures.** Escalation, mandated reporting, breach. A day of
writing, and they are the documents you will be most grateful for and least able to produce
under pressure.

**Then the age gate**, because it is your largest statutory exposure and it is what makes your
certificate retention decision lawful rather than contrary to §312.10.

**Then engage the attorney** — with this document and the seven-item list from the brief, not
with "please review our privacy policy." You will get a better answer for less money.

**One thing I would reconsider, without recommending you reverse it.** You have chosen to be an
independent platform *and* to let adults message minors *and* not to run background checks. Any
two of those three are ordinary. All three together mean **you are the only safeguard**, which
is a real position to occupy — Discord and Roblox occupy it — but those platforms carry trust
and safety teams. At your scale the compensating control is *narrowness*: keep messaging tightly
scoped to genuine applicant relationships, make blocking and reporting effortless, and be
publicly, specifically honest that you do not vet organizers. That is a defensible posture. What
is not defensible is the current combination of broad capability and absent enforcement.

**What is genuinely good, and worth saying.** The authorization spine, step-up re-authentication,
derived-not-stored hours, the audit log, telemetry minimisation, private-by-default profiles,
opt-in leaderboard, and the event-scoped read-only-after-completion messaging model are all
better than most funded products ship. The messaging design in particular is more thoughtful
than I credited on the first pass. You are not far from a defensible launch — the remaining gap
is concentrated, nameable, and mostly about a week of engineering plus a lawyer.
