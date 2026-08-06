# Appendix E — Testing Strategy

**Status:** Normative
**Binds:** Volume I §1.5, and every acceptance criterion in Volumes II–VI
**Currency obligation:** Updated whenever a guard class is added or a coverage obligation
changes.

---

## E.1 Baseline

| Measurement | Value |
|---|---|
| Test files | 194 |
| Tests | 3,163 |
| Runner projects | 2 — browser-like for client, node for server |
| Isolation | Per-file, both projects |
| Excluded | Full-copy directories |

**Requirement.** Both isolation settings and both exclusions are **measured, documented,
load-bearing decisions**. Neither may be "simplified". The exclusion exists because a
full-copy directory contains a second copy of roughly a hundred test files, which the runner
will otherwise walk into.

---

## E.2 Test taxonomy

| Class | Runs against | Answers | Cost |
|---|---|---|---|
| **Unit** | A pure module, no fixtures | Does this decision behave? | Microseconds |
| **Integration** | The real application in-process, throwaway database | Does this endpoint behave? | Milliseconds |
| **Component** | A rendered component with a mocked API surface | Does this screen behave? | Milliseconds |
| **Static guard** | **Source code, not execution** | Is this structural rule still obeyed? | Milliseconds |
| **Storage-layer** | The database directly, bypassing the application | Does the constraint hold for *every* path? | Milliseconds |
| **Boot** | A spawned process with a stated environment | Does misconfiguration fail closed? | Hundreds of milliseconds |
| **Subprocess probe** | A fresh process with a replaced environment | What does a module do under a configuration this suite cannot have? | Hundreds of milliseconds |

### E.2.1 When each class is required

| Situation | Required class |
|---|---|
| A decision expressible without data | Unit |
| An endpoint | Integration, one per role that must be refused plus the success path |
| A screen | Component |
| A structural rule | **Static guard** |
| An invariant enforced by the database | **Storage-layer**, asserted directly, not through a handler |
| A configuration guard | **Boot**, asserting exit status **and** message |
| A module whose behaviour depends on environment read at load | **Subprocess probe** |

**Requirement on storage-layer tests.** An immutability constraint MUST be asserted by
attempting the write **directly against the database**, not through the application. A test
going through a handler proves the handler is careful; the constraint exists to protect
against every path anybody ever writes, including an operational script and a database
console.

**Requirement on subprocess probes.** A module reading configuration at load cannot be tested
in a process whose configuration is already set. The suite configures providers for every
test; a test needing to observe an **unconfigured** provider therefore cannot run in that
process at all. Each such case MUST spawn a fresh process with an environment it states in
full — and the environment MUST **replace** rather than merge, or a developer with real
credentials exported in their shell turns every "missing credential" case into a configured
one, and the suite passes for them and fails in continuous integration.

---

## E.3 Coverage doctrine

### E.3.1 Line coverage is not a gate

**Requirement.** No line-coverage target may exist in any configuration.

**RATIONALE.** A percentage target is satisfied most cheaply by testing the code that is
easiest to test, which is systematically the code that matters least. It also produces tests
asserting what the code does rather than what it must do — which converts a defect into a
specification.

### E.3.2 Mandatory coverage by change class

| Change | Obligation |
|---|---|
| Bug fix | A test reproducing the defect, **observed failing first** |
| New endpoint | Refusal for every role that must not reach it, plus the success path |
| Authorization change | Both directions: permitted actor succeeds, every other is refused |
| Anything touching credited hours | Derivation, ledger parity, snapshot rule |
| New boot guard | A spawned process asserting exit status and message |
| Migration | Idempotency, data preservation, and for a rebuild every guard in Volume I §1.6.4 |
| Security fix | The exploit, executed against unmodified code and observed to succeed |
| New static guard | Observed failing against an introduced violation |
| Copy on a failure state | The tone rule for its severity class |
| A derived figure | Parity against its source |
| A capability | Exhaustive matrix assertion, derived from the registry |

**Requirement.** "Observed failing first" is not satisfied by reasoning that it would have
failed. The failure MUST be produced and recorded.

---

## E.4 Static guard inventory

