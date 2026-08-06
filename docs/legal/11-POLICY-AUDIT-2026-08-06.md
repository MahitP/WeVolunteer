# Policy and Legal Document Audit — 2026-08-06

**Scope.** Textual review of the ten published policy documents in
`docs/legal/policies/`. No redesign, no architecture change, no section reordering,
no template language. Every claim below was checked against the code, and the
check is cited.

**Nothing in this audit has been applied.** Reasons in §0.

## 0. Read this first — why no edit was applied

Three mechanical facts constrain every edit to these files:

1. **Each document's SHA-256 is pinned** in `server/legalDocuments.js`, verified by
   `server/legalDocuments.test.js`, and re-verified at boot by
   `verifyPolicyFiles()`. **A production server refuses to start when a policy
   file does not match its pinned hash.** Editing a document without running
   `node bin/legal-hashes.mjs` and updating the registry is a deployment outage.
2. **A MAJOR version bump invalidates every existing acceptance record** and forces
   re-consent from every user. Whether a given correction is MAJOR or MINOR is a
   judgement with legal consequences, and the registry's own rule is that the test
   is *consequence*, not diff size.
3. **Several edits cannot be written without owner input** — vendor names, the
   liability cap, the monitored hours. Publishing a guess would be worse than the
   placeholder, which is the rule `docs/legal/policies/README.md` already states.

So this is a recommendation set. §7 marks which items are safe to apply
immediately and which are blocked on an answer.

