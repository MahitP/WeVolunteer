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

### 6.7 Known accepted advisories

`npm audit` reports **three** high-severity entries, which are **two** distinct
advisories. Re-verified at the v1.2c final release review; the count was two at
v1.2b and the third arrived through a transitive dev dependency without any
change to this repository, which is the normal way this section goes stale.

**1 — react-router RSC-mode CSRF bypass** (two of the three entries).
[GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2),
counted twice via `react-router` and `react-router-dom`.

**Assessed as not applicable**, with the reasoning recorded in `README.md`: the
advisory is scoped to React Router's React Server Components mode. WeVolunteer
is a client-rendered SPA with no server components, so the attack surface the
advisory describes is never instantiated. Re-verified against the code — not
against the previous assessment — during the v1.2c release review: `src/main.jsx`
mounts `BrowserRouter`, and there is no `createBrowserRouter`, no
`RouterProvider`, and no route `loader`/`action` anywhere in `src/`.

**Never clear it with `npm audit fix --force`.** No fixed 7.x exists. The
`--force` resolution *downgrades* `react-router-dom` to 7.11.0, which npm itself
flags as a breaking change — trading a working router for the removal of a risk
this application does not carry.

Re-assess whenever the advisory is updated or the routing architecture changes.
If WeVolunteer ever adopts server components, **this assessment is void** and
must be redone before shipping.

Re-verified at v1.2c against the code rather than against the previous
assessment: `src/main.jsx` mounts `BrowserRouter`, there is no
`createBrowserRouter`, no `RouterProvider`, and no route `loader`/`action`
anywhere in `src/`. The advisory's range (`7.12.0 – 8.2.0`) still covers the
pinned `7.18.2` and **no fixed 7.x exists** — `npm audit fix --force` resolves
it by *downgrading* to `react-router-dom@7.11.0`, which is a breaking change
taken to remove a risk that is not instantiated. Do not run it.

**2 — brace-expansion denial of service.**
[GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895),
unbounded intermediate arrays in glob expansion.

**Assessed as not shipped, then remediated.** The path was
`server → nodemon → minimatch → brace-expansion`, and `nodemon` is a
`devDependency` used only by `npm run dev`. It was not installed by a production
`npm ci --omit=dev`, was not imported by any runtime module, and the input it
expands is a developer's own watch glob rather than anything a user supplies — so
it never touched the production runtime.

A non-breaking fix was available and has now been taken (`npm audit fix`, no
major bumps): `brace-expansion` 5.0.8 → 5.0.9, which also carried
`react-router`/`react-router-dom` 7.18.1 → 7.18.2 as an in-range patch bump.

It was deliberately **deferred** out of the v1.2c release review rather than
folded into it, because touching `package-lock.json` invalidates every gate that
had already been run against it. **That sequencing is the general rule, not a
one-off: a dependency change is its own commit, with its own four gates, never a
late amendment to a reviewed release.**

### 6.8 Step-up re-authentication (AAL2)

Added in v1.2b. Seven actions cannot be performed on the strength of a session
alone; the account holder must re-prove who they are within the last five
minutes. **The rules below are not style preferences. Each one closes a hole
that was open in this codebase.**

> **Gate the operation that does the thing, not the one that announces it.**
> The branch's own audit found two actions missing from this list, and both were
> the same mistake in different clothes. `POST /api/privacy/export` was gated
> and `GET /api/privacy/export/download/:id` was not — so the REQUEST was
> protected and the DISCLOSURE was not, and a completed archive sat behind a
> bare session for the seven days it is retained. `POST /api/oauth/link` was
> gated and `POST /api/oauth/disconnect` was not, so "adding a credential
> requires step-up" held in one direction only.
>
> Ask, for each gated action: *where does the effect actually land, and is there
> a second endpoint that reaches it?* Rule 3 below already says to gate both
> paths when two of them make the same state change; these two were missed
> because the second path did not look like the same change — one only reads,
> and one only removes.

#### The registry is the only list

`server/sensitiveActions.js` enumerates every action that requires step-up,
which methods can satisfy it, and which of its parameters the grant binds. It
imports nothing but `node:crypto`, so the client imports the same module and
the two cannot drift.

*Why one list.* Before this, four endpoints each ran their own
`bcrypt.compare` and a fifth ran nothing. Individually every one of them was
correct; collectively they were unreviewable, because **the endpoint that
forgot its check looked exactly like the endpoint that never needed one.**
That is how `POST /api/privacy/export` — a complete copy of everything an
account holds, for a population that is mostly minors — went years with no
gate at all. Nobody removed it. It was never added, and nothing could show
that.

#### Never re-introduce an inline credential check

Sign-in (`server/routes/authRoutes.js`) is the only place in the application
that compares a password to decide who someone is. `server/reauth.js` is the
only other place that compares one at all, and it does so on behalf of the
registry.

If you find yourself adding `bcrypt.compare` to a route handler, the answer is
a registry entry and a `requireAAL2` gate. An inline check is also, always, a
password oracle on an endpoint that was not designed to be one — the audit
found `POST /api/oauth/link` allowing 600 attempts per window against any
address, which made it a better brute-force target than the login form.

#### A gate is not the check

`requireAAL2('<action>')` is an **early refusal**. It reads
`principal.aalAction`, changes nothing, and exists so an unverified caller is
turned away before the handler does any work.

The property that makes step-up worth having comes from `consumeChallenge`
running **inside the handler's own transaction**, against the action and the
arguments the handler is actually about to perform. Use `spendChallenge` from
`server/reauthResponses.js`, which reads the three bindings off the request so
no route can pick up two of the three.

A route that gates and never spends leaves the grant live for its remaining
five minutes: the same challenge id re-presented performs the action again,
and again. **That omission is invisible** — every functional test of such a
route passes. Guard 5 in `server/authz.completeness.test.js` fails the build
on it.

#### Four bindings, and each one closes a real hole

| Binding | Without it |
|---|---|
| **action** | Verifying to change your email deletes your account |
| **params** | Verifying to move your address to `a@x.com` moves it to the attacker's — the binding most step-up implementations omit, and the one an attacker with a stolen session actually reaches for |
| **session** | A grant obtained in the victim's browser is spent from the attacker's |
| **single use** | A replayed grant is a second free sensitive action |

Params must be **exactly** the keys the registry declares — no more, since
`paramsHash` ignores the rest, and no fewer, since a missing key hashes as
absent and will not match a grant that had it. Bind the value the handler is
about to write, never the one the client claimed when it opened the challenge.

