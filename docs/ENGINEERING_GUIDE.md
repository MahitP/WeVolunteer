# WeVolunteer — Engineering Guide

**Status:** maintained. This document is expected to be accurate. Update it when
behaviour changes.

**Established:** 2026-07-31, immediately after the 1.1.0 release and the
repository consolidation that preceded it.

---

## How to read this document

Every rule here exists because something went wrong, or came close to going
wrong, in this project's history. Where that is the case, the incident is named
and dated. This is deliberate: a rule without a reason gets deleted by the next
engineer who finds it inconvenient, and a rule whose reason is a real outage
does not.

Read the reasoning, not just the rule. If you understand why a rule exists you
will know when it genuinely does not apply. If you only know the rule, you will
either follow it superstitiously or break it blindly.

This guide governs **how we work on the repository**. It does not cover how to
deploy a server — that is [`operations/pilot-deployment-runbook.md`](operations/pilot-deployment-runbook.md)
— nor the pre-launch operational gate, which is
[`operations/release-checklist.md`](operations/release-checklist.md). Where this
guide and those documents overlap, they should agree; if they disagree, the
operations documents win on operational specifics and this guide wins on
process.

---

## Table of contents

1. [Repository philosophy](#1-repository-philosophy)
2. [Git workflow](#2-git-workflow)
3. [Pull request standards](#3-pull-request-standards)
4. [Release process](#4-release-process)
5. [Dependency management](#5-dependency-management)
6. [Security rules](#6-security-rules)
7. [Testing philosophy](#7-testing-philosophy)
8. [Deployment philosophy](#8-deployment-philosophy)
9. [Technical debt register](#9-technical-debt-register)
10. [Future scaling roadmap](#10-future-scaling-roadmap)
11. [Engineering lessons learned](#11-engineering-lessons-learned)

---

## 1. Repository philosophy

### 1.1 Why `main` exists

`main` is the single branch that describes what WeVolunteer *is*. Everything
else is a proposal.

This is not the arrangement we started with. Before 2026-07-31 the repository
had three long-lived branches — `main`, `v1.1-security-accessibility-ux`, and
`stabilization-backup-pre-purge` — and no one could answer the question "which
one is the product?" without a forensic audit. That audit found:

- `main` was 48 commits **behind** and 0 commits ahead. It had zero unique work.
- `stabilization-backup-pre-purge`, despite the word "backup" in its name, was
  not a backup of anything. It was an intermediate checkpoint *on the way to*
  `v1.1`, fully contained within it, with zero unique commits.
- `v1.1-security-accessibility-ux` contained 100% of all committed work in the
  repository.

So the branch named `main` was the least current thing in the repo, and the
branch named "backup" was not a backup. Both names actively misled. It took a
full audit — ancestry proofs, route inventories, a sweep of dangling commits and
dropped stashes — to establish something that should have been obvious from
`git branch`.

**The rule:** there is one production branch, it is called `main`, and it is
always the answer to "what is WeVolunteer today". Anything long-lived that is
not `main` is a liability, because it is a second candidate answer to a question
that must have exactly one.

### 1.2 Why `main` must remain deployable

If `main` is not deployable, we do not have a release process — we have a
release *project*, undertaken from scratch each time.

WeVolunteer has already been bitten by this twice, in different ways:

**The uncommitted-fixes incident (2026-07-30).** A forensic audit found seven
ship-blocking defects. All seven were fixed. But the fixes lived only in a
working tree — nothing was committed. The runbook's own deploy procedure
(`git clone`, `git checkout`) would therefore have shipped the version that
still contained them, including a `POST /api/auth/reset` endpoint that destroyed
the database instead of resetting it. Green tests on a laptop are not a release.

**The lockfile incident (discovered 2026-07-31).** For four days `main`'s
successor branch could not be installed from scratch: `npm ci` failed with
`EUSAGE`. Tests passed, the build passed, lint passed — all against a
`node_modules` that had been assembled incrementally and no longer corresponded
to any committed lockfile. Section 5 covers the mechanics. The governance point
is that "deployable" is a property that must be *tested*, not assumed, and the
only command that tests it is `npm ci`.

**The rule:** `main` is deployable at every commit. Concretely, at any commit on
`main`, all four of `npm ci`, `npm test`, `npm run build`, and `npm run lint`
must pass. This is not aspirational — it is the definition of the branch. A
commit that breaks any of the four is a defect to be fixed forward immediately,
with the same urgency as a production outage, because it *is* a production
outage waiting for someone to attempt a deploy.

### 1.3 Why history rewriting is discouraged

Rewriting history destroys the evidence you need when something goes wrong.

WeVolunteer's history is not decoration. During the 2026-07-31 consolidation,
the safety of the entire operation rested on facts that could only be read out
of history:

- `git merge-base --is-ancestor` proved `main` was contained in `v1.1`, which is
  what made the consolidation a fast-forward rather than a merge, which is what
  made code loss *impossible* rather than merely unlikely.
- A sweep of five dangling commits — three dropped stashes and two hook smoke
  tests — proved nothing valuable was orphaned. That sweep compared route
  inventories (92 routes in each) to establish the stashes held no unique API
  surface.
- `git log -S'"compression"'` identified commit `6b3aab4` as the exact origin of
  the lockfile defect, which is what turned a confusing `npm ci` failure into a
  five-minute diagnosis.

None of those checks are possible against rewritten history. Every rebase,
amend, squash-of-published-work, and force-push trades away the ability to
answer "how did this get here?" — and that question is asked precisely when the
stakes are highest.

There is a second cost. Rewriting published history breaks every clone,
every open branch, and every reference anyone else holds. It converts one
person's tidiness preference into everybody else's merge conflict.

**The rule:**

- **Never** rewrite anything that has been pushed. No force-push to `main`, no
  rebase of a shared branch, no amending a published commit. There is no
  exception for "it was only a typo in the message."
- **Freely** rewrite your own unpushed local work. Rebasing your own feature
  branch onto current `main` before opening a PR is encouraged — that history
  is private and its tidiness is a real benefit.
- **Fix forward, don't rewrite.** When a mistake is already committed, the
  correct response is another commit that fixes it and explains what happened.

That last point has a worked example in this repository. During the 1.1.0
release prep, a `git add` aborted on an already-staged deletion path, so commit
`d713c4c` captured only part of its intended change while its message described
all of it. The tidy fix would have been `git commit --amend`. Instead the work
was completed in `ec6a70e`, whose message explicitly records that it finishes
`d713c4c` and why the amend was declined. The resulting tree is byte-identical
to what an amend would have produced. The history is one commit longer and
completely honest. That is the right trade.

### 1.4 Why rollback tags exist

A rollback tag is a promise that the previous state is still reachable.

Before the 2026-07-31 consolidation moved `main` forward by 48 commits, three
annotated tags were created and **pushed**:

| Tag | Target | What it preserves |
|---|---|---|
| `backup/main-pre-consolidation-2026-07-31` | `9ae59db` | `main` as it stood at 1.0.0 — the rollback point |
| `backup/v1.1-pre-consolidation-2026-07-31` | `6036b4c` | The exact tree that was promoted |
| `archive/stabilization-backup-pre-purge-2026-07-31` | `fe14d19` | The intermediate checkpoint, for provenance |

Three properties make these useful, and all three are deliberate:

1. **They are tags, not branches.** Branches move. A tag is a fixed claim about
   a specific commit. A "backup branch" is an oxymoron — anything that can move
   is not a backup.
2. **They are annotated, not lightweight.** An annotated tag carries a message,
   a tagger, and a date as a real object in the database. Six months from now
   the message is what tells you what the tag was for. A lightweight tag is a
   bare pointer with no explanation, which is exactly what you don't want when
   you're reading it under pressure.
3. **They are pushed.** A local-only backup tag protects you from your own
   mistakes but not from losing the machine. Pushing them is what made the
   consolidation genuinely safe rather than theatrically safe.

**The rule:** before any operation that moves `main` non-trivially, or that
migrates data, or that cannot be trivially undone, cut
`backup/<purpose>-<YYYY-MM-DD>` and push it. The cost is seconds. The value is
that every subsequent step becomes reversible, which changes how carefully you
have to hold your breath.

**Corollary:** rollback tags are immutable. Never move one, never delete one.
They are the audit trail.

### 1.5 Why releases are tagged

A release tag answers "what exactly is running in production?" — a question that
gets asked during incidents, when nobody has time to guess.

`v1.1.0` is an annotated tag whose target is `ec6a70e`, the exact commit on
`main` that passed all four validation gates. Not "roughly that commit", not
"main as of Tuesday". That precision matters because:

- **Incident response starts with identification.** `/health` reports
  `{"version":"1.1.0"}`, and that string maps to exactly one commit. Without the
  tag, correlating a running deployment to a diff means guessing from dates.
- **Diffing releases is how you find regressions.** "What changed between 1.1.0
  and 1.2.0" is only answerable if both are pinned.
- **Rollback needs a target.** "Roll back to the previous release" requires the
  previous release to be a nameable thing.

The tag's message is part of the deliverable, not an afterthought. `v1.1.0`
carries the full release summary — security, platform, experience, quality —
inside the tag object, so the information survives even if release notes on a
forge are lost or the forge is changed.

**The rule:** every release gets an annotated `vX.Y.Z` tag on the exact merged,
validated commit, and the tag is pushed. Tags are immutable: if a release is
bad, ship `vX.Y.Z+1`. Never re-point a published tag — someone has already
recorded that it meant something.

---

## 2. Git workflow

### 2.1 The model

```
main                          the product; always deployable; protected
 ├─ feature/oauth
 ├─ feature/email-system
 ├─ feature/pwa
 ├─ feature/dashboard-redesign
 ├─ feature/qr-attendance
 └─ feature/service-portfolios
```

Short-lived branches off `main`, merged back into `main`, deleted at merge.
`main` is the only long-lived branch. That is the whole model, and its
simplicity is the point — the three-branch arrangement it replaced required an
audit to interpret.

### 2.2 Allowed branch types

Names are lowercase, hyphen-separated, and describe the **area of work** — not
the person, not a ticket number. `feature/oauth` tells the next engineer what
the branch is. `feature/mahit-work` and `feature/JIRA-412` do not.

#### `feature/*` — new capability

- **Purpose:** adds something the product could not do before.
- **Examples:** `feature/oauth`, `feature/email-system`, `feature/pwa`,
  `feature/qr-attendance`, `feature/service-portfolios`,
  `feature/dashboard-redesign`
- **Lifecycle:** branch from current `main` → commit → open PR → four gates pass
  → review → squash-merge → **branch deleted at merge**.
- **Expected lifespan:** days to two weeks. A feature branch that has been open
  for a month is a warning sign; see §2.7.

#### `fix/*` — corrects broken behaviour

- **Purpose:** repairs a defect in existing behaviour. No new capability.
- **Examples:** `fix/attendance-rounding`, `fix/waitlist-promotion-order`,
  `fix/ics-timezone-offset`
- **Lifecycle:** same as `feature/*`, but a `fix/*` branch should almost always
  add a regression test that fails before the fix and passes after (§7.4).
- **Expected lifespan:** hours to days. Fixes should be small and land fast.

#### `chore/*` — maintenance with no behavioural change

- **Purpose:** dependency bumps, tooling, lint cleanup, CI configuration,
  lockfile maintenance. Nothing a user could observe.
- **Examples:** `chore/lint-unused-imports`, `chore/untrack-tool-artifacts`,
  `chore/bump-vite-8`, `chore/add-npm-ci-to-ci`
- **Lifecycle:** same as `feature/*`. Because these claim "no behavioural
  change", the test suite is the evidence for that claim — a `chore/*` branch
  that changes test *results* is misclassified and is really a `fix/*` or
  `feature/*`.
- **Expected lifespan:** hours.

#### `docs/*` — documentation only

- **Purpose:** changes confined to `.md` files and comments.
- **Examples:** `docs/engineering-guide`, `docs/oauth-setup`,
  `docs/update-runbook-smtp`
- **Lifecycle:** same as `feature/*`. The full gate still runs — documentation
  branches have broken builds before, usually by touching a code comment that
  turned out to be load-bearing, or a `.md` file that a test asserts against
  (this repository has tests that read documentation).
- **Expected lifespan:** hours to days.

#### `archive/*` — retired, kept for reference

- **Purpose:** a branch that is no longer developed but is not yet deleted. The
  prefix is a statement: *do not commit here.*
- **Examples:** `archive/v1.1-security-accessibility-ux`,
  `archive/stabilization-backup-pre-purge`
- **Lifecycle:** a branch is renamed *into* `archive/` when its work has landed
  and it is no longer a development target. It stays for a cooling-off period
  (recommended: one month of production stability), then is deleted with
  `git branch -d` once its content is provably contained in `main` and its tip
  is pinned by a pushed tag.
- **Important:** `archive/*` is a **holding pattern, not a storage system.** The
  durable record is the pushed tag. An archive branch is a convenience for
  humans during the transition, and it should eventually go away. Permanent
  `archive/*` branches recreate the sprawl this model exists to prevent.

### 2.3 Branch creation rules

1. **Always branch from current `main`.** Fetch first. Never branch from another
   feature branch.

   This is the single most important rule in this section, and it is the rule
   that was broken to create `stabilization-backup-pre-purge`. That branch was
   cut from mid-sprint work rather than from `main`, which is precisely why its
   relationship to everything else was unclear and why establishing it required
   ancestry proofs. Branching from `main` means your branch's relationship to
   the product is unambiguous by construction.

2. **One concern per branch.** A branch does one thing, describable in its name.

   The branch this model replaced was called
   `v1.1-security-accessibility-ux` — three concerns in one name, which honestly
   advertised the problem. It accumulated 48 commits spanning cookie
   authentication, CSP, dialog semantics, SQL pagination, route splitting, and a
   messaging feature. Any one of those was reviewable. All of them together were
   not, which is why they shipped as a single unreviewable unit and why a
   forensic audit was needed afterwards to work out what was even in there.

3. **Name the area, not yourself or a ticket.** See §2.2.

4. **Rebase your own branch onto `main` to stay current** — this is your own
   unpushed history, and keeping it current makes the eventual merge trivial.
   Once pushed and shared, stop rebasing (§1.3).

### 2.4 Merge rules

1. **Squash-merge features into `main`.** One shipped capability, one commit on
   `main`. The intermediate "wip", "fix typo", "actually fix it" commits
   disappear, which keeps `main` readable and `git bisect` meaningful.

2. **`main` is protected.** No direct pushes. No force-pushes. Every change
   arrives via pull request.

3. **All four gates green, plus one review.** See §3.

4. **The squash commit message is the permanent record.** It should explain
   *why*, not restate the diff. The repository's existing history is the
   standard to match — commit `6b3aab4`'s successor commits, and the two 1.1.0
   release commits, explain root cause and reasoning rather than listing files.

5. **Fast-forward is preferred where it applies.** The 2026-07-31 consolidation
   used `git merge --ff-only`, deliberately, because `--ff-only` is not merely
   an action but an *assertion*: it fails loudly if the branch is not actually a
   descendant. `--no-ff` would have manufactured a two-parent history for what
   was a straight line, and would have silently succeeded even if the
   containment assumption had been wrong. Prefer the option that can catch you
   being wrong.

6. **Delete the branch at merge time.** Not next week. Not "when I get around to
   it." This is the highest-leverage anti-sprawl rule in this document: the
   three-branch mess of July 2026 happened because merged work was never
   retired, not because anyone decided to keep three production branches.

### 2.5 Deletion rules

1. **Use `git branch -d`, never `-D`.** Plain `-d` refuses to delete a branch
   that is not fully merged. That refusal is a feature — it makes the command
   itself re-verify your containment assumption. `-D` overrides the only
   automatic safety check git offers you.

2. **Before deleting anything long-lived, verify three things:**
   - it is an ancestor of `main` (`git merge-base --is-ancestor <branch> main`)
   - it has zero unique commits (`git rev-list --count main..<branch>` → `0`)
   - its tip is pinned by a **pushed** tag (`git tag --points-at <tip>`, then
     confirm with `git ls-remote --tags origin`)

   All three held for both branches retired after 1.1.0. Verifying them takes
   under a minute and converts "I'm fairly sure this is safe" into "this is
   provably safe."

3. **Never delete a tag.** Tags are the audit trail (§1.4, §1.5).

4. **Deletion is never urgent.** Disk is free; recovering deleted work is not.
   When in doubt, wait.

### 2.6 Release rules

Summarised here, detailed in §4:

- Releases are cut from `main`, never from a feature branch.
- `main` must be green *at the commit being tagged* — not "green last week".
- The version bump is its own commit, landing through the normal PR gate.
- The tag is annotated, pushed, and immutable.

### 2.7 Anti-sprawl guardrails

Branch sprawl is not caused by a decision to have many branches. It is caused by
the absence of a decision to remove them. These are the tripwires:

| Signal | What it means | Action |
|---|---|---|
| A branch open > 2 weeks | Scope too large, or abandoned | Split it, or archive it |
| A branch with > 15 commits | Multiple concerns bundled | Split into separate PRs |
| A branch whose name has "and", or three nouns | Multiple concerns, self-declared | Split |
| A branch named `backup/*` | Backups are tags, not branches | Convert to a tag |
| A second branch that could answer "what is the product?" | The exact 2026-07 failure | Resolve immediately |
| More than ~6 open branches | Work in progress exceeds review capacity | Land or close some |

---

## 3. Pull request standards

### 3.1 Required checks

Every PR must have all four green before merge. They are not
interchangeable — each catches a class of failure the others cannot.

| Check | What it proves | What it cannot catch |
|---|---|---|
| `npm ci` | The committed lockfile can produce a working install **from scratch** | Anything about behaviour |
| `npm test` | 1059 tests across 88 files still pass | Anything not covered by a test |
| `npm run build` | The frontend compiles and code-splits for production | Runtime behaviour |
| `npm run lint` | Zero errors (warnings currently tolerated — see §9) | Anything semantic |

**`npm ci` is not optional and is not a slower `npm install`.** It is the only
one of the four that validates the lockfile, and its absence is exactly how the
1.1.0 lockfile defect survived four days of otherwise-green runs. `npm install`
would have silently *repaired* the desync locally and hidden the problem;
`npm ci` fails loudly, which is the entire point. See §5.

**Run order matters:** `npm ci` first. If the lockfile is broken, the other
three results are measured against a `node_modules` that no clean environment
will ever reproduce, and are therefore meaningless.

### 3.2 What constitutes a merge blocker

A blocker stops the merge. Not "we'll fix it in a follow-up" — stops it.

#### Failing tests

Any failure, including one. There is no acceptable number of failing tests above
zero, because the moment one is tolerated the suite stops being a signal and
becomes a thing people scroll past.

**"It's flaky, just re-run it" is not a resolution.** Flakiness is a defect in
the test or the harness, and this repository has already paid for learning that.
`vitest.config.js` pins `isolate: true` with a comment recording the measurement
behind it: with isolation off, the suite failed *every* run, with a failure count
that varied by scheduling order (2, then 4, then 2 across three runs), because
module-level state such as rate-limiter counters survived across test files
sharing a worker. That is what "flaky" actually was — a real, reproducible,
order-dependent bug. Pinned, the suite is green every time.

If a test is genuinely flaky, that is a `fix/*` branch, not a re-run.

#### Security regressions

Blocking, without discussion:

- Weakening or removing a production boot guard (§6.1, §6.2)
- Reintroducing token storage in `localStorage` — 1.1.0 removed this deliberately
- Removing or narrowing a security header: CSP, HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`
- Loosening `.gitignore`'s secret rules (§6.4)
- Removing or bypassing the pre-commit secret scan
- Introducing an authorization check that is missing on any route, or an
  endpoint that returns another user's data
- Committing any credential, in any form, ever

**Any diff touching authentication, authorization, or secret handling requires
explicit security review**, regardless of size. The 2026-07-30 auth audit found
four broken auth flows that had been shipped and believed working. Small diffs
in this area have an outsized blast radius.

#### Deploy failures

- `npm run build` fails, or emits an error
- The server does not boot with a valid production environment
- `/health` does not return `{"status":"ok","database":"connected","writable":true}`
- A migration fails, or is not additive (§8.3)
- Graceful shutdown stops draining workers, the scheduler, or the database

#### Lockfile inconsistencies

- `npm ci` fails for any reason
- A nested `package-lock.json` appears anywhere outside the repository root
  (§5.3) — this is prohibited outright
- `package.json` changed without the corresponding root lockfile change in the
  same commit
- A lockfile diff contains unexplained churn. Adding one dependency should add
  that dependency and its transitives, nothing else. The 1.1.0 fix was validated
  precisely this way: 4 packages added, 0 removed, 0 re-versioned. Large
  unexplained lockfile diffs hide supply-chain changes.

#### Other blockers

- Version bumped in `package.json` but not `server/package.json`, or vice
  versa — `/health` reads the **server** manifest and would report a wrong
  version (§4.1)
- New tracked artifacts that are generated, temporary, or tool-produced (§9)
- A `chore/*` branch that changes test results — it is misclassified

### 3.3 What is *not* a blocker

Precision matters in both directions. These should be raised, not blocked on:

- Existing lint **warnings** (currently 90, all `no-unused-vars` — §9)
- The two known `npm audit` high-severity entries, both the same react-router
  advisory, assessed as not applicable and documented in `README.md` (§6.7)
- Style preferences already consistent with surrounding code
- Missing tests for pure refactors with no behavioural change (§7.4)

### 3.4 Review expectations

**As author:** explain *why* in the description. State what you verified and
how. If you found something out of scope, say so rather than silently widening
the diff. Keep PRs small — a 261-file change is not reviewable, which is how
1.1.0's content shipped without meaningful review and needed an audit afterwards.

**As reviewer:** you are accountable for what you approve. Confirm the four
gates actually ran on the current head rather than an earlier push. Read the
test diff first — it tells you what the author believes the change does. Be
specific: "this breaks when `latitude` is null" beats "add error handling."

---

## 4. Release process

### 4.1 The exact process

#### Step 0 — Confirm the starting state

`main` clean, current, tracking `origin/main`, zero divergence. Verify with
`git status -sb` and `git branch -vv`. If anything differs from expectation,
stop and find out why before proceeding.

#### Step 1 — Version bump

Bump **both** manifests together:

```
npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root
```

This updates `package.json`, `server/package.json`, and the three version fields
in the root `package-lock.json` in one pass. `--no-git-tag-version` is required:
we create the tag ourselves, after validation and merge, so the tag lands on a
commit that has actually been verified.

**Why both manifests.** `server/app.js` derives the `/health` version by reading
**`server/package.json`** — not the root. Bumping only the root produces a build
that reports a stale version at exactly the moment you most need to trust it:
during an incident, when `/health` is how you identify what is running. Before
1.1.0 all three files read `1.0.0` while the branch carried the entire v1.1
codebase, so `/health` was advertising a superseded release.

#### Step 2 — Validation

All four gates, in this order, on the release commit:

```
npm ci
npm test
npm run build
npm run lint
```

Confirm explicit exit codes rather than eyeballing output. This matters more
than it sounds: during 1.1.0 prep a validation chain printed empty
`PIPESTATUS` values, and the run had to be repeated with explicit `$?` capture
before the push could be justified. "It looked fine" is not a gate.

Then confirm the version actually reached the running application: boot with a
valid production environment and check that `/health` reports the new version.
This is the step that catches a half-applied bump.

#### Step 3 — Land the bump

The version bump goes through the normal PR gate like any other change. It is
not exempt. Merge to `main`.

#### Step 4 — Tag creation

Annotated tag on the exact merged commit, with a meaningful message — the
release summary belongs in the tag object, so it survives independently of any
forge:

```
git tag -a vX.Y.Z main -F <message-file>
git push origin refs/tags/vX.Y.Z
```

Push the tag by explicit ref rather than `--tags`, so you know exactly what
became public.

#### Step 5 — Verify the tag

Do not trust local state. Verify against the remote:

```
git cat-file -t vX.Y.Z          # must print "tag" — annotated, not lightweight
git ls-remote --tags origin 'refs/tags/vX.Y.Z*'
```

The `^{}` line in `ls-remote` output is the dereferenced target. It must equal
the release commit. For 1.1.0: tag object `6653dc8`, dereferenced target
`ec6a70e`, equal to `main`. Both were confirmed present locally and remotely
before the release was declared done.

#### Step 6 — Deployment

Follow [`operations/pilot-deployment-runbook.md`](operations/pilot-deployment-runbook.md).
Deploy the **tag**, not a branch — `git checkout vX.Y.Z` — so the deployed
artifact is pinned and identifiable. Work through
[`operations/release-checklist.md`](operations/release-checklist.md), which
covers configuration, firewall, SMTP proven end to end, OAuth, backups and
restore, credential rotation, and restart behaviour. That checklist exists
because of the 2026-07-30 incident described in §1.2 and should not be
short-circuited.

#### Step 7 — Post-deployment verification

- `/health` returns `{"status":"ok","database":"connected","writable":true}` with
  the expected version string
- An unauthenticated request to a protected route returns `401`
- All four security headers present on responses
- Logs show workers and scheduler started
- A real user flow works end to end — sign in, view an event, apply

Record the deployed version and commit somewhere durable. During an incident,
"what is running?" must be answerable in seconds.

### 4.2 Patch, minor, or major

Semantic versioning, applied to observable behaviour.

#### Patch — `X.Y.Z+1`

Bug fixes and security patches only. No new capability, no schema change, no
API change. A patch release should be boring and safe enough to ship on a
Friday.

*Would-be example:* clearing the 90 `no-unused-vars` lint warnings plus a
correctness fix, with no behavioural change → `1.1.1`.

#### Minor — `X.Y+1.0`

Additive. New features, new endpoints, new columns — nothing existing breaks.
Existing clients continue working untouched.

*Actual example: 1.1.0.* This was correctly minor, and the diff proves it: 261
files changed, **183 added, 78 modified, 0 deleted, 0 renamed**, and all 92
existing routes preserved. Cookie authentication, Socket.IO, pagination, the
location system, private messaging, dark mode — all additive. Nothing that
worked in 1.0.0 stopped working.

Note the one thing that makes 1.1.0 a borderline call, because it is worth
learning from: it *did* introduce hard production boot requirements
(`JWT_SECRET`, SMTP). An operator upgrading from 1.0.0 with an incomplete `.env`
finds the server refusing to start. That is an operational breaking change even
though it is not an API breaking change. It shipped as minor because the guards
fail closed and loudly with actionable messages, and because a server that
boots with a placeholder signing secret is worse than one that refuses. **The
lesson: a new mandatory configuration requirement must be called out
prominently in release notes, whatever the version number says.**

#### Major — `X+1.0.0`

Breaking. Removed or changed API contracts, authentication changes requiring
client updates, non-additive schema migrations, or a mandatory operator
migration.

*Anticipated example:* multi-district tenancy (§10.7) almost certainly requires
organization-scoping every table and every query. That is `2.0.0`.

A major release needs a migration guide, a tested rollback path, and a
deprecation period for anything removed.

---

## 5. Dependency management

### 5.1 npm workspaces

WeVolunteer is a single npm workspace. The root `package.json` declares
`"workspaces": ["server"]`.

This means the repository is **one dependency graph with one lockfile at the
root**, even though it contains two `package.json` files. The root manifest owns
the frontend and the toolchain; `server/package.json` declares the backend's
dependencies but does **not** own a lockfile.

Both manifests pin `"node": ">=24.0.0 <25"`. The upper bound is deliberate: the
server uses `node:sqlite`, which is still flagged experimental and emits a
warning on every boot. Experimental APIs change across major Node versions, so
the runtime is pinned to a known-good major rather than left open.

### 5.2 Root lockfile authority

**`/package-lock.json` is the single source of truth for every dependency in
this repository, including the server's.**

Consequences, and they are not negotiable:

- Run `npm install` **only from the repository root.** Never from inside
  `server/`.
- Run `npm ci` **only from the repository root.**
- Any dependency change — frontend or backend — updates the root lockfile, and
  that update is committed in the same commit as the `package.json` change.

### 5.3 Why nested lockfiles are prohibited

A nested `package-lock.json` inside a workspace is not a second opinion. It is
an **invisible** file: `npm ci` at the root does not read it, does not validate
it, and does not warn about it. It looks authoritative, is version-controlled,
and has no effect. That combination is worse than having no lockfile there at
all, because it convinces the next engineer that the dependency was recorded.

**Rule: no `package-lock.json` exists anywhere except the repository root. A PR
introducing one is blocked (§3.2).**

### 5.4 Root-cause analysis: the 1.1.0 lockfile incident

**Discovered:** 2026-07-31, during Phase 3 validation of the repository
consolidation. **Latent for:** four days. **Impact:** `main`'s successor branch
could not be installed from scratch. Any clean CI build or container deploy
would have failed.

#### Symptom

`npm ci` at the root exited non-zero with `EUSAGE`:

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync.
npm error Missing: compression@1.8.1 from lock file
npm error Missing: compressible@2.0.18 from lock file
npm error Missing: negotiator@0.6.4 from lock file
npm error Missing: on-headers@1.1.0 from lock file
```

Note that npm's own output leads with a generic usage dump; the four `Missing:`
lines — the actual diagnosis — were buried. The real error was found in
`~/.npm/_logs/`. **When npm prints a usage block, read the debug log before
believing the surface message.**

#### Root cause

Commit `6b3aab4` ("perf: compression, event-list windowing, iOS safe-area
activation") added `compression: ^1.8.1` to `server/package.json`. The
dependency was then recorded in a **newly created 2,662-line
`server/package-lock.json`** instead of the root lockfile.

Because `server` is a workspace, `npm ci` at the root reads only
`/package-lock.json`. It never saw the nested file. So the root lockfile never
learned about `compression` or its three transitive dependencies, and
`package.json` and the root lock were permanently out of sync.

#### Why it stayed hidden for four days

This is the important part.

`npm test`, `npm run build`, and `npm run lint` **all passed** throughout. They
ran against a `node_modules` directory that had been assembled incrementally by
earlier `npm install` runs and did contain `compression`. That directory
corresponded to no committed lockfile — it was a local accident that happened to
work.

`npm ci` is the only command that builds from the lockfile alone and therefore
the only one that could detect the desync. It was not being run.
`npm install` would have made things worse: it would have silently repaired the
root lockfile locally, producing an uncommitted fix and hiding the defect
further.

#### Resolution

Fixed across commits `d713c4c` and `ec6a70e`:

1. Deleted `server/package-lock.json` (2,662 lines). Verified safe first: all 14
   dependencies declared in `server/package.json` resolve in the root lock, and
   zero packages present in the nested lock were absent from the root lock.
2. Regenerated the root lockfile with `npm install --package-lock-only`. Change
   was surgical and verified before committing: **4 packages added**
   (`compression@1.8.1`, `compressible@2.0.18`, `on-headers@1.1.0`,
   `compression`'s pinned `negotiator@0.6.4`), **0 removed, 0 re-versioned.**
3. The regenerated lock also picked up `engines: node >=24.0.0 <25` in two
   places. Verified that both manifests already declared that range at `HEAD`,
   confirming this was the lockfile catching up rather than a policy change.
4. The fix was validated **out-of-tree first** — in a scratch copy, where
   `npm ci --dry-run` was confirmed to exit 0 — before touching the repository.
5. Verified end to end afterwards, not just in the lockfile:
   `compression@1.8.1` resolves after `npm ci`, is mounted first in
   `server/app.js` with `threshold: 1024`, and a 327,871-byte asset returns
   `Content-Encoding: gzip`. `/health` is correctly *not* compressed — its
   ~70-byte body is below the threshold.

#### Lessons

1. **`npm ci` must run in CI.** This is the highest-priority open item in §9. The
   defect was undetectable without it and trivially detectable with it.
2. **A passing test suite does not mean the repository is installable.** They are
   different properties requiring different checks.
3. **Never run `npm install` inside a workspace package.** This is the entire
   proximate cause.
4. **Validate risky fixes out-of-tree first.** Proving the fix in a scratch copy
   cost one minute and removed all guesswork.
5. **Read the debug log when npm prints usage text.** The real error is often not
   the one on screen.

### 5.5 Adding or updating a dependency

1. From the **repository root**, install with the appropriate `--workspace` flag
   for a server dependency.
2. Confirm only `/package-lock.json` changed — no nested lockfile was created.
3. Inspect the lockfile diff. Expect the new package and its transitives and
   nothing else. Unexplained churn is a blocker (§3.2).
4. Run `npm ci` locally to confirm the lockfile is installable from scratch.
5. Commit the `package.json` and lockfile changes **together**. Splitting them
   creates a commit where `main` is not installable.

### 5.6 Vulnerability handling

Run `npm audit` at each release. For each finding, decide and **document**:

- **Fix** if a non-breaking upgrade exists.
- **Assess and accept** if the advisory does not apply — but write down the
  reasoning where the next person will find it. `README.md` records the
  react-router assessment (§6.7); that note is why `npm audit`'s two high-severity
  entries did not block the 1.1.0 release, and why nobody has to re-derive the
  analysis each time.
- **Schedule** if it applies but the fix is breaking. Track it in §9.

Never run `npm audit fix --force` as a reflex. It forces breaking major upgrades
and will silently change your dependency graph far beyond the advisory.

---

## 6. Security rules

### 6.1 JWT requirements

`server/config.js` resolves the signing secret at import time and enforces:

- **Production, unset:** refuses to boot. Fatal, with instructions for
  generating one.
- **Production, placeholder or weak:** refuses to boot. The template value
  `your-super-secret-jwt-key` from `.env.example` is explicitly rejected, as are
  other detectable weaknesses.
- **Development, unset:** boots with an insecure fallback and a loud warning.

**Why this is fail-closed.** Every session cookie is signed with this secret. A
guessable value means anyone can mint a valid session for any user, including an
administrator. There is no partial compromise: the secret is either unguessable
or authentication is decorative.

A server that refuses to start is a visible, immediately-actionable failure. A
server that starts with a placeholder secret is a silent, total compromise that
looks healthy in every dashboard. **Given the choice, always fail loudly.**

Rotating the secret invalidates all existing sessions — that is intended, and is
the mechanism for forcing a global logout. Token revocation is also available
per-user through `users.token_version`.

### 6.2 SMTP requirements

Production requires `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS`. Without them the
server refuses to boot.

**Why this is a boot guard rather than a runtime warning.** Email is not
cosmetic in WeVolunteer — password reset, email verification, and volunteer
notifications all depend on it. A server running without SMTP appears healthy
while silently breaking account recovery. Users discover it at the worst
moment: locked out, unable to reset. The failure surfaces days later as
"password reset doesn't work" with no obvious cause.

Booting is the right place to check, because it is the only moment when someone
is watching and can fix the configuration.

### 6.3 Secret management

- Secrets come from the environment. Never from committed files, never
  hard-coded, never in a comment "temporarily".
- `.env.example` is the template. It contains placeholder values only, and the
  boot guards actively reject those placeholders in production (§6.1).
- Rotate on any suspicion of exposure. Treat a secret that has ever touched a
  git object, a log, a chat message, or a screenshot as compromised.
- Credential material — `*.p8`, `*.p12`, `*.pem`, `*.key`,
  `service-account*.json` — never enters the repository. `.gitignore` denies
  these by pattern.
- `docs/operations/pilot-credentials.md` is gitignored. Operational credentials
  do not live in version control.

### 6.4 `.env` handling and the 2026-07 secret leak

#### The incident

Recorded as **audit finding C-3**. A `.env` file containing a **live
`GOOGLE_CLIENT_SECRET`** was committed to the repository.

**Root cause:** `.gitignore` ignored `.env.production` — a specific filename —
but not `.env`. The rule was written to cover the file that existed at the time
rather than the *class* of files, so the moment someone created a plain `.env`,
it was tracked.

**Current status:** remediated and verified. `.env` is tracked in no branch and
appears in **zero commits reachable from any ref**. This was confirmed during
the 2026-07-31 consolidation audit by walking every reachable commit, not by
checking branch tips.

#### The fix, and why it is shaped this way

`.gitignore` now denies the whole class and re-allows only known templates:

```
.env
.env.*
!.env.example
!.env.development
!.env.production.example
```

**This is deny-by-default with an explicit allowlist, and that inversion is the
entire lesson.** Under the old rule, every new env-file variant — `.env.staging`,
`.env.pilot`, `.env.local` — was exposed until someone remembered to add a rule
for it. The protection depended on human memory at exactly the moment a
developer is busy doing something else. Under the new rule, a new variant is
ignored the instant it is created, and only files deliberately added to the
allowlist are ever tracked.

**Rule: never weaken these patterns.** Adding a template requires an explicit
`!` allowlist entry and review confirming the file contains no live values.

#### Lessons

1. **Enumerate the class, not the instance.** `.env.production` was a correct
   rule for one file and a broken rule for a category.
2. **Deny by default; allowlist deliberately.** Security defaults must not
   depend on someone remembering.
3. **Verify remediation across all reachable history, not just branch tips.** A
   secret removed from `HEAD` may still sit in an old commit, and clones carry it.
4. **Rotate anything exposed.** Removing a secret from git does not un-leak it.

### 6.5 Git ignore rules

Beyond secrets, `.gitignore` excludes generated and personal-data artifacts —
each with a comment recording *why*, because a bare pattern gets deleted by
someone who cannot tell what it protects:

- `exports/`, `*.zip` — generated data-export archives. Each is one user's
  complete personal record: profile, messages, attendance, certificates. Written
  beside the database, which in development is the repository root. **Must never
  be committed.**
- `backups/` — database backups.
- `playwright-report/`, `test-results/`, `test_output.txt`, `*.tap` — test
  artifacts. `test_output.txt` was tracked once and carried 991 lines of vitest
  stdout including raw ANSI escapes; it went stale the moment the suite changed
  while still reading as authoritative.
- `*.db-wal`, `*.db-shm` — SQLite runtime sidecars.
- `update_css.cjs` — a spent one-off codemod. Re-running it against today's
  `index.css` would corrupt it.

**Rule: when adding an ignore rule, add a comment explaining what it protects
and why.** The rules above survive because their reasoning is attached.

### 6.6 Secret scanning

`bin/pre-commit-secret-scan.sh` runs as a pre-commit hook, installed by
`bin/install-hooks.sh` (symlinked into `.git/hooks/pre-commit`).

Because git hooks are not version-controlled and do not install themselves,
**every developer must run `bin/install-hooks.sh` after cloning.** An
uninstalled hook fails silently and invisibly — it looks exactly like a hook
that found nothing.

The hook is a safety net, not a control. It catches the accident of a pasted
credential. It cannot catch a determined mistake, and it must never be the only
thing standing between a secret and the remote. Never bypass it with
`--no-verify` to "fix it in the next commit" — the object is already written
once the commit exists.

### 6.7 Known accepted advisory

`npm audit` reports two high-severity entries. Both are the same advisory
([GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2),
react-router RSC-mode CSRF bypass), counted twice via `react-router` and
`react-router-dom`.

**Assessed as not applicable**, with the reasoning recorded in `README.md`: the
advisory is scoped to React Router's React Server Components mode. WeVolunteer
is a client-rendered SPA with no server components, so the attack surface the
advisory describes is never instantiated.

Re-assess whenever the advisory is updated or the routing architecture changes.
If WeVolunteer ever adopts server components, **this assessment is void** and
must be redone before shipping.

### 6.8 Current verified security posture

Confirmed at `v1.1.0`:

| Control | Verified behaviour |
|---|---|
| Session authentication | httpOnly cookies; no `localStorage` token storage |
| Logout | Server-side, with revocation via `users.token_version` |
| Unauthenticated protected route | Returns `401` |
| Content-Security-Policy | Enforced, including `frame-ancestors 'none'` |
| HSTS | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `JWT_SECRET` guard | Refuses production boot on placeholder or weak values |
| SMTP guard | Refuses production boot when unconfigured |
| Password minimum length | 8 characters |
| Login throttling | Active |
| Account enumeration | Hardened |
| Privacy export | IDOR-tested |
| Secret scanning | Pre-commit hook installed |

---

## 7. Testing philosophy

### 7.1 Current state

**1059 tests across 88 test files, all passing** as of `v1.1.0`. Typical runtime
is 20–27 seconds.

Growth for context — this is what sustained investment looks like:

| Point in history | Test files |
|---|---|
| 1.0.0 (`main` before consolidation) | 25 |
| Mid-sprint checkpoint | 44 |
| **1.1.0** | **88** |

### 7.2 Structure

Two vitest projects, deliberately separated by environment:

- **`client`** — `src/**/*.test.{js,jsx}`, `jsdom` environment, loads
  `src/setupTests.js`.
- **`server`** — `server/**/*.test.js`, `node` environment.

**Why not one global environment.** The server suites talk to `node:sqlite`,
bind real ports, and read `process.env`. Running them under `jsdom` would put
them in a fake browser where `fetch` against `127.0.0.1` and `DatabaseSync`
behave differently than in production — and the resulting failures would be
blamed on the code rather than the harness. Only the client suites need a DOM,
and only they pay for `@testing-library`.

Two configuration details are **load-bearing** and documented as such in
`vitest.config.js`. Do not "simplify" either:

- **`isolate: true`** — see §3.2. Removing it produces order-dependent flakiness
  rather than clean failure, which is far harder to diagnose than an outright
  break.
- **`scratch/` exclusion** — `scratch/` holds throwaway full copies of the
  project made during deployment checks. Vitest walks the filesystem rather than
  git, so `.gitignore` does not keep it out. Measured: dropping the exclusion
  turned a passing run of 25 files / 256 tests into 73 files / 36 failures.
  `scratch/` currently holds 101 test files.

### 7.3 Coverage standards

We do not enforce a global coverage percentage. A number is easy to hit with
tests that execute code without asserting anything meaningful, and it creates
pressure to test trivial code while leaving the risky paths alone.

Instead, coverage is expected to be **proportional to consequence**:

| Area | Standard |
|---|---|
| Authentication, authorization, sessions | Every path, including every failure path |
| Anything touching credited hours | Every write path — hours are the product's core record |
| Data export, deletion, privacy | Every path, including IDOR attempts |
| Security headers, boot guards, config | Asserted explicitly |
| Migrations | Tested for idempotency |
| Money, certificates, attendance | Every path |
| UI rendering and layout | Enough to catch crashes and regressions |
| Pure presentational styling | Light |

The existing suite reflects this: there are dedicated tests for cookie
authentication, logout revocation, auth hardening, account enumeration, privacy
export IDOR, event-ID collision, waitlist promotion, JWT secret configuration,
cookie options, health, shutdown, instance locking, and worker durability.
That distribution is the standard to maintain.

### 7.4 When tests must be added

**Required:**

- **Any bug fix.** Write the test first; watch it fail; then fix. A fix without
  a failing-then-passing test has not been demonstrated to fix anything, and
  nothing stops the bug returning. The 2026-07-30 auth audit found four broken
  auth flows that had shipped and were believed working — regression tests are
  what make "believed working" into "known working".
- **Any new endpoint or route.** Success and failure, authorized and
  unauthorized.
- **Any change to authentication or authorization.** No exceptions, however
  small.
- **Any change touching credited hours.**
- **Any new configuration requirement or boot guard** — assert that it fails
  closed.
- **Any migration** — assert idempotency.
- **Any security fix** — assert the vulnerable behaviour is gone.

**Not required:**

- Pure refactors with no behavioural change, where the existing suite already
  covers the behaviour. The suite passing unchanged *is* the evidence.
- Documentation-only changes.
- Dependency bumps with no behavioural change.

**Judgement:** new UI components. Test behaviour and crash-resistance; do not
snapshot-test styling, which produces brittle tests that fail on every visual
tweak and train people to regenerate snapshots without reading them.

### 7.5 Regression prevention

The suite's job is to make old bugs stay dead. Practices that make it work:

- **Name regression tests after the defect**, not the function. A test called
  `routes.eventIdCollision.test.js` explains itself in a failure report; one
  called `test event creation` does not.
- **Assert the specific failure**, not merely that something threw.
- **Keep the suite fast.** 20–27 seconds is fast enough to run before every
  push. A slow suite gets skipped, and a skipped suite prevents nothing.
- **Never delete a failing test to make a build pass.** If a test is wrong, fix
  it and explain why in the commit message. Deleting it discards the only record
  that the behaviour ever mattered.
- **Treat flakiness as a defect.** See §3.2.

---

## 8. Deployment philosophy

### 8.1 Current model

Single-server deployment. Node.js (pinned `>=24.0.0 <25`) serving an Express
application with an SQLite database via `node:sqlite`, fronted by a built Vite
SPA. Background workers and a scheduler run in-process. Realtime updates use
Socket.IO.

Deployment is documented in
[`operations/pilot-deployment-runbook.md`](operations/pilot-deployment-runbook.md)
and gated by
[`operations/release-checklist.md`](operations/release-checklist.md).

**Deploy tags, not branches.** `git checkout vX.Y.Z` pins exactly what is
running. Deploying a branch means the deployed artifact changes underneath you.

Key operational facts worth knowing before you need them:

- The API port is **`API_PORT`**, defaulting to **5050**. It is *not* `PORT` —
  setting `PORT` has no effect, which is a genuine trap and has already cost
  debugging time.
- Single-instance by design: `server/instanceLock.js` prevents two processes
  competing over the same database.
- Graceful shutdown (`server/shutdown.js`) drains in-flight requests, stops the
  notification and export workers and the auto-select scheduler, then closes the
  database.
- Response compression is mounted **first**, before helmet and the routers, with
  `threshold: 1024`. Bodies under ~1 KB are intentionally not compressed, which
  is why `/health` returns uncompressed.

### 8.2 Environment requirements

Production boot **fails closed** without these. The failure is deliberate
(§6.1, §6.2):

| Variable | Requirement |
|---|---|
| `JWT_SECRET` | Required. Long, random. Placeholders and weak values rejected. |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Required. |
| `APP_URL` | Required for correct password-reset links. |
| `EMAIL_FROM` | Sender identity. |
| `WEV_DB_PATH` | Database location. |
| `API_PORT` | Optional; defaults to 5050. |
| OAuth credentials | Only if OAuth is enabled. |

`.env.example` is the template. Never commit a populated `.env` (§6.4).

### 8.3 Database and migrations

Schema evolves through **additive** `ALTER TABLE ... ADD COLUMN` guards executed
at initialization — 16 of them at 1.1.0 — each idempotent, so a restart against
an existing database is a no-op. There is no migration-file framework.

**Rule: migrations are additive.** No column drops, no type changes, no
destructive rewrites in an automatic startup path. A failed additive migration
leaves a working database; a failed destructive one may not.

Non-additive changes need an explicit, separately-run, tested, documented,
backed-up migration — and they are a strong signal of a major release (§4.2).

`server/migrate_usernames.js` is a standalone one-off with test coverage. That
is the pattern for anything that cannot be an idempotent additive guard.

### 8.4 Health checks

`/health` returns:

```
{"status":"ok","database":"connected","writable":true,"version":"1.1.0"}
```

Each field earns its place:

- **`status`** — the process is up and serving.
- **`database`** — connectivity, not merely process liveness. A server that is
  up but cannot reach its database is not healthy, and a naive check would call
  it healthy.
- **`writable`** — the database accepts writes. Read-only failure modes (disk
  full, permissions, filesystem remounted read-only) are real and would
  otherwise pass a connectivity-only check while every user action fails.
- **`version`** — read from `server/package.json`, so `/health` identifies
  exactly what is deployed. This is why the version bump must touch the server
  manifest (§4.1).

### 8.5 Rollback strategy

1. **Identify** the currently deployed version from `/health`.
2. **Check out the previous release tag** — e.g. `git checkout v1.0.0`.
3. **Install from the lockfile** with `npm ci`, so the dependency tree matches
   what that release was tested with.
4. **Restore the database if required.** Additive migrations mean a newer
   schema is generally readable by older code — a new column is simply ignored.
   This is a designed property of §8.3, not luck, and it is what makes
   code-only rollback usually sufficient. Verify restores with
   `bin/verify-restore.sh`; a backup that has never been restored is a
   hypothesis, not a backup.
5. **Verify** per §4.1 Step 7.

**Consider rolling back rather than fixing forward** when the fix is not
understood, when data integrity is at risk, or when diagnosis will take longer
than users can tolerate. Rolling back is not an admission of failure; it is the
cheapest way to stop the bleeding while you think.

### 8.6 Why rollback tags are mandatory

Because "we can always go back" must be a verified fact, not a hope.

Every operation that moves `main` non-trivially requires a pushed rollback tag
first (§1.4). This is mandatory rather than recommended for three reasons:

1. **It makes the operation reversible before it is attempted.** The
   2026-07-31 consolidation moved `main` forward 48 commits. Because
   `backup/main-pre-consolidation-2026-07-31` existed and was pushed, undoing
   it was a one-line, non-destructive operation at every point.
2. **It removes the pressure that causes second mistakes.** Irreversible
   operations invite rushed judgement. A rollback tag converts a tense
   operation into a routine one.
3. **A local-only tag is not a backup.** Pushing costs seconds and covers the
   case where the machine, not the branch, is what you lose.

The naming convention `backup/<purpose>-<YYYY-MM-DD>` is chosen so that tags
sort together, self-document, and never collide.

**Never** create a *branch* named `backup/*`. Branches move; a backup that can
move is not a backup. This repository already learned that from
`stabilization-backup-pre-purge`, which despite its name was not a backup of
anything (§1.1).

---

## 9. Technical debt register

Maintained. Review at every release. Add items when you find them; remove them
when they are done, not when they become uncomfortable to look at.

**Classification:**

- **Critical** — creates real risk of outage, data loss, or security exposure.
  Address in the current or next cycle.
- **Medium** — degrades reliability, review quality, or velocity. Schedule
  deliberately.
- **Low** — cosmetic or convenience. Fix opportunistically.

### Critical

#### TD-1 — `npm ci` is not enforced in CI

- **Risk:** the exact defect described in §5.4 recurs, undetected. `main` becomes
  undeployable while every other check reports green.
- **Why critical:** this already happened once and stayed hidden for four days.
  Nothing currently prevents a repeat.
- **Action:** add `npm ci` as the **first** required check in CI, ahead of test,
  build, and lint. Also add a check that fails if any `package-lock.json` exists
  outside the repository root (§5.3).
- **Effort:** small. **Opened:** 2026-07-31.

### Medium

#### TD-2 — Branch protection is not enforced on `main`

- **Risk:** §2.4's rules are currently convention, enforced by discipline alone.
  A direct push or force-push to `main` is technically possible.
- **Action:** enable branch protection on `origin/main`: require PR, require the
  four status checks, require one review, forbid force-push and deletion.
- **Effort:** small, configuration only. **Opened:** 2026-07-31.

#### TD-3 — 90 lint warnings

- **Detail:** all `no-unused-vars`, zero errors. Mostly dead imports left by the
  route split in `d8672a4`.

  | File | Warnings |
  |---|---|
  | `server/routes/userRoutes.js` | 21 |
  | `server/routes/authRoutes.js` | 10 |
  | `server/routes/accountRoutes.js` | 7 |
  | `server/routes/contentRoutes.js` | 6 |
  | `src/components/EventShiftsTab.jsx` | 5 |
  | remainder, across 12 files | 41 |

- **Risk:** 90 tolerated warnings are 90 places a *new*, meaningful warning can
  hide. The number normalizes into background noise.
- **Action:** clear them in a `chore/lint-unused-imports` branch, then consider
  failing the build on new warnings to prevent regrowth.
- **Effort:** small, mechanical, low-risk. Good first contribution.
  **Opened:** 2026-07-31.

#### TD-4 — Historical branch archival pending

- **Detail:** `v1.1-security-accessibility-ux` (`6036b4c`) and
  `stabilization-backup-pre-purge` (`fe14d19`). Both are **local-only** — the
  remote holds only `refs/heads/main`. Both are ancestors of `main` with **zero
  unique commits**, and both tips are pinned by pushed tags.
- **Risk:** low in substance, medium in confusion. They are the residue of the
  arrangement §1.1 exists to prevent, and their names still mislead.
- **Action:** after ~1 week of production stability, rename both under
  `archive/`. After ~1 month, delete with `git branch -d` (never `-D`),
  re-verifying the §2.5 conditions. Not urgent; deletion is never urgent.
- **Effort:** minutes. **Opened:** 2026-07-31.

#### TD-5 — Consolidation audit worktree still present

- **Detail:** the throwaway branch and linked worktree created for the
  2026-07-31 consolidation audit, pinned at `9ae59db`. An ancestor of `main`
  with no unique commits.
- **Action:** remove the worktree and delete the branch once the release has
  settled.
- **Effort:** minutes. **Opened:** 2026-07-31.

### Low

#### TD-6 — `internal tooling scratch/` artifacts tracked

- **Detail:** 5 tracked files, 8,400 bytes total, and `internal tooling scratch/` is **not**
  gitignored, so more will accumulate:
  - `internal tooling scratch/brainstorm/51970-…/state/server.pid` — stale PID `51970`
  - `internal tooling scratch/brainstorm/52186-…/state/server.pid` — stale PID `52186`
  - `internal tooling scratch/brainstorm/52186-…/state/server-stopped`
  - `internal tooling scratch/brainstorm/52186-…/content/context-message-layouts.html`
  - `internal tooling scratch/brainstorm/52186-…/content/waiting-after-context-layout.html`
- **Risk:** low but real. Stale PID files shipped inside a release are actively
  misleading — during triage someone will eventually check whether PID 51970 is
  alive. Verified that no code or configuration references the path.
- **Action:** add `internal tooling scratch/` to `.gitignore` with an explanatory comment
  (§6.5), then `git rm --cached` the five files.
- **Effort:** minutes. **Opened:** 2026-07-31.

#### TD-7 — `v1.0.0-pilot` tag is local-only

- **Detail:** exists locally, never pushed. `v1.0.0` was pushed.
- **Action:** push it for completeness, or delete it locally. Decide rather than
  leaving an inconsistency someone must investigate later.
- **Effort:** trivial. **Opened:** 2026-07-31.

#### TD-8 — `node:sqlite` is experimental

- **Detail:** emits an experimental warning on every boot; the `<25` Node upper
  bound exists to contain the risk (§5.1).
- **Risk:** deferred, not present. It becomes real at the next Node major, or if
  the API changes.
- **Action:** re-evaluate before any Node major upgrade. Related to §10.1.
- **Effort:** unknown; assessment only for now. **Opened:** 2026-07-31.

### Register maintenance

Review at every release. When closing an item, note the commit that closed it.
When an item is deliberately deferred, record *why* — an item that keeps
reappearing without explanation is either mis-classified or genuinely
unimportant, and either way the register should say which.

---

## 10. Future scaling roadmap

Architectural decisions we are **deliberately not making yet**. Each entry
records why it may become necessary, the concrete trigger that would justify it,
and what it would cost.

**The governing principle:** every item here is a real improvement and also real
added complexity. Adopting one before its trigger fires means paying the
complexity immediately for a benefit that arrives later, or never. The triggers
exist so the decision is made on evidence rather than enthusiasm.

### 10.1 PostgreSQL migration

- **Why it may become necessary.** SQLite via `node:sqlite` is a genuinely good
  fit today: single server, modest concurrency, no separate service to operate.
  It constrains three things — concurrent writes are serialized, the database is
  tied to one machine's filesystem, and horizontal scaling is impossible.
- **Triggers.** Write contention appears under normal load (lock timeouts,
  slow writes during event sign-up bursts). A second application instance is
  needed for availability or load. A managed, point-in-time-recoverable database
  becomes a district procurement requirement. Multi-district tenancy (§10.7)
  arrives — that is the most likely forcing function.
- **Tradeoffs.** Gains: real concurrency, network-independent storage, mature
  operational tooling, and it removes the experimental-API exposure in TD-8.
  Costs: a service to run, back up, monitor, and secure; connection pooling;
  a data migration with a tested rollback; SQL dialect differences across the
  query layer — including the SQL-side filtering, sorting, and distance
  calculation added in 1.1.0.
- **Do not adopt** to "be ready". Adopt when a trigger fires.

### 10.2 Redis adoption

- **Why it may become necessary.** Several pieces of state are currently
  in-process: rate-limiter counters, the auto-select scheduler, Socket.IO
  connection state. All are correct for exactly one instance — and
  `instanceLock.js` enforces that assumption. The moment a second instance
  exists, every one of them becomes wrong: rate limits become per-instance
  (trivially bypassed by reconnecting), the scheduler double-runs, and realtime
  events reach only the clients attached to one instance.
- **Triggers.** A second application instance, for any reason. Session or cache
  state must outlive a restart. Socket.IO needs an adapter to broadcast across
  instances.
- **Tradeoffs.** Gains: shared state, correct distributed rate limiting, a
  working Socket.IO adapter, distributed locks. Costs: another service; a new
  failure mode (what happens when Redis is down?); cache-invalidation bugs; and
  the temptation to move state there that should be in the database.
- **Note.** This is tightly coupled to §10.1 and §10.7. Multi-instance is a
  single decision with three consequences, not three independent projects.

### 10.3 Email infrastructure

- **Why it may become necessary.** SMTP works and is a hard production
  requirement (§6.2). What is missing is *deliverability*: without SPF, DKIM,
  and DMARC, mail to school domains — which typically filter aggressively — will
  land in spam. Password-reset mail in spam is indistinguishable from broken
  account recovery.
- **Triggers.** Users report unreceived reset or verification mail. A district
  requires authenticated sending. Volume exceeds a basic relay's limits. Bounce
  and complaint tracking becomes necessary.
- **Tradeoffs.** Gains: deliverability, bounce handling, suppression lists,
  visibility into what was actually delivered. Costs: DNS configuration per
  domain; provider cost and lock-in; a webhook path for bounces; templates to
  maintain.
- **Foundations already present.** Outbox worker, retention policy, opt-out,
  and escaping tests. The remaining work is largely operational rather than
  architectural — which is exactly why it is worth doing early relative to its
  cost.

### 10.4 OAuth

- **Why it may become necessary.** Schools live in Google Workspace or Microsoft
  365. "Sign in with Google" removes password management entirely for most users
  — and password reset is the single largest support burden for a volunteer
  platform used by teenagers.
- **Triggers.** A district requires SSO. Password-reset support volume becomes
  significant. Onboarding friction measurably suppresses sign-ups.
- **Tradeoffs.** Gains: less friction, no passwords to leak for those users,
  a plausible path to district-managed identity. Costs: per-provider credential
  management and rotation; redirect-URI configuration that is easy to get subtly
  wrong; account-linking complexity when someone has both a password and a
  provider identity; and a hard question — what happens when a student's school
  account is deprovisioned at graduation but their volunteer record must persist?
- **Status.** Nearest to shippable of anything in this section. Google,
  Microsoft, and Apple providers are scaffolded with test coverage, and a
  `ConnectedAccounts` UI exists. Remaining work is real credentials, a careful
  redirect-URI review, and the account-linking and deprovisioning decisions
  above — which are product decisions, not code.

### 10.5 PWA and mobile

- **Why it may become necessary.** Volunteers use phones, frequently at event
  sites with poor connectivity. 1.1.0 did the responsive and accessibility work
  — safe areas, touch targets, dialog semantics — but there is no service worker
  and no manifest, so there is no installability and no offline capability.
- **Triggers.** Volunteers need event details or check-in where connectivity is
  unreliable. Organizers ask for a home-screen app. QR attendance (§10.6) is
  built and needs to work offline at the door.
- **Tradeoffs.** Gains: installability, offline reads, faster repeat loads,
  push notifications. Costs: service workers are a genuine source of hard bugs —
  stale caches serving old code after a deploy is the classic one, and it looks
  exactly like "the fix didn't deploy". Requires a deliberate cache-versioning
  strategy tied to releases, and offline writes raise conflict resolution.
- **Recommendation.** If adopted, start with offline *reads* only. Offline writes
  are a much larger commitment and should be a separate decision.

### 10.6 Analytics

- **Why it may become necessary.** Districts will ask whether the programme
  works: participation rates, hours served, which events fill, who is
  underserved. Today those questions require ad-hoc queries.
- **Triggers.** A district requests reporting. Organizers need dashboards.
  Product decisions need usage evidence rather than intuition.
- **Tradeoffs.** Gains: evidence for product decisions, reporting that supports
  adoption. Costs: aggregation queries competing with transactional load —
  a direct argument for §10.1; a privacy surface that must be designed, not
  accreted; and a strong pull toward third-party analytics that would be
  inappropriate for a platform holding minors' data.
- **Hard constraint.** WeVolunteer holds data about students, many of them
  minors. **Any analytics must be first-party, aggregate, and minimal.** Do not
  add third-party tracking. This is not a preference; it is a legal and ethical
  boundary.
- **Foundations.** The auto-select scheduler and audit routes already produce an
  event stream. No aggregation layer exists.

### 10.7 Multi-district tenancy

- **Why it may become necessary.** The single largest architectural question
  facing the project. **There is no tenancy model today** — the schema assumes
  one organization. Every district beyond the first either needs a separate
  deployment or a schema that scopes data by organization.
- **Triggers.** A second district adopts WeVolunteer. Any requirement to
  isolate data between organizations. Per-district administration or branding.
- **Tradeoffs.** Gains: one deployment serving many districts; shared
  operational effort; a genuine path to scale. Costs: substantial and
  unavoidable — an organization-scoping migration across essentially every
  table; every query and every authorization check must become tenant-aware, and
  **a single missed scope is a cross-district data leak**; the admin model needs
  a new tier; and per-tenant configuration, branding, and data-export boundaries
  all follow.
- **This is a `2.0.0`** (§4.2). It is a breaking change requiring a migration
  guide and a tested rollback.
- **Strong recommendation.** Do this as a **dedicated design phase with its own
  written specification and security review, before any feature work depends on
  it.** Retrofitting tenancy into a system that has grown further is
  dramatically harder than doing it deliberately — and the failure mode is a
  data leak between school districts, which is close to the worst outcome this
  project could produce.
- **Sequencing note.** Multi-district almost certainly forces §10.1 and §10.2.
  Treat them as one programme, not three tickets.

### 10.8 Sequencing

Roughly ascending cost and risk, given today's foundations:

1. **Email deliverability** (§10.3) — mostly operational, foundations exist
2. **OAuth** (§10.4) — scaffolded and tested; needs credentials and decisions
3. **Lint and CI hygiene** (TD-1, TD-2, TD-3) — cheap, and TD-1 prevents a
   known recurrence
4. **PWA, offline reads** (§10.5) — self-contained
5. **Analytics** (§10.6) — needs a privacy design first
6. **PostgreSQL** (§10.1) — infrastructure change
7. **Redis** (§10.2) — arrives with multi-instance
8. **Multi-district tenancy** (§10.7) — dedicated design phase, `2.0.0`

This is a default ordering, not a commitment. A district requirement can
reorder it overnight, and that is fine — what matters is that the reorder is a
decision, made against the triggers above, rather than a drift.

---

## 11. Engineering lessons learned

The reasoning behind this document. Each lesson is drawn from something that
actually happened in July 2026.

### 11.1 From the consolidation

**Branch names are claims, and unverified claims mislead.** `main` was the least
current branch in the repository. `stabilization-backup-pre-purge` was not a
backup. Both names were confidently wrong, and both were believed. The fix is
structural, not naming discipline: one production branch, so there is only ever
one candidate answer.

**Audit before you merge.** The instruction that made the consolidation safe was
"do not merge immediately." The audit found the three branches were strictly
linear — `main` ⊂ `stabilization-backup-pre-purge` ⊂
`v1.1-security-accessibility-ux` — with **zero commits anywhere in the
repository unreachable from `v1.1`**. That single fact changed the operation from
a risky three-way merge into a fast-forward where content loss was
*impossible*. Fifteen minutes of `git merge-base` and `rev-list` turned a
dangerous operation into a safe one.

**Prefer the command that can prove you wrong.** `--ff-only` was chosen over
`--no-ff` because it *fails* if the containment assumption is false. `--no-ff`
would have succeeded either way, including when wrong. When a safer variant
exists that asserts your assumption, use it — it costs nothing and occasionally
saves everything.

**Check for orphaned work explicitly.** Five dangling commits existed: three
dropped stashes and two hook smoke tests. Rather than assume they were
disposable, their route inventories were compared against `v1.1` — 92 routes in
each, zero unique. Their apparent additions turned out to be whitespace variants
of code already present. That check took minutes and converted "probably fine"
into "verified fine."

**Additive changes are dramatically safer.** 1.1.0 was 183 files added, **0
deleted, 0 renamed**. That is why the consolidation could be validated so
confidently. Additive change is not always possible, but when it is, it is worth
choosing.

### 11.2 From the lockfile incident

**A green test suite does not mean the repository is installable.** Tests, build,
and lint all passed for four days while `npm ci` was broken. Different checks
prove different properties, and none of them substitute for each other.

**`npm install` inside a workspace package is the whole bug.** One command, run
in the wrong directory, produced a four-day latent outage. The root lockfile is
the only lockfile.

**A file that is version-controlled and ignored is worse than no file.**
`server/package-lock.json` looked authoritative, was committed, and had no
effect. It convinced everyone the dependency was recorded.

**Read the debug log when the error is generic.** npm's `EUSAGE` output led with
a usage dump; the four `Missing:` lines that constituted the actual diagnosis
were buried, and the real detail was in `~/.npm/_logs/`.

**Validate risky fixes out-of-tree first.** Reproducing the fix in a scratch
copy — confirming exactly 4 packages added, 0 removed, 0 re-versioned, and
`npm ci --dry-run` exiting 0 — took one minute and removed all uncertainty
before the repository was touched.

**Verify the fix by its effect, not its artifact.** The lockfile diff looked
right, but the fix was only *proven* by confirming `compression@1.8.1` resolved
after `npm ci`, was mounted in the app, and actually gzipped a 327 KB asset.

### 11.3 From the release process

**Verify assumptions immediately before acting, not from memory.** Before
pushing, `origin/main` was re-fetched to confirm it had not moved, and
`git merge-base --is-ancestor` confirmed the push would fast-forward. Both were
"obviously" true. Checking cost seconds.

**Confirm exit codes; do not read output.** A validation chain printed empty
`PIPESTATUS` values and had to be re-run with explicit `$?` capture. "It looked
like it passed" is not a gate, particularly when the next step is irreversible.

**Verify remote state against the remote.** Local `git tag` and `git branch -vv`
report the local view. `git ls-remote` reports what is actually published, and
that is the thing that matters. The `v1.1.0` tag was confirmed by dereferencing
`refs/tags/v1.1.0^{}` on the remote and comparing it to `main`.

**Fix forward rather than rewrite, and say what happened.** A partial commit
(`d713c4c`) was completed by a second commit (`ec6a70e`) instead of an amend.
One extra commit, complete honesty, identical tree.

**Version consistency is not cosmetic.** Bumping only the root manifest would
have left `/health` reporting `1.0.0` for a 1.1.0 deployment — a lie told at
exactly the moment during an incident when it would do most damage.

**A green build is not a release.** The 2026-07-30 incident — seven fixed
defects living only in an uncommitted working tree — is why
`operations/release-checklist.md` exists, and why every gate here runs against
the committed tree.

### 11.4 From the security hardening

**Fail closed, and fail loudly.** A server that refuses to boot without a real
`JWT_SECRET` is a visible problem someone fixes in a minute. A server that boots
with a placeholder is a silent total compromise that looks healthy on every
dashboard. Always prefer the loud failure.

**Enumerate the class, not the instance.** `.gitignore` ignored
`.env.production` and not `.env`, so a live `GOOGLE_CLIENT_SECRET` was
committed. The fix inverted the default: deny `.env.*`, allowlist templates
explicitly. Security defaults must not depend on someone remembering to add a
rule.

**Verify remediation across all reachable history.** Confirming the leaked
secret was gone meant walking every reachable commit, not checking branch tips.

**Audits find things you were sure about.** The 2026-07-30 auth audit found
**four broken auth flows** that had shipped and were believed working. Belief is
not verification, and authentication is the last place to rely on it.

**Document why a vulnerability does not apply.** The react-router advisory
assessment lives in `README.md`. That note is why `npm audit`'s two
high-severity entries did not block the release and why nobody re-derives the
analysis each time. An undocumented risk decision gets re-litigated forever, or
worse, silently reversed.

**Attach reasoning to protective rules.** Every non-obvious `.gitignore` rule,
and both load-bearing settings in `vitest.config.js`, carry comments explaining
what they protect and what happened without them — including measured failure
counts. Rules with reasons survive. Rules without reasons get deleted by the
next person who finds them inconvenient.

---

## Document maintenance

**Owner:** whoever is acting as release manager.

**Review:** at every release, and whenever an incident produces a lesson worth
keeping.

**Standard for changes:** this document is governance. Changes go through the
normal PR gate. When you change a rule, change the reasoning with it — and if
you cannot articulate the reasoning, that is a signal the rule may not belong
here.

**Add to §9** whenever debt is identified, and to §11 whenever an incident
teaches something. A register nobody adds to is a register nobody trusts.

---

*Established 2026-07-31 at `v1.1.0`. WeVolunteer — volunteer scheduling and
service-hour tracking for schools and community organizations.*