**Coverage honesty.** The Privacy Policy, Terms of Service, Community Guidelines
and Youth Safety Guidelines were read line by line. The Data Deletion Policy,
Cookie Notice, Certificate Verification Policy, Volunteer Record Policy,
Organizer Agreement and Admin Responsibilities Policy were reviewed by targeted
search for claim-bearing language (SLAs, retention periods, "we verify", "we
review", enforcement powers) rather than line by line. Findings for those six are
real but the absence of a finding is weaker evidence than for the first four.

---

## 1. The five findings that matter most

Ordered by consequence, not by document.

### F-1 — Four documents display a version number that contradicts their own acceptance record · **HIGH**

`LegalDocument.jsx` renders the version from the registry. The document body then
prints its own version string. They disagree:

| Document | Registry (page header **and** acceptance record) | Body text |
|---|---|---|
| Terms of Service | **2.1** | 2.0 |
| Community Guidelines | **2.2** | 2.1 |
| Privacy Policy | **3.0** | 2.0 |
| Data Deletion Policy | **2.0** | 1.0 |
| Admin Responsibilities | **1.0** | *no version line at all* |
| Organizer Agreement | 1.0 | *no "Last updated" date* |

A reader of `/legal/terms-of-service` sees "Version 2.1" in the header and
"**Version 2.0**" three lines below it. The acceptance record says 2.1.

This is exactly the failure the hash-pinning system exists to prevent, arriving by
the one route the hash check cannot see: the hash proves the *file* is the one that
was pinned, and nothing proves the *version string inside the file* matches the
registry. In a dispute the question is "what did this person agree to", and this
platform currently answers it two different ways on the same screen.

**Fix:** correct the four body strings to match the registry; add a version line to
Admin Responsibilities and a date line to the Organizer Agreement. This is a
labelling correction, not a substantive change — **MINOR**, no re-consent.

**Also recommend a code guard** (not a document edit): extend
`server/legalDocuments.test.js` to assert that each file's `**Version X.Y**` line
equals its registry `version`, and its `Last updated` equals `effectiveAt`. Without
it this drifts again on the next bump. There is no such assertion today.

### F-2 — The urgent safety alert can be switched off by a notification preference · **HIGH**

The Community Guidelines promise "a report reaches a human within one business day"
and "anything flagged as a safety concern is looked at the same day". The Youth
Safety Guidelines promise "It reaches a human within one business day."

What the code does:

- Priority is **derived from the category and never accepted from the client**, and
  a student reporting an adult floors at `urgent` whatever the category says
  (`moderation.js`). This part is good and stronger than the policy claims.
- **Only `urgent` reports notify anyone.** Normal-priority reports dispatch nothing,
  deliberately (`reportService.js:238`) — they wait for someone to open the queue.
- The urgent alert is `notificationService.dispatch('SYSTEM_ALERT', …)`, and
  **`SYSTEM_ALERT` is not in `MANDATORY_NOTICE_EVENTS`**
  (`notificationContent.js:37`). So in `notificationService.dispatch`,
  `mandatory` is `false`, and therefore
  `emailEnabled = user.email_opt_out === 1 ? false : getPref('email')`.

**The single notification standing between a child-safety report and an unread
queue is subject to a user-preference toggle.** If the operator — the only
moderator — has email off globally or for that category, urgent safety reports are
silent. `ACCOUNT_SUSPENDED` and the appeal outcomes are correctly mandatory; the
report that *causes* a suspension is not.

This is a code defect, not a wording problem, and it is the reason the "one
business day" promise is not currently supportable. **Recommend adding
`SYSTEM_ALERT` to `MANDATORY_NOTICE_EVENTS`** before publishing either promise.
Until then the promise should be softened per §2 (E-1).

### F-3 — A sole operator can never decide an appeal against a suspension they issued · **HIGH**

Community Guidelines: "Your appeal will be reviewed by a different administrator."

`appeals.js` implements that honestly and strictly:
`NEVER_OVERRIDABLE = ['self', 'suspension_issuer', 'suspension_auditor']`, and the
`PATCH /api/admin/appeals/:id` cascade ends in an explicit 403 when any conflict is
not overridable. `disqualifiers()` adds `suspension_issuer` from the snapshot **and**
`suspension_auditor` from the `ACCOUNT_SUSPENDED` audit row.

So the administrator who suspended you can never decide your appeal, and no
privilege level overrides it. **With one administrator, every appeal is structurally
undecidable** — the student is told an appeal will be reviewed, files it, and it
sits in `open` forever.

This is not speculation. `server/appealsRoutes.test.js` had to seed a second
administrator to test appeals at all, and says so: *"A second administrator who
issues no suspensions. Needed because the conflict-of-interest rule now works: the
seeded admin suspends everybody in these fixtures and is therefore disqualified
from deciding any of it."*

The rule is correct and should not be weakened. What is wrong is publishing an
appeal right with no second administrator in place. **This is an operational
blocker, not a drafting one:** either a second administrator exists before launch,
or the documents must say plainly what happens when no eligible reviewer exists.

### F-4 — The Privacy Policy publishes a retention period nothing enforces · **MEDIUM-HIGH**

Privacy Policy retention table: "**Applications** | 3 years after the event".

`retentionWorker.js` sweeps exactly three things: `messages` (3y), `admin_audit_logs`
(1y), and anonymised user shells (3y). **No code deletes applications by age.** The
only `DELETE FROM applications` statements are cascades in `eventRoutes.js` when a
slot or event is deleted.

The same table then says, two rows later, "These periods are enforced by a job that
runs every day and deletes what has aged out — they are not just a statement of
intent." For this row that sentence is false.

Every other period in the table checks out: error diagnostics 30/30/180/7 match
`EVENT_RETENTION_DAYS`/`CLOSED_GROUP`/`OPEN_GROUP`/`SINGLE_CLIENT_GROUP`; export
archives 7 days match `exportWorker.js`; messages, audit logs and shells match
`RETENTION`. Applications is the single unenforced claim — which makes it more
dangerous, not less, because the surrounding accuracy earns the reader's trust.

**Two honest resolutions**, and the owner should pick:
- **(a) Implement it** — add `applicationDays: 3 * 365` to `RETENTION` and a sweep,
  keeping the existing evidence holds. Preferred: the period is reasonable and the
  policy already promises it.
- **(b) Correct the text** to describe what actually happens: applications are kept
  while the event exists and are removed with it. Faster, and honest.

### F-5 — "Reports are not triaged by software" is false as written · **MEDIUM**

Youth Safety Guidelines, step 1: "It reaches a human within one business day.
**Reports are not triaged by software.**"

Software does triage them. `moderation.js` derives priority from the reported
category, floors a student-reporting-an-adult at `urgent`, and that derived priority
decides whether any human is alerted at all (F-2). That is triage in the ordinary
sense, and it is *good* triage — but the sentence as written is the kind of claim a
journalist or regulator checks and finds untrue.

The defensible version of the intended point is that no software makes a *decision*
about the outcome. Wording in §2 (E-2).

---

## 2. Document-by-document audit

Codes: **A** contradiction · **B** legally risky · **C** technically unsupported ·
**D** confusing · **E** promise to weaken · **F** protection to strengthen ·
**G** retention to reconsider · **H** New Jersey · **I** minors · **J** keep exactly as written

### 2.1 Privacy Policy (registry v3.0, body says 2.0)

- **A** F-1 version mismatch. Also: body header says "Applies to WeVolunteer version
  1.2 and later" while the app is 1.2.0 — fine, but will silently age.
- **C** F-4 applications retention.
- **C** "**We are building** an option to void them when you delete your account …
  but it does not exist yet." No such work exists in the repo. "We are building"
  states a commitment with a schedule. Soften to "We may add" or state no timetable.
- **C / B** "we are **taking legal advice** on what the right one is" (safety-report
  retention). If no counsel is engaged this is a false statement of fact in a privacy
  notice — the worst place to have one. Either engage counsel, or say "we have not
  yet taken legal advice on this and intend to".
- **G** Safety reports "kept indefinitely". The document already admits this is "the
  honest description of what the software does today, not a considered retention
  period". Correct and admirable, but indefinite retention of minors' safety records
  by a sole proprietor with no stated end is the single largest privacy exposure in
  the set. See §4.
- **H** The breach section says notification goes to "the New Jersey State Police as
  state law requires". N.J.S.A. 56:8-163 also requires notification to affected
  individuals and, above thresholds, to consumer reporting agencies. The text covers
  individuals ("then tell you what happened") but the ordering implies police first
  as the only regulator step. Counsel should confirm; do not expand unilaterally.
- **I** The under-13 handling is strong. Keep.
- **J — keep exactly as written:** the entire "What we do not do, and want you to
  know before you go looking for it" section on guardian consent. It is the best
  writing in the document set and precisely the transparency the philosophy demands.
  Also keep the closing "Being one person is the honest answer to 'who monitors
  this?'".
- **J — keep:** the Auto Select explanation. Verified accurate against
  `weighting.js` (hours-only weighting, recorded draws).

### 2.2 Terms of Service (registry v2.1, body says 2.0)

- **A** F-1 version mismatch.
- **B** Liability cap TODO unresolved — see §3.
- **B** No postal address — see §3, and the address is to be removed rather than filled.
- **J — keep:** §11 "What we do not limit at all", and the note for counsel kept in
  the published version. A published document that explains why its own liability
  section is deliberately weak than standard is unusual and is a credibility asset.
- **J — keep:** "There is no arbitration clause in these terms and no class-action
  waiver", including the reasoning.
- **J — keep:** §14's "Step 1 is not a precondition for anything that matters"
  paragraph listing 911, DCP&P, school, Consumer Affairs, AG, FTC. This is the
  paragraph that stops the dispute process reading as a gag.
- **H** Governing law / Middlesex County venue is consistent with a South Brunswick
  sole proprietor. Counsel confirmation is already flagged in the text.
- **I** "This section does not apply to users under 18" on indemnity — keep exactly.

### 2.3 Community Guidelines (registry v2.2, body says 2.1)

- **A** F-1 version mismatch.
- **A / C** "submit a report securely to our **moderation team**". There is no team.
  Contradicts the Privacy Policy's "Being one person is the honest answer" and the
  Youth Safety document's "it is one person".
- **C** Enforcement ladder step 3: "Suspension — you cannot sign in, **for a stated
  period**." Migration 006 adds `suspended_at`, `suspended_by`, `suspension_reason`
  and **no expiry column**; nothing expires a suspension. The appeals code and its
  comments state a suspension is permanent by default. There is no such thing as a
  suspension for a stated period.
- **C** Step 2: "A warning on your account." `warning_issued` exists only as a
  moderator *resolution label* (`moderation.js:224`). There is no warning state on
  an account and nothing displays one. Needs verification or softening.
- **E** F-2 "one business day" / "same day".
- **C / F-3** "Your appeal will be reviewed by a different administrator."
- **J — keep:** "You will not get in trouble for reporting something that turns out
  to be nothing — we would far rather look."
- **J — keep:** "We never tell the person you reported who reported them", plus the
  pointer to anonymous hotlines for readers who do not want the operator to know
  either. Verified: `reportService.js` sends nothing to the reported party at any
  priority.

### 2.4 Youth Safety Guidelines (v1.1, consistent)

- **C** F-5 "Reports are not triaged by software."
- **E** F-2 "reaches a human within one business day", gated on the unresolved
  monitored-hours TODO — which the document itself says gates it. Do not publish the
  promise with the blank, exactly as the TODO instructs.
- **C** Step 3 "suspending an organizer **permanently**" — accurate, since there is no
  expiry. Note this *contradicts* Community Guidelines' "for a stated period". Fix
  the Community Guidelines, not this.
- **H / I** Mandated-reporter framing: New Jersey's N.J.S.A. 9:6-8.10 is a
  universal-reporter statute — **any** person, not a defined class. The document
  states this correctly in three places. Counsel review is already flagged and should
  happen, but the statement itself is right and should not be softened.
- **J — keep:** "**The hotlines above are anonymous. A report inside the app is
  not.**" This is the most useful sentence in the document for a frightened student.
- **J — keep:** "**Emergencies** — call 911. Do not wait for us."

### 2.5 Organizer Agreement (v1.0)

- **A** No "Last updated" date line; add one matching `effectiveAt`.
- **J — keep:** the acknowledgement checklist, especially "I understand WeVolunteer
  has not run a background check on me" and "I will never be alone with a single
  student". Naming the absence of vetting inside the document the organizer signs is
  the strongest safety statement in the set.
- **F** Consider adding, as a matter of text only: what happens to the organizer's
  local copies of contact details when their account is suspended. The checklist
  covers deletion "when the event is over"; suspension mid-event is unaddressed.
- **I** Verified supported: organizers see applicant contact details only for their
  own events (`applicationRoutes.js` scoping, `messaging.applicantScope.test.js`).

### 2.6 Data Deletion Policy (registry v2.0, body says 1.0)

- **A** F-1 version mismatch.
- **J — keep:** the certificate carve-out. It is the one place a student is told
  before deciding that a certificate keeps their full name permanently, and the
  Privacy Policy correctly points here.
- **G** Cross-check: the 3-year shell purge, the attendance/certificate exception and
  the open-safety-report hold all match `retentionWorker.js`. Accurate.

### 2.7 Cookie and Tracking Notice (v1.0)

- **C** Archive URL TODO — see §3.
- **J — keep:** the CARTO disclosure. Verified against `app.js` CSP (`imgSrc`
  includes `https://*.basemaps.cartocdn.com`), and the claim that CARTO sees an IP
  but not identity is correct. Naming a third party that receives an IP address on a
  platform of minors, unprompted, is the transparency philosophy working.
- **J — keep:** the theme-preference explanation for the one first-party storage item.

### 2.8 Certificate Verification Policy (v1.0)

- **C** "public URL" TODO in the verification instructions — see §3.
- **B / I** Verified and worth stating plainly: codes are `crypto.randomBytes(5)` =
  **40 bits**. The document says so. 40 bits is fine against online guessing given
  the 20-per-15-minute limiter (`verifyLimiter`), and the document is honest about
  the mechanism. Keep. But note the verification response returns a **minor's full
  name** to anyone holding a code, forever, with no way to revoke — see §4.
- **J — keep:** the rate-limit wording "This is not a verdict on the certificate",
  which is also implemented (`app.js` `verifyLimiter` handler).

### 2.9 Volunteer Record Policy (v1.0)

- **E** "We respond within **5 business days**" — tighter than the 10 business days
  promised everywhere else, for the same one person. Either align to 10 or explain
  why records are faster. Inconsistent SLAs across documents are the easiest thing
  for a complainant to point at.
- **J — keep:** the correction process. It matches the actual mechanism (hours are
  derived, corrections are ledger entries) and does not overpromise self-service.

### 2.10 Admin Responsibilities Policy (v1.0)

- **A** No version line and no date line at all. Add both.
- Three TODOs — approver, register location, review cadence. See §3.
- **J — keep:** "I understand New Jersey law requires **me personally** to report
  suspected child abuse". Personal, not institutional, and that is the correct
  framing under a universal-reporter statute.
- **F** The audit log is swept at 1 year (`RETENTION.auditDays`) while this document
  promises access is "logged and reviewed". A one-year window is short relative to
  how late misuse surfaces, and the document does not disclose the period. Either
  disclose it here or lengthen it. The Privacy Policy does disclose it; this one
  should not be silent where the Privacy Policy is explicit.

---

## 3. TODO resolution

Classification: **(1)** completable now · **(2)** owner decision · **(3)** legal review ·
**(4)** technical verification.

### T-1 Postal address (ToS §17) — **REMOVE, do not fill**

**Class: (2) owner decision, with a clear recommendation.**

Do not publish a home address. A sole proprietor operating a platform for minors
who prints a residential address has published the home address of the person who
suspends accounts and reads safety reports, to the people they suspend. That is a
foreseeable personal-safety risk and it is not mitigated by any drafting.

**Recommended replacement text:**

> **CURRENT:**
> `[[TODO: postal address — required on a published ToS and for regulator and legal correspondence. Owner to supply the address to print; a home address may not be the right answer, so this may need a mail-forwarding or registered-agent decision first.]]`
>
> **RECOMMENDED:**
> `**wevolunteer.platform@gmail.com**, which is read by the operator personally.`
> `For legal or regulatory correspondence that must be served on paper, email that address and we will provide a postal address for service. We do not publish one here: WeVolunteer is operated by one individual rather than a company, and the only postal address available is a residential one.`
>
> **REASON:** A published ToS does not legally require a postal address for a US sole
> proprietor operating a free website. What matters is that service of process is
> *achievable*, and an email address that produces one on request achieves it. The
> sentence explaining the omission is worth more than the omission is worth hiding —
> it is consistent with the document's philosophy and pre-empts the obvious
> criticism.

**The durable fix is a mailbox, not wording.** Recommend, in order: a New Jersey
commercial mail-receiving agency (CMRA) box (~$150–300/yr, gives a street address);
or forming an LLC with a registered agent, which supplies a public business address
and separates personal liability — which the operator should be considering anyway
(§4). Until one exists, the wording above is the honest interim.

### T-2 Liability cap (ToS §11) — **$100**

**Class: (2) owner decision + (3) legal review to confirm.**

**Recommended text:** `**one hundred US dollars ($100)**`

**Reason.** The service is free, so "fees paid" resolves to zero, and a
zero-recovery cap in a contract with minors is the kind of term a New Jersey court
is most likely to find unconscionable and strike — leaving no cap at all. A small
real number is more likely to survive than an aggressive one, which is the drafting
note already in the document. $100 is a recognisable nominal figure.

This does **not** meaningfully cap real exposure, and the document should not
pretend otherwise — the carve-outs in "What we do not limit at all" are where the
actual exposure lives, and that exposure is an insurance question (§4). Counsel
should confirm the figure before publication, but the section is publishable with
$100 and a counsel note in a way it is not publishable with a blank.

### T-3 Policy archive URL (Privacy, ToS, Cookie — one shared answer) — **blocked**

**Class: (2) owner decision.** Depends on the production domain, which is
unresolved (see also the deployment blockers in the production readiness audit).

Three documents promise superseded versions stay readable. That promise is
currently unkeepable. Two options:

- **(a) Preferred — a stable path on the production domain**, e.g.
  `https://<domain>/legal/archive`. Requires the domain decision and a place to put
  superseded Markdown. Note the platform does not currently serve superseded
  versions: `LEGAL_DOCUMENTS` holds only the current entry per slug, so an archive
  is new work, not a link.
- **(b) The public git history.** Every version is already immutably recorded with a
  content hash. Link the repository path. Honest, zero new work, and arguably
  stronger evidence than a web page. Weaker for a non-technical parent.

**Recommended interim wording that is keepable today**, replacing all three TODOs
identically:

> `Superseded versions are kept. Until a public archive page exists, ask us at **wevolunteer.platform@gmail.com** for any previous version and the date it applied, and we will send it. Each version is recorded with a content fingerprint so the copy you receive can be checked against the one your account accepted.`

That is true now, uses a mechanism that exists (`contentHash`), and does not promise
a URL that does not resolve.

### T-4 Email-sending provider (Privacy §Other companies) — **technical, then publish**

**Class: (4) technical verification.** The name is whatever `SMTP_HOST` is set to in
production, and production is not deployed. Cannot be answered from the repo.

**Question for the owner in §5 (Q-1).** Do not publish the row until it is answered
— the document's own note is right that a named subprocessor list is the point of
the table. If Gmail/Google Workspace SMTP is used, the row becomes "Google", which
also merges with the existing Google row and should say so.

### T-5 Hosting provider (Privacy §Other companies) — **technical, then publish**

**Class: (4) technical verification.** Same reasoning. Must also state whether data
stays in the United States — which matters more than the vendor name for a platform
of minors. **Q-2.**

### T-6 Safety-report retention period (Privacy) — **needs legal review**

**Class: (3) legal review.** The document is already honest that "indefinitely" is a
description, not a decision. The right period is tied to how long someone who was a
minor at the time may bring a claim in New Jersey, which is long — and for
child-sexual-abuse claims New Jersey's 2019 revival statute (N.J.S.A. 2A:14-2a/2b)
extends limitations dramatically. **A short retention period here would destroy
exactly the evidence that protects both the reporting student and the operator.**

**Recommendation: do not set a short period. Publish a reasoned floor instead.**

> `We keep a safety report and the messages saved with it for **at least 7 years, and until the reporting student turns 25, whichever is later.** New Jersey gives someone who was a minor at the time a long window to bring a claim, and a report deleted before that window closes would destroy the record that protects the student who filed it at least as much as it protects us. After that point we will review whether a report can be removed; we will not delete one while any dispute, appeal, or investigation about it is open.`

Counsel must confirm the figures. But this converts "indefinitely, and we know that
is not a real answer" into a defensible published period with a stated reason, which
is what a regulator asks for.

### T-7 Monitored hours for the safety inbox (Youth Safety) — **owner decision, blocking**

**Class: (2) owner decision.** This gates the "one business day" promise and the
document says so. See E-1 in §7 for wording that is keepable by one person.

### T-8 Admin approver / register location / review cadence (Admin Responsibilities) — **completable**

**Class: (1) completable now**, given the operator is the sole administrator.

- **Approver:** `the operator (Mahit Pulavarthi), who is currently the only person able to grant an administrator account`
- **Register location:** recommend the truthful mechanical answer — the register *is*
  the `users` table plus `user_capabilities`, readable by any holder of
  `audit.read`. Say that rather than inventing a spreadsheet.
- **Review cadence:** the document already recommends quarterly. Adopt it, and add
  the honest caveat that with one administrator the review is self-review — which is
  a real limitation and should be printed, not hidden.

### T-9 Counsel confirmation of no-arbitration / NJ venue (ToS §14–15) — **legal review**

**Class: (3).** The choice is well-reasoned and should be kept. The bracketed
instruction to counsel should be **removed from the published text** before
publication (it is an internal note, unlike the §11 counsel note which is
deliberately public and should stay). Track it outside the document.

---

## 4. Operator risk review

The operator is one individual, personally liable, in New Jersey.

| Exposure | Rating | Why |
|---|---|---|
| **Safety-reporting** | **HIGH** | F-2: the only alert on an urgent report is defeatable by a preference toggle. F-3: appeals are undecidable with one administrator. Both are published promises the software cannot currently keep, on the subject where failure is least forgivable. |
| **Legal / liability** | **HIGH** | Sole proprietor = unlimited personal liability. The liability section is deliberately weak (correctly), and the carve-outs for personal injury and gross negligence are exactly the claims a child-safety incident produces. Mitigation is insurance and an entity, not drafting. |
| **Retention** | **HIGH** | Indefinite retention of minors' safety reports and permanently verifiable certificates bearing minors' full names, with no revocation path, held by one person with no stated end date. This is the most likely subject of a regulator question. |
| **Certificate verification** | **MEDIUM-HIGH** | A 40-bit code returns a minor's full name to any holder, forever. The design is sound and honestly documented, and the rate limit is real — but there is no revocation, and the Privacy Policy has to tell students their name is on it permanently. |
| **Privacy** | **MEDIUM** | Genuinely strong: no ads, no analytics, no tracking cookies, private by default, opt-in leaderboard, server-side redaction before error storage, step-up auth on sensitive actions. Two gaps: the unenforced applications period (F-4) and two unnamed subprocessors. |
| **Data breach** | **MEDIUM** | Single SQLite file, single host, one operator. NJ breach notification duties fall on that person personally. Backups exist and restore is rehearsable, but breach *detection* depends on the same alerting as F-2. |
| **Organizer misuse** | **MEDIUM** | Contact details are correctly scoped per event and the agreement is explicit that no background check was run. Residual risk is inherent to the model and is disclosed rather than hidden — which is the right handling, but it is still the largest real-world harm channel. |

**Practical next steps, in order:**

1. Fix F-2 (one line in `MANDATORY_NOTICE_EVENTS`). Cheapest, highest-value.
2. Recruit a second administrator, or publish what happens without one (F-3).
3. Form a **New Jersey LLC**. Separates personal assets, supplies a business
   address (T-1), and the Privacy Policy is already written so the operator block is
   the only place that changes.
4. Get **insurance** — general liability plus cyber/privacy. The ToS's own counsel
   note says exposure "is a matter of insurance, not drafting", and it is right.
5. Engage counsel for the four flagged items (T-2, T-6, T-9, breach ordering). One
   focused review, not an open engagement.
6. Resolve T-4/T-5 as part of deployment, not as a separate task.

---

## 5. Questions for the owner

### A. Required before publication

**Q-1 — Which service sends production email?**
*Why it matters:* the Privacy Policy publishes a complete subprocessor table and one
row is a placeholder. A named list is the point of the table.
*Affected:* Privacy Policy §Other companies involved (T-4).
*Recommended answer:* Google Workspace / Gmail SMTP, which you already use for
`wevolunteer.platform@gmail.com`. Then the row merges into the existing Google row
and the table shrinks rather than grows.
*Tradeoffs:* Gmail SMTP has sending limits that a whole school's signup day could
hit, and the address is a consumer Gmail account. A transactional provider
(Postmark, SES) is more reliable but is one more named subprocessor and one more
contract. Reliability matters here because verification email *is* the login path.

**Q-2 — Who hosts production, and does the data stay in the United States?**
*Why it matters:* it is the company that physically holds minors' records. The US
question is more important than the vendor name.
*Affected:* Privacy Policy §Other companies involved (T-5).
*Recommended answer:* a US-region VPS from a named provider, with the region stated
in the policy.
*Tradeoffs:* naming a provider means updating the policy if you migrate — a MINOR
bump. That is the cost of an accurate table and it is worth paying.

**Q-3 — What hours can one person actually commit to reading the safety inbox?**
*Why it matters:* it gates the "one business day" promise in two documents, and an
unkeepable safety SLA is worse than a modest one.
*Affected:* Youth Safety (T-7), Community Guidelines response times.
*Recommended answer:* something like "most evenings and weekends, usually within 24
hours on weekdays" — with the 911/1-877-NJ-ABUSE/988 routing stated immediately
after, as it already is.
*Tradeoffs:* a vaguer commitment reads as less professional but is keepable. A
precise one you miss once, in a safety context, is the thing that gets quoted.

**Q-4 — Will a second administrator exist before launch?**
*Why it matters:* F-3. Without one, no appeal against a suspension you issued can
ever be decided, and the Community Guidelines promise a review.
*Affected:* Community Guidelines appeals paragraph, Youth Safety step 3, Admin
Responsibilities.
*Recommended answer:* yes — recruit one trusted adult before launch.
*Tradeoffs:* a second administrator sees students' private messages and contact
details, so this widens access. If the answer is no, the documents must say that an
appeal may be referred outside the platform, and the code should stop offering an
appeal it cannot decide.

**Q-5 — Applications retention: implement or correct?**
*Why it matters:* F-4, a published period nothing enforces.
*Affected:* Privacy Policy retention table.
*Recommended answer:* implement the sweep. The period is already published and
reasonable, and the sweep is a small addition to a worker that already exists and is
tested.
*Tradeoffs:* implementing costs a change to retention code and tests. Correcting the
text costs nothing but removes a privacy protection you had told students they had.

### B. Recommended before launch

**Q-6 — Will you form an LLC?** Resolves T-1 (business address), caps personal
liability, and changes one block in the Privacy Policy by design. Recommended: yes,
before any real student data exists. Tradeoff: a few hundred dollars and an annual
filing.

**Q-7 — Will you carry insurance?** Recommended: general liability + cyber. The ToS
already says exposure is an insurance matter. Tradeoff: cost, against the only real
mitigation for the risks the ToS correctly refuses to disclaim.

**Q-8 — Is counsel engaged?** The Privacy Policy currently asserts "we are taking
legal advice" about safety-report retention. If nobody is engaged, that sentence is
false and must change either by engaging someone or by rewording. Recommended:
engage for one focused review covering T-2, T-6, T-9 and the breach-notification
ordering.

**Q-9 — Does "a warning on your account" exist?** Community Guidelines step 2 implies
a warning state. I found only a moderator resolution label. Recommended answer:
soften the text to "we tell you what was wrong and that it must not happen again"
unless you intend to build a warning record.

### C. Future decisions

**Q-10 — Certificate revocation.** The Privacy Policy says you "are building" an
option to void certificates on deletion. Do you intend to? If not, change the
wording now. If yes, it is the single most meaningful privacy improvement available,
because it is the only permanent, unrevocable publication of a minor's name in the
system.

**Q-11 — The safety-report retention floor.** T-6 recommends "at least 7 years, and
until the reporting student turns 25". Confirm with counsel and publish it, replacing
"indefinitely".

**Q-12 — Suspension durations.** Community Guidelines promise suspension "for a
stated period" and no such feature exists. Either build durations or correct the
text. Recommended: correct the text now; durations are a real feature worth having
later.

---

## 6. Prioritised action plan

### BLOCKING BEFORE PUBLICATION

| # | Action | Urgency | Risk if ignored | Owner decision |
|---|---|---|---|---|
| 1 | **Add `SYSTEM_ALERT` to `MANDATORY_NOTICE_EVENTS`** (F-2) | Immediate | A child-safety report notifies nobody because of a preference toggle, while two documents promise one business day | None needed — this is a defect |
| 2 | **Fix the four version strings + add missing version/date lines** (F-1) | Immediate | Two different version numbers on one page; acceptance records point at a version the page contradicts | None — MINOR labelling fix |
| 3 | **Resolve or remove the "one business day" promise** (Q-3, T-7) | Immediate | Unkeepable safety SLA, in writing, by a sole operator | Q-3 |
| 4 | **Answer Q-1 and Q-2** (subprocessor names) | Immediate | Privacy Policy publishes with placeholders; the table's whole value is that it is complete | Q-1, Q-2 |
| 5 | **Set the liability cap to $100** (T-2) | Immediate | Blank cap in a published contract | Q — confirm $100 |
| 6 | **Replace the postal-address TODO with the §3 wording** (T-1) | Immediate | Either a blank in a published ToS, or a home address published to people you suspend | Confirmed: do not publish a home address |
| 7 | **Fix "moderation team", "for a stated period", "not triaged by software"** (F-5, §2.3) | Immediate | Three false statements of fact, each independently checkable | None — corrections |
| 8 | **Resolve applications retention** (F-4) | Immediate | A published retention period nothing enforces, in a table that claims all of them are enforced | Q-5 |
| 9 | **Replace the archive-URL TODOs with the keepable wording** (T-3) | Immediate | Three documents promise an archive that does not exist | Q — accept interim wording |

### SHOULD FIX BEFORE LAUNCH

| # | Action | Urgency | Risk if ignored | Owner decision |
|---|---|---|---|---|
| 10 | **Second administrator, or publish what happens without one** (F-3) | High | Appeals are structurally undecidable; a suspended student is promised a review that cannot occur | Q-4 |
| 11 | **Add the version/date consistency test** to `legalDocuments.test.js` (F-1) | High | F-1 recurs on the next bump; nothing currently catches it | None |
| 12 | **Reword "we are building" certificate voiding, and "we are taking legal advice"** | High | Two statements of fact that may not be true | Q-8, Q-10 |
| 13 | **Publish a safety-report retention floor** (T-6) | High | Indefinite retention of minors' safety records with no stated end | Q-11 + counsel |
| 14 | **Align the 5-vs-10 business day SLAs** (§2.9) | Medium | Inconsistent promises across documents for the same one person | Owner: pick 10 |
| 15 | **Complete the three Admin Responsibilities TODOs** (T-8) | Medium | Three blanks in the document that governs access to minors' records | None — §3 supplies wording |
| 16 | **Form an LLC; obtain insurance** (Q-6, Q-7) | High | Unlimited personal liability on a platform for minors | Q-6, Q-7 |
| 17 | **Remove the internal counsel bracket from ToS §14** (T-9) | Medium | An internal instruction published to users | None |

### CAN WAIT UNTIL LATER

| # | Action | Reason it can wait |
|---|---|---|
| 18 | Certificate revocation feature (Q-10) | Real improvement, but the policy is currently honest that it does not exist |
| 19 | Suspension durations (Q-12) | Correcting the text removes the inaccuracy now; the feature is a nice-to-have |
| 20 | Organizer-suspension handling of local contact copies (§2.5) | Narrow gap; the agreement already covers the normal case |
| 21 | Lengthen or disclose the 1-year audit-log period in Admin Responsibilities (§2.10) | The Privacy Policy already discloses it; this is a consistency improvement |
| 22 | Public archive page (T-3 option a) | The interim wording is keepable and honest |

---

## 7. What is safe to apply right now, without any owner answer

Items 1, 2, 7, 11, 17 and the T-8 wording need no decision from anyone — they
correct false or contradictory statements, or add a guard. Applying them requires
running `node bin/migration-checksums.mjs`'s sibling, `node bin/legal-hashes.mjs`,
updating the `contentHash` values in `server/legalDocuments.js`, and classifying each
document's bump as **MINOR** (clarification, notice only — no re-consent), because
none of them changes a reader's rights or obligations.

Items 3, 4, 5, 6, 8, 9 change published commitments or supply facts only the owner
has, and should not be applied on anyone else's judgement.
