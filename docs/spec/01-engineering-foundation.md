# Volume I — Engineering Foundation

**Status:** Normative
**Scope:** Engineering philosophy, repository rules, system architecture, testing
doctrine, documentation duties, migration rules, coding standards, branch strategy,
release process, Definition of Done.

---

## 1.1 Purpose and goals of this volume

### 1.1.1 Purpose

This volume specifies how work is done on WeVolunteer. It binds every other volume:
where Volume III specifies what the moderation system does, this volume specifies what
must be true of the change that builds it before that change may merge.

It exists because the platform's dominant risk is not a missing feature. It is a
correct-looking change that silently removes a protection. The population is majority
minors, the data includes private messages and disciplinary records, and the
engineering team is between one and three people plus coding agents. That combination
produces a specific failure profile, and the rules in this volume are shaped to it.

### 1.1.2 Goals

| ID | Goal | Measured by |
|---|---|---|
| G-1.1 | A protection cannot be removed silently. | Every invariant in §0.7 has a build-failing test. |
| G-1.2 | A new contributor — human or agent — reaches correct behaviour by following the repository, not by asking. | Every load-bearing constraint carries an in-file rationale naming its incident. |
| G-1.3 | The cost of a mistake is bounded and recoverable. | Every destructive operation has a documented rollback that has been executed at least once. |
| G-1.4 | Verification precedes assertion. | No release note, audit or completion claim is made without the command output that supports it. |
| G-1.5 | The system degrades honestly. | Every failure state names what happened, what is safe, and what to do. |

### 1.1.3 Non-goals

- **Coverage percentage.** Line coverage is not measured and MUST NOT be adopted as a
  gate. See §1.5.3.
- **Architectural purity.** Layering, dependency inversion and abstraction are means.
  Where a direct approach is clearer and equally safe, it is preferred.
- **Framework currency.** Dependencies are upgraded for security or for a needed
  capability. Being current is not itself a goal; see §1.2.7.
- **Microservices.** Explicitly rejected. See §1.4.9.

---

## 1.2 Engineering philosophy

The following ten principles are normative. They are ordered: where two conflict, the
earlier governs.

### 1.2.1 P-1 — Safety of minors outranks every other consideration

Where a design choice trades a child-safety property against performance,
convenience, elegance, delivery speed, or an adult user's preference, the
child-safety property wins. This is not a tie-breaker; it is a total order.

**Applied consequences, each specified in full elsewhere:**

- A conversation always has a staff or organizer party (Volume III §3.1.5).
- Evidence is captured at report time and cannot be destroyed by its subject
  (Volume III §3.4).
- An urgent report's notification cannot be suppressed by a user preference
  (Volume III §3.6.5).
- Reading a student's private messages is a distinct, capability-gated, logged act
  (Volume III §3.4.6).
- A retention period, once published, is honoured even when honouring it is
  inconvenient (Volume V §5.8.3).

**RATIONALE.** A platform for minors that treats safety as one requirement among many
will trade it away incrementally, each trade individually defensible. Stating the
order removes the incremental path.

### 1.2.2 P-2 — Make the dangerous thing impossible, not discouraged

A rule enforced by documentation is a rule that will be broken. A rule enforced by a
test is a rule that will be broken and then caught. A rule enforced by the type of the
data, a database constraint, or the absence of an affordance cannot be broken.

Enforcement mechanisms, in descending order of strength. A requirement MUST be
enforced at the strongest level that is practical.

| Level | Mechanism | Example in this platform |
|---|---|---|
| 1 | Structurally impossible | No request-body column exists on `error_events`, so a body cannot be stored. |
| 2 | Storage-layer constraint | `BEFORE UPDATE`/`BEFORE DELETE` triggers on `report_evidence`. |
| 3 | Boot-time refusal | Production boot fails on a weak `JWT_SECRET`. |
| 4 | Build-failing static guard | No route file may compare a role identifier. |
| 5 | Behavioural test | A suspended session is refused on the next request. |
| 6 | In-file rationale | A header comment naming the incident behind a constraint. |
| 7 | External documentation | This specification. |

**FAILURE MODE this addresses.** A protection expressed only at level 6 or 7 is
removed by a well-meaning simplification, and nothing fails. The change looks like a
cleanup. It merges.

### 1.2.3 P-3 — Derive, do not enumerate

Where a guard, a list, a loop or a matrix can be computed from the artefact it
governs, it MUST be computed rather than written out.

**RATIONALE.** A hand-written list covers what its author remembered. It does not fail
when the subject grows — it silently covers less, while continuing to pass. This is the
most frequently realised failure mode in this repository's history: it has occurred at
least four times (the OAuth provider state loop, the OAuth credential fixtures, the
suspension enforcement points, and the animated-class list in the error stylesheet).

**Requirements.**

- A test that iterates over a set of subjects MUST derive that set from the
  filesystem, a registry, or an exported constant — never from a literal array.
- Where derivation is impossible, the enumeration MUST be paired with a *completeness*
  assertion that fails when the enumerated set and the real set diverge.
- An exemption list MUST be paired with a *staleness* assertion that fails when an
  exemption no longer matches anything. An exemption that outlives its subject is an
  exemption nobody has re-read.

### 1.2.4 P-4 — An error must tell the truth

Every failure state MUST answer three questions, in this order:

1. What happened, in the reader's terms rather than the system's.
2. What is safe — specifically, whether the reader has lost data.
3. What to do next.

A failure state MUST NOT: display a status code to a reader who cannot act on one;
attribute a system fault to the reader; report success for a partial operation; or
redirect silently in place of explaining.

**Tone requirement.** Failures that may coincide with data loss (`500`, an uncaught
render error, offline, session expiry) MUST be written flat, MUST lead with the safety
answer, and MUST NOT contain humour or exclamation. Failures that are merely
inconvenient (`404`, `403`, a stale bundle, planned maintenance) MAY carry
personality. This distinction MUST be enforced by test, not by taste.

### 1.2.5 P-5 — Verification precedes assertion

A claim that something works MUST be accompanied by the evidence that it works,
produced by executing it. This applies to commit messages, release notes, audit
documents, and status reports.

**Prohibited constructions**, each of which has produced a false record in this
project's history:

- "Should now work" — a prediction presented as a result.
- "Tests pass" without the counts.
- "Fixed" for a change whose test was not observed failing beforehand.
- A completion claim covering work partially done, with the incomplete portion
  unnamed.

**Required for a bug fix.** The test MUST be written first and MUST be observed to
fail against the unmodified code. A test written after the fix proves that the code
and the test agree; it does not prove that either is right.

### 1.2.6 P-6 — Minimise what is collected, stored and disclosed

