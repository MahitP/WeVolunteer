# Milestone 1 — Security & Accountability Foundation

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 is
> implementable now. Tasks 2–4 are planning deliverables whose own documents must be
> approved before any code is written.

**Goal:** Close the live notification-coverage regression, establish that every published
retention promise is enforced, and design the two accountability foundations — the Audit
Log Explorer and the Super Admin bootstrap — to the point where they can be built without
further design decisions.

**Architecture:** M1 changes almost nothing at runtime. Task 1 is a test-integrity fix
plus one comment move. Tasks 2–4 produce plans. The only source change authorised by this
document is Task 1.

**Tech Stack:** Node 24 · `node:sqlite` · Express · React 19 · Vitest

---

## Global Constraints

Copied verbatim from the specification. Every task's requirements implicitly include
these.

- **Four gates, in order:** `npm ci` → `npm test` → `npm run build` → `npm run lint`.
- **`npm install` from the repository root only.** Never inside `server/`.
- **A bug fix's test is written first and observed failing** against unmodified code.
- **A new guard is observed failing** against an introduced violation, and the observation
  is recorded in the introducing commit.
- **A guard derives its subject set**; a hand-written list is a guard that silently covers
  less as the subject grows (P-3).
- **A guard asserts its subject set is non-empty** (GD-2), or documents tolerated emptiness.
- **No test is retried, skipped or loosened** to reach green (P-10).
- **Commit messages state** what was wrong, why it was wrong, what changed, what was
  deliberately not changed, and what verifies it.
- **No assistant attribution** in commits or documentation.
- **Comments explain why.** A comment made stale by a change is corrected in that change.
- **Appendices are updated in the same commit** as the change that affects them.

---

## Scope

| # | Task | Type | Authorised to change code? |
|---|---|---|---|
| 1 | Notification coverage regression | **Implementation** | **Yes** |
| 2 | Retention enforcement review | Planning → `RETENTION_ENFORCEMENT_PLAN.md` | No |
| 3 | Audit Log Explorer foundation | Planning → `AUDIT_EXPLORER_IMPLEMENTATION_PLAN.md` | No |
| 4 | Super Admin bootstrap design | Planning → `SUPER_ADMIN_IMPLEMENTATION_PLAN.md` | No |

**Out of scope for M1**, recorded so the boundary is a decision rather than an omission:

- Administrator promotion, revocation and invitations — blocked on the Explorer existing
  and on ownership enforcement.
- Ownership enforcement itself (INV-008 refusal paths) — Task 4 designs the *bootstrap*;
  enforcement is M2.
- Developer Mode — deferred, and must not precede the Explorer.
- The 13 vacuum-prone guards and 5 stale-exemption guards — real, but they are their own
  work stream and folding them into Task 1 would obscure what Task 1 verified.

---

## File Structure

Only Task 1 touches source.

| File | Responsibility | Change |
|---|---|---|
| `server/notificationContent.coverage.test.js` | Discovers dispatched events and asserts each has usable content | **Modify** — comment-strip the scanner, add a ternary matcher, add registry-derived assertions, add scanner self-tests |
| `server/routes/adminRoutes.js` | Suspension handler | **Modify** — move one comment out of a call's argument list |
| `server/services/notificationContent.js` | Content registry | **Modify** — correct one stale comment |
| `docs/spec/appendix-testing-strategy.md` | Guard inventory | **Modify** — record the corrected guard |

---

## Task 1: Notification Coverage Regression

**Files:**
- Modify: `server/notificationContent.coverage.test.js`
- Modify: `server/routes/adminRoutes.js` (the `ACCOUNT_SUSPENDED` dispatch call)
- Modify: `server/services/notificationContent.js` (one stale comment)
- Modify: `docs/spec/appendix-testing-strategy.md`

**Interfaces:**
- Consumes: `EVENT_CATEGORIES`, `MANDATORY_NOTICE_EVENTS`, `getInAppContent` from
  `server/services/notificationContent.js`
- Produces: `matchDispatchedEventNames(src)`, `matchIndirectEventNames(src)`,
  `matchTernaryEventNames(src)`, `stripComments(src)` — all exported from the coverage
  test file so the scanner is itself testable, which is the existing convention in that
  file

### Why this task exists

