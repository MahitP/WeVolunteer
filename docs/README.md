# Documentation

Two directories with different purposes and different lifetimes.

## `operations/` — current, maintained

Documents an operator is expected to follow. These are kept accurate and should
be updated when behavior changes.

| Document | Purpose |
|---|---|
| [`pilot-deployment-runbook.md`](operations/pilot-deployment-runbook.md) | Provisioning through incident response. Written for an engineer who has not seen this project before. |
| [`pilot-readiness-review.md`](operations/pilot-readiness-review.md) | Pre-launch review: findings, severity, and what was done about each. |

Deployment artifacts referenced by the runbook live in [`../deploy/`](../deploy/).

## `history/` — archive, not maintained

A record of how the system reached its current state: audits, implementation
plans, and analyses written at specific points during development.

**These are point-in-time documents and are deliberately not updated.** Some
describe behavior that has since changed. They are kept because the reasoning
is often more useful than the conclusion, and because the invariants they
established still hold.

| Document | Written | Subject |
|---|---|---|
| `LAUNCH_READINESS_ROADMAP.md` | 2026-07-21 | Full codebase audit and phased plan |
| `2026-07-21-p0-launch-blockers.md` | 2026-07-21 | Launch-blocking defects |
| `2026-07-22-production-hardening.md` | 2026-07-22 | Security and correctness hardening |
| `2026-07-25-product-quality-roadmap.md` | 2026-07-25 | Usability and accessibility review |
| `BLOCK2_HOURS_PIPELINE_ANALYSIS.md` | — | How credited hours are derived |
| `BLOCK2_STEP2_MUTATION_MAP.md` | — | Every write path touching hours |
| `BLOCK2_STABILIZATION_REPORT.md` | — | Outcome of that work |

If you are looking for how something works today, read the code and
`operations/`. If you are looking for why it works that way, start here.