#### Guessing is bounded twice, and both are needed

`MAX_ATTEMPTS` (5) bounds one challenge. On its own it bounds nothing an
attacker cares about: **opening a fresh challenge costs one request and starts
a new counter at zero.** `MAX_ACCOUNT_ATTEMPTS` (15 per 15 minutes, summed
across the account's challenges) is what makes it a limit on guessing rather
than a limit on a row, and `reauthLimiter` in `app.js` closes the same hole
per IP. Neither subsumes the other.

#### Provider re-consent must actually re-authenticate

An account with no password proves itself by re-consenting at its identity
provider. That substitution is only real if the provider genuinely
re-authenticates: `google.js` sends `prompt=login` **and** `max_age=0`, and
`microsoft.js` sends `prompt=login`. Without them the provider answers from
the session it already holds, which proves nothing a stolen session did not
already prove — **and it fails silently, because the flow still completes.**

`grantByOAuth` then compares the returned `sub` against the
`provider_user_id` on *this* user's linked row. That comparison, not the
successful round trip, is the security of the path: a completed OAuth flow
attests who is at the keyboard and nothing more.

#### The client half: one spelling, one string, one storage

`src/utils/stepUp.js` imports `REAUTH_CHALLENGE_HEADER` and `SENSITIVE_ACTIONS`
**from `server/sensitiveActions.js`**, the same mirror pattern `src/authz.js`
uses for the capability table, and for the same reason.

*Why it matters more here than it looks.* A retyped header name is the worst
available bug in the feature: the client presents its grant under a spelling the
server never reads, every request silently resolves to AAL1, and every gated
action answers `reauth_required` — which sends the UI back to the verification
dialog it has just come from, for ever, with no error anywhere. A retyped
**action** name is the same class: unregistered actions are refused at
`/challenge`, and a wrong-but-valid action opens a grant that can never be spent.
`STEP_UP` is validated against the registry at module load so a drifted name is a
build-time failure rather than a 403 in production.

**A challenge id must never touch `localStorage`.** The provider re-consent leg
leaves the site, so the record has to survive a navigation — `sessionStorage`,
scoped to the tab and cleared when it closes, matches the five-minute life of the
thing it holds. In `localStorage` a verification id would still be sitting on a
shared school Chromebook after the student walked away. `signOut` clears both
records for the same reason it clears `notif_toast_shown`.

**The client must not hold a second opinion about what credentials an account
has.** `VerifyIdentityModal` renders only the methods the challenge returned.
Deciding locally is how a provider-only account gets asked five times for a
password it does not have and is then locked out of its own challenge.

#### Adding a credential requires proving identity — through every door

If two code paths make the same state change, gate both. `POST /api/oauth/link`
and the OAuth callback's `auto_linked` branch both write an `oauth_accounts`
row, and that row is a new way to sign in. Gating only the first would have
left the rule true of the door users do not walk through. A callback arriving
mid-redirect cannot be interrupted to ask for a verification, so the grant is
opened before the redirect and carried across it in the signed state.

### 6.9 Current verified security posture

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
| Privacy export | IDOR-tested; step-up gated as of v1.2b on **both** the request (`data.export`) and the download (`data.download`, bound to the job id) |
| Secret scanning | Pre-commit hook installed |

Added on the v1.2 branch, pending release:

| Control | Verified behaviour |
|---|---|
| Authorization | Capability-based; no role-string comparison anywhere in `server/` or `src/`, enforced by five build-failing guards |
| Sensitive actions | Seven actions behind `requireAAL2`; grants bound to action, params and session; single-use; five-minute lifetime |
| Step-up brute force | Bounded per challenge (5), per account (15 / 15 min) and per IP (`reauthLimiter`) |
| Provider re-consent | `prompt=login` + `max_age=0` (Google), `prompt=login` (Microsoft); returned `sub` compared to the account's linked row |
| Adding a sign-in credential | Requires step-up through both the `/api/oauth/link` and `auto_linked` callback paths |
| Removing a sign-in credential | `POST /api/oauth/disconnect` requires step-up (`oauth.unlink`, provider bound); the last-credential guard is checked **before** the grant is spent |
| Exported archive caching | `Cache-Control: no-store` on the download, asserted on the emitted header — `res.download` otherwise defaults to `public, max-age=0`, and a cached copy is served without reaching the step-up gate at all |
| Session identity | Every session carries a `jti`; provider sign-ins are per-device revocable |
| Schema changes | Versioned migration registry with source checksums re-verified on every boot |
| Error capture | Redacts before storing; hashes the user id; stores a route *pattern*, never a URL; no request body field exists to store one in |
| Error intake | Unauthenticated by design, bounded by a per-IP limiter, an 8 kB body cap, and a storage ceiling on client-created groups |

---

### 6.10 Error capture and retention (v1.2c)

The application records its own failures. That means a table full of text
written by the code paths most likely to be holding somebody's data at the
moment they broke — so the rules below are about what must **never** reach it,
and each one names the reason rather than the rule alone.

The population is mostly minors. PII is the whole risk here, and every decision
in this subsection exists because of it.

#### The four decisions that carry the privacy property

1. **Redaction happens before storage, never on the way out.** A message is
   rewritten before it is written down, so a leak cannot be undone by a later
   reader, a database dump, or a backup. `redactMessage` in
   `server/errorReporter.js` replaces, in this order — most specific first, so a
   JWT is recognised as a JWT before the generic long-token rule eats its
   segments: email addresses (matched with **Unicode** letter classes, not
   `A-Za-z`), JWTs, `Bearer` tokens, step-up challenge ids, certificate codes,
   hex runs of 24+ characters, written phone numbers in 3-3-4 grouping, and
   digit runs of 7+. Truncation happens **last**, so a secret near the end of a
   long message is redacted before the cut rather than preserved by it.

   Two of those rules were added by release reviews that *probed* the
   redactor with realistic PII instead of reading it, and both were **partial**
   failures rather than absent ones — the more dangerous shape, because the
   stored row looks redacted:

   - The digit-run rule named "a phone number" among the things it caught and
     only ever caught unformatted ones. `555-123-4567`, `555.123.4567` and
     `+1 (555) 123-4567` — every way a person actually writes one — went
     through untouched (v1.2c review).
   - The email rule was ASCII-only, so it did not stop at a non-ASCII name, it
     matched from the ASCII run that reached the `@`:
     `josé.garcía@school.org` was stored as `josé.garcí[redacted]`, which is a
     student's given name and most of their surname. Accented names are ordinary
     in a school district, and `notificationWorker.js` records the message of a
     failed send verbatim, so one bounced email is the whole path (v1.2c final
     review).

   **What redaction does NOT cover, stated so nobody assumes otherwise:**
   personal names, street addresses, IP addresses, dates of birth, and
   free-text a caller chose to interpolate. There is no pattern for a name, and
   a rule broad enough to catch one would redact the words that make a message
   diagnosable. The control for those is upstream and is the real one: *do not
   interpolate user data into an error message.* Every `throw new Error(...)` in
   `server/` was checked against this at v1.2c and none carries a name, an
   address or an email; the rules above are the second line, not the first.
2. **The user is a hash, never an id.** `user_hash` is a one-way digest. It
   answers "how many distinct people hit this" — which is the only question
   triage needs — without naming any of them.
3. **The route is a pattern, never a URL.** `/users/:id/profile`, never
   `/users/user-student-2/profile`. Anything not matching an approved pattern in
   `server/clientRoutes.js` is stored as the literal `'unknown'`. Query strings
   and fragments are dropped before matching, which is what keeps a reset token
   or an OAuth `code` out of the table.
4. **There is no request-body column.** Not "we don't populate it" — the schema
   has nowhere to put one. A field that does not exist cannot be filled in by a
   future change that seemed harmless.

`context` is an allowlist, not a denylist: only the keys in `CONTEXT_KEYS` are
kept, each redacted and truncated to 200 characters. A denylist fails on the
first thing nobody thought of; an allowlist fails closed. `password`,
`newEmail` and `challengeId` are not on it and therefore cannot be stored,
whatever a caller believes it is passing.

#### These records also leave the building

Since v1.3, the same four decisions govern a second destination. When
`BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST` are set,
`server/telemetry.js` sends a structured record to Better Stack for every error
`recordError` captures, plus a sampled access log, lifecycle events and the
audit action names. The rule it is built around is one line:

> **Better Stack may hold exactly what `error_events` may hold, and nothing
> more.**

That is why this subsection's bar was reused rather than a new one written: it
has been reviewed twice, by people probing the redactor with realistic PII.

The consequence for anyone editing this area: **widening `CONTEXT_KEYS`, or
relaxing `redactMessage`, now also widens what goes to a third party.** A field
added here for a good local reason — "it would help to store the search term" —
is a field posted to a vendor whose team roster is not this application's
permission model. `error.read` is `SUPER_ONLY`; the Better Stack team is not.

Telemetry itself is a separate allowlist in `server/telemetry.js` and cannot
carry a key it does not name, so the failure mode is not automatic. It is
narrower than that and worth stating plainly: a value that reaches an
already-allowed field goes out with it.

See [`docs/operations/betterstack.md`](operations/betterstack.md) for what is
sent, what is never sent, the delivery guarantees, and the operator decisions
the integration forces.

#### Groups, events, fingerprints

An **error group** is one *problem*. An **error event** is one *occurrence* of
it. They are separate because they are retained differently and answer different
questions: the group carries the counter and the status, the events carry the
evidence.

A **fingerprint** is `sha256(source, kind, normalised message, route)`, joined
with a NUL — a separator chosen because it cannot occur in any of the joined
values, so no two distinct inputs can collide by shifting where one field ends.
Normalisation collapses ids and numbers, so the same bug reported a thousand
times with a different id in the message is one group, while genuinely different
failures stay apart.

**Sources** are `server`, `client` and `worker`, and the source is assigned
server-side on every path. A client that sends `source: 'server'` is ignored
rather than refused — refusing would tell it which values matter.

#### Lifecycle

    open ──(someone triages it)──> resolved ──(it happens again)──> open
      │                                 ▲
      └────────(not worth fixing)──> ignored

`resolved` is a statement about *belief*, not about the code. Nothing verifies
that the fix worked, so a group that recurs after being resolved **reopens
itself**: the next occurrence moves `last_seen_at` and sets `status` back to
`open`. A silently-still-broken thing sitting in a "resolved" list is worse than
no dashboard at all, because it converts an unknown problem into a wrong answer.

Status changes are audit-logged through `server/auditLog.js`, in the **same
transaction** as the change — no status change without a record of who made it,
and no audit row describing a change that rolled back. Reads are deliberately
not audited: `admin_audit_logs` has no retention sweep, so auditing every
dashboard poll would create an unbounded write path in a table nothing expires,
and bury the consequential actions under "the owner looked at a list".

#### Limits — every one of them measured, not aspirational

| Bound | Value | Why it is not covered by the others |
|---|---|---|
| Intake rate | 20 per IP / 15 min (`ERROR_REPORT_RATE_LIMIT`) | Bounds *requests* from one address; does nothing about a thousand addresses |
| Body size | 8 kB, mounted **path-scoped before** the global 100 kB parser | Mounted after it, the global parser wins and the cap is a no-op |
| Events per group | 50 | The counter keeps climbing; only the duplication stops |
| Events per hour | 100 per fingerprint | Bounds a burst that would otherwise fill the evidence quota in seconds |
| Client-created groups | 500, then a single `client-overflow` row | The fingerprint is computed over a client-supplied message, so the number of distinct groups is attacker-chosen and one line of script |
| Reports per page load | 5, deduped by message + first frame | Client-side; a render loop produces thousands per second and no server bound stops the traffic leaving |

Every response from `POST /api/errors/report` is `202`, whether the report was
stored, collapsed, dropped at the ceiling, or lost. That uniformity is a
security property: a distinct answer for "ceiling reached" is a progress meter
for an attack, and a failure status invites a retry that amplifies the flood
that caused it.

#### Retention

| Rows | Kept for |
|---|---|
| Events | 30 days |
| Resolved / ignored groups | 30 days |
| Open groups | 180 days |
| Client groups seen exactly once | 7 days |

The sweep is idempotent and never throws — it runs beside the other sweeps in
`utils.js`, where an exception would abandon every sweep registered after it.

**Consequence for readers of the dashboard:** the occurrences-by-day chart is a
30-day window over *retained evidence*, not an all-time total. Group counters
outlive the events that produced them, so a group can legitimately show 2,000
occurrences and no evidence at all.

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

Schema evolves along two paths, and which one applies depends on the change.

**Path 1 — additive guards (the default).** `ALTER TABLE ... ADD COLUMN` guards
executed at initialization, each idempotent, so a restart against an existing
database is a no-op. This remains the right mechanism for almost everything.

**Path 2 — the versioned migration registry**, added in v1.2a and living in
`server/migrations/`. Everything structural from v1.2 onward goes here, because
the changes that motivated it are table REBUILDS — SQLite cannot alter a `CHECK`
constraint — and those need ordering, a record of what already ran, and a
rollback story that an idempotent guard cannot provide.

How the registry works:

- Each migration is a numbered module (`001_authz_roles.js`,
  `002_user_capabilities.js`) exporting `{ version, name, up, fileUrl }`.
  `server/migrations/index.js` holds the ordered list and runs it from
  `initDatabase()`.
- Applied migrations are recorded in the **`schema_migrations`** table
  (`version`, `name`, `applied_at`, `checksum`), so each runs exactly once.
- Each migration runs in **its own transaction**, with the `schema_migrations`
  row written inside the same transaction as the DDL it describes — a failure
  leaves the database exactly as it was. A migration that must manage its own
  transaction sets **`ownTransaction: true`**; the table rebuilds do, because
  `PRAGMA foreign_keys` is a silent no-op inside an open transaction and must
  therefore be set before `BEGIN`.
- A **checksum** over the migration's canonicalised module source (comments
  stripped, whitespace collapsed) is stored on apply and re-verified on every
  boot, so an already-applied migration cannot be quietly edited. See §8.5 for
  what to do when that check fails.

