# Documentation

One governance document at the root, plus four directories with different
purposes and different lifetimes. Only `ENGINEERING_GUIDE.md` and `operations/`
are maintained; `plans/`, `specs/` and `history/` are deliberately frozen.

## `ENGINEERING_GUIDE.md` — governance, maintained

| Document | Purpose |
|---|---|
| [`ENGINEERING_GUIDE.md`](ENGINEERING_GUIDE.md) | How we work on this repository: repository philosophy, git workflow, PR standards, release process, dependency and security rules, testing and deployment philosophy, the technical debt register, and the scaling roadmap. Established 2026-07-31 at `v1.1.0`. Every rule in it is tied to the incident that produced it. |

Start here if you are new to the project, or if you are about to cut a release,
add a dependency, or create a branch. Where it overlaps with `operations/`, the
operations documents win on operational specifics and the guide wins on process.

## `operations/` — current, maintained

Documents an operator is expected to follow. These are kept accurate and should
be updated when behavior changes.

| Document | Purpose |
|---|---|
| [`pilot-deployment-runbook.md`](operations/pilot-deployment-runbook.md) | Provisioning through incident response. The living operational reference — written for an engineer who has not seen this project before, and kept current. |
| [`load-testing.md`](operations/load-testing.md) | The HTTP load test — how to run it, what each scenario exercises, the before/after measurements, and the performance budgets derived from them. Its companion is `postgres-scale-measurements.md`, which measures SQL rather than requests. |
| [`horizontal-scaling.md`](operations/horizontal-scaling.md) | What is safe for multiple backend instances and what is not, item by item. The deployment runs ONE instance and `instanceLock.js` enforces that; this records the seams that exist and the one blocker that remains. |
| [`pilot-readiness-review.md`](operations/pilot-readiness-review.md) | The pre-launch engineering gate, dated 2026-07-26. A point-in-time audit rather than a maintained document: every finding in it was addressed before 1.0.0, and it is kept because the reasoning behind each severity call is still useful. |
| [`owner-center.md`](operations/owner-center.md) | The owner-only operations page at `/owner`: who can open it, what each figure is read from, how to configure the four integrations it surfaces, what happens when one is unreachable, and what it deliberately refuses to do. |

Deployment artifacts referenced by the runbook live in [`../deploy/`](../deploy/).

## `plans/` and `specs/` — point-in-time, not maintained

Implementation plans and design specifications written before the work they
describe. Like `history/`, these are **not updated** once the work lands: they
record what was intended, which is often more informative than what was built.

| Directory | Contents |
|---|---|
| [`plans/`](plans/) | Task-by-task implementation plans |
| [`specs/`](specs/) | Design specifications, audits and sprint reports |

If a plan and the code disagree, the code is correct and the plan is history.

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