The platform holds the personal data of minors. Every field is a liability with a
lifetime.

**Requirements.**

- A field MUST NOT be added without a named consumer. "We might want it" is not a
  consumer.
- Personal data MUST NOT be placed in a URL path, query string, or fragment.
- A disclosure of private content MUST be gated on a capability distinct from the
  capability that permits acting on the surrounding record, and MUST be recorded.
- Free-text captured for diagnostics MUST be redacted before storage, most-specific
  rule first, with truncation applied last.
- Third-party analytics, telemetry and session-replay SDKs MUST NOT be integrated.
  Their data flows cannot be constrained by this specification and their presence
  makes the Privacy Policy unverifiable.

### 1.2.7 P-7 — Dependencies are a liability, not a resource

Every dependency is code the team does not read, cannot fix quickly, and must
nonetheless answer for.

**Requirements.**

- A new runtime dependency MUST be justified against the cost of implementing the
  needed subset directly. The justification MUST be recorded in the adopting commit.
- A dependency MUST NOT be added for a single function that can be written in under
  roughly fifty lines.
- Upgrades are performed for a security advisory or a needed capability. A version
  bump for its own sake is not performed, because it consumes review attention
  without producing a change in behaviour.
- An advisory MUST be *assessed for applicability* before it is acted on. The
  assessment MUST record whether the vulnerable code path is reachable in this
  configuration. Downgrading a dependency to clear an inapplicable advisory is
  prohibited, because it exchanges a theoretical risk for a real behaviour change.

### 1.2.8 P-8 — One definition of every rule

A rule expressed in two places will diverge, and the copy that stops being updated is
the one still being consulted.

**Requirements.**

- A rule shared between server and client MUST be defined once, on the server, and
  re-exported to the client. It MUST NOT be reimplemented.
- A predicate consulted at more than one enforcement point MUST be a named function.
  The inline comparison MUST be prohibited by static guard.
- Where duplication is unavoidable, the copies MUST be tied by a test that fails when
  they diverge.

### 1.2.9 P-9 — Comments explain why

A comment restating what the code does is noise. A comment recording why the code is
shaped as it is, and what happened when it was shaped otherwise, is the primary
defence against a future correct-looking simplification.

**Requirements.**

- A module protecting an invariant MUST open with a header stating the invariant, the
  failure mode, and — where one exists — the incident.
- A non-obvious constraint MUST carry the reason inline, at the constraint.
- A comment MUST be updated when the code it describes changes. A stale comment
  asserting a defect that has been fixed is worse than no comment: it causes the
  reader to distrust working code, or to "re-fix" it.
- An ordering that is load-bearing MUST say so, and MUST say what breaks if reordered.

### 1.2.10 P-10 — Flakiness is a defect

A test that fails intermittently provides no signal. Re-running is not a remedy.

**Requirements.**

- A flaky test MUST be diagnosed. The diagnosis MUST distinguish a defect in the code
  under test, a defect in the test, and a defect in the infrastructure.
- An infrastructure flake MUST be recorded in the technical-debt register with the
  evidence that it reproduces on unmodified code.
- A test MUST NOT be retried, skipped or loosened to make a suite green. Loosening a
  test to stop it failing converts a signal into a comfort.
- Cross-test state leakage is a defect in the fixture, not in the test that noticed.
  Reset helpers MUST clear every column the suite writes, including columns whose
  stale values are inert *today*.

---

## 1.3 Repository rules

### 1.3.1 Purpose

These rules govern the physical repository: what is in it, what is not, and how
dependencies are installed.

### 1.3.2 Current state

The repository is a single npm workspace root with one workspace, `server/`. The
client lives at `src/`, built by Vite to `dist/`, which the server serves statically
with an SPA fallback. There is exactly one lockfile, at the root.

### 1.3.3 Dependency installation

**REQUIRED.** All installation is performed from the repository root.

**MUST NOT.** `npm install` MUST NOT be run inside `server/`.

**FAILURE MODE.** `server/` is a workspace. A nested `server/package-lock.json` is
invisible to a root `npm ci` while appearing authoritative to a reader and to some
tooling. The root install resolves a different tree from the one the nested lockfile
describes, and the divergence surfaces as a runtime failure in an unrelated subsystem.
This has occurred and rendered the default branch uninstallable for four days.

**REQUIRED guard.** CI MUST fail when any lockfile exists outside the repository root.

### 1.3.4 Gate ordering

The four gates MUST be executed in this order:

1. `npm ci`
2. `npm test`
3. `npm run build`
4. `npm run lint`

**RATIONALE.** `npm ci` is the only gate that validates the lockfile. The other three
measure the behaviour of an installed tree; if the install is wrong, they measure the
wrong tree and their success is meaningless.

### 1.3.5 Files that MUST NOT be committed

| Class | Rule |
|---|---|
| Environment files | `.gitignore` MUST be deny-by-default for env files, allowlisting specific example files by exception. A rule naming a *file* rather than a *class* is prohibited. |
| Databases | No `.db`, `.db-wal`, `.db-shm`, or backup artefact. |
| Build output | `dist/`, coverage output, test artefacts. |
| Secrets in any form | Including in test fixtures, example files, and documentation. |
| Full project copies | Directories containing a second copy of the tree (`scratch/`) MUST be ignored by the test runner and MUST NOT be committed. |

**FAILURE MODE for the env-file rule.** A `.gitignore` entry naming `.env` does not
match `.env.production`. A live OAuth client secret has been committed to this
repository once for exactly this reason. The rule MUST name the class.

**REQUIRED guard.** A pre-commit secret scan MUST be installed by
`bin/install-hooks.sh`, and running that script MUST be a documented post-clone step.

### 1.3.6 Node version

The runtime version is a **requirement**, not a recommendation: the server depends on
`node:sqlite`, which is unavailable in earlier majors and unstable across majors. Both
manifests MUST pin the same bounded range, and the boot sequence MUST refuse to start
outside it rather than failing later with an unrelated error.

### 1.3.7 Repository layout

```
/                      root workspace; client source, config, lockfile
  bin/                 operational scripts (hooks, checksums, resets, hash tooling)
  deploy/              host provisioning and service units
  docs/                documentation tree
    spec/              this specification
    operations/        runbooks
    legal/             policy source documents
    plans/, specs/     per-release design and audit records
    history/           superseded records, retained
  server/              API workspace
    routes/            HTTP surface, one module per domain
    migrations/        versioned schema registry
    workers/           background processors
    services/          domain services with side effects
    realtime/          socket transport
    oauth/             provider adapters
  src/                 client application
    views/             routed screens
    components/        shared and domain components
    session/           session and page-data provider
    routes/            route table and code-split boundaries
    utils/             API client and helpers
  tests/               end-to-end specs (not part of the standard loop)
```