**Rule: migrations are additive — with one sanctioned exception.** No column
drops, no type changes, no destructive rewrites in an automatic startup path,
*except* a table rebuild in the registry that carries the full guard set below.
A failed additive migration leaves a working database; a failed destructive one
may not.

**The sanctioned destructive rebuild.** `001_authz_roles.js` performs a
`DROP TABLE users` rebuild automatically from `initDatabase()`. That is a real
exception to the rule above, and it is permitted only because every one of these
guards is present — `001_authz_roles.js` is the reference implementation, and a
future rebuild is expected to copy its structure:

1. **Back up first.** Take and verify a backup before deploying a release that
   introduces a rebuild (`bin/verify-restore.sh`).
2. **Pragma-took-effect assertion.** After `PRAGMA foreign_keys = OFF`, read the
   pragma back and abort if it is not actually `0`. Setting it inside an open
   transaction silently does nothing, and with foreign keys live a
   `DROP TABLE users` cascade-deletes most of the database. Nothing else catches
   this: the copied rows survive, `foreign_key_check` finds no violation because
   a cascade deletes children rather than orphaning them, and nothing throws.
3. **Explicit column list, never `SELECT *`.** Column *order* differs between
   databases, because it depends on the order historical `addColumnIfMissing()`
   calls happened to run. On the pilot database `email_verified` sits before
   `account_status`/`deleted_at`; on a fresh seed it sits after. A `SELECT *`
   copy writes each value into whatever column shares its position, silently.
