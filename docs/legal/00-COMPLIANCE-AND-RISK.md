# WeVolunteer — Compliance Analysis and Legal Risk Register

**Date:** 2026-08-05
**Scope:** WeVolunteer v1.2.0, as it exists on `fix/v1.2c-review-findings`
**Prepared by:** Engineering/product analysis, grounded in the schema and route handlers
**Status:** DRAFT — requires review by a licensed attorney before launch

> **This is not legal advice.** It is a structured, code-grounded compliance analysis
> written to make an attorney's review fast and cheap. Every legal conclusion below is
> marked with a confidence level and a citation. Where the law is genuinely unsettled or
> depends on a fact only you can supply, it says so rather than guessing.

---

## Part 0 — The decision that determines everything else

**Nothing else in this document can be finalised until this is answered.**

WeVolunteer can launch in one of two postures, and they carry *different laws*, *different
controllers*, *different consent mechanics*, and *different documents*:

### Posture A — District-adopted (WeVolunteer is a vendor)

A school or district signs an agreement. The district is the data controller. WeVolunteer
is a "school official" under FERPA's exception and an "operator" under New Jersey's
student-privacy statute.

- FERPA obligations attach **to the district**, and flow to you by contract.
- N.J. P.L. 2019, c. 494 attaches **to you directly** as the operator.
- Parents get inspection and amendment rights *through the district*.
- You need: a Data Privacy Agreement (DPA), an Operator Agreement, and to be listed on the
  district's vendor register.
- Consent for the service itself is generally handled by the district's annual notice —
  you are not collecting consent from students yourself.

### Posture B — Independently operated (WeVolunteer is the controller)

Students sign up directly. You are the controller. There is no school standing between you
and a 14-year-old's data.