**Rule.** Domain logic MUST NOT live in a route handler. A route handler parses,
authorises, delegates, and formats. Logic that can be tested without HTTP MUST be in a
module that can be imported without booting a listener.

### 1.3.8 Side-effect-free modules

**REQUIRED.** The configuration module MUST be free of side effects: importing it MUST
NOT open a database, bind a port, start a timer, or write a file.

**RATIONALE.** This property is what allows a route module to be imported by a test
without booting the application or touching the production database. Losing it makes
every test an integration test.

### 1.3.9 Acceptance criteria for §1.3

| # | Criterion |
|---|---|
| AC-1.3.1 | A lockfile committed outside the root fails CI. |
| AC-1.3.2 | The four gates are documented in the stated order in the contributor entry point. |
| AC-1.3.3 | The env-file ignore rules are pattern-based with an explicit allowlist. |
| AC-1.3.4 | A pre-commit secret scan is installable by one documented command. |
| AC-1.3.5 | Both manifests pin an identical bounded Node range, and boot refuses outside it. |
| AC-1.3.6 | The configuration module can be imported in a unit test without a database. |

---

## 1.4 System architecture

### 1.4.1 Purpose

This section specifies the shape of the system: its processes, its boundaries, its
request lifecycle, and the invariants that hold across it.

### 1.4.2 Architectural style and its justification

WeVolunteer is a **single-process modular monolith** serving a **single-page
application** from the same origin, backed by an **embedded relational database**.

**Chosen because:**

- The deployment target is one school. Concurrency is measured in tens of
  simultaneous users, not thousands.
- Same-origin delivery removes CORS from the client's critical path and permits
  `SameSite` cookie protections that a cross-origin split would weaken.
- An embedded database removes network partition from the failure model entirely.
- One process means one place to look during an incident, which matters
  disproportionately for a one-person operations team.

**Costs accepted and their mitigations:**

| Cost | Mitigation |
|---|---|
| No horizontal scaling | Single-instance enforcement (INV-017) makes the constraint explicit rather than latent. Vertical headroom is specified in Volume V §5.7. |
| Deploy is a restart | Graceful drain specified in Volume V §5.2.6; the window is bounded and announced. |
| Background work shares the process | Workers are drained before database close; failure isolation specified in Volume V §5.6.4. |
| Database is a single file | Backup, verification and restore-drill obligations in Volume V §5.8. |

### 1.4.3 INV-001 — Credited hours are derived

**INVARIANT.** A volunteer's credited service hours MUST NOT be stored on the user
record. They MUST be derived on every read, from attendance records marked present.

**Requirements.**

- No write path may set a total on a user row. No such column may exist.
- Every change to credited hours MUST additionally append to an hours ledger, giving
  an independent record from which the derivation can be verified.
- A parity check comparing the ledger to the derivation MUST be executable as a
  standalone command and MUST exit non-zero on mismatch.
- Check-in and hours confirmation are **separate operations**. Check-in credits
  nothing.
- A credit, once written, retains its original value permanently. Editing the shift
  that produced it MUST NOT re-price it.

**RATIONALE.** Service hours are a student's transcript-adjacent record. A stored
total is a second source of truth that will drift from the events that produced it,
and the drift is undetectable without the events. Deriving makes the events
authoritative. The ledger makes the derivation auditable. The snapshot rule prevents a
retroactive edit from silently altering a record a student has already relied on.

**FAILURE MODE.** A stored total drifts by one shift after a partial failure. Nobody
notices for a year. A student's college application reports a number the platform can
no longer justify.

### 1.4.4 Request lifecycle

Middleware order is normative. Each position is justified; reordering is a defect.

| # | Stage | Why here |
|---|---|---|
| 1 | Compression | Must wrap all downstream responses. |
| 2 | Security headers | Must apply to every response including errors. |
| 3 | CORS, scoped to the API prefix | Static assets are same-origin and need no policy; scoping narrows the surface. |
| 4 | Body parsing | After CORS so a rejected origin never has its body read. |
| 5 | Path-scoped body limits | MUST be mounted **before** the global parser. |
| 6 | Rate limiters | Before handlers so a limited request does no work. |
| 7 | Route modules | The application surface. |
| 8 | Health endpoint | After routes, before static, so it cannot be shadowed. |
| 9 | Static assets and SPA fallback | Last resort before the error handler. |
| 10 | Error handler | MUST be last; Express selects error middleware by position. |

**Requirement on stage 5.** A path-scoped body limit mounted *after* the global parser
has no effect: the global parser has already consumed and accepted the body. This MUST
be verified by test, not assumed, because both orderings read identically.

### 1.4.5 Client architecture

**REQUIRED properties.**

- **Route-level code splitting.** Every routed screen MUST be lazily imported. The
  shell — navigation, notification indicator, theme control, error boundary, loading
  skeleton — stays eager, because it renders on the first frame and the skeleton is
  what the lazy boundaries fall back to.
- **A route table as data.** Routes MUST be declared as data with their capability
  conditions attached, not as inline conditional JSX. A role added to the system
  cannot then miss a branch.
- **Declared props.** A route that takes no shell props MUST declare an empty prop
  set explicitly. Omission MUST throw at composition time.
  **FAILURE MODE:** cloning an element with an undefined prop map is legal and yields
  a component with every prop absent. It renders wrongly and nothing warns.
- **No state-management library.** Session and cross-screen page data live in one
  provider. Local state is local.

**Two load-bearing orderings in the shell.** Both MUST be preserved and both MUST
carry an inline note:

1. Authentication-flow paths (the OAuth callback and the password-reset screen) MUST be
   matched **above** the session-checking gate. Below it, the flows race the session
   check.
2. The session provider MUST NOT gate its children on the session check. An early
   return there unmounts the tree that the flows above depend on.

### 1.4.6 INV-016 — An authorization refusal is a takeover

**INVARIANT.** Every error presentation MUST replace the application shell rather than
render inside it. This applies to `400`, `401`, `403`, `404`, `500`, uncaught render
errors, stale-bundle failures, offline, session expiry and planned maintenance without
exception.

**Requirements.**

- The refusal MUST NOT render with navigation, sidebar, profile menu or dashboard
  chrome visible.
- The refusal MUST carry its own recovery action, because it has replaced the
  navigation that would otherwise provide one.
- A refusal MUST name the feature attempted, the reason, and who can grant access.
  Copy requirements are in Volume II §2.4.7.