A static guard reads source and fails the build on a structural violation. Every invariant in
Volume 0 §0.7 expressible structurally MUST have one.

### E.4.1 Guard requirements

| # | Requirement |
|---|---|
| GD-1 | **Derive** the subject set from the filesystem, a registry, or an exported constant. Never a literal list (P-3). |
| GD-2 | Assert the subject set is **non-empty**, or document why emptiness is tolerated and when it will end. |
| GD-3 | Produce a failure message naming the file, the violation, and the **remedy**. |
| GD-4 | Pair any exemption list with a **staleness** assertion. |
| GD-5 | Strip comments before matching, so prose discussing the prohibited pattern does not trip it. |
| GD-6 | Be **verified failing** against an introduced violation, and the verification recorded in the introducing commit. |

**RATIONALE for GD-1.** A hand-written list covers what its author remembered. It does not
fail when the subject grows — it silently covers less while continuing to pass. This has
occurred at least four times in this repository: the provider state loop, the provider
credential fixtures, the suspension enforcement points, and the animated-class list.

**RATIONALE for GD-2.** A guard whose derivation returns nothing passes vacuously and looks
green forever.

**RATIONALE for GD-3.** Abstraction belongs in the mechanism; concreteness belongs in the
message. A derived guard whose failure says only "a rule was violated" is a guard nobody can
act on.

**RATIONALE for GD-5.** Several modules carry comments explaining why a pattern is
prohibited. A guard matching raw source reports those comments as violations, and the fix
becomes deleting the explanation.

### E.4.2 Server guards

| # | Guard | Prevents |
|---|---|---|
| SG-1 | No role-identifier comparison in any authorization-deciding module, any spelling | Adding a role silently denying it everywhere |
| SG-2 | Every authenticated route behind a capability gate or a reviewed justification | An ungated route |
| SG-3 | The same scan over client source | Drift in the direction of offering controls the API rejects |
| SG-4 | Every step-up gate argument is a registry literal | A computed action identifier that cannot be statically verified |
| SG-5 | Every gate paired with a spend for the same action; every registered action gated | A replayable grant — **and every functional test still passes** |
| SG-6 | Every direct grant expenditure declared | An undeclared consumption path |
| SG-7 | The capability kernel imports nothing | Decay into a data-access layer; loss of client shareability |
| SG-8 | One definition of "suspended right now" across every server module | A second, wrong definition — the provider-door lockout |
| SG-9 | Every implemented provider invokes the credential guard | An authorization URL with an empty identifier |
| SG-10 | Every implemented provider has state-matrix fixtures | A provider with zero state coverage that looks covered |
| SG-11 | Every configuration variable read appears in the example file | An undocumented variable discovered during an incident |
| SG-12 | The owner role appears in no writable enumeration *(specified, Volume VI P-00)* | Ownership seizure through a route |
| SG-13 | Every Developer Mode route applies the identity check *(specified, P-00)* | A route registered outside the prefix, unguarded |
| SG-14 | Every audit action in code appears in Appendix D, and conversely *(specified)* | An unregistered action; a stale appendix |
| SG-15 | Every table appears in Appendix C, and conversely *(specified)* | An undocumented table; a stale appendix |

### E.4.3 Client guards

| # | Guard | Prevents |
|---|---|---|
| CG-1 | Every custom property referenced is defined, **no allowlist** | A silently unstyled element |
| CG-2 | No colour literal or colour function outside the single stylesheet | Theme drift; unthemeable colour |
| CG-3 | No class without a rule, and no rule without a reference | An element that renders unstyled and looks like a layout bug; dead rules accumulating |
| CG-4 | Every animated selector has a reduced-motion opt-out, **derived** | A new theme animating with no opt-out, leaving a vestibular-sensitive reader nothing but a comment |
| CG-5 | Every `api.X()` call exists on the client API surface | A call to a method never written, throwing on first use |
| CG-6 | Every client capability name exists in the registry | An entry invisible to every user and a route that refuses everyone — nothing throws, nothing logs |
| CG-7 | Every gated route's capability has a plain-language name *(specified, P-00)* | Vaguer refusal copy becoming the norm |
| CG-8 | Every internal link resolves to a declared route | A dead link in the one message a suspended user is guaranteed to read |

