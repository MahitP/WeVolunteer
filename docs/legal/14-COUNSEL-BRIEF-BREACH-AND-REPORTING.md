# Counsel brief — breach notification and mandated reporting

**Prepared 2026-09-28. This is not legal advice and was not prepared by a lawyer.**
It is a compliance assessment written to make an attorney engagement short and
cheap: the statutes have been read and quoted from primary sources, the facts have
been checked against the code and the database schema, and what is left is a small
number of questions that genuinely require judgement.

**Read this first, then the two runbooks it covers:**
[`breach-response.md`](../operations/breach-response.md) ·
[`mandated-reporter-procedure.md`](../operations/mandated-reporter-procedure.md)

---

## Summary

**Proceed with conditions.** Nothing here blocks operating the platform. Two of the
three findings that looked like open legal risk dissolved on reading the statute,
and one narrow question remains that changes whether a statutory duty exists at all.

The single most important correction: the breach runbook's statutory basis was
taken from a **pre-2019 summary**, under which none of this platform's data was
"personal information" and N.J.S.A. 56:8-163 did not apply. That is no longer true.
P.L. 2019, c.95 added the element that reaches us.

---

## Who and what

| | |
|---|---|
| Platform | WeVolunteer — volunteer/service-hours platform for school students |
| Data subjects | **Minors**, plus adult organizers and staff |
| Jurisdiction | New Jersey. No EU/UK data subjects; GDPR and UK GDPR are out of scope |
| Posture | A — district vendor (processor), subject to a DPA |
| Decision-maker | Mahit Pulavarthi, platform owner — `privacy@wevolunteers.org`, 201-790-7275 |

---

## Applicable regulations

| Regulation | Relevance | Key requirement |
|---|---|---|
| **N.J.S.A. 56:8-161/163** (as amended by P.L. 2019, c.95) | **Directly applicable, subject to Q1** | Report to NJ State Police *in advance of* notifying individuals; no prescribed notice content |
| **N.J.S.A. 9:6-8.10** | **Directly applicable** | *Any person* with reasonable cause to believe a child has been abused must report **immediately** to DCP&P by telephone |
| **N.J.S.A. 9:6-8.13 / 9:6-8.14** | Applicable | Immunity for good-faith reports; failure to report is an offence, and a **fourth-degree crime** for sexual abuse (P.L. 2019, c.40) |
| **FERPA** | Indirect | **No breach-notification duty.** Funding condition on schools; poor security is not itself a violation |
| **COPPA** (16 CFR 312) | Indirect | Reasonable security (312.8); **no breach-notification duty**. Relevant to the under-13 school-consent route |
| **The district DPA** | **Binds first in practice** | Commonly 24 hours from discovery — shorter and more certain than the statute |
| GDPR / UK GDPR / CCPA | **Out of scope** | No EU/UK data subjects; CCPA thresholds not met |

---

## Requirements

| # | Requirement | Status | Action |
|---|---|---|---|
| 1 | Written breach runbook | **Met** | — |
| 2 | Named decision-maker | **Met** — Mahit Pulavarthi | Deputy declined 2026-09-28 (one administrator); accepted risk, revisit when a second exists |
| 3 | Pre-drafted notifications | **Met** — four templates + pre-send checklist | — |
| 4 | Rehearsal | **Partly** — assessment half walked 2026-09-28; found three defects, all fixed | Containment (§2.1) still never executed |
| 5 | State Police before individuals | **Met** — fixed as the house rule regardless of Q1 | — |
| 6 | Notice content compliant | **Not applicable** — the statute prescribes none | — |
| 7 | Mandated-reporter procedure | **Met**, citations verified | Threshold judgement is Q3 |
| 8 | Every admin briefed | **Met** for the only administrator — register dated 2026-09-28 | Brief each new admin before their account is created |
| 9 | Reachable contact | **Met** — email and voice | Consider a forwarding number before publishing the repo |
| 10 | Admin Responsibilities Policy accepted | **Not met** — gate is live in production, zero acceptances | Accept it |

---

## Questions for counsel

Three, in order of what they change. **Q1 is the one worth paying for.**

### Q1 — Does encryption take the `users` table outside the statutory definition?