- A refusal MUST NOT be implemented as a redirect. Redirecting to a dashboard makes
  "you may not do this" indistinguishable from "nothing happened", which produces the
  report *"nothing happens when I click it"*.

**RATIONALE.** Application chrome surrounding an error message asserts that the
application is working. For a permission refusal it also frames the message with the
navigation that led there, which reads as a malfunction rather than a rule.

### 1.4.7 INV-019 — Navigation entries declare a capability

**INVARIANT.** Every navigation entry MUST declare either a required capability or a
non-empty set of alternative capabilities. An entry declaring neither MUST cause a
boot-time failure.

**RATIONALE.** `can(user, undefined)` is false for every principal including a wildcard
holder. An entry with no condition is therefore invisible to everyone — and invisible
is exactly what a forgotten annotation looks like. Failing at boot converts a silent
omission into an immediate, unambiguous error.

### 1.4.8 Background work

Four in-process components run for the life of the server: a notification outbox
processor, an export processor, a retention sweep, and an auto-selection scheduler.

**Requirements.**

- Each MUST be independently startable and stoppable.
- The shutdown sequence MUST drain all of them **before** closing the database.
- A worker failure MUST NOT terminate the process. It MUST be recorded and the worker
  MUST remain schedulable.
- A worker MUST NOT hold a transaction open across an await boundary.
- Any sweep that deletes MUST perform its safety assertions **inside** the deleting
  transaction.
  **FAILURE MODE:** an assertion after commit detects the loss and then issues a
  rollback against an already-committed transaction. The rollback error is swallowed,
  one line is logged, and the data is permanently gone. Detection without rollback is
  not a guard.

### 1.4.9 Alternatives considered

| Alternative | Rejected because |
|---|---|
| Microservices | Introduces network partition, distributed transactions and multi-process observability for a system serving one school. Every current invariant enforced by a single transaction would need a compensating protocol. |
| Server-rendered multi-page application | The organizer surfaces are dense and stateful; full-page transitions would degrade them. Also forfeits offline handling. |
| Client-side database with sync | Places private message content and disciplinary records in browser storage on shared school devices. Rejected under P-1. |
| Managed backend platform | Examined in Volume V §5.9. The synchronous database access model is the blocker; the analysis is recorded rather than repeated here. |
| Separate API origin | Forfeits `SameSite` cookie strength and adds CORS to every request. Rejected absent a reason to split. |

### 1.4.10 Acceptance criteria for §1.4

| # | Criterion |
|---|---|
| AC-1.4.1 | No column on the user table stores a service-hour total. |
| AC-1.4.2 | The ledger/derivation parity command exists and exits non-zero on mismatch. |
| AC-1.4.3 | Middleware order matches §1.4.4 and is asserted by test. |
| AC-1.4.4 | A path-scoped body limit is proven effective by test, not assumed. |
| AC-1.4.5 | Every routed screen is lazily imported; the shell is not. |
| AC-1.4.6 | A route with no declared prop entry throws at composition. |
| AC-1.4.7 | Every error kind renders as a takeover; asserted per kind. |
| AC-1.4.8 | A navigation entry with no capability condition fails at boot. |
| AC-1.4.9 | Shutdown drains all four background components before database close. |
| AC-1.4.10 | Every deleting sweep asserts inside its transaction. |

---

## 1.5 Testing doctrine

### 1.5.1 Purpose

This section specifies what is tested, why, and what a test must establish to count.
Appendix E specifies the taxonomy and the guard inventory in detail.

### 1.5.2 Current state

194 test files, 3,163 tests, across two runner projects: a browser-like project for
client code and a Node project for server code. Both isolate test files from one
another and both exclude full-copy directories. Server tests boot the real
application in-process against a throwaway database file.

### 1.5.3 Coverage is proportional to consequence

**Requirement.** Test effort MUST be allocated by the consequence of the code being
wrong, not by the proportion of lines executed.

**Line coverage MUST NOT be adopted as a gate.** A percentage target is satisfied most
cheaply by testing the code that is easiest to test, which is systematically the code
that matters least. It also produces tests that assert what the code does rather than
what it must do, which converts a defect into a specification.

**Mandatory test classes.** A change in any of these classes MUST NOT merge without
tests:

| Class | Obligation |
|---|---|
| Bug fix | A test reproducing the defect, observed failing first. |
| New endpoint | Authorization refusals for every role that must not reach it, plus the success path. |
| Authentication or authorization change | Both directions: the permitted actor succeeds and every other actor is refused. |
| Anything touching credited hours | Derivation, ledger parity, and the snapshot rule. |
| New boot guard | A process that fails to boot, asserted by exit status and message. |
| Migration | Idempotency, data preservation, and — for a rebuild — every guard in §1.6.4. |
| Security fix | The exploit, executed against the unmodified code and observed to succeed. |
| Copy on a failure state | The tone rule for its severity class. |

### 1.5.4 Static guards

A **static guard** is a test that reads source code rather than executing it, and
fails the build on a structural violation.

**Requirement.** Every invariant in §0.7 that can be expressed structurally MUST have
a static guard. A guard MUST:

- derive its subject set (P-3);
- produce a failure message naming the file, the violation, and the remedy;
- pair any exemption list with a staleness assertion;
- be verified to fail by introducing a violation, at the time it is written.

**A guard that has never been observed failing is not a guard.** The verification MUST
be recorded in the commit that introduces it.

### 1.5.5 Server test isolation

**Requirement.** A server test MUST NOT statically import, at module scope, anything
that transitively opens the database.

**RATIONALE.** The database module opens its file at module scope. The first import
therefore decides the path. A static import evaluated before the test harness sets the
path binds the entire suite to the repository-local database — which is, in
development, the real one.

**Requirements.**

- Such imports MUST be moved inside the setup hook, after the harness resolves.
- The harness MUST assert the opened path and fail loudly if it is not the throwaway
  file. This assertion MUST NOT be removed; it is the only thing standing between a
  test run and the development database.

### 1.5.6 Fixture rules

- A fixture MUST create the state it depends on. A test that passes only because
  another test ran first is a defect.
- A reset helper MUST clear every column its suite writes, **including columns whose
  stale values are currently inert**. A future value in a currently-unused column
  becomes live when a related feature ships, and presents as a flake rather than a
  failure.
- A fixture MUST NOT assume a seeded identity's attributes. Where a test depends on a
  specific account, it MUST assert the precondition it relies on.
- A test asserting an absence MUST first assert that the mechanism producing the
  absence was actually exercised. Asserting that nothing happened is satisfied by
  nothing happening for the wrong reason.

### 1.5.7 Characterisation of known defects

