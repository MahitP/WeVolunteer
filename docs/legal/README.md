# WeVolunteer — legal, privacy, and safety

Everything produced by the 2026-08-05 legal and design engagement.

> **Not legal advice.** These are code-grounded analyses and professional-grade drafts intended
> to make an attorney's review fast and cheap. Anything touching minors' data needs licensed
> review before launch. [The brief](00-COMPLIANCE-AND-RISK.md#where-outside-counsel-is-genuinely-required)
> names the seven items that genuinely require it.

## Start here

| If you are… | Read |
|---|---|
| Deciding what to do next | **[Roadmap](09-ROADMAP.md)** — supersedes the launch checklist |
| Briefing a lawyer | [Compliance analysis and risk register](00-COMPLIANCE-AND-RISK.md) |
| Writing code | [Developer handoff](04-DEVELOPER-HANDOFF.md) |
| Designing | [Design system and page designs](02-DESIGN-SYSTEM.md) |
| Writing product copy | [UX copy](01-UX-COPY.md) |

## Contents

| Document | What it is |
|---|---|
| [00 — Compliance and risk](00-COMPLIANCE-AND-RISK.md) | Applicable law, 19-item risk register scored severity×likelihood, launch brief, open decisions |
| [01 — UX copy](01-UX-COPY.md) | Before/after for every legal string in the product, quoted from source |
| [02 — Design system](02-DESIGN-SYSTEM.md) | Critique of the current notice, token extensions, components, six page designs |
| [03 — Accessibility report](03-ACCESSIBILITY-REPORT.md) | WCAG 2.1 AA audit with contrast ratios computed from real token values |
| [04 — Developer handoff](04-DEVELOPER-HANDOFF.md) | Components, props, states, tests, implementation order |
| [05 — Launch checklist](05-LAUNCH-CHECKLIST.md) | Blockers, 90-day items, dated obligations *(pre-dates the re-audit)* |
| **[06 — Re-audit: independent platform](06-REAUDIT-POSTURE-B.md)** | **Current.** Re-scored register, resolved open questions, P0–P3 gap analysis, threat model, roadmap, executive summary |
| **[09 — Implementation roadmap](09-ROADMAP.md)** | **Start here for execution.** Full repo audit, then every remaining task as an independently shippable PR with acceptance criteria, complexity and rollout risk |
| **[08 — Implementation log](08-IMPLEMENTATION-LOG.md)** | What was actually built across both implementation sessions, and what was found while building it |
| **[07 — Consent system](07-CONSENT-SYSTEM.md)** | **Current.** Legal journeys per role, signup consent UX, consent-record schema, versioning and re-consent, Legal Center IA, organizer and safety acknowledgements, gap analysis, roadmap |
| [policies/](policies/) | The ten legal documents, each with a specification block and a draft |

> ### ⚠️ Read the re-audit first
>
> **[`06-REAUDIT-POSTURE-B.md`](06-REAUDIT-POSTURE-B.md) supersedes the risk register** in
> document 00. WeVolunteer is now an **independent platform**, not a district vendor, and that
> decision re-scored most of the register. Document 00 remains the authoritative record of the
> statutory research and the Posture A analysis.

## The three things to know

**1. The safety and consent foundations now exist.** Suspension ends every session immediately,
blocking is student-initiated and closes conversations already in progress, consent is recorded
transactionally on all three account-creation paths, the age gate blocks under-13 server-side,
and retention is enforced by a daily job rather than merely published. 156 test files, 2517
tests. See [08](08-IMPLEMENTATION-LOG.md).

**2. What blocks launch is no longer engineering-shaped.** The Organizer Agreement binds nobody
because nothing records acceptance. There is no guardian consent, so a minor's assent has
nothing behind it. There is no legal entity to be a party to a Terms of Service. And there is no
moderation workflow beyond a status field — a report can be marked resolved, but not assigned,
prioritised, noted, or appealed.

**3. One live defect, introduced by this work.** `/legal/terms` and `/legal/guidelines` are
linked from the signup consent block and neither route exists. Both 404, in the one place a user
is being asked to rely on a document. **PR-0 in the [roadmap](09-ROADMAP.md) fixes it and should
ship before anything else.**

## Conventions

`[[BRACKETED]]` marks a fact nobody has supplied yet. **A document does not publish while it
contains one** — the same rule `src/config.js` already enforces in code, and for the reason
stated there: placeholder legal text manufactures the appearance of a reviewed policy.