- FERPA **does not apply** (you are not an educational agency and hold no education records
  on a school's behalf).
- COPPA applies with full force if any user is under 13.
- You collect consent yourself, and for minors that means guardian consent is the only
  defensible basis for several features.
- The FTC Act §5 becomes your primary exposure: every promise in your privacy notice is
  enforceable against you.
- NJDPA applicability turns on thresholds you will not meet at pilot scale — but the
  *deception* exposure does not have a threshold.

**Current code presumes Posture A.** `PRIVACY_OWNER` defaults to `SCHOOL_NAME`, and
`PrivacyNotice.jsx` speaks of "the district" throughout. But nothing enforces it: the app
runs perfectly well with no district at all, which is Posture B by default and by accident.

> **DECISION 1 (blocking):** Which posture? If both (a district pilot now, public later),
> say so — the documents must be written to switch, and this analysis assumes they are.

---

## Part 1 — Compliance Check

### Summary

**Assessment: Requires further review before launch.**

The engineering foundation is unusually strong for a pre-launch product — deny-by-default
authorization, step-up re-authentication on all seven sensitive actions, audit logging,
redacted error telemetry, private-by-default profiles, opt-in leaderboard. The security
posture is better than most funded startups.

The *legal* foundation is close to absent, and three specific gaps are launch blockers.
None of them are hard to fix; all of them are hard to fix *after* someone gets hurt.

### Applicable Regulations

| Regulation | Applies? | Why | Key Requirements | Confidence |
|---|---|---|---|---|
| **COPPA** (15 U.S.C. §6501; 16 CFR Pt. 312), as amended eff. 2025-06-23, full compliance 2026-04-22 | **Conditionally — and unmanaged** | Attaches on actual knowledge of a user under 13. The `grade` enum accepts `'9'` (students can be 13 at enrollment) and `'N/A'` (accepts anyone). No age gate exists. | Verifiable parental consent; **written data-retention policy published in the privacy notice** (new §312.10); written children's security programme; direct notice to parents; parental review/deletion rights | High |
| **FERPA** (20 U.S.C. §1232g; 34 CFR Pt. 99) | **Posture A only** | Service hours tied to a graduation requirement are education records. You would hold them as a "school official" under 34 CFR §99.31(a)(1). | District direct control; legitimate educational interest; no redisclosure (§99.33(a)); parent inspection & amendment via district; annual notification | High |
| **N.J. P.L. 2019, c. 494** (A4978, approved 2020-01-21) | **Likely — Posture A; arguable Posture B** | Binds an "operator of an online education service offering education for grades K–12." Whether a volunteer-coordination platform is such a service is a genuine judgment call. | No amassing a student profile except in furtherance of K–12 education; no selling education records; no disclosure except in furtherance of the educational purpose; reasonable security; **delete an education record on request of the school, or of a student who has reached majority** | Medium — applicability is the open question, not the content |
| **NJDPA** (S332, P.L. 2023, c.266), eff. 2025-01-15; enforcement grace ended **2026-07-01** | **Not by threshold; design to it anyway** | Thresholds: 100,000 NJ consumers, or 25,000 + revenue from sale. A pilot meets neither. Also exempts data covered by FERPA. | Where the controller knows a consumer is 13–16: **affirmative consent** required for targeted advertising, sale, **and profiling** in furtherance of decisions with legal or similarly significant effects | High on content; high that thresholds are unmet |
| **PPRA** (20 U.S.C. §1232h) | **Posture A, marginal** | Free-text `bio` and `skills` fields can incidentally capture protected categories (religion, political affiliation). No survey instrument exists. | No required survey on 8 protected categories without consent; no collection of student info for marketing | Medium |
| **FTC Act §5** | **Always** | Unfair or deceptive practices. Every claim in the privacy notice is enforceable. | Do not overstate protections; honour stated retention and deletion behaviour | High |
| **CAN-SPAM** (15 U.S.C. §7701) | **Yes, lightly** | Notification email is largely "transactional or relationship" and exempt from most provisions. | Any promotional email needs opt-out + valid physical postal address; honour opt-outs within 10 business days | High |
| **N.J.S.A. 56:8-163** (NJ breach notification) | **Yes** | Any breach of computerised personal information of NJ residents. | **Notify the NJ State Police (Division of State Police) BEFORE notifying individuals** — a distinctive NJ requirement; then notify affected residents in the most expedient time possible | High |
| **N.J.S.A. 9:6-8.10** (child abuse reporting) | **Yes — operationally** | New Jersey is a **universal mandated reporter** state: *any person* with reasonable cause to believe a child has been abused must report immediately to DCP&P (1-877-NJ-ABUSE). | Immediate report; no internal-escalation-first; no discretion | High |
| **N.J.S.A. 18A:37-13** et seq. (Anti-Bullying Bill of Rights) | **Posture A** | Messaging and comments are a plausible HIB vector. District staff acquire statutory duties on notice. | Report to principal same day; investigation initiated within 1 school day; completed within 10 school days | Medium — duties attach to the district, not you, but your product must support them |
| **ADA Title II** (DOJ web rule, 28 CFR Pt. 35) | **Posture A** | Public entities must conform web content and mobile apps to **WCAG 2.1 Level AA**. Deadlines extended by DOJ on 2026-04-17. | **2027-04-26** for entities serving ≥50,000 population; **2028-04-26** for smaller entities and special districts | High |
| **ADA Title III / §504** | **Posture B** | Places of public accommodation; recipients of federal funds. | WCAG 2.1 AA is the practical safe harbour | Medium |
| **Illinois BIPA / Texas CUBI** | **No, today** | Avatars are stored images. No biometric template is derived. QR check-in is not biometric. | Would attach immediately if face-matching were ever added to check-in | High |

### Requirements Status

| # | Requirement | Status | Action needed |
|---|---|---|---|
| 1 | Published privacy notice | **Partially met** | `/privacy` exists and is honest, but ships incomplete by design — retention, contact, and under-13 are unset config values |
| 2 | Written data-retention policy, **published in the notice** (COPPA §312.10) | **Not met** | Blocking. See DECISION 3 |
| 3 | Age gate preventing under-13 accounts | **Not met** | Blocking. No DOB, no gate; `grade='N/A'` accepts anyone |
| 4 | Verifiable parental consent mechanism | **Not met** | Only required if you permit under-13. Recommended answer: don't |
| 5 | Guardian access / correction path | **Not met** | No guardian role, no documented request path, `PRIVACY_CONTACT` unset |
| 6 | Terms of Service | **Not met** | No document exists |
| 7 | Community guidelines / acceptable use | **Not met** | Messaging and comments ship with no published rules |
| 8 | Organizer agreement | **Not met** | Adults receive minors' contact details under no written undertaking |
| 9 | Breach response procedure (incl. NJ State Police step) | **Not met** | Blocking-adjacent: cannot be authored during an incident |
| 10 | Data deletion policy matching actual behaviour | **Not met** | Behaviour is anonymisation + record retention; nothing published says so precisely |
| 11 | Cookie/tracking notice | **Not met** | Even though there are no trackers — saying so in writing is the asset |
| 12 | Certificate verification policy | **Not met** | A public unauthenticated endpoint discloses a minor's name with no published governing rule |
| 13 | Vendor/subprocessor disclosures + DPAs | **Not met** | Nominatim, Open-Meteo, Google OAuth, SMTP provider — none contracted or disclosed |
| 14 | Records of processing | **Not met** | No inventory exists; Part 2 of this document is the closest thing |
| 15 | WCAG 2.1 AA conformance statement | **Not met** | Deadline 2027-04-26 (Posture A, ≥50k) |
| 16 | Audit logging | **Met** | `admin_audit_logs` + `recordAudit`, used consistently |
| 17 | Access control / least privilege | **Met, strongly** | `authz.js` with six build-failing completeness guards |
| 18 | Step-up auth on sensitive actions | **Met, strongly** | All seven registered actions gated and spent transactionally |
| 19 | Transport & credential security | **Met** | bcrypt hashing, `token_version` invalidation, `no-store` on exports |
| 20 | Telemetry minimisation | **Met** | Errors hash the user, normalise routes, strip identifiers |

---

## Part 2 — Legal Risk Register

Scored **Severity (1–5) × Likelihood (1–5)**.
GREEN 1–4 · YELLOW 5–9 · ORANGE 10–15 · RED 16–25

### Risk summary

| ID | Risk | Sev | Lik | Score | Level | Counsel? |
|---|---|---|---|---|---|---|
| R-01 | Under-13 accounts are structurally possible and entirely unmanaged | 5 | 3 | **15** | ORANGE | **Yes** |
| R-02 | Deleted students' real names persist in publicly-verifiable certificates | 4 | 4 | **16** | **RED** | **Yes** |
| R-03 | Adults and minors can exchange private messages with no guardian visibility | 5 | 3 | **15** | ORANGE | **Yes** |
| R-04 | Organizers receive minors' contact details under no written undertaking | 4 | 3 | **12** | ORANGE | **Yes** |
| R-05 | No guardian access, correction, or complaint path exists | 4 | 3 | **12** | ORANGE | Yes |
| R-06 | Auto Select profiles students algorithmically with no disclosure or appeal | 3 | 4 | **12** | ORANGE | **Yes** |
| R-07 | No breach response procedure; NJ requires State Police notice first | 4 | 2 | **8** | YELLOW | Yes |
| R-08 | Third-party calls to uncontracted services (Nominatim, Open-Meteo) | 3 | 3 | **9** | YELLOW | No |
| R-09 | No published retention period; COPPA now requires one in the notice | 4 | 2 | **8** | YELLOW | Yes |
| R-10 | Event comments are unmoderated by policy; no SLA, no retention rule | 3 | 3 | **9** | YELLOW | No |
| R-11 | Admin visibility is total, with no access-review or roster policy | 3 | 3 | **9** | YELLOW | No |
| R-12 | Leaderboard consent is a minor's unaided click | 2 | 3 | **6** | YELLOW | No |
| R-13 | School-level analytics can re-identify in small cohorts | 2 | 3 | **6** | YELLOW | No |
| R-14 | Error telemetry claims in the notice could drift from behaviour | 3 | 2 | **6** | YELLOW | No |
| R-15 | Impersonation (v2.0, unimplemented) would let an adult act as a minor | 5 | 2 | **10** | ORANGE | **Yes, before it ships** |
| R-16 | WCAG 2.1 AA not formally verified; district deadline 2027-04-26 | 3 | 3 | **9** | YELLOW | No |
| R-17 | No ToS: no liability limit, no governing law, no termination right | 4 | 3 | **12** | ORANGE | **Yes** |
| R-18 | Map tiles load from CARTO — students' browsers contact an uncontracted CDN | 3 | 4 | **12** | ORANGE | No |
| R-19 | `localStorage` caches account details, persisting on shared school devices | 2 | 4 | **8** | YELLOW | No |

---

### R-02 — Deleted students' real names persist in publicly-verifiable certificates · **RED (16)**

**This is the highest-scoring finding and the one I'd fix first.**

**What the code does.** In `server/routes/accountRoutes.js`, deletion reads the user row at
line 46 — *before* anonymisation — then at lines 89–118 writes `userRow.name`, the real
pre-anonymisation name, into `certificates.volunteer_name_snapshot`. Anonymisation of the
`users` row happens afterwards, at lines 169–174. So the snapshot is *created by the act of
deletion*, and it captures the name deletion was meant to remove.

`GET /api/certificates/verify/:code` (`attendanceRoutes.js:243`) is unauthenticated by
design, and at lines 249–257 it returns `volunteer_name_snapshot` **in preference to** the
live join. So after deletion the public endpoint serves the real name; before deletion it
serves the live one.

**Net effect:** a student deletes their account, and their full legal name becomes
permanently retrievable by anyone holding a certificate code — with no expiry, no
revocation path, and no way for the student to ever remove it.

**Why it matters.** N.J. P.L. 2019, c. 494 requires an operator to delete an education
record on request of a student who has reached majority. A record that survives deletion
*by design* is in direct tension with that. Separately, the delete dialog tells the user
"Your verified volunteer records and certificates **may** be preserved for verification
purposes" — which is disclosed, but "may be preserved" does not convey to a 15-year-old
that their full legal name stays publicly queryable forever. That gap between what is
disclosed and what happens is the FTC Act §5 exposure.

**Mitigating factors — genuine ones.** The retention itself is *defensible and probably
correct*: a certificate a college can no longer verify is worthless, and the whole point of
the snapshot is that verification must survive the account. Codes carry 40 bits of entropy
(`crypto.randomBytes(5)`, `WEV-XXXX-XXXX`) and `verifyLimiter` rate-limits the endpoint, so
this is not enumerable — the disclosure is to whoever *holds a code*, not to the world. And
grade is deliberately omitted from the response.

**Possible harm.** A student who leaves the platform specifically to erase their presence
discovers they cannot. In the bad case, a student with a safety reason to disappear — a
stalking or domestic situation — finds their name still resolvable.

**Recommended mitigation (in priority order):**
1. **Disclose it precisely**, at the moment of deletion, in plain words: *"Certificates you
   have already earned keep your name on them so schools can still verify them. This does
   not go away when you delete your account."* Replace "may be preserved."
2. **Offer a choice at deletion**: keep certificates verifiable, or void them. A student who
   voids them loses verification; that is their call to make, not yours. Voiding sets
   `volunteer_name_snapshot` to the anonymised form and marks the certificate revoked.
3. **Publish a certificate retention period** in the Certificate Verification Policy — e.g.
   verifiable for 7 years after issue, then purged. Indefinite retention of a minor's name
   is the part that is hardest to defend.
4. Add a test asserting that a deleted account's certificate returns whatever the student
   chose, so the behaviour cannot silently regress.

**Legal review needed:** Yes — specifically on whether the verification interest justifies
indefinite retention, and on whether P.L. 2019 c. 494's deletion duty reaches it.

**Residual risk after mitigation:** YELLOW (6) — Severity 3, Likelihood 2.

---

### R-01 — Under-13 accounts are structurally possible and unmanaged · **ORANGE (15)**

**What the code does.** `users.grade` is
`CHECK(grade IN ('9','10','11','12','Adult','N/A'))`. There is no date of birth column, no
age screen, and no signup validation that excludes a child. Ninth-graders are commonly 13
at enrollment, and `'N/A'` accepts literally anyone.

**Why it matters.** COPPA attaches on *actual knowledge* that a user is under 13. Collecting
"grade 9" is not actual knowledge — but it is close enough that the FTC's willful-blindness
posture is a real concern, and the amended Rule (fully enforceable since 2026-04-22) raised
the stakes: §312.10 now requires a **written retention policy published in the privacy
notice**, plus a written children's data-security programme.

**Contributing factors:** no age gate; `'N/A'` grade; the product is marketed to schools,
some of which are K–12 and include middle schoolers; nothing prevents a district from
onboarding an 8th-grade service club.

**Mitigating factors:** the product is designed for high school; grade is collected, so a
gate is a small change; no advertising, no sale, no third-party analytics — so several
COPPA obligations would be trivially satisfied if it ever did apply.

**Possible harm:** FTC enforcement (civil penalties per violation), and the practical harm
of a 12-year-old's contact details being handed to an adult event organizer.

**Recommended mitigation:**
1. **Add a neutral age screen at signup** — collect birth date (or a "are you 13 or older"
   neutral gate) *before* collecting anything else, and hard-block under-13 with a message
   that does not invite retrying with a different answer.
2. Remove or restrict `'N/A'` as a self-selectable grade. If it exists for adult organizers,
   it should not be reachable from the student signup path.
3. Publish the retention policy required by §312.10 regardless — you need it anyway.
4. If a district genuinely needs middle-school participation, that is a *different product
   decision* requiring full verifiable parental consent. Do not solve it by leaving the door
   open.

**Legal review needed:** Yes.
**Residual after mitigation:** GREEN (4) — Severity 4, Likelihood 1.

> **DECISION 2 (blocking):** Is the minimum age 13, 14, or "enrolled in grade 9+"? And is
> `'N/A'` grade ever offered to a self-registering user?

---

### R-03 — Adults and minors can exchange private messages, no guardian visibility · **ORANGE (15)**

**What the code does.** `server/authz.js` grants `message.send` to **both** `student` and
`organizer`. Organizers are adults. Conversations are private between participants; there is
no guardian view, no transcript access, no adult co-presence, and no keyword monitoring.

**Mitigating factors — and they are substantial.** A reporting mechanism exists
(`conversation_reports`, `conversation_report_messages`), participants can be muted
(`muted_until`), `report.resolve` is an admin capability, and organizers must be approved
(`organizer.approve`, `requiresVerified`). This is better than most youth platforms ship.

**Why it still matters.** Private adult-to-minor messaging is the single highest child-safety
surface in any youth product, and the controls above are *reactive* — they work once someone
reports. New Jersey is a universal mandated-reporter state (N.J.S.A. 9:6-8.10): *any person*
with reasonable cause to believe a child has been abused must report immediately to DCP&P.
Your admins will at some point read a report that triggers that duty, and right now nothing
tells them what to do.

**Possible harm:** grooming; the platform as the contact vector in a safeguarding incident;
in Posture A, a district's Anti-Bullying Bill of Rights duties triggered without the product
supporting the statutory timelines (same-day report to principal, investigation within 1
school day, complete within 10).

**Recommended mitigation:**
1. **Publish Youth Safety Guidelines** stating plainly what organizers may and may not do,
   and that reports of harm are escalated to a named human, immediately.
2. **Write the mandated-reporter procedure** into the Admin Responsibilities Policy: NJ is
   universal-reporter, the report goes to DCP&P directly and immediately, and internal
   escalation does not substitute for it.
3. **Constrain the messaging graph, in code.** The strongest single control: an organizer may
   message a student only where an application relationship exists, and only until some
   period after the event. Unbounded adult→any-minor DM is the shape to remove.
4. Add a persistent, non-dismissible reporting affordance in every conversation.
5. Consider guardian visibility as a district-configurable option in Posture A.
6. Retain conversation records long enough to support an investigation — and say so.

**Legal review needed:** Yes — particularly the mandated-reporter procedure.
**Residual after mitigation:** YELLOW (8) — Severity 4, Likelihood 2.

> **DECISION 3:** May an organizer message a student who has *not* applied to their event?
> I recommend no.

---

### R-06 — Auto Select profiles students algorithmically, undisclosed · **ORANGE (12)**

**What the code does.** `server/weighting.js` computes a selection weight from a student's
total credited hours: `W(h) = 1.5 + 8.5 / (1 + 0.005h)`. A new volunteer (0 hours) gets
weight 10.0; a 500-hour volunteer approaches 1.5. Selection is a weighted draw without
replacement, seeded per event+slot with Mulberry32 so a run is reproducible and auditable.
Undrawn applicants become the waitlist in draw order.

**This is good design.** It is equitable by intent (it favours students who have had fewer
opportunities), it is deterministic and auditable, and it is isolated in one testable module.
`auto_select_runs` records runs.

**Why it is still a risk.** It is *automated decision-making about minors, affecting access
to a resource tied to graduation requirements*, and **nothing in the product tells students
it exists.** Students experience it as an organizer's choice. There is no explanation of the
curve, no notice that hours affect selection odds, and no appeal path.

- **NJDPA** requires affirmative consent for *profiling in furtherance of decisions producing
  legal or similarly significant effects* for consumers the controller knows are 13–16.
  You know grade, so you know the band. Whether volunteer selection is "similarly
  significant" is arguable — but where it is tied to a graduation service requirement, I
  would not want to argue the other side. (Thresholds mean NJDPA likely does not bind you at
  pilot scale; design to it anyway.)
- **N.J. P.L. 2019 c. 494** prohibits amassing a student profile "for any purpose other than
  the furtherance of K–12 education." Auto Select is defensible under that — but the defence
  needs to be *written down before* it is questioned, not improvised after.

**Recommended mitigation:**
1. **Disclose it, in the product**, where students apply: *"Some organizers use Auto Select.
   It gives students with fewer recorded hours a better chance, so opportunities spread
   around. It never uses your grade, school, or profile."*
2. Publish the actual rule — including the curve — in the Volunteer Record Policy. There is
   no reason to hide it; transparency is the whole defence.
3. **Give the student a reason and a route.** A declined applicant should see whether the
   event used Auto Select, and how to ask the organizer about it.
4. Record and retain the seed and inputs per run (`auto_select_runs` already does) so any
   decision can be reconstructed on challenge.
5. Confirm in writing that the weight uses **only** credited hours — never grade, school,
   gender, or profile fields. The code does; the policy should promise it.

**Legal review needed:** Yes — on the "similarly significant effects" characterisation.
**Residual after mitigation:** YELLOW (6) — Severity 3, Likelihood 2.

---

### R-04 — Organizers receive minors' contact details under no written undertaking · **ORANGE (12)**

Organizers see name and contact details for students who apply to *their* event — correctly
scoped (they cannot see other events' applicants). But there is no Organizer Agreement, no
confidentiality undertaking, no stated purpose limitation, no prohibition on exporting the
list into a personal address book, and no background-check requirement or representation.

In Posture A this is a **redisclosure** question under FERPA §99.33(a): the district may
disclose to a school official with a legitimate educational interest, and an external
community-nonprofit organizer may not be one. Under N.J. P.L. 2019 c. 494 the question is
whether the disclosure is "in furtherance of the educational purpose."

**Mitigation:** the Organizer Agreement (policy #9) is the single highest-value document in
this set. It must bind the organizer to: use contact details only to run the event; not
retain them after the event; not disclose them onward; report safety concerns; and
acknowledge NJ mandated-reporter status. Gate `organizer.approve` on acceptance, and record
acceptance with a timestamp and version.

**Legal review needed:** Yes. **Residual:** YELLOW (6).

---

### R-05 — No guardian access, correction, or complaint path · **ORANGE (12)**

There is no guardian role, no guardian view, no documented request address, and
`PRIVACY_CONTACT` is unset — so the privacy notice currently renders "Not yet provided" for
the very question a worried parent arrives with.

FERPA gives parents inspection and amendment rights for students under 18 (Posture A, via
the district). COPPA gives parents review and deletion rights (if under-13 is ever in scope).
Independently of either, a parent who cannot find a way to ask a question is a parent who
calls the district, the press, or the AG.

**Mitigation:** name a monitored contact; publish a guardian request procedure with a stated
response time (I recommend 10 business days to acknowledge, 45 to resolve — matching the
strictest US norm); document identity verification proportionate to the request.

**Residual:** GREEN (4) once a contact exists and is monitored.

---

### R-17 — No Terms of Service · **ORANGE (12)**

There is no ToS. That means: no limitation of liability, no disclaimer of warranties, no
governing law or venue, no stated right to suspend or terminate an abusive account, no
acceptable-use rules to enforce against, no IP terms for user-uploaded avatars and bios, and
no dispute-resolution clause.

For a platform where an adult and a minor can transact and communicate, and where a student's
graduation-relevant record lives, that is a material gap. Note also that **a minor's
agreement to a ToS is voidable** — which is precisely why the guardian acknowledgement and
the district agreement do the real load-bearing work in Posture A.

**Legal review needed:** Yes — this one genuinely needs drafting counsel, not just review.

---

### R-07 — No breach response procedure · **YELLOW (8)**

New Jersey's breach statute (N.J.S.A. 56:8-163) has a step most templates get wrong:
**notify the New Jersey State Police before notifying affected individuals.** A procedure
improvised during an incident will miss it.

Also required: in Posture A, contractual breach notice to the district — student-privacy DPAs
commonly demand notification within 24 hours, which is far tighter than statute.

**Mitigation:** write the runbook now (`docs/operations/` already holds runbooks — it belongs
there), name the decision-maker, pre-draft the notification templates, and rehearse once.

---

### R-08 — Uncontracted third-party services · **YELLOW (9)**

| Service | What is sent | Contract | Notes |
|---|---|---|---|
| Nominatim (OSM) | Event location strings | None — free public API | Usage policy requires valid User-Agent + rate limiting; verify compliance |
| Open-Meteo | Event coordinates | None — free public API | No personal data |
| Google OAuth | Email, profile | Google ToS | Scopes are minimal (`userinfo.email`, `userinfo.profile`) — good |
| SMTP provider | Recipient email + notification content | Depends on provider | **Undetermined — you must tell me who this is** |

No student PII currently reaches Nominatim or Open-Meteo (event locations are venues, not
homes). **That must stay true** — if a student's address is ever geocoded, this becomes an
ORANGE finding immediately.

**Mitigation:** disclose all four as subprocessors; get a DPA with the SMTP provider; add a
code comment or test asserting that only event locations reach the geocoder.

> **DECISION 4:** Which SMTP provider? A district DPA will require naming it.

---

### R-09 · R-10 · R-11 · R-12 · R-13 · R-14 · R-16 — YELLOW findings in brief

- **R-09 — No published retention period.** COPPA §312.10 now requires a written retention
  policy *published in the notice*. `PRIVACY_RETENTION` is an unset config value. Blocking
  for the notice to be complete. **DECISION 5:** how long do you keep an inactive account's
  data? A defensible default: purge inactive non-graduated accounts after 3 years; keep
  attendance and certificates per the Volunteer Record Policy.
- **R-10 — Comments.** `event.moderate` exists and `reports` exists, but no published rule,
  no moderation SLA, no retention period. Community Guidelines + a stated response time fix
  this cheaply.
- **R-11 — Admin visibility.** Total by design, audited by `recordAudit` — good. Missing: a
  policy defining who may be an admin, periodic access review, and a rule that browsing a
  student's record without a task is misuse. That is the Admin Responsibilities Policy.
- **R-12 — Leaderboard consent.** `leaderboard_opt_in DEFAULT 0` is exactly right.
  Remaining question is whether a 15-year-old's click is meaningful consent to publish their
  name and hours. Mitigation: plain-language framing at the toggle, and guardian visibility
  in Posture A.
- **R-13 — Analytics re-identification.** `analytics.school` over a small cohort (three
  seniors at one school) re-identifies. Mitigation: suppress cells below a minimum count
  (n<5 is the usual education-data convention) — this is a real code change, not a doc.
- **R-14 — Telemetry claims could drift.** The notice makes three specific promises about
  error logs. They are true today. Add a test asserting redaction so they stay true, because
  the notice converts them into §5 representations.
- **R-16 — Accessibility.** Deadline 2027-04-26 (Posture A, ≥50k population). Phase 5 of this
  engagement addresses it. Not urgent; is dated.

### R-18 — Students' browsers contact an uncontracted third-party CDN · **ORANGE (12)**

**Found while fact-checking the Cookie Notice draft, not in the original sweep.**

`src/components/location/LeafletMap.jsx:61` loads map tiles from
`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`.

Unlike Nominatim and Open-Meteo — which are called **server-side**, so the student's device is
never exposed — tile requests are made **by the student's browser**. CARTO therefore receives:

- the student's **IP address** (and, in a school, effectively the school's)
- the **User-Agent**
- the **tile coordinates**, which reveal the geographic area being viewed — i.e. roughly which
  event a particular student was looking at, and when

**Why this scores as it does.** Severity 3: no name, email, or account reaches CARTO, and this
is ordinary web-mapping practice — it is not tracking and not a sale. Likelihood 4: it happens
on every map render, today, for every student.

**Why it matters anyway.**
1. **It contradicts what the product is about to publish.** The natural sentence to write —
   "we use no third-party CDNs" — would be a §5-actionable misstatement. It was caught only
   because the draft was checked against the code.
2. **District procurement will ask.** "Do student browsers contact any third party?" is a
   standard question on student-data-privacy vendor questionnaires, and "yes, an uncontracted
   one" is a slow answer to have to give mid-review.
3. **There is no agreement with CARTO.** No DPA, no terms accepted, no service tier. The free
   basemap service can also change terms or rate-limit without notice.

**Mitigation options:**

| Option | Effectiveness | Effort | Recommend |
|---|---|---|---|
| Disclose it accurately in the Cookie Notice and Privacy Policy | Medium — honest, not protective | Low | **Yes, immediately** — done in the drafts |
| Self-host tiles, or proxy them through the API server | High — no third party sees the student at all | High (storage + bandwidth) | Later; the right end state |
| Proxy tile requests server-side through the existing API | High | Medium | **Yes** — mirrors how Nominatim and Open-Meteo are already handled |
| Render maps only on explicit interaction ("Show map") | Medium — reduces exposure a lot for one line of code | Low | **Yes, as an interim** |
| Drop maps | High | Low | No — they are genuinely useful |

**Recommended:** disclose now; add a click-to-load map as an interim; proxy tiles server-side
when convenient. The proxy approach is consistent with the pattern the codebase already uses
for its other two geo services, which is a strong hint it is the intended architecture.

**Residual after proxying:** GREEN (2).

---

### R-19 — Account details cached in `localStorage` on shared devices · **YELLOW (8)**

`src/utils/api.js` caches the user object in `localStorage` (lines 130, 140) to avoid a blank
flash on load. It is cleared on sign-out and on session revocation — and the code at line 316
shows this was already thought about and fixed once.

The residual issue is the shared school Chromebook: a student who closes the tab without
signing out leaves their name, username, and role readable by the next person. The step-up
grant code deliberately chose `sessionStorage` for exactly this threat model
(`src/utils/stepUp.js:69`); the user cache did not get the same treatment.

**Mitigation:** either move the cache to `sessionStorage` (accepting the flash on a new tab),
or keep it and tell users plainly to sign out on shared devices — which the Cookie Notice
draft now does. Low cost either way; the disclosure is the minimum.

---

### R-15 — Impersonation, before it ships · **ORANGE (10), forward-looking**

`impersonation.start` is registered in `SUPER_ONLY` with no route implementing it (v2.0).
`principalFor` already separates `actualRole` from `effectiveRole` and carries `actorId` —
thoughtful groundwork.

**Do not ship it without a policy.** An adult acting as a minor's account could send
messages that appear to come from that minor. Requirements before it exists: every
impersonated action audited with the real actor; the impersonated user notified; messaging
and deletion disabled while impersonating; a hard time limit; and a written justification
recorded per session.

---

## Part 3 — Launch Briefing

### Executive summary

WeVolunteer is engineering-mature and legally immature, and the gap between the two is
unusually wide. The authorization spine, step-up re-authentication, audit logging, and
telemetry minimisation are stronger than most Series-A products. There is no Terms of
Service, no retention policy, no age gate, and no written agreement binding the adults who
receive minors' contact details.

The good news is that the hard part is done. Almost every legal gap here is a *document* or
a *small, well-scoped code change* — not an architectural problem. The existing privacy
notice's refusal to invent district policy is exactly the right instinct, and this work
extends it rather than replacing it.

### Current legal maturity: **2 / 5**

| Dimension | Score | Note |
|---|---|---|
| Technical security controls | 4.5 / 5 | Genuinely strong |
| Data minimisation | 4 / 5 | Private by default, opt-in leaderboard, redacted telemetry |
| Transparency | 2 / 5 | One honest but incomplete notice |
| Consent architecture | 1 / 5 | One checkbox, gated on an unset config value |
| Contractual foundation | 0 / 5 | Nothing exists |
| Operational procedures | 1 / 5 | Good engineering runbooks; no legal ones |
| Youth-safety governance | 1.5 / 5 | Good reactive tooling, no policy or reporting procedure |

### Launch blockers — must be resolved before any real student uses this

1. **Answer DECISION 1** (Posture A or B). Everything else branches on it.
2. **Age gate.** Block under-13 at signup (R-01).
3. **Retention policy**, written and published in the notice — COPPA §312.10 (R-09).
4. **Fix or fully disclose the post-deletion certificate name** (R-02).
5. **Terms of Service** (R-17).
6. **Organizer Agreement**, with acceptance gated on `organizer.approve` (R-04).
7. **Youth Safety Guidelines + mandated-reporter procedure** (R-03).
8. **A monitored privacy contact address** — fills `PRIVACY_CONTACT` (R-05).
9. **Breach response runbook**, including the NJ State Police step (R-07).
10. **Posture A only:** signed DPA with the district before any student data is loaded.

### Not blockers, but do them in the first 90 days

Community Guidelines · Cookie/tracking notice · Certificate Verification Policy · Volunteer
Record Policy · Admin Responsibilities Policy · subprocessor disclosures + SMTP DPA ·
analytics small-cell suppression · WCAG 2.1 AA conformance statement · redaction regression
test · Auto Select in-product disclosure.

### Where outside counsel is genuinely required

Not everything here needs a lawyer. These do:

| Item | Why |
|---|---|
| Terms of Service | Needs drafting, not review — liability, venue, minor capacity |
| Posture A: DPA + Operator Agreement | District counsel will redline; you need a position |
| Under-13 strategy (R-01) | COPPA exposure is the one with statutory penalties |
| Post-deletion certificate retention (R-02) | Genuinely unsettled; needs a judgment call on record |
| Auto Select as "profiling" (R-06) | Novel characterisation; worth a written opinion |
| Mandated-reporter procedure (R-03) | Getting this wrong has consequences beyond legal ones |
| Whether P.L. 2019 c. 494 reaches this product | The threshold question for NJ operator duties |

A focused engagement with a NJ education-law or student-privacy attorney covering these
seven items is a far better use of budget than a general "review our privacy policy."

---

## Open decisions — I need answers before these documents can be finalised

| # | Decision | Blocks | My recommendation |
|---|---|---|---|
| 1 | Posture A (district vendor) or B (independent)? | Everything | A for pilot; write documents to switch |
| 2 | Minimum age? Is `'N/A'` grade self-selectable? | R-01, signup, Privacy Policy | 13+ hard floor; `'N/A'` not self-selectable |
| 3 | May organizers message students who have not applied? | R-03, Youth Safety, code | No |
| 4 | Which SMTP provider? | Subprocessor list, DPA | — |
| 5 | Retention period for inactive accounts? | R-09, Privacy Policy, COPPA §312.10 | 3 years inactive → purge |
| 6 | How long do certificates stay verifiable? | R-02, Certificate Policy | 7 years, then purge |
| 7 | Legal entity behind WeVolunteer? Sole proprietor, LLC, school club? | ToS, liability, who signs | Form an entity before any district signs |
| 8 | Governing law / venue for the ToS? | ToS | New Jersey |
| 9 | Who is the named privacy contact, and who monitors it? | R-05, `PRIVACY_CONTACT` | — |
| 10 | Will guardians get accounts, or act through the district? | Guardian access design | Through the district in A; guardian email verification in B |

---

## Sources

- [Ogletree — FAQ on the New Jersey Data Protection Act, effective January 15, 2025](https://ogletree.com/insights-resources/blog-posts/frequently-asked-questions-about-the-new-jersey-data-protection-act-effective-january-15-2025/)
- [PrivacyLawMap — New Jersey NJDPA compliance, cure period ended July 1](https://privacylawmap.com/states/new-jersey)
- [Fenwick — What the Amended COPPA Rule Means for Data Retention Practices](https://www.fenwick.com/insights/publications/what-the-amended-coppa-rule-means-for-data-retention-practices)
- [Finnegan — COPPA's Amended Rule Is Now in Full Effect](https://www.finnegan.com/en/insights/articles/coppas-amended-rule-is-now-in-full-effect-what-operators-need-to-know.html)
- [Federal Register — Extension of Compliance Dates, ADA Title II web accessibility (April 2026)](https://www.federalregister.gov/documents/2026/04/20/2026-07663/extension-of-compliance-dates-for-nondiscrimination-on-the-basis-of-disability-accessibility-of-web)
- [ADA.gov — Fact Sheet: Web Content and Mobile Apps rule](https://www.ada.gov/resources/2024-03-08-web-rule/)
- [NJ Legislature — A4978 (2018–2019), enacted as P.L. 2019, c. 494](https://www.njleg.state.nj.us/bill-search/2018/A4978)
- [LegiScan — NJ A4978 bill text and history](https://legiscan.com/NJ/research/A4978/2018)