Where a defect is known but not yet fixed, it MUST be recorded as a test that is
*green while the defect is present and red when it is fixed*.

**Requirements.**

- The test MUST assert the **correct** behaviour, not the defective behaviour.
- It MUST carry a header naming the defect and its consequence.
- When the defect is fixed, the inversion marker MUST be removed and the header MUST
  be **relabelled to record that it is fixed** — not deleted.

**RATIONALE for relabelling rather than deleting.** The header records why the
assertion is worth making. Deleting it leaves an assertion that looks arbitrary and
will eventually be removed as redundant. Leaving it unmodified is worse: the file then
describes the code as broken in ways it is not, causing a reader to distrust working
code. This has occurred in this repository — nine defect headers survived their
fixes, and a file header promised inverted tests that no longer existed.

### 1.5.8 Flakiness

Restates P-10 as procedure.

1. A flaky test MUST be run in isolation. A test that passes alone and fails in the
   suite indicates shared state — a fixture defect.
2. It MUST be run against unmodified baseline code. A flake that reproduces on the
   baseline is infrastructure.
3. An infrastructure flake MUST be recorded with the evidence, the observed rate, and
   the reason it is not a code defect.
4. Any other flake MUST be fixed before the change merges.

### 1.5.9 Acceptance criteria for §1.5

| # | Criterion |
|---|---|
| AC-1.5.1 | No line-coverage gate exists in any configuration. |
| AC-1.5.2 | Every invariant in §0.7 expressible structurally has a static guard. |
| AC-1.5.3 | Every static guard derives its subject set or carries a completeness assertion. |
| AC-1.5.4 | Every exemption list carries a staleness assertion. |
| AC-1.5.5 | The harness asserts the opened database path. |
| AC-1.5.6 | Both runner projects isolate files and exclude full-copy directories. |
| AC-1.5.7 | Every characterised defect asserts correct behaviour and carries a labelled header. |

---

## 1.6 Migration rules

### 1.6.1 Purpose

This section specifies how the schema changes. Appendix C specifies the schema itself.

### 1.6.2 Two paths, and choosing between them

| Path | Use for | Mechanism |
|---|---|---|
| **Additive guard** | Adding a nullable column, adding an index. | Idempotent statement executed at initialisation. |
| **Versioned registry** | Everything structural: constraints, rebuilds, backfills, data reshaping. | Numbered module, ordered, recorded, checksum-verified. |

**Rule.** Anything that is not "add a nullable column or an index" goes in the
registry. The additive path has no ordering, no record and no rollback story; using it
for a structural change means the change cannot be reasoned about later.

### 1.6.3 Registry requirements

Every registry migration MUST:

1. Declare a unique, monotonically increasing version and a stable name.
2. Be **idempotent**. The registry's own tests execute migrations against databases
   that may already carry the change.
3. Run inside a transaction, unless it declares otherwise for a stated reason.
4. Record a checksum of its **whole source file**, re-verified on every boot.
5. Declare a rollback procedure in its header. Where no clean automatic rollback
   exists, the manual procedure MUST be written out, including what must be deleted
   first and in what order.
6. Carry a header stating what defect or requirement it exists for.

**On checksums.** The checksum covers the entire file, not the exported function, so
that module-level code is inside the verified surface. A checksum failure at boot has
three distinct causes with three different remedies, and the remedies are not
interchangeable: an edited migration, a changed checksum scheme, and a corrupted
record. The operator documentation MUST distinguish them. Deleting the recorded row is
correct for exactly one of the three.

**On transactions.** A migration that must control its own transaction MUST declare
that fact. The specific case that requires it: a foreign-key enforcement pragma is a
**silent no-op inside an open transaction**. A rebuild depending on that pragma and
running inside a wrapping transaction will execute with foreign keys enforced,
cascade-delete its children, and report success.

### 1.6.4 INV-018 — Destructive migrations carry six guards

**INVARIANT.** A migration that drops and recreates a table MUST carry all six of the
following. Five of six is not four-fifths of a guard; each covers a failure the others
do not.

| # | Guard | The failure it alone catches |
|---|---|---|
| 1 | **Backup taken before execution** | Everything, once the others have failed. Operational, not code. |
| 2 | **Pragma-took-effect assertion** | The pragma silently not applying. Nothing else catches this: the parent's rows are copied and survive; a foreign-key check finds nothing because a cascade *deletes* children rather than orphaning them; and no exception is thrown, so no rollback fires. Without this the migration commits an emptied database and reports success. |
| 3 | **Explicit column list — never a wildcard** | Column *order* differing between databases. Positional insertion then writes one column's data into another. A database built by the initialisation path and one built by an earlier rebuild are not guaranteed to agree on order. |
| 4 | **Unknown/missing column guard** | A column this migration does not know about being silently dropped by the explicit copy. The data in it belongs to someone. |
| 5 | **Schema-derived child row count comparison** | Child rows vanishing for any reason, whatever the cause. Snapshot before mutation, compare after rename, so a loss *throws* and the rollback undoes it — converting a catastrophic path into a recoverable one. The set of children MUST be derived from the schema, never listed (P-3). |
| 6 | **Foreign-key check before commit** | Residual violations the rebuild introduced. |

**Additional requirements.**

- The rebuild MUST restore every index and trigger that the drop removed. A dropped
  index is a silent performance regression; a dropped immutability trigger is a silent
  loss of an invariant.
- Where the rebuild introduces a constraint that a naïve port to another engine would
  not reproduce, the migration header MUST name it, and Volume V §5.9 MUST record it.

**Sanctioned rebuilds.** Exactly two exist. Both are recorded in Appendix C with their
justification. A third requires the amendment procedure in §0.8.

### 1.6.5 Migrations are additive by default

**Requirement.** A migration MUST NOT delete user data as a side effect of a
structural change. Where a structural change is impossible without data loss, the loss
MUST be the migration's stated purpose, MUST be enumerated, and MUST be approved by
the platform owner in writing before the migration is written.

### 1.6.6 Ordering dependencies

Where one migration must precede another for correctness, the dependency MUST be
stated at the ordering site, with the consequence of reversal.

Two such dependencies presently exist and are recorded in Appendix C. Both are of the
form "this rebuild must run while the table is childless" — reordering makes the
rebuild destructive rather than merely wrong.

### 1.6.7 INV-015 — Published legal documents are immutable

**INVARIANT.** A published legal document's version, and the hash of its published
body, MUST NOT change. Editing a published version MUST throw.

**Requirements.**

- A document's hash MUST be pinned as a constant in source and verified against the
  file at boot. Boot MUST fail on mismatch.
- The hash MUST cover the **published body** only, so that editorial matter outside
  the published body may be corrected without moving it.