`ACCOUNT_SUSPENDED` is the notice a suspended minor receives, carrying the reason for the
suspension and the appeal link. It is currently invisible to the test that verifies
notification content exists, renders, and contains no placeholder text.

The cause: the scanner matches `dispatch(` followed immediately by a quoted literal. A
JSDoc block now sits between them, introduced in commit `b8434fd` while shipping timed
suspensions. The comment is correct and worth keeping; its position broke the scanner.

`APPEAL_DECISION_STANDS` and `APPEAL_DECISION_REVERSED` are invisible to the same scanner
for a different reason — they are dispatched from a ternary — and that one is
pre-existing.

**The fix must be the guard, not the instance.** Restoring only the comment position
leaves a scanner that the next comment will blind again.

### The four requirements, mapped

| Requirement | Satisfied by |
|---|---|
| Restore coverage discovery | Steps 3–4 (comment stripping) and 6–7 (ternary matcher) |
| Do not weaken the test | The dispatch scan is **retained**, not replaced. Registry assertions are **added alongside** it. Step 12 asserts the scan still finds what it found before |
| Prove comments/refactors cannot silently remove events | Step 9: every mandatory notice must be discoverable by the scanner — derived from the registry, so it cannot be satisfied by a hand-written list |
| Verify notification still behaves correctly | Step 14: the existing suspension route tests, plus a content assertion on the delivered notice |

### Design decisions

**D1 — Strip comments before scanning, rather than broadening the whitespace pattern.**

A pattern permitting arbitrary characters between `dispatch(` and the literal would also
match a *different* call's literal further down the file. Comment-stripping removes the
blinding class entirely without loosening what counts as a match. This is the same
technique three other guards in the repository already use.

**D2 — Add a dedicated ternary matcher rather than a general expression parser.**

The ternary form is the only non-literal dispatch shape present. A general parser is
disproportionate and would itself need testing.

**D3 — Assert content for every mandatory notice, derived from the registry.**

This is the assertion that would have caught the regression when it was introduced. It is
scoped to mandatory notices rather than all 40 registered events because 10 registered
events currently have no content, and forcing that decision into this task would block a
regression fix behind a product question. Those 10 are recorded in Task 1's follow-up
(§Follow-ups) and belong to decision A-04.

**D4 — Do not add `ACCOUNT_SUSPENDED` to the anti-vacuity anchor list.**

Tempting, and wrong: it would make the specific event pass while leaving every other event
blindable by the same mechanism. The derived assertion in Step 9 covers the class.

### Steps

- [ ] **Step 1: Reproduce the regression**

Run:
```bash
node -e "
const s=require('fs').readFileSync('server/routes/adminRoutes.js','utf8');
const found=[...s.matchAll(/dispatch\(\s*['\"\`]([A-Z0-9_]+)['\"\`]/g)].map(m=>m[1]);
console.log('found:', found.join(', '));
console.log('ACCOUNT_SUSPENDED visible?', found.includes('ACCOUNT_SUSPENDED'));
"
```
Expected: `ACCOUNT_SUSPENDED visible? false`

Record the output. This is the failing observation the fix is measured against.

- [ ] **Step 2: Write the failing scanner self-test for comment blinding**

Add to the existing "the dispatch scanner itself" section of
`server/notificationContent.coverage.test.js`:

```js
it('is not blinded by a comment between the call and its first argument', () => {
  const src = `
    notificationService.dispatch(
      /**
       * A comment explaining the payload.
       */
      'ACCOUNT_SUSPENDED', { reason }, targetId
    );
  `;
  expect(matchDispatchedEventNames(stripComments(src))).toContain('ACCOUNT_SUSPENDED');
});

it('is not blinded by a line comment before the first argument', () => {
  const src = `dispatch(\n  // why this payload\n  'HOURS_APPROVED', p, u);`;
  expect(matchDispatchedEventNames(stripComments(src))).toContain('HOURS_APPROVED');
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run server/notificationContent.coverage.test.js -t "blinded by a comment"`
Expected: FAIL — `stripComments is not defined`

- [ ] **Step 4: Implement `stripComments` and apply it at every read site**

```js
/**
 * Comments removed before scanning.
 *
 * ── Why ──
 *
 * The scanner matches `dispatch(` followed immediately by a quoted literal. A JSDoc
 * block placed between the two makes the call invisible — which is how
 * ACCOUNT_SUSPENDED, the notice a suspended student receives with their appeal link,
 * stopped being covered by this file while every test stayed green.
 *
 * Stripping comments removes that class entirely. Broadening the pattern to permit
 * arbitrary characters instead would let it match a DIFFERENT call's literal further
 * down the file, which is a worse failure than the one being fixed.
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
```

Apply it in both walkers, at the point each file is read:

```js
const src = stripComments(readFileSync(full, 'utf8'));
```

**Note on the line-comment pattern:** the `[^:]` guard prevents `//` inside a URL literal
(`https://…`) from truncating the line. This matters — `notificationContent.js` contains
support links.

- [ ] **Step 5: Run to confirm both self-tests pass**

Run: `npx vitest run server/notificationContent.coverage.test.js -t "blinded"`
Expected: PASS (2)

- [ ] **Step 6: Write the failing self-test for the ternary form**

```js
it('finds an event dispatched from a ternary', () => {
  const src = `
    notificationService.dispatch(
      decision === 'reversed' ? 'APPEAL_DECISION_REVERSED' : 'APPEAL_DECISION_STANDS',
      payload, userId
    );
  `;
  const found = matchTernaryEventNames(stripComments(src));
  expect(found).toContain('APPEAL_DECISION_REVERSED');
  expect(found).toContain('APPEAL_DECISION_STANDS');
});
```

- [ ] **Step 7: Run to confirm it fails, then implement `matchTernaryEventNames`**

Run: `npx vitest run server/notificationContent.coverage.test.js -t "from a ternary"`
Expected: FAIL — `matchTernaryEventNames is not defined`

Implement:

```js
/**
 * Events dispatched from a conditional expression.
 *
 * `dispatch(cond ? 'A' : 'B', …)` puts no literal immediately after the parenthesis, so
 * the primary matcher cannot see either branch. Both appeal decision notices are
 * dispatched this way and have therefore never been covered by this file.
 *
 * Bounded to the first argument by stopping at the first comma that follows a closing
 * quote, so a payload containing an uppercase string cannot be mistaken for an event.
 */
export function matchTernaryEventNames(src) {
  const names = [];
  for (const m of src.matchAll(/dispatch\(\s*[^,'"`]*\?\s*['"`]([A-Z0-9_]+)['"`]\s*:\s*['"`]([A-Z0-9_]+)['"`]/g)) {
    names.push(m[1], m[2]);
  }
  return names;
}
```

Add it to the union the file already builds:

```js
const all = new Map([...direct, ...indirect, ...ternary]);
```

- [ ] **Step 8: Run to confirm it passes**

Run: `npx vitest run server/notificationContent.coverage.test.js -t "from a ternary"`
Expected: PASS

- [ ] **Step 9: Add the derived regression guard — the assertion that matters**

```js
/**
 * Every mandatory notice must be DISCOVERABLE by the scanner.
 *
 * ── What this catches that nothing else does ──
 *
 * The other assertions in this file check the events the scanner happens to find. This
 * one checks that the scanner finds the events that must exist — so a refactor, a
 * comment, or a change of call shape that makes a mandatory notice invisible fails here
 * rather than silently reducing coverage.
 *
 * Scoped to MANDATORY_NOTICE_EVENTS because those are the notices a person must receive:
 * a suspension, a warning, a reinstatement, an appeal outcome, an urgent safety alert.
 * An undispatched or invisible one of those is the most consequential failure this
 * subsystem has.
 *
 * Derived from the registry, never listed. A hand-written list here would cover the
 * events its author remembered, which is the failure mode this guard exists for.
 */
describe('every mandatory notice is reachable and covered', () => {
  const discovered = new Set(all.keys());

  it('has at least one mandatory notice to check (guards this guard)', () => {
    expect(MANDATORY_NOTICE_EVENTS.size).toBeGreaterThan(0);
  });

  it.each([...MANDATORY_NOTICE_EVENTS])('%s is dispatched somewhere the scanner can see', (event) => {
    expect(
      discovered.has(event),
      `${event} is a mandatory notice but no dispatch site is visible to the scanner. `
      + 'Either it is never sent — in which case a person who must be told is not being '
      + 'told — or the call is written in a shape the scanner cannot read, in which case '
      + 'this event has silently lost its content coverage. Check the call site before '
      + 'changing this test.',
    ).toBe(true);
  });

  it.each([...MANDATORY_NOTICE_EVENTS])('%s has real content', (event) => {
    const c = getInAppContent(event, { reason: 'x', token: 't', appealDeadline: 'Monday' });
    expect(c.title).not.toBe('Notification');
    expect(c.body).not.toBe('You have a new notification.');
    expect(c.title.trim().length).toBeGreaterThan(0);
    expect(c.body.trim().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 10: Run it — expect `ACCOUNT_SUSPENDED` to fail**

Run: `npx vitest run server/notificationContent.coverage.test.js -t "mandatory notice"`
Expected: **FAIL** on `ACCOUNT_SUSPENDED is dispatched somewhere the scanner can see`

This is the regression, now caught by a guard. Record the output.

- [ ] **Step 11: Move the comment out of the call's argument list**

In `server/routes/adminRoutes.js`, relocate the JSDoc block from between
`notificationService.dispatch(` and `'ACCOUNT_SUSPENDED'` to **immediately above** the
`dispatch(` call. The comment text is unchanged.

Add one line to it recording why its position matters:

```
 * Kept ABOVE the call rather than inside its argument list: a comment between
 * `dispatch(` and the literal makes the event invisible to
 * notificationContent.coverage.test.js, which is how this notice lost its coverage once.
```

- [ ] **Step 12: Run the whole coverage file**

Run: `npx vitest run server/notificationContent.coverage.test.js`
Expected: PASS, and the anti-vacuity assertion still finds more than 15 events.

Confirm the scan did not *shrink*: the event count must be **greater than or equal to**
the pre-change count, never lower. Record both numbers.

- [ ] **Step 13: Correct the stale comment in the content registry**

`server/services/notificationContent.js` states that the coverage test "asserts every
member has content". Before this task that was false. After Step 9 it is true for
mandatory members. Update the comment to say exactly that — every **mandatory** member —
rather than leaving a claim broader than the guard.

- [ ] **Step 14: Verify the notification still behaves correctly**

Run: `npx vitest run server/routes.suspension.test.js server/routes.warning.test.js`
Expected: PASS, all cases.

Then confirm the delivered notice is unchanged, not merely that the route succeeds:

```bash
npx vitest run server/routes.suspension.test.js -t "names the end date in the notice"
```
Expected: PASS — the notice still contains "This suspension ends on".

- [ ] **Step 15: Run the four gates in order**

```bash
npm ci && npm test && npm run build && npm run lint
```
Expected: 194 files, ≥ 3163 tests, all passing. Record the counts.

- [ ] **Step 16: Update Appendix E**

Record in `docs/spec/appendix-testing-strategy.md` §E.4.2: the notification coverage guard
now strips comments, reads the ternary form, and derives a mandatory-notice reachability
assertion from the registry.

- [ ] **Step 17: Commit**

```bash
git add server/notificationContent.coverage.test.js server/routes/adminRoutes.js \
        server/services/notificationContent.js docs/spec/appendix-testing-strategy.md
git commit
```

Message must state: that `ACCOUNT_SUSPENDED` was invisible to the coverage scanner and
why; that the cause was a comment introduced in `b8434fd` while shipping timed
suspensions; that the fix is the scanner rather than the comment position, because the
next comment would blind it again; that the ternary matcher additionally recovers both
appeal decision notices, which have never been covered; and that the derived
mandatory-notice assertion is what would have caught it at introduction.

### Acceptance criteria

- [ ] `ACCOUNT_SUSPENDED` is discoverable by the scanner, proven by the Step 1 command now
      reporting `true`.
- [ ] Both appeal decision notices are discoverable.
- [ ] The mandatory-notice reachability guard is derived from the registry and asserts a
      non-empty subject set.
- [ ] The guard was **observed failing** at Step 10 before the fix at Step 11.
- [ ] The discovered event count did not decrease.
- [ ] The suspension notice's content is unchanged.
- [ ] The stale registry comment is corrected rather than deleted.
- [ ] Four gates pass in order.

### Follow-ups this task deliberately does not do

| # | Item | Why deferred |
|---|---|---|
| FU-1 | The 10 registered events with no content | A product decision (A-04): build or delete. Blocking a regression fix behind it would be wrong |
| FU-2 | `REMOVED_FROM_EVENT` — has content, no dispatch site | Same decision |
| FU-3 | The dedupe catch swallowing mandatory failures on a substring match | Separate defect, separate fix, separate test. Bundling would blur what this task verified |
| FU-4 | Two vocabularies in `notifications.kind` | Dead code removal; unrelated |

**FU-3 is the highest-priority follow-up** and should be the next commit after this task.

---

## Task 2: Retention Enforcement Review

**Deliverable:** `docs/spec/reviews/RETENTION_ENFORCEMENT_PLAN.md`
**Authorised to change code:** No.
**Authorised to change policy:** **No.** The published wording is not to be edited.

**Method required:** for each published promise, record the policy statement verbatim, the
tables it covers, the current enforcement mechanism with its file, what is missing, and
what would be required to close it.

**Note on a correction.** `SPEC_VALIDATION_2026-08-06.md` C-01 asserted that published
retention periods were unenforced and that launch criterion LR-20 could not pass. That
assertion is **wrong** and Task 2's document must say so explicitly and correct it. The
validation finding conflated "tables with no sweep" with "promises with no enforcement";
several of the tables it named carry no published promise at all, and one is swept by a
different worker.

---

## Task 3: Audit Log Explorer Foundation

**Deliverable:** `docs/spec/reviews/AUDIT_EXPLORER_IMPLEMENTATION_PLAN.md`
**Authorised to change code:** No.

Must cover backend query API, filtering, pagination, authorization, export strategy;
database indexes with a migration plan and query-performance validation; a Super
Admin-only timeline frontend with immutable records and no editing or deleting; and tests
for authorization, pagination, filtering and performance regression.

**One decision reversal to record.** The instruction specifies **Super Admin only**.
`AUDIT_VIEWER_DESIGN.md` §3.3 recommended administrator **and** owner access, on the
ground that a trail visible only to the person most likely to be its subject is not an
accountability mechanism. The instruction overrides that recommendation, and Task 3's
document must implement the instruction while recording the consequence and the mechanical
change it forces — `audit.read` is currently held by `admin`, so restricting the surface
requires moving the capability rather than hiding the screen.

---

## Task 4: Super Admin Bootstrap Design

**Deliverable:** `docs/spec/reviews/SUPER_ADMIN_IMPLEMENTATION_PLAN.md`
**Authorised to change code:** No.

Must define the bootstrap process, immutable owners, the two initial owners, recovery
strategy, migration strategy, CLI requirements and audit requirements — under the four
rules: no UI path creates a super admin, super admins cannot be removed normally, an
administrator cannot become a super admin, and every privilege action is audited.

**Blocking input required from the owner:** the two owner identities, specifically the
address for the second account, which must not share a recovery channel with the first.

---

## Execution order and gates

| # | Gate | Passes when |
|---|---|---|
| G1 | Task 1 merged | Its acceptance criteria hold; four gates pass; the guard was observed failing first |
| G2 | Tasks 2–4 documents written | All four exist and are internally consistent |
| G3 | **Owner review** | The three plans are reviewed and approved. **No code is written for Tasks 3 or 4 before this** |
| G4 | M1 closed | G1–G3 hold; the validation document's C-01 correction is applied |

---

## Self-review

**Spec coverage.** Task 1 maps to all four stated requirements (§Task 1, "The four
requirements, mapped"). Tasks 2, 3 and 4 each name their deliverable path and the
sub-requirements the instruction lists. The instruction's "STOP" is honoured by G3.

**Placeholder scan.** No step says "add appropriate handling" or "similar to Task N".
Every code step carries the code. Every run step carries the command and the expected
output.

**Type consistency.** `stripComments`, `matchDispatchedEventNames`,
`matchIndirectEventNames` and `matchTernaryEventNames` are used with the same signatures in
Steps 2, 4, 6, 7 and 9. `all` is the existing Map the file already builds; Step 7 extends
it rather than introducing a second name.

**One gap found and closed during review:** Step 4's line-comment pattern originally
truncated URLs containing `//`. The `[^:]` guard was added, with the reason stated inline,
because `notificationContent.js` contains support links.