**Facts.** `users` holds, in one row: `name`, `email`, `username`, `password_hash`
(bcrypt), and `tfa_secret` (a TOTP seed, AES-256-GCM encrypted under
`TFA_ENCRYPTION_KEY`, which is held in the host environment and **not** in the
database). No Social Security numbers, no driver's licence or State ID numbers, no
payment or financial account data exist anywhere in the system.

**Law.** "Personal information" (56:8-161) includes *"user name, email address, or
any other account holder identifying information, in combination with any password
or security question and answer."* "Breach of security" excludes access to personal
information *"secured by encryption or by any other method or technology that
renders the personal information unreadable or unusable."*

**The question.** A bcrypt hash is not a password and does not permit access. A TOTP
seed does, but is encrypted under a key that a database-only attacker does not have.

- **Database-only exposure** (stolen dump, leaked backup, SQL-injection read) — are
  both credential elements "unreadable or unusable", such that no reportable breach
  occurred?
- **Host compromise** — the AES key is in the environment, so the seed is readable.
  We assume this is reportable. Correct?

**Why it matters.** It decides whether any statutory duty exists, including the
State Police step. **Our current standing rule is to assume it applies**, because
over-notifying is not an offence and under-notifying is.

### Q2 — What does the DPA actually require, and does it displace anything?

No DPA is signed yet. When one is, its notification clause is expected to bind
sooner (commonly 24 hours from discovery) and regardless of Q1. Confirm the clause
on signing and whether any obligation is delegated to the district as controller.

### Q3 — Where is the "reasonable cause to believe" line for a platform operator?

We do not ask counsel to decide individual cases. We ask for the shape of the
threshold as it applies to an administrator reading a report about adult-to-minor
messaging, so the trigger list in §4 of the procedure is calibrated rather than
guessed. Our standing instruction is **when in doubt, report**, which 9:6-8.13
makes safe.

---

## Risk areas

| Risk | Severity | Mitigation |
|---|---|---|
| Under-notifying because Q1 is unanswered | **High** | Standing rule: assume the duty applies |
| Single decision-maker, no deputy | **High** | **Accepted 2026-09-28** — one administrator, so a deputy would be a name with no role. Containment and preservation proceed without authorisation; the notification clock does not |
| Containment (§2.1) never executed | **Medium** | Unresolved. The steps under most time pressure are the untested ones |
| Admin duties unacknowledged | **Medium** | Gate is live; acceptance outstanding |
| Personal mobile committed to the repo | **Low** | Acceptable in a private repo; replace before publishing |
| Historical PII in published git refs | **Separate finding** | Gates publishing, not launching |

---

## Recommended actions

1. **Put Q1 to counsel.** One question, yes/no, decides whether a statutory duty exists.
   Cheapest routes: fold it into the district's own DPA review, or a nonprofit legal clinic.
2. **Accept the Admin Responsibilities Policy.** The gate is live in production with zero
   acceptances, so administrative capability is currently withheld from both owners.
3. **Rehearse containment** against staging — the half that has never been executed, and the
   half under the most time pressure.
4. **Read the DPA's notification clause on signing**; it likely governs before the statute.
5. **Revisit the deputy decision** the moment a second administrator exists.

---

## Further review recommended

- Q1, Q2 and Q3 above.
- The seven items in [`00-COMPLIANCE-AND-RISK.md`](00-COMPLIANCE-AND-RISK.md).
- Terms of Service — drafted by an attorney, not merely reviewed. Separate, and
  blocked on the Phase 0 legal-entity decision.

---

## What changed on 2026-09-28, and why it is recorded

Three claims in the runbooks were checked against primary sources rather than the
risk register that first asserted them:

| Claim | Outcome |
|---|---|
| N.J.S.A. 9:6-8.10 is universal, immediate, by telephone | **Verified.** Quoted in full in the procedure |
| Notice content is "partly prescribed by statute" | **Wrong.** The statute prescribes none. Corrected, and it removes the legal risk from the templates' wording |
| The breach statute reaches this platform | **True, but not for the reason given.** The prior reading was pre-2019 and would have concluded the opposite |

Added: 9:6-8.13 and 9:6-8.14, which turn "when in doubt, report" from a moral
position into a legal one; and the host-versus-database distinction in Q1, which
the rehearsal surfaced and which no document had before.