- An acceptance record MUST reference a version and a hash, so that what a person
  agreed to is recoverable exactly.
- A correction to a published document is a **new version**. There is no in-place edit.
- Version numbering MUST reflect reality: absent public users and real acceptances,
  the initial published version is `1.0` for every document, and inventing later
  versions to work around a tooling collision is prohibited.

**RATIONALE.** An acceptance record whose referenced text can change is not evidence
of anything. This is the platform's only legally operative data structure and the only
one whose integrity cannot be restored after the fact.

### 1.6.8 Acceptance criteria for §1.6

| # | Criterion |
|---|---|
| AC-1.6.1 | Every structural change since the registry's introduction is in the registry. |
| AC-1.6.2 | Every migration is idempotent, verified by executing `up` twice. |
| AC-1.6.3 | Every migration declares a version, name, source URL and rollback. |
| AC-1.6.4 | Checksums cover whole files; boot verifies; the three failure causes are documented separately. |
| AC-1.6.5 | Each rebuild carries all six guards, each individually verified. |
| AC-1.6.6 | Each rebuild restores every index and trigger. |
| AC-1.6.7 | Editing a published legal version throws, asserted by test. |
| AC-1.6.8 | Boot fails on a legal hash mismatch. |

---

## 1.7 Coding standards

### 1.7.1 Naming

- A name states what the thing **is** or what it **guarantees**, not how it is built.
- A predicate reads as a question at its call site.
- A capability is `domain.action`, lower case, dot-separated. Where an action is scoped,
  the scope is a further segment (`event.edit.own`).
- An audit action identifier is `SCREAMING_SNAKE_CASE`, verb-final, and names the act
  rather than the endpoint.
- A boolean MUST NOT be negated in its name.
- A persona identifier MUST NOT be spelled the same as a role identifier, so that a
  comparison against a persona cannot be mistaken — by a reader or by a static guard —
  for a role comparison.

### 1.7.2 Error handling

- A handler MUST distinguish a caller error (`4xx`) from a system fault (`5xx`).
  Reaching a constraint violation, a parameter-binding failure or a foreign-key error
  because input was not validated is a `500` that should have been a `400`.
- Every refusal MUST carry a stable machine-readable code alongside its human message.
  Clients branch on the code; the message is free to change.
- An error response MUST NOT include a stack trace, a SQL fragment, an internal
  identifier the caller cannot use, or the existence of a record the caller may not
  see.
- An operation with more than one refusal reason MUST answer **all refusals before
  performing any state change** — including before spending a re-authentication grant.
  A request that delivers nothing MUST NOT cost the caller anything.

### 1.7.3 Validation

- Validate **shape** before reading values; validate values before writing them.
- Validate against a **closed set** where one exists, and return the legal values in
  the refusal.
- A filter parameter that is not understood MUST be **refused**, never ignored.
  **FAILURE MODE:** a mistyped filter that silently returns everything, or silently
  returns nothing, shows a moderator a queue that is not the queue they asked for. On
  that surface, "I saw no open reports" is the wrong thing to be wrong about.
- Type-check before measuring. A length comparison against a non-string is not a
  refusal: `undefined < 20` is false, so the guard passes.
  **FAILURE MODE:** a numeric value satisfies a twenty-character minimum on the one
  field an appeal is reviewed against.

### 1.7.4 Transactions

- A write that must be accompanied by a record MUST occur in the **same transaction**
  as that record. Recorded-but-not-performed and performed-but-not-recorded are both
  worse than a clean, retryable failure.
- A mandatory notification MUST be enqueued inside the transaction and MUST **throw**
  if it cannot be. A suspension whose notice could not be created is a person locked
  out with no reason given and no appeal path in existence.
- A non-mandatory notification MUST NOT fail the operation that triggered it.
- A transaction MUST NOT span an await boundary.

### 1.7.5 Cascade and referential rules

- A foreign key from a **record of an event** to the **subject of that event** MUST NOT
  cascade on delete. Deleting the subject MUST NOT delete the record.
  **FAILURE MODE:** a student who reported an adult destroys their own report by
  exercising their deletion right; the platform's privacy guarantee erases the
  evidence of what was done to them.
- Where a cascade is severed, a **snapshot of the identifying attributes** MUST be
  captured at record time, so the record remains legible.
- Every join reading a table whose foreign key has been severed MUST be an outer join.
  **FAILURE MODE:** an inner join makes affected records *vanish* from a moderation
  queue — the quietest possible failure, and one a moderator cannot notice, because
  nothing renders to say anything is missing.

### 1.7.6 Client standards

- **No colour literal or colour function outside the single stylesheet.** Enforced by
  static guard.
- **Every custom property referenced must be defined.** Enforced by static guard, with
  no allowlist.
- **No class name without a rule, and no rule without a reference.** Enforced by
  static guard. A styled element whose class has no rule renders unstyled and looks
  like a layout bug; a rule with no reference is dead weight that accumulates.
- **Every animated selector must have a reduced-motion opt-out.** The set of animated
  selectors MUST be derived, not listed.
- **Every API method a component calls must exist.** Enforced by a static guard that
  walks shipped client code.
  **FAILURE MODE:** a call to a method that was never written throws on first use, and
  is indistinguishable from a method not yet implemented until the code runs. This has
  taken down the appeals queue — the screen where a suspended student's appeal is
  read.

### 1.7.7 Prohibited patterns

| Pattern | Why prohibited |
|---|---|
| Comparing a role identifier outside the capability kernel | INV-002. |
| An inline password comparison in a route | Sign-in is the only place identity is decided from a password. Policy rules needing a hash live in the account-validation module. |
| A bare `else` terminating an authorization cascade | INV-007. |
| A wildcard column list in a rebuild | §1.6.4 guard 3. |
| Storing a derived value | §1.4.3. |
| A retry, skip or loosened assertion to green a suite | P-10. |
| A hand-written list where derivation is possible | P-3. |
| Rewriting pushed history | §1.8.5. |
| A silent redirect in place of a refusal | §1.4.6. |
| Prefetching data whose read is audited | Manufactures records of disclosures nobody performed, making the trail unusable in the direction it exists to serve. |

### 1.7.8 Acceptance criteria for §1.7

| # | Criterion |
|---|---|
| AC-1.7.1 | Every refusal carries a stable code. |
| AC-1.7.2 | No error response contains a trace, SQL, or an unusable identifier. |
| AC-1.7.3 | Every unknown filter value is refused with its legal set. |
| AC-1.7.4 | Every string-length rule type-checks first. |
| AC-1.7.5 | Every mandatory notice is enqueued inside its transaction and throws on failure. |
| AC-1.7.6 | No record-of-event foreign key cascades to its subject. |
| AC-1.7.7 | Every severed-cascade read uses an outer join. |
| AC-1.7.8 | All four client static guards pass with no allowlist. |

