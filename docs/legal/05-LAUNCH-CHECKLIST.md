# Legal launch checklist

Complements [`../PILOT_READINESS_CHECKLIST.md`](../PILOT_READINESS_CHECKLIST.md), which covers
technical deployment readiness. This one covers legal, policy, and safety readiness. **Both
must pass** before a real student uses the platform.

Ordered so that each phase unblocks the next. Phase 0 blocks everything.

---

## Phase 0 — Decisions only you can make

Nothing below can be completed while any of these is open.

| # | Decision | Blocks | Recommendation | Done |
|---|---|---|---|---|
| 1 | **Posture A (district vendor) or B (independent)?** | Everything | A for the pilot; write documents to switch | ☐ |
| 2 | **Minimum age. Is `'N/A'` grade self-selectable?** | Age gate, Privacy Policy, COPPA | 13+ hard floor; `'N/A'` not self-selectable | ☐ |
| 3 | **May organizers message students who haven't applied?** | Youth Safety, Organizer Agreement, code | No | ☐ |
| 4 | **Which SMTP provider?** | Subprocessor list, DPA | — | ☐ |
| 5 | **Retention period for inactive accounts?** | Privacy Policy, COPPA §312.10 | 3 years inactive → purge | ☐ |
| 6 | **How long do certificates stay verifiable?** | Certificate Policy, R-02 | 7 years, then purge | ☐ |
| 7 | **Legal entity behind WeVolunteer?** | ToS — you cannot publish one without a legal person to be a party to it | Form an entity before any district signs | ☐ |
| 8 | **Governing law and venue?** | ToS | New Jersey | ☐ |
| 9 | **Named privacy contact, and who monitors it?** | Every document | — | ☐ |
| 5a | **The four `PRIVACY_*` values**, once 5 and 9 are answered: `PRIVACY_CONTACT`, `PRIVACY_RETENTION`, `PRIVACY_UNDER13`, `PRIVACY_OWNER` | The built-in privacy notice — `privacyNoticeComplete()` is false until all four are set, and the page says it is incomplete | Set them as `VITE_*` build variables; the code will not invent them | ☐ |
| 10 | **Do guardians get accounts, or act through the district?** | Guardian access design | Through the district in A | ☐ |

---

## Phase 1 — Launch blockers

### Legal documents

> **Audited 2026-09-27**, the same way the code column was. Four of these were
> already true. The two that look like placeholder checks were false alarms
> resolved by reading context — both surviving `[[…]]` strings are historical
> notes ABOVE the `## Draft` marker, describing markers that were removed, and a
> reader never sees them. What is left is the attorney work and one deferral.