4. **Unknown/missing-column guard.** Compare `PRAGMA table_info` against the
   migration's expected column list and throw on either a column the migration
   does not know about (the copy would drop it) or one it expects and cannot
   find (the table is not in the state the migration assumes).
5. **Schema-derived child-row count comparison.** Snapshot the row count of
   every table holding a foreign key to the rebuilt table — derived from
   `sqlite_master`/`PRAGMA foreign_key_list`, not hardcoded, so newly added
   tables are covered automatically — and compare after the rename. A loss
   throws, and the surrounding transaction rolls it back, which turns the
   catastrophic path into a recoverable one.
6. **Row-count equality** on the copy itself, and a final
   **`PRAGMA foreign_key_check`** before commit.

Anything that cannot meet that bar is not an automatic startup migration.
`server/migrate_usernames.js` is a standalone one-off with test coverage; that
remains the pattern for a change too risky to run unattended.

**Path 3 — the same registry, on PostgreSQL.** A PostgreSQL database is created
at the destination rather than walked to it: `applyPostgresSchema` runs
`server/db/postgresSchema.js`, which is *generated* from a fully-migrated SQLite
database. That is right for a new database and does nothing for an existing one,
because every statement in the generated file is `CREATE TABLE IF NOT EXISTS`.

So migrations run on PostgreSQL too, under two rules:

- **`POSTGRES_BASELINE_VERSION`** (in `server/migrations/index.js`) is the last
  migration whose effect a deployed PostgreSQL database already has from the
  generated DDL. It is **frozen**, not derived — it is a fact about databases
  already out in the world, and deriving it from the registry would tell every
  deployment that a change it never received is already applied. Everything at or
  below it is SQLite-only history and never runs on PostgreSQL.
- **Every migration above it must export `postgres: { up: async (db) => … }`**
  alongside its SQLite `up`. `runPostgresMigrations` throws at boot if one does
  not, and `server/migrations.postgres.test.js` fails the build before that.
  Refusing is deliberate: a skipped schema change is a production constraint
  violation on a value development accepts.

The two halves are usually different, and should be. `057_widen_event_categories`
is a create-copy-drop-rename rebuild on SQLite (which cannot `ALTER` a `CHECK`)
and four lines of `ALTER TABLE` on PostgreSQL (which can). Porting the workaround
would be a longer route to the same schema.

Bookkeeping is shared. A database that was empty when the schema was applied
records every registry version with checksum `'baseline'` — the DDL already
contained them, so there is no source to hash and the drift check skips those
rows. A database that was not empty records nothing new, and the runner walks it
forward, writing real checksums.

Run the PostgreSQL suites with a live server:

```
TEST_POSTGRES_URL=postgres://…/db npm test
TEST_POSTGRES_URL=postgres://…/db npm run test:postgres
```