---

## 1.8 Branch strategy and version control

### 1.8.1 Branch model

Trunk-based. One long-lived branch. Work happens on short-lived branches that merge
by squash and are deleted at merge.

| Prefix | For |
|---|---|
| `feature/` | New capability. |
| `fix/` | Defect correction. |
| `chore/` | Dependencies, tooling, non-behavioural maintenance. |
| `docs/` | Documentation, including this specification. |
| `archive/` | Preservation of abandoned work. Never merged. |

**Requirements.**

- A branch is named for the **area of work**, never for a person or a ticket
  identifier. A branch name is read months later by someone who has neither.
- A branch carries **one concern**. Two concerns in one branch make the review of each
  worse and the revert of either impossible.
- A branch starts from current trunk.

### 1.8.2 Commit granularity

One logical change per commit. A commit MUST be revertible without taking unrelated
work with it.

A commit that fixes a defect MUST include its test. A commit that adds an endpoint MUST
include its authorization tests. Splitting a change from the test that proves it means
the trunk contains a commit whose correctness is unestablished.

### 1.8.3 Commit messages

Conventional Commits for the subject. The body is where the engineering record lives
and is **not optional** for behavioural change.

A body MUST state:

1. What was wrong — the defect or absence, concretely.
2. Why it was wrong — the consequence, in terms of what a user experiences.
3. What changed, and what was **deliberately not** changed.
4. What verifies it — the tests, with what they assert.
5. Where a decision was made between alternatives, the alternative and why it lost.

**Prohibited:** a body that restates the diff; "various fixes"; a subject with no body
for a behavioural change; assistant or tool attribution.

**RATIONALE.** The commit message is the only documentation guaranteed to be present
when the code is next read. A message recording the reasoning converts archaeology
into reading.

### 1.8.4 Merge discipline

- Squash merge. Trunk history is one commit per concern.
- The four gates MUST pass on the merged result, in the order in §1.3.4.
- Trunk MUST be installable and bootable at every commit.

### 1.8.5 History is never rewritten

**Requirement.** Pushed history MUST NOT be rewritten. A mistake is corrected by a
forward commit that explains what happened.

**RATIONALE.** Rewriting invalidates every reference to a commit — in issues, in
review comments, in this specification, in another engineer's local clone. The cost is
paid by everyone except the person rewriting.

### 1.8.6 Reverting

A revert is a normal operation and MUST NOT be treated as a failure. A defective change
on trunk MUST be reverted rather than fixed forward when the fix is not immediately
obvious. The revert commit MUST state what was wrong and what will happen next.

### 1.8.7 Acceptance criteria for §1.8

| # | Criterion |
|---|---|
| AC-1.8.1 | No branch name contains a person or ticket identifier. |
| AC-1.8.2 | Every behavioural commit body covers the five required points. |
| AC-1.8.3 | No commit contains assistant attribution. |
| AC-1.8.4 | Trunk is installable and bootable at every commit. |
| AC-1.8.5 | No pushed history has been rewritten. |

---

## 1.9 Release process and Definition of Done

### 1.9.1 Versioning

Semantic versioning over the **API and user-visible behaviour**.

| Increment | For |
|---|---|
| Major | A removed or reversed guarantee; a breaking API change; a removed capability. |
| Minor | New capability, new endpoint, new screen; a behavioural change that does not break an existing contract. |
| Patch | Defect fix, copy correction, dependency update with no behavioural change. |

**Requirement.** A version bump MUST touch **both** manifests. The health endpoint
reports the workspace manifest's version, so a root-only bump makes the running system
misreport what it is. This MUST be enforced by test.

### 1.9.2 Release checklist

Every item MUST be evidenced by executing it. Copying a previous release's evidence is
prohibited.

| # | Item | Evidence |
|---|---|---|
| R-1 | Four gates pass in order on the release commit. | Command output with counts. |
| R-2 | Both manifests carry the new version. | Diff. |
| R-3 | Health endpoint reports the new version. | Response body. |
| R-4 | Migrations apply to a **copy of production**, not a fresh database. | Before/after row counts for every affected table and its children. |
| R-5 | Migration checksums verify at boot. | Boot log. |
| R-6 | Legal hashes verify at boot; every published document answers 200. | Boot log plus per-document status. |
| R-7 | Every new endpoint refuses every role that must not reach it. | Test names and results. |
| R-8 | Every new capability appears in Appendix A. | Diff. |
| R-9 | Every new audit action appears in Appendix D. | Diff. |
| R-10 | Every new table or column appears in Appendix C with a retention class. | Diff. |
| R-11 | Dependency advisories assessed for applicability, not merely counted. | Written assessment per advisory. |
| R-12 | Changelog entry states the defect and the reasoning, not the feature name. | Diff. |
| R-13 | Backup taken and its restore **verified** before any destructive migration. | Restore output. |
| R-14 | Rollback procedure written and executable by one person under time pressure. | The procedure. |

### 1.9.3 Definition of Done

A change is Done when **every** statement below is true. Partial satisfaction is not
partial doneness; it is not Done.

**Correctness**

- [ ] D-1 The change does what was asked, in full. Where scope was reduced, the
      reduction is stated explicitly and was the owner's decision.
- [ ] D-2 Every acceptance criterion for the affected sections is satisfied.
- [ ] D-3 Every invariant touched is still enforced by a build-failing test.

**Verification**

- [ ] D-4 The four gates pass in order, and the output was observed.
- [ ] D-5 For a defect fix: the test was observed failing against unmodified code.
- [ ] D-6 For a new guard: the guard was observed failing against an introduced
      violation.
- [ ] D-7 For a user-visible change: it was exercised in a running instance, and what
      was observed is recorded.
- [ ] D-8 No test was retried, skipped or loosened to reach green.

**Record**

- [ ] D-9 The commit message covers the five points in §1.8.3.
- [ ] D-10 Every affected appendix is updated in the same commit.
- [ ] D-11 Every load-bearing constraint introduced carries an in-file rationale.
- [ ] D-12 Every comment the change made stale is corrected.
- [ ] D-13 Anything found but deliberately not fixed is recorded where it will be
      seen, with the reason.

**Safety**

- [ ] D-14 Authentication, authorization or secret handling changes have a recorded
      security review, regardless of size.
- [ ] D-15 No new path discloses private content without a distinct capability and a
      record.