| Item | Ref | Evidence | Done |
|---|---|---|---|
| Privacy Policy finalised, all `[[BRACKETS]]` filled | [policy 1](policies/01-privacy-policy.md) | Zero unresolved placeholders in any published body across all 13 documents | ☑ |
| **Terms of Service drafted by an attorney** — not merely reviewed | [policy 2](policies/02-terms-of-service.md) | Not verifiable from the repository, and not an engineering task | ☐ |
| Data Deletion Policy matches actual behaviour | [policy 4](policies/04-data-deletion-policy.md) | Every concrete claim checked against code: messages 3y, audit logs 1y, anonymised shells 3y, applications 3y after the EVENT (`retentionWorker.js` `RETENTION`), hours and certificates indefinite (`PRESERVED_TABLES`), exports 7d (`cleanupExpiredExports`), and the certificate name snapshot. All match | ☑ |
| Youth Safety Guidelines published | [policy 8](policies/08-youth-safety-guidelines.md) | `GET /api/legal/documents/youth-safety-guidelines` → 200, 12,738 bytes, unauthenticated | ☑ |
| Organizer Agreement published **and acceptance recorded in the database** | [policy 9](policies/09-organizer-agreement.md) | Published: 200, 8,764 bytes. Acceptance: the mechanism is built and tested (19 cases) and writes to `legal_acceptances`. **Zero rows today because production has no organizer accounts** — 2 students, 2 super_admins. Not a gap; an empty set. It becomes true the first time an organizer onboards, and capabilities stay withheld until then | ☑ |
| Every `[[BRACKETED]]` value in every published document resolved | — | Two `[[…]]` strings remain, both in explanatory notes above the `## Draft` marker in policies 4 and 6, describing markers already removed. Not published, not hashed, not seen by a reader | ☑ |
| Attorney sign-off on the seven items in the brief | [brief](00-COMPLIANCE-AND-RISK.md#where-outside-counsel-is-genuinely-required) — plus the three questions in [14-COUNSEL-BRIEF](14-COUNSEL-BRIEF-BREACH-AND-REPORTING.md), which is written to make the engagement short: statutes quoted from primary sources, facts checked against the schema, and Q1 (does encryption take the users table outside N.J.S.A. 56:8-161) is the one that decides whether a statutory duty exists at all | ☐ |
| **~~Cookie Notice~~ DONE 2026-09-28 (migration 070).** It had claimed "we do not ask you to turn it on, there is no pop-up" — false the moment the consent prompt shipped. Corrected, re-hashed and republished; nobody had ever accepted it, so the repair cost no consent record. **Privacy Policy still open below.** | [notice 5](policies/05-cookie-and-tracking-notice.md) | ☑ |
| **Privacy Policy: "we never prompt you to" is now false** (~line 189), same defect as the Cookie Notice. **Cannot be repaired the same way:** this document has an acceptance row and it belongs to a student who agreed to it on 2026-09-14. Migration 070 refuses to clear any version with an acceptance, and `syncLegalDocuments` blocks the boot rather than republishing over it — verified by planting an acceptance row and watching it refuse. The replacement wording is written and staged above the `## Draft` marker, where it is unhashed and unpublished. Apply at launch in the same pass as the CARTO passage, when the reset makes it free | [policy 1](policies/01-privacy-policy.md) | ☐ |
| **Privacy Policy: remove the CARTO passage** — it says map images load in the reader's browser directly from CARTO, which can therefore see their IP address. Untrue since the tile proxy shipped; the Cookie Notice was corrected on 2026-09-27 and this was deliberately left, so the two published documents currently disagree. Deferred because it is the one drifted document with an acceptance row, and repairing 1.0 under an acceptance is a decision about a consent record. At launch the reset makes it free. | [policy 1 §third parties](policies/01-privacy-policy.md) | ☐ |

### Code changes the documents depend on

> **Audited line by line on 2026-09-27, and this column was badly out of date.**
> Five of the eight were already built and tested; three were finished that day;
> one was never a code task. Every ☑ below names the test that proves it, so the
> claim can be rechecked rather than believed. The lesson for the rest of this
> file: a checklist that understates completion costs as much as one that
> overstates it — somebody rebuilds finished work at the worst moment.

| Change | Finding | Evidence | Done |
|---|---|---|---|
| Age gate at signup; under-13 hard block; `'N/A'` not self-selectable | R-01 | `server/ageGate.test.js` — 18 cases, incl. "REFUSES an under-13 applicant", "cannot be bypassed by claiming an Adult grade", and the OAuth path. `MINIMUM_AGE = 13` in `accountValidation.js` | ☑ |
| Certificate handling at deletion fixed **or** disclosed precisely | R-02 | Disclosed, 2026-09-27. Deletion snapshots the volunteer's real name onto certificates and keeps them; the dialog now says so instead of "may be preserved" | ☑ |
| Organizer→student messaging constrained to applicants | R-03 | `server/messaging.friends.test.js` — "an organizer cannot reach an arbitrary student through the peer endpoint", alongside "organizer → student on their own event still works" | ☑ |
| `organizer_agreements` table; `organizer.approve` gated on acceptance | R-04 | **Built differently and better.** No separate table: acceptance is a row in `legal_acceptances`, matched on `(slug, version)` so any version bump re-gates. `organizerAgreement.js` withholds 8 capabilities — `event.create`, `applicant.review`, `attendance.*`, `announcement.post` — until accepted. `server/routes.organizerAgreement.test.js`, 19 cases, incl. "sees no applicants at all — the finding this exists for" | ☑ |
| `PRIVACY_URL` defaults to `/privacy` so consent always renders | UX §1 | `src/config.js` — defaults to `/legal/privacy-policy` (hash-verified, versioned); `/privacy` still redirects there | ☑ |
| `PRIVACY_CONTACT`, `PRIVACY_RETENTION`, `PRIVACY_UNDER13`, `PRIVACY_OWNER` set — `privacyNoticeComplete()` returns true | R-05, R-09 | **Not a code task — moved to Phase 0.** The code is finished and deliberately refuses to supply these: how long a district keeps student records, who a family contacts, and what consent applies below 13 are decisions a district is accountable for, and a plausible default would manufacture the appearance of a reviewed policy. They are empty, the page says loudly that it is incomplete, and `privacyNoticeComplete()` stays false until a human fills them in. **Blocked on Phase 0 decisions 5 and 9.** | ☐ |
| Auto Select disclosed at the application form and on decline | R-06 | Apply surface: `EventDetailsExperience.jsx`. Decision surface added 2026-09-27 — acceptance and waitlisting from the draw now say a machine decided. **"On decline" deliberately not done:** Auto Select never rejects, it waitlists, because "the organizer did not reject them"; naming it on a decline would blame a machine for a human refusal. `server/autoSelectDisclosure.test.js` pins both halves | ☑ |
| Deletion copy replaces "may be preserved" | R-02 | `DeleteAccountModal.jsx` — now states that certificates keep your name and nothing else does, matching what the Data Deletion Policy already said | ☑ |

### Operational

| Item | Ref | Done |
|---|---|---|
> **Audited 2026-09-27.** This column is mostly genuine — unlike the code column,
> little of it turned out to be secretly finished. Three items have no document
> at all, one has a document that has drifted out of date, and two are half true.
> Two findings below are new and are not on any list.

| Item | Ref | Evidence | Done |
|---|---|---|---|
| Privacy contact inbox exists, monitored, with a named owner | DECISION 9 | `privacy@wevolunteers.org` is defined in `emailIdentity.js` and named 15 times across the published policies, and the domain has Cloudflare MX records so mail is accepted. **Monitored, by a named person — unverified and not checkable from here.** That half is DECISION 9 | ☐ |
| Safety inbox exists, monitored, with a stated response window | policy 8 | `security@wevolunteers.org` exists and policy 8 names it. **No stated window:** the published text says reports are reviewed "as soon as", where the Privacy Policy commits to 10 business days and 45 days. A safety inbox with a vaguer commitment than the privacy one is the wrong way round | ☐ |
| **Breach response runbook written**, including the NJ State Police-first step | R-07 | [`docs/operations/breach-response.md`](../operations/breach-response.md) — **drafted 2026-09-27**. Sequencing fixed (contain → assess → NJ State Police → district → individuals), containment and evidence-preservation steps, the five assessment answers, and the data inventory. Notification templates drafted 2026-09-28 — [`breach-notification-templates.md`](../operations/breach-notification-templates.md), four of them plus a pre-send checklist. **Decision-maker named 2026-09-28: Mahit Pulavarthi** (§3). **Statutory basis verified 2026-09-28** against N.J.S.A. 56:8-161/163 as amended by P.L. 2019 c.95, replacing a second-hand reading — see §0: element (4) of "personal information" reaches the users table, the statute prescribes NO notice content, and FERPA/COPPA add no notification duty. **Rehearsal (assessment half) walked 2026-09-28** — [record](../operations/breach-rehearsal-2026-09-28.md); it found three defects in the runbook, all fixed. Contact number added. **Deputy declined 2026-09-28** — one administrator, so a deputy would be a name with no role; accepted risk, revisit when a second exists. **Still open:** one narrow counsel question, written up as Q1 of [14-COUNSEL-BRIEF](14-COUNSEL-BRIEF-BREACH-AND-REPORTING.md) (does the encryption carve-out take the users table outside the definition — and it answers differently for a host compromise), and containment (§2.1) has still never been executed | ☐ |
| Mandated-reporter procedure written and every admin briefed | R-03 | [`docs/operations/mandated-reporter-procedure.md`](../operations/mandated-reporter-procedure.md) — **drafted 2026-09-27**. The duty is personal and immediate, the hotline is first, preserve-don't-investigate, protect-after-reporting, and a trigger list. **Citations VERIFIED 2026-09-28** against primary sources: N.J.S.A. 9:6-8.10 is universal ("any person", "immediately", by telephone to DCP&P) exactly as claimed; added 9:6-8.13 (civil AND criminal immunity for good-faith reports) and 9:6-8.14 (failure to report = disorderly persons offence; failure to report SEXUAL abuse = fourth-degree crime, raised by P.L. 2019 c.40); hotline and TTY confirmed against nj.gov. **Briefing register dated 2026-09-28** for the only administrator, on his own confirmation that he has read §2 and §3 in full — which is what a briefing register records. **Still open:** counsel on the "reasonable cause" threshold only (Q3 of the counsel brief), and a standing rule that each new admin is briefed *before* their account is created | ☐ |
| Admin roster documented; every admin has accepted policy 10 | R-11 | `docs/operations/administrator-register.md` **exists but has drifted.** It records one account and says "Sole administrator at launch"; production holds **two** `super_admin` accounts. **Zero acceptances of policy 10.** The register is named in a published policy that tells admins "if you are not on it, you should not have the access", so the drift is a broken commitment rather than untidiness | ☐ |
| Report triage: who looks, how fast, what gets escalated | R-10 | [`docs/operations/report-triage.md`](../operations/report-triage.md) — **drafted 2026-09-27**. The three queues and which is which, response targets sized for one administrator, the escalation table, and the appeal obligation. **Owner named 2026-09-28: Mahit Pulavarthi**, deliberately the same person as the breach decision-maker so a report that becomes an incident does not change hands. **Still open:** no deputy, the same-day target is unmeasured so must not be published in policy 8 yet, and the dismissed-report retention question in §7 needs an owner decision | ☐ |
| **Posture A:** DPA signed before any student data is loaded | — | ☐ |
| **Posture A:** listed on the district's vendor register | — | ☐ |

#### Two findings from the 2026-09-27 audit that were on no list

| Finding | Detail | Done |
|---|---|---|
| **A dormant `super_admin` nobody registered** | `owner_wevolunteerplatfor`, seeded alongside `mahit` on 2026-09-08, holds full platform privileges, has **never signed in**, has no second factor of any kind, and is not in the administrator register. It is not an open door — `REQUIRE_ADMIN_2FA` defaults to ENABLED when unset, which is how production runs, so it cannot sign in without enrolling one. But a privileged account nobody has listed or used is exactly what the register exists to surface. Decide whether it is needed; remove it or register it | ☐ |
| **~~Neither~~ ONE administrator has not accepted policy 10** | Verified in production 2026-09-28: `mahit` **accepted** it; `owner_wevolunteerplatfor` has not — and has never signed in, so it cannot, which makes this the same finding as the dormant-account row above rather than a second one. Resolving that account resolves this. | R-11 | ☐ |

---

## Phase 2 — First 90 days

| Item | Ref | Done |
|---|---|---|
| Community Guidelines published | [policy 3](policies/03-community-guidelines.md) | ☐ |
| Cookie and Tracking Notice published | [policy 5](policies/05-cookie-and-tracking-notice.md) | ☐ |
| Certificate Verification Policy published | [policy 6](policies/06-certificate-verification-policy.md) | ☐ |
| Volunteer Record Policy published | [policy 7](policies/07-volunteer-record-policy.md) | ☐ |
| Admin Responsibilities Policy published | [policy 10](policies/10-admin-responsibilities-policy.md) | ☐ |
| Legal hub at `/legal` shipped | [design](02-DESIGN-SYSTEM.md) | ☐ |
| **A11Y-1: `--input-border` contrast fix** — a real WCAG AA failure | [a11y](03-ACCESSIBILITY-REPORT.md) | ☐ |
| Map tiles: click-to-load, then proxy server-side | R-18 | ☐ |
| SMTP provider DPA signed | R-08 | ☐ |
| Analytics small-cell suppression (n<5) | R-13 | ☐ |
| Error-redaction regression test | R-14 | ☐ |
| Geocoder input test — only event locations | R-08 | ☐ |
| `localStorage` cache reviewed against shared-device use | R-19 | ☐ |
| Policy version archive at a stable URL | all | ☐ |

---

## Phase 3 — Before scale, and dated obligations

| Item | Deadline | Done |
|---|---|---|
| VoiceOver + NVDA testing on all six legal pages | before a conformance claim | ☐ |
| Keyboard-only and 400% zoom passes | same | ☐ |
| **WCAG 2.1 AA conformance statement / VPAT** — only after real AT testing | **2027-04-26** (district ≥50k) · **2028-04-26** (smaller) | ☐ |
| Quarterly admin access review established | ongoing | ☐ |
| Annual policy review scheduled | ongoing | ☐ |
| Impersonation policy **written before any impersonation code ships** | before v2.0 | ☐ |
| Re-assess NJDPA thresholds (100k NJ consumers / 25k + sale) | annually | ☐ |
| Breach runbook rehearsed once | within 6 months | ☐ |

---

## The publication gate

**A document does not go live while it contains a `[[BRACKETED]]` value.**

This is the same rule `src/config.js` already enforces in code, for the reason stated there:
placeholder legal text is worse than no legal text, because it manufactures the appearance of a
reviewed policy. `privacyNoticeComplete()` is that rule expressed as a function. Extend the same
gate to every document rather than trusting a manual check.

Suggested: a build-time test that fails if any file in `docs/legal/policies/` marked
`status: published` contains `[[`.

---

## What "done" looks like

You are ready to put a real fourteen-year-old on this platform when:

1. A student can find out **what you know about them** in under a minute, from any page.
2. A parent can find **a person to email** in under a minute, and gets a reply within 10
   business days.
3. Every adult with access to a minor's contact details has **signed something** saying what
   they may do with it.
4. An administrator who reads a disturbing message **knows exactly what to do**, without asking.
5. A student who deletes their account **is not surprised** by anything afterwards.
6. Nothing you have published is untrue about the code, and nothing the code does is
   undisclosed.

Item 6 is the one worth re-reading. It is the standard the existing privacy notice already
holds itself to, and the reason this engagement found real issues — the CARTO tile CDN (R-18)
surfaced only because a draft sentence was checked against the source rather than assumed.