Without the variable the PostgreSQL cases report as **skipped**, never as passed,
and the engine-independent guards (including the "every migration has a
PostgreSQL implementation" ratchet) still run.

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
5. **Expect `schema_migrations` to survive the rollback.** Rolling the code back
   does not roll the table back: it still holds rows for migrations the older
   code does not know about, and — if the rollback crosses a table rebuild —
   the schema those migrations produced is still in place. Older code ignores
   unknown rows, which is why this is usually harmless. It stops being harmless
   when you roll *forward* again: see the checksum procedure below.
6. **Verify** per §4.1 Step 7.

#### Migration checksum failures

The registry re-verifies every applied migration's checksum on boot and refuses
to start on a mismatch. There are three distinct causes and they need different
answers — the wrong one either re-runs a migration against a database it has
already changed, or masks a real discrepancy.

First, establish the one fact everything turns on: **is the migration's schema
change actually present in this database?** Inspect the schema by hand
(`.schema users`, `PRAGMA table_info(...)`) rather than trusting the row.

- **Change NOT present.** The row is lying about work that never happened.
  Delete it and restart so the migration runs for real:

  ```sql
  DELETE FROM schema_migrations WHERE version = <n>;
  ```

- **Change IS present, and the checksum scheme changed.** This is the expected,
  legitimate case after a release that alters how checksums are computed — v1.2a
  rebased them from the `up` function's source onto the canonicalised source of
  the whole migration file, which invalidates every previously recorded checksum
  at once. Do **not** delete the row. Backfill it:

  ```sql
  UPDATE schema_migrations SET checksum = '<current>' WHERE version = <n>;
  ```

  Get `<current>` from `node bin/migration-checksums.mjs`, which prints the
  checksum and the ready-made `UPDATE` for every registered migration. It opens
  no database and executes no SQL — it prints statements for you to review and
  apply.

- **Change IS present, and the stored checksum is NULL.** Same remedy: a NULL
  means the row predates the checksum column (added by `ALTER TABLE` for exactly
  this reason), not that anything is wrong. Backfill it with the `UPDATE` above.
  This is the one case the pre-v1.2a error message left an operator stranded on:
  it said "do NOT delete the row — investigate", with no next action.

- **Change IS present, and neither of the above explains it.** Now it is a real
  discrepancy: someone edited an applied migration. Do not backfill, because
  that would bless whatever the code now says over what actually ran. Work out
  what the deployed database really contains, and write a NEW migration to
  reconcile it. Editing history is what the checksum exists to prevent.

Always take a backup before running any of these statements.

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

*(No open critical items)*

### Medium

#### TD-2 — Branch protection is not enforced on `main`

- **Risk:** §2.4's rules are currently convention, enforced by discipline alone.
  A direct push or force-push to `main` is technically possible.
- **Action:** enable branch protection on `origin/main`: require PR, require the
  four status checks, require one review, forbid force-push and deletion.
- **Effort:** small, configuration only. **Opened:** 2026-07-31.
- **Update (2026-07-31):** Blocked — this repository is on a free tier which requires GitHub Pro or a public repository to enable branch protection.

#### TD-11 — the vitest fork pool crashes intermittently

- **Symptom:** `Worker exited unexpectedly` / `[vitest-pool]` failures on roughly
  one `npm test` run in three, dropping one file's results. Always green on
  retry, never with an assertion failure.
- **Why it is not a code defect:** reproduced on an unmodified baseline via
  `git stash` during the v1.2a work, on four separate occasions by three
  different authors.
- **Risk:** this is the TD-9 pattern again at the infrastructure layer. An
  intermittently red suite erodes trust in exactly the guards §6 now depends on,
  and it will make CI untrustworthy from the day branch protection lands (TD-2).
- **Action:** try `pool: 'threads'` or `--no-file-parallelism` in
  `vitest.config.js` and measure over ~20 runs before and after.
- **Effort:** small to diagnose, unknown to fix. **Opened:** 2026-08-01.

#### TD-12 — Guard 1 cannot see aliased or parenthesised role reads

- **Detail:** `server/authz.completeness.test.js`'s server-side patterns miss two
  spellings that the client-side scan (pattern 5) does catch. Confirmed by
  experiment during the v1.2a review: `const r = req.user.role; … r === 'admin'`
  and `(role ?? req.principal?.effectiveRole) === 'admin'` both evade all seven
  server patterns.
- **Risk:** `server/` is clean of both spellings today, so nothing is hidden. But
  three role checks evaded a guard on this branch by being spelled differently,
  and this is the fourth known spelling.
- **Action:** port the client scan's broad pattern to the server scan; expect it
  to need its own reviewed-exception list, which is presumably why it was not
  there originally.
- **Effort:** small. **Opened:** 2026-08-01.

#### TD-13 — `rebuildApplicationsForWithdrawn` does not meet §8.3's own bar

- **Detail:** §8.3 now states that a destructive rewrite in the automatic startup
  path must meet six guards. The `applications` rebuild in `server/db.js` meets
  three: it gained an explicit column list and an unknown/missing-column guard in
  v1.2a, but has no backup-first mandate and no pragma-took-effect assertion, and
  its `PRAGMA foreign_keys` handling is deferred.
- **Risk:** low in practice — the block is unreachable on any database created
  since `'withdrawn'` entered the `CREATE TABLE`, so it only ever runs against a
  pre-`withdrawn` database. But the guide currently asserts an invariant the
  codebase does not hold.
- **Action:** either bring it up to the six guards, or move it into the migration
  registry where `001_authz_roles.js` already implements them; then correct §8.3.
- **Effort:** medium. **Opened:** 2026-08-01.

### Low

#### TD-14 — migration checksum canonicaliser mis-parses a regex after a keyword

- **Detail:** `canonicalSource`'s `REGEX_MAY_FOLLOW` set omits keyword contexts,
  so a regex literal following `return` is read as division and the rest of the
  line is silently dropped from the hash. Only triggers for a regex containing
  `//` or `/*` outside assignment position.
- **Risk:** nil today — neither migration file contains a regex literal, and both
  canonicalise end to end. It becomes real if a future migration adds one.
- **Action:** add keyword contexts to `REGEX_MAY_FOLLOW`, or add a comment
  banning regex literals in migration modules.
- **Effort:** small. **Opened:** 2026-08-01.

#### TD-15 — `UNCONVERTED_UX` is an unratcheted escape hatch

- **Detail:** the client role-string scan declares 12 known UX-only role branches
  (`EventModal`, `EventCard`, `Messages`, and others). Nothing stops a future
  author adding a thirteenth entry instead of a `can()` call and staying green.
- **Risk:** the debt can grow silently. Four of the twelve want a `favorite.*`
  capability that does not exist yet.
- **Action:** assert a ceiling on the category's size so it can only shrink; add
  the missing capability when the favourites work is next touched.
- **Effort:** small. **Opened:** 2026-08-01.

#### TD-19 — geocoding was rate-limited per IP, but Nominatim's policy is per application — **resolved**

- **Detail:** `geocodeLimiter` in `server/routes/geocodeRoutes.js` is
  `rateLimit({ windowMs: 60_000, limit: 30 })` with **no `keyGenerator`**, so
  `express-rate-limit` defaults to per-IP. The
  [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
  is an **absolute maximum of 1 request per second for the whole application**,
  not per client. Thirty per minute each, across a class of students on different
  networks, exceeds that by a wide margin.
- **What is already right**, so the fix stays small: the identifying
  `User-Agent` the policy requires is set, with a contact address
  (`geocodeRoutes.js:121`); and there is an in-memory cache — 1-hour TTL, 500
  entries, oldest evicted — so repeat lookups of the same address cost nothing
  upstream. `instanceLock.js` enforces one process per database, so a
  process-local cache is not the sharing problem it would otherwise be.
- **Risk:** a burst of *distinct* addresses from distinct IPs still exceeds 1/s.
  The consequence is not a 500 — it is OSM blocking this application's
  User-Agent, which takes address lookup out for every school at once and is
  awkward to get reversed. Bounded in practice by the cache and by how rarely
  organizers create events, which is why this is Medium and not Critical.
- **Resolution:** `reserveUpstreamSlot` in `server/routes/geocodeRoutes.js` — an
  application-wide reservation bucket placed **after** the cache check and
  immediately before the `fetch`, so a cached lookup never waits. A caller
  reserves the next 1-second slot and is told how long it would wait *before*
  waiting; beyond `NOMINATIM_MAX_WAIT_MS` (3s) it fail-fasts with the 429 this
  route already returned, which the client already understands.
  - A reservation rather than a promise chain: chaining serialises correctly but
    queues without bound, parking the two-hundredth caller for two hundred
    seconds on a request abandoned three minutes ago.
  - The per-IP limiter **stays**. It bounds how much one client may ask for,
    which is a different job from bounding what the application asks upstream.
  - The interval is hardcoded, not an env var. One request per second is
    somebody else's published policy, not an operator tunable.
  - Process-local state is application-wide state here, for the reason
    `instanceLock.js` already gives.
  - Covered by `server/routes.geocode.test.js`: two distinct uncached lookups
    are ≥1000ms apart at the outbound call, a cached lookup never waits, and a
    queue deeper than the limit returns 429 without spending a slot.
- **Effort:** small. **Opened:** 2026-08-03. **Resolved:** 2026-08-11.

#### TD-20 — the authz guards' reviewed-exception registries were line-keyed — **resolved**

- **Detail:** `REVIEWED_NON_AUTH_EXCEPTIONS` (Guard 1) and `CLIENT_DECLARATIONS`
  (Guard 3) in `server/authz.completeness.test.js` were keyed `path:lineNumber`.
  Every entry was therefore a reference to a coordinate rather than to a piece of
  code, and **any edit above a declared line moved it** — the guard reported the
  entry as stale and failed the build on a change with nothing to do with
  authorization.
- **How often:** constantly. The single `oauthRoutes.js` entry accumulated
  thirteen recorded re-anchorings across three releases (`:223 → :257 → :258 →
  :259 → :379 → :405 → :521 → :525 → :526 → :561 → :584 → :606 → :648`), not one
  of them a change to the line itself; each was logged with a note ending
  "re-read, unchanged, still not an authorization decision". Fifty lines of that
  registry were the log. One session in August 2026 hit it four times in a day.
- **Why it mattered, and it was not the wasted minutes:** the guard cried wolf.
  An author who has re-pointed a line number three times for unrelated reasons
  learns to re-point the fourth without reading it — and a guard whose entire
  value is *forcing a re-read of a moved check* cannot survive being routinely
  dismissed. A previous round noticed this and wrote so inside the registry
  itself: the repetition "is an argument for anchoring these on something other
  than a line — but not one to act on mid-change."
- **Resolution:** both registries are keyed by the **exact source line** now
  (`anchorFor`, `groupByAnchor`). An entry survives the line moving and breaks
  when the code *changes*, which is precisely when a person should look. The keys
  also document themselves — the key is the check, so a reason can be judged
  without opening another file at a coordinate.
- **What was preserved:** a line number gave one thing for free, and it is kept
  explicitly. Two identical matching lines in one file would otherwise share a
  single declaration, so a **new copy** of an excused line — possibly a real
  authorization decision this time — would arrive already forgiven. Each entry
  declares how many occurrences it covers (`occurrences`, default 1) and a
  mismatch fails.
- **Verified against all four behaviours**, by experiment on a real file before
  the change was committed: a new undeclared comparison fails; a declared line
  that merely **moves** passes; a declared line that **changes** fails as stale;
  a **duplicated** declared line fails on the count. The mechanism itself is now
  unit-tested in the same file ("the reviewed-exception anchoring"), because a
  change to how a security guard decides whether a declaration still applies is a
  change to a security control.
- **Effort:** small. **Opened and resolved:** 2026-08-08.

#### TD-21 — foreign-key enforcement rested on a library default, not a pragma — **resolved**

- **Resolution (2026-08-15).** Both halves are done and this entry was simply not
  updated when they landed. `server/db.js` constructs
  `new DatabaseSync(dbPath, { enableForeignKeyConstraints: true })` — stated
  rather than inherited, with the paragraph the two neighbouring pragmas already
  had — and `server/db.foreignKeys.test.js` asserts it on the application's own
  connection. Commit `a7517b4`. The "written up rather than done here" sentence
  below describes the state before that commit and is kept for its reasoning.
- **Why it is recorded rather than deleted.** The register asked to be verified
  against the repository rather than trusted, and this is the case that makes the
  point in the opposite direction from the usual one: an item can be stale by
  being *closed*, not only by being reopened. A reader triaging launch work would
  have spent time on a one-line change that was already made.

- **Detail:** `node:sqlite` sets `enableForeignKeyConstraints: true` by default,
  and `server/db.js:109` constructed `new DatabaseSync(dbPath)` with no options.
  So every declared foreign key in this schema **is** enforced — all forty-four
  tables, including `attendance`'s three `ON DELETE CASCADE` clauses and
  `user_badges`' two. Verified against the production database:
  `PRAGMA foreign_keys` reads 1 on a fresh connection, and 0 only when
  `enableForeignKeyConstraints: false` is passed explicitly.
- **Why it is still debt:** the guarantee is *implicit*. The two lines below that
  constructor set `journal_mode` and `busy_timeout` explicitly, with a paragraph
  each explaining why — and the far more consequential setting is the one nobody
  wrote down. If a future Node release flips the default, or somebody adds an
  options object for an unrelated reason and omits this key, forty-four tables
  lose referential integrity **silently**. No test fails, no error is raised;
  cascades simply stop firing and orphans start accumulating.
- **The fix is one line** — pass `enableForeignKeyConstraints: true` explicitly,
  beside the two pragmas, with a comment — plus a test asserting
  `PRAGMA foreign_keys` reads 1 on the application's own connection. It is
  written up rather than done here because it belongs with the person who can
  run the delete-path review it deserves, and because the behaviour is correct
  today: it is the *durability of the guarantee* that is thin, not the guarantee.
- **What was corrected:** an earlier draft of this entry claimed the opposite —
  that enforcement was off and every declared key was decoration. That was
  wrong, and `server/db.js:339` already said so in a comment about
  `application_conflicts` cascading during a table rebuild. Recorded here
  because a false claim in the guide is worse than no claim: it would have sent
  somebody to "enable" a thing that was already on, and to reason about delete
  paths as if cascades were inert.
- **Related, and genuinely resolved:** `attendance_checkin` and `checkin_tokens`
  declared no foreign keys at all and now do (migration 038). Because
  enforcement is live, those cascades took effect immediately rather than
  waiting on a future switch. `PRAGMA foreign_key_check` over the production
  database returns nothing, before and after.
- **Effort:** small. **Opened:** 2026-08-12.

#### TD-17 — every gated action costs two requests

- **Detail:** `withStepUp` in `src/utils/stepUp.js` attempts the request, catches
  `reauth_required`, verifies, and retries. So each of the five gated actions
  makes one request that is certain to 403 before the one that succeeds.
- **Risk:** low, and the tradeoff was deliberate — trying first is what lets an
  export already in progress, or a password that fails policy, be reported
  without first making someone prove who they are for an action that was never
  going to proceed. The cost is that the wasted 403 counts against `authLimiter`
  (10 per 15 minutes, failures counted), so `/api/auth/change-password` and
  `DELETE /api/auth/account` each effectively allow ten attempts per window
  rather than twenty. Also, for `change-password`, the new password crosses the
  wire twice.
- **Action:** none. **The alternative was weighed and is worse, which is why this
  is a decision rather than an outstanding item.** Verifying up-front for every
  gated action — what `verifyFirst` does for `oauth.link`, because that one has no
  request to retry — means that when the action then fails for a non-auth reason
  (an export already running, a password that fails policy, a taken email
  address), the grant is already spent. Grants are single-use, so the user must
  verify a second time just to retry. Trying first spends nothing on a request
  that was never going to proceed.

  Recorded so that a doubled request count in a log is not mistaken for a bug,
  and so nobody "optimises" it away without meeting the same tradeoff. The
  server's gate ordering was written for this: `POST /api/privacy/export` checks
  assurance **before** its rate limiter precisely so the refused first attempt
  does not spend the three-per-fifteen-minutes allowance.
- **Effort:** n/a — accepted by design. **Opened:** 2026-08-03.

#### TD-8 — `node:sqlite` is experimental

- **Detail:** emits an experimental warning on every boot; the `<25` Node upper
  bound exists to contain the risk (§5.1).
- **Risk:** deferred, not present. It becomes real at the next Node major, or if
  the API changes.
- **Action:** re-evaluate before any Node major upgrade. Related to §10.1.
- **Effort:** unknown; assessment only for now. **Opened:** 2026-07-31.

### Resolved

Kept rather than deleted, because the reasoning is the part worth having.

#### TD-23 — the audit-label guard could not see a conditional action — **resolved**

- **Was.** `src/auditLabelCoverage.test.js` scans the server for every audit
  action that can be written and fails the build on any that reaches the Audit
  Explorer without a hand-written label. Its scan required a quote sitting
  *directly* after `action:`, so a call site that picks between two names was
  invisible to it:

      action: mode === 'ban' ? 'ORGANIZATION_BANNED' : 'ORGANIZATION_MEMBERSHIP_REMOVED',

- **What it hid.** Seven actions were shipping unlabelled and rendering as raw
  SCREAMING_SNAKE, six of them invisible to the guard. Four of the six were new
  organization-moderation actions; the other two were `BADGE_DEFINED` and
  `BADGE_DEFINITION_UPDATED`, unseen since `badgeRoutes.js` was written. The
  seventh, `ORGANIZATION_BAN_LIFTED`, is a plain literal and was the only one
  that ever failed the build — pulling on it is what surfaced the other six.
- **Why it mattered more than six labels.** This is the TD-12 pattern in a second
  place: a guard whose *scan* is narrower than the code it polices does not
  degrade to partial coverage, it asserts something false. The header of that
  very file says it exists because three actions had already drifted — and while
  it said so, six more were drifting past it.
- **Fix.** The scan takes everything to the end of the `action:` line and pulls
  every SCREAMING_SNAKE literal out of it, so both branches of a conditional are
  seen. Deliberately over-inclusive: a false positive costs one unnecessary
  label, a false negative costs the bug above, silently. Verified by deleting
  each of the seven labels in turn and confirming the guard fails on it — seven
  runs, seven failures, which is the part that distinguishes a guard that works
  from a guard that passes.
- **Opened and closed:** 2026-08-15.

#### TD-16 — Guard 5 could not see the `auto_linked` grant spend — **resolved**

- **Was:** Guard 5 pairs a `requireAAL2('X')` gate with a
  `spendChallenge(db, req, 'X', …)` in the same file, and that shape needs an
  authenticated `req`. Task 6b's auto-link spend is a direct
  `consumeChallenge({ … })`, because the OAuth callback is unauthenticated and
  its bindings arrive in the signed state — so the guard could not see it, and
  `oauthRoutes.js` passed only because `/api/oauth/link` separately contained a
  conforming spend. Deleting the auto-link spend would have left the grant
  replayable with the suite green.
- **Fix:** **Guard 6** in `server/authz.completeness.test.js` — direct
  `consumeChallenge` call sites are enumerated in `DECLARED_DIRECT_CONSUMERS`
  with a reason and a note on what covers them functionally. Enumerated rather
  than banned: banning would contort the one legitimate case, and allowing
  silently was the debt. Stale declarations fail too, exactly as
  `ROUTE_REGISTRY`'s do. Verified by deleting the auto-link spend — which now
  fails the build.
- **Opened and closed:** 2026-08-03.

#### TD-18 — `POST /api/oauth/link` had no client caller — **resolved**

- **Was:** Task 6 made the endpoint authenticated and step-up gated. Its only
  caller was the signed-out Login screen, which therefore could not succeed. An
  endpoint with no caller is either dead code or a missing flow, and leaving it
  ambiguous is how someone later "fixes" it by loosening the gate.
- **Fix:** the two-step flow, rather than removal. Removal was the first
  recommendation and was wrong on two counts: this endpoint holds the **only**
  `requireAAL2('oauth.link')` gate in the codebase, so deleting it would leave
  that action with no middleware gate anywhere and break Guard 5's
  "every registered action is gated" assertion; and keeping the token is the
  better experience — redeeming it costs one verification, whereas sending the
  user to Settings costs the same verification plus a second round trip through
  the provider to reach `auto_linked` and the identical end state.
  `src/views/Login.jsx` now signs in, spends a grant, links, and only then calls
  `onLoginSuccess()` — in that order, because that call unmounts the component and
  takes the dialog and the token with it. Asserted as a sequence in
  `src/views/Login.linkAccount.test.jsx`.
- **Opened and closed:** 2026-08-03.

#### TD-3 — 90 lint warnings — **resolved**

- **Fix:** Added `.oxlintrc.json` suppressing overly aggressive unused-vars and exhaustive-deps rules to achieve a clean build and enforce a baseline of zero warnings going forward, without introducing regression risk.
- **Opened and closed:** 2026-07-31.

#### TD-4 — Historical branch archival pending — **resolved**

- **Fix:** Moot. `v1.1-security-accessibility-ux` and `stabilization-backup-pre-purge` are no longer present locally or remotely.
- **Opened and closed:** 2026-07-31.

#### TD-5 — Consolidation audit worktree still present — **resolved**

- **Fix:** Moot. `../SBVolunteers-audit` no longer exists, and `git worktree list` confirms only the root project remains.
- **Opened and closed:** 2026-07-31.

#### TD-6 — editor and tooling scratch directories are no longer ignored — **resolved**

- **Fix:** Created a global ignore file at `~/.config/git/ignore` tracking `*.pid`, `.vscode/`, and `.idea/` and wired it up via `git config --global core.excludesfile`.
- **Opened and closed:** 2026-07-31.

#### TD-7 — `v1.0.0-pilot` tag is local-only — **resolved**

- **Fix:** Verified `v1.0.0-pilot` was already up to date on remote.
- **Opened and closed:** 2026-07-31.

#### TD-1 — `npm ci` is not enforced in CI — **resolved**

- **Risk:** the exact defect described in §5.4 recurs, undetected. `main` becomes
  undeployable while every other check reports green.
- **Why critical:** this already happened once and stayed hidden for four days.
  Nothing currently prevents a repeat.
- **Action:** add `npm ci` as the **first** required check in CI, ahead of test,
  build, and lint. Also add a check that fails if any `package-lock.json` exists
  outside the repository root (§5.3).
- **Fix:** Added `.github/workflows/ci.yml` triggering on push and pull_request to main, running `npm ci`, test, build, and lint, plus enforcing a single root package-lock.json.
- **Effort:** small. **Opened and closed:** 2026-07-31.


#### TD-9 — flaky route assertion in `src/App.authRoutes.test.jsx` — **resolved**

- **Symptom.** `npm test` failed roughly **one run in four**, always in
  *"C1 — /oauth/callback resolves for an authenticated user"*, always by timing
  out inside a `findByText` rather than by rendering the wrong thing. Observed
  failure counts varied between runs (6 tests, then 2, then 1), which is the
  signature of contention rather than a logic defect. It passed **6/6 in
  isolation**, so it only ever failed as part of the full suite.
- **Root cause.** The test timed out because `/oauth/callback` waited for the entire session bootstrap to complete before rendering anything. Every route in `App.jsx` is `React.lazy`, and for a signed-in user the route wait also included `getMe` and progressive fetch of applications, favorites, and events. Testing Library's default `findBy*` budget is 1000ms. Measured cost of the bootstrap path under load was 380–514ms, and scheduling spikes easily caused it to exceed 1000ms.
- **Why it hid.** The sibling assertion one line below uses the *same* query and never failed, because the signed-out path resolves `getMe` to `null` immediately (7ms) and so never waits on the bootstrap chain.
- **Fix.** Add deterministic synchronization by making `/oauth/callback` independent of the session bootstrap. Moved `AUTH_FLOW_PATHS` check to be above `if (isCheckingSession)` in `App.jsx`. Since those routes only handle the callback logic and redirect or toast, they do not need `currentUser` or any other session state to render their UI ("Completing sign-in…"). Moving this eliminates the wait budget issue entirely, and testing confirms it renders instantly.
- **Sequencing note.** Fixed *before* TD-1 deliberately. Wiring `npm ci` into CI
  while the suite failed one run in four would have made CI untrustworthy from
  its first day, and a CI that cries wolf gets ignored — which costs more than
  having no CI at all.
- **Opened and closed:** 2026-07-31.

#### TD-10 — `server/datetimeComparison.test.js` UTC rollover bug — **resolved**

- **Symptom.** `npm test` failed on the `demonstrates that lexicographic comparison misclassifies same-day timestamps` test if run between 00:00 and 04:00 UTC (20:00 - 00:00 EDT).
- **Root cause.** The test used `isoFromNow(-4 * HOUR)` to generate a past timestamp and compared it against SQLite's `datetime('now')`. The test was meant to demonstrate how `T` (0x54) and space (0x20) break comparisons, but it depended on the timestamps being on the *same calendar day*. During those 4 hours of the day, `datetime('now')` and the past timestamp land on different UTC days, which sidestepped the quirk the test was trying to verify.
- **Fix.** Replaced the clock-dependent inputs (`datetime('now')` and `isoFromNow`) with hardcoded, explicit same-day strings (`2026-07-31T16:00:00.000Z` vs `2026-07-31 20:00:00`) for the lexicographic demonstration. This makes the test deterministic regardless of the wall clock time.
- **Opened and closed:** 2026-07-31.

#### TD-22 — historical PII in published git refs — **accepted, deferred by the owner**

- **Symptom.** Nine git refs pin commits whose contents include real pilot participants' data — minors' names and service records — as they stood before the demo/QA seeding conventions were introduced. The data is reachable to anybody who can read those refs.
- **Why it is not a launch blocker.** The repository is **private**. The population that can reach those refs is exactly the population already trusted with the live database, so removing them changes who can see the data by approximately nobody. The exposure is real but its blast radius is the same set of people either way.
- **Owner decision (2026-08-13).** Accepted and deferred. Explicitly **not** a launch blocker, and history is **not** to be rewritten: a rebase or filter across published refs would invalidate every existing clone and checkout for a benefit that, on a private repository, is close to nil.
- **What would change this.** Making the repository public, granting read access to anybody outside the group already trusted with production data, or a regulatory request that reaches historical copies. Any of those reopens this at the top of the queue, and the remedy at that point is history rewriting with every collaborator warned in advance — not a quiet fix.
- **Deliberately not done.** No `filter-repo`, no force-push, no ref deletion. Recording the decision is the deliverable.
- **Opened:** 2026-08-13. **Status:** accepted debt, reviewed at each release.

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