- [ ] D-16 Every destructive operation has a rollback that has been executed.
- [ ] D-17 No new failure state renders inside the application shell.

**Honesty**

- [ ] D-18 No claim is made that was not verified.
- [ ] D-19 No feature is exposed that the backend cannot support.
- [ ] D-20 Any capability granted describes something the system can actually do.

**RATIONALE for D-19 and D-20.** Both record realised failures. A screen over an
endpoint that does not exist is worse than its absence, because the absence is visible
and the broken screen is not. A capability granted before the data model supports it
replaces a permission error with an empty screen — a worse outcome, not a better one,
because the permission error was at least accurate.

### 1.9.4 Review duties

A review MUST establish the following, in this order. A review that begins with style
has already failed.

1. **Does it do what was asked?** Including the parts that are hard.
2. **What did it break?** Specifically: which invariant could this weaken, and is that
   invariant still enforced?
3. **Is the verification real?** Was the failing test observed? Was the guard observed
   failing?
4. **Is the record honest?** Does the message match the diff? Are the limitations
   stated?
5. **Will the next reader understand why?** Are the load-bearing parts marked as such?
6. Then, and only then: consistency and style.

**Required reviews by change class.**

| Class | Required |
|---|---|
| Authentication, authorization, secrets | Security review. Not optional at any size. |
| Schema change | Migration review against §1.6. |
| Anything writing a trail | Audit review against Appendix D. |
| Personal data flow | Privacy review against §1.2.6. |
| New screen or changed failure state | Accessibility review against Volume I §1.4.6 and each volume's accessibility section. |
| Destructive migration | Owner sign-off in writing. |

### 1.9.5 Acceptance criteria for §1.9

| # | Criterion |
|---|---|
| AC-1.9.1 | Both manifests agree on version; enforced by test. |
| AC-1.9.2 | Every release checklist item has evidence produced for that release. |
| AC-1.9.3 | Migrations were applied to a production copy before release. |
| AC-1.9.4 | Every advisory has a written applicability assessment. |
| AC-1.9.5 | Definition of Done is satisfied in full for every merged change. |

---

## 1.10 Documentation requirements

### 1.10.1 The documentation set

| Artefact | Purpose | Currency obligation |
|---|---|---|
| `docs/spec/` | This specification. Target state and binding contracts. | Amended by §0.8 procedure. |
| `docs/ENGINEERING_GUIDE.md` | Process in force, each rule annotated with its incident. | Updated when a rule changes. |
| `README.md` | What the product is, how to run it. | Verified each release. |
| `CHANGELOG.md` | Behavioural change with reasoning. | Every behavioural change. |
| `docs/operations/` | Runbooks: deployment, release, restore, incident, triage. | Verified by execution, not by reading. |
| `docs/legal/` | Policy sources. Published bodies are immutable. | §1.6.7. |
| In-file headers | The invariant a module protects and the incident behind it. | Same commit as the code. |

### 1.10.2 In-file header requirement

A module MUST open with a header when any of the following is true:

- it enforces an invariant;
- it contains an ordering that is load-bearing;
- its shape is counter-intuitive and the intuitive shape is wrong;
- it exists because of a specific incident.

The header MUST state the invariant or ordering, the failure mode, and — where one
exists — the incident. It MUST NOT restate what the code does.

### 1.10.3 Runbooks are verified by execution

**Requirement.** A runbook MUST be executed end to end, by a person following only
the runbook, before it is considered current. A runbook that has been read but not
executed is a hypothesis.

This applies with particular force to the restore procedure. **A backup that has never
been restored is not a backup.** See Volume V §5.8.5.

### 1.10.4 Changelog requirements

An entry MUST state the defect or absence and its consequence, not the feature name.

- **Prohibited:** "Added evidence viewer."
- **Required:** what could not be done, what that meant for the person affected, what
  now happens, and what was deliberately excluded.

**RATIONALE.** A changelog of feature names answers "what shipped". A changelog of
defects and consequences answers "why is the system shaped like this", which is the
question actually asked a year later.

### 1.10.5 Acceptance criteria for §1.10

| # | Criterion |
|---|---|
| AC-1.10.1 | Every invariant-enforcing module carries a header meeting §1.10.2. |
| AC-1.10.2 | No comment describes a defect that has been fixed. |
| AC-1.10.3 | Every runbook has an execution record with a date. |
| AC-1.10.4 | The restore runbook has been executed against a real backup. |
| AC-1.10.5 | Every changelog entry states a defect and a consequence. |
| AC-1.10.6 | Every appendix matches the code it describes. |

---

## 1.11 Failure modes of this volume

The rules above have failure modes of their own. They are recorded so that a future
reader can recognise the failure rather than concluding the rules are wrong.

| Failure mode | Symptom | Response |
|---|---|---|
| Guard fatigue | Guards pinned to line numbers fail on unrelated edits; the response becomes mechanical updating without re-reading. | The guard MUST require re-reading, and the update MUST record that the re-read happened and what it concluded. A pin updated without a re-read is a rubber stamp. |
| Rationale rot | Comments accumulate faster than they are corrected. | D-12 makes correcting a stale comment part of the change that staled it. Reviewers check it. |
| Specification drift | This document describes a system that no longer exists. | §0.8 precedence rules, plus §0.9 baseline measurements that a reader can re-take. |
| Over-derivation | A derived guard becomes so abstract nobody can tell what it enforces. | A derived guard MUST produce a failure message naming the concrete file and remedy. Abstraction in the mechanism, concreteness in the message. |
| Ceremony without signal | The Definition of Done becomes a box-ticking exercise. | Every item is stated as an observation, not an intention. "The output was observed" is checkable; "tests were run" is not. |
| Honest-reporting decay | Partial work reported as complete because the remainder is small. | D-1 and D-13 make the remainder part of the record. A scope reduction is the owner's decision, not the implementer's. |

---

## 1.12 Volume I acceptance summary

Volume I is satisfied when:

- Every acceptance criterion in §§1.3.9, 1.4.10, 1.5.9, 1.6.8, 1.7.8, 1.8.7, 1.9.5 and
  1.10.5 holds.
- Every invariant in §0.7 attributed to Volume I (INV-001, INV-015, INV-016, INV-018,
  INV-019) is enforced by a build-failing test that has been observed to fail.
- The four gates pass in the order specified.
- The Definition of Done in §1.9.3 is the checklist actually applied to merges, and a
  sample of recent merges demonstrates it.

**Cross-references.** Volume II §2.3 specifies the capability kernel that INV-002,
INV-003 and INV-005 govern. Volume V §5.9 specifies the database evolution that §1.6
constrains. Volume VI assigns the phases in which any unmet criterion above is closed.