**Requirement on CG-1.** No allowlist. An allowlist on this guard is a list of properties
somebody decided not to define, which is the condition the guard exists to detect.

---

## E.5 Server test isolation

### E.5.1 The import rule

**Requirement.** A server test MUST NOT statically import, at module scope, anything that
transitively opens the database.

**RATIONALE.** The database module opens its file at module scope, so the **first import
decides the path**. A static import evaluated before the harness sets the path binds the
entire suite to the repository-local database — which is, in development, the real one.

**Requirement.** Such imports MUST be moved inside the setup hook, after the harness
resolves.

**Requirement.** The harness MUST assert the opened path and fail loudly if it is not the
throwaway file. **This assertion MUST NOT be removed**; it is the only thing standing between
a test run and the development database.

### E.5.2 Fixture rules

| # | Rule |
|---|---|
| FX-1 | A fixture creates the state it depends on. A test passing only because another ran first is a defect. |
| FX-2 | A reset helper clears **every column its suite writes**, including columns whose stale values are currently inert. |
| FX-3 | A test MUST NOT assume a seeded identity's attributes; it MUST assert the precondition it relies on. |
| FX-4 | A test asserting an absence MUST first assert that the mechanism producing the absence was exercised. |
| FX-5 | Where a schema constraint makes a fixture unique-per-row, the fixture MUST create distinct subjects rather than reusing one. |

**RATIONALE for FX-2.** A future value in a currently-unused column becomes live when a
related feature ships, and presents as a **flake** rather than a failure. A suspension
deadline left on a row by one test silently shortens a suspension imposed by another.

**RATIONALE for FX-4.** Asserting that nothing happened is satisfied by nothing happening for
the wrong reason — a filter that matched nothing, a query naming a column that stores
something else. A test filtering notifications by event name passed while asserting the
absence of rows it never looked for, because that column stores the category.

---

## E.6 Characterisation of known defects

Where a defect is known and not yet fixed:

| # | Rule |
|---|---|
| CH-1 | The test asserts the **correct** behaviour, not the defective behaviour. |
| CH-2 | It is registered inverted, so it is green while the defect is present and red when fixed. |
| CH-3 | It carries a header naming the defect and its consequence. |
| CH-4 | On fix, the inversion is removed and the header is **relabelled to record that it is fixed** — not deleted. |

**RATIONALE for CH-4.** The header records why the assertion is worth making. Deleting it
leaves an assertion that looks arbitrary and will eventually be removed as redundant.
Leaving it unmodified is worse: the file then describes the code as broken in ways it is not,
causing a reader to distrust working code or to "re-fix" it. This has occurred — nine defect
headers survived their fixes, and a file header promised inverted tests that no longer
existed.

---

## E.7 Flakiness

**Requirement.** Flakiness is a defect. Re-running is not a remedy.

| # | Step |
|---|---|
| FL-1 | Run in isolation. Passing alone and failing in the suite indicates shared state — a **fixture** defect. |
| FL-2 | Run against unmodified baseline code. Reproducing on the baseline indicates **infrastructure**. |
| FL-3 | An infrastructure flake is recorded with the evidence, the observed rate, and why it is not a code defect. |
| FL-4 | Any other flake is fixed before the change merges. |

**Requirement.** A test MUST NOT be retried, skipped or loosened to green a suite. Loosening
converts a signal into a comfort.

**Recorded infrastructure flake.** The runner's worker pool exits unexpectedly on roughly one
run in three under full-suite load. Reproduced on unmodified baselines; always green on
retry. Recorded rather than worked around, because working around it would mean adding a
retry, and a retry would mask a genuine flake in the same shape.

---

## E.8 Verification discipline

### E.8.1 Observed failure

**Requirement.** For each of the following, the failure MUST be **produced and observed**,
not reasoned about:

| Situation | What must be observed |
|---|---|
| A bug fix | The test failing against unmodified code |
| A new static guard | The guard failing against an introduced violation |
| A transactional guarantee | The rollback occurring under an **induced** failure |
| A boot guard | The process exiting with the expected status and message |
| A parity check | A non-zero exit under an **induced** divergence |

**Requirement.** The observation MUST be recorded in the commit that introduces the test.

### E.8.2 The wildcard content rule

**Requirement.** Every authorization cascade MUST be asserted for the **content** a wildcard
principal receives, not only the status.

**RATIONALE.** A cascade mis-ordered so the wildcard lands in a narrow branch still returns
200 with a plausible body. The platform owner silently receives a student's scoped view of
the data. No status assertion detects it.

### E.8.3 Exhaustive matrices stay cheap

**Requirement.** The capability matrix test MUST be exhaustive over role × capability, and
MUST remain fast enough to stay exhaustive. This is why the kernel is pure (Volume II
§2.3.2): a matrix test requiring fixtures would be too slow to run exhaustively and would be
sampled instead.

---

## E.9 What is not tested, and why

Stated so an absence is a decision rather than an oversight.

| Not tested | Reason |
|---|---|
| Third-party library internals | Not our code; testing it tests the version, not the system. |
| Visual appearance | No screenshot comparison. It produces failures on every legitimate change and trains the operator to accept diffs. Structure, semantics and token discipline are guarded instead. |
| Exact copy strings, except where a rule binds them | Copy changes legitimately. Where a rule binds it — tone by severity class, absence of a powerless referral, presence of a remedy — the **rule** is asserted, not the string. |
| Mail deliverability | External. Verified operationally by a send test each release. |
| Browser compatibility matrix | Manual, against the institution's actual device population. |
| Load beyond the measured ceiling | Volume V §5.7.2: capacity work follows a measured trigger, and so does its testing. |
| End-to-end browser specs | A specification exists but is not part of the standard loop: the driver is not a declared dependency and no script runs it. **Its absence from the loop is recorded here rather than implied by its presence in the tree.** |

---

## E.10 Test naming and structure

| # | Rule |
|---|---|
| TN-1 | A test name states the **behaviour**, not the mechanism. "refuses a note under twenty characters", not "validates resolutionNote". |
| TN-2 | A test asserting a safety property SHOULD say so in its name, so a failure reads as a safety failure in continuous integration output. |
| TN-3 | A file carries a header stating what it is responsible for **and what it is not**, with the file that covers the remainder. |
| TN-4 | An assertion with a non-obvious failure mode carries a message stating the consequence, not the expectation. |

**RATIONALE for TN-3.** Without it, two files each assume the other covers a case. The header
that says "not authorization: that is covered by these three files, which fail for different
reasons" is what prevents both a gap and a duplication.

**RATIONALE for TN-4.** `expected 200 to be 403` tells a reader nothing. "a student could
read the queue" tells them what broke.

---

## E.11 Continuous integration

| # | Requirement |
|---|---|
| CI-1 | The four gates run in the order in Volume I §1.3.4. |
| CI-2 | Any lockfile outside the root fails the build. |
| CI-3 | Every static guard runs on every change; guards are not a separate optional job. |
| CI-4 | A failure is never retried automatically. |
| CI-5 | Output includes test **counts**, so a silent reduction in tests executed is visible. |

**RATIONALE for CI-5.** A change that accidentally excludes a directory reduces the suite
without failing it. Counts are how that becomes visible.

---

## E.12 Verification obligations for this appendix

| # | Obligation |
|---|---|
| VE-1 | Every invariant in Volume 0 §0.7 expressible structurally has a guard. |
| VE-2 | Every guard satisfies GD-1 to GD-6. |
| VE-3 | Every exemption list fails when stale. |
| VE-4 | The harness asserts the opened database path. |
| VE-5 | No line-coverage gate exists. |
| VE-6 | Every characterised defect asserts correct behaviour with a labelled header. |
| VE-7 | Every cascade is asserted for wildcard content. |
| VE-8 | The capability matrix assertion is exhaustive and derived. |
| VE-9 | Every recorded infrastructure flake has evidence of reproducing on baseline. |
| VE-10 | Test counts appear in continuous integration output. |
