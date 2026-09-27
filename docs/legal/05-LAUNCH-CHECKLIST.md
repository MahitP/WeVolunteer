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

| Item | Ref | Done |
|---|---|---|
| Privacy Policy finalised, all `[[BRACKETS]]` filled | [policy 1](policies/01-privacy-policy.md) | ☐ |
| **Terms of Service drafted by an attorney** — not merely reviewed | [policy 2](policies/02-terms-of-service.md) | ☐ |
| Data Deletion Policy matches actual behaviour | [policy 4](policies/04-data-deletion-policy.md) | ☐ |
| Youth Safety Guidelines published | [policy 8](policies/08-youth-safety-guidelines.md) | ☐ |
| Organizer Agreement published **and acceptance recorded in the database** | [policy 9](policies/09-organizer-agreement.md) | ☐ |
| Every `[[BRACKETED]]` value in every published document resolved | — | ☐ |
| Attorney sign-off on the seven items in the brief | [brief](00-COMPLIANCE-AND-RISK.md#where-outside-counsel-is-genuinely-required) | ☐ |
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
| Privacy contact inbox exists, monitored, with a named owner | DECISION 9 | ☐ |
| Safety inbox exists, monitored, with a stated response window | policy 8 | ☐ |
| **Breach response runbook written**, including the NJ State Police-first step | R-07 | ☐ |
| Mandated-reporter procedure written and every admin briefed | R-03 | ☐ |
| Admin roster documented; every admin has accepted policy 10 | R-11 | ☐ |
| Report triage: who looks, how fast, what gets escalated | R-10 | ☐ |
| **Posture A:** DPA signed before any student data is loaded | — | ☐ |
| **Posture A:** listed on the district's vendor register | — | ☐ |

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
