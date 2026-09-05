# WeVolunteer — Post-Audit Remediation Report

**Date:** 2026-09-05
**Follows:** [`2026-09-05-product-coherence-audit.md`](./2026-09-05-product-coherence-audit.md)
**Branch:** `main`, 14 commits ahead of `origin/main`, nothing pushed
**Scope:** remediation, partial branch integration, and an independent re-audit

---

## 1. Executive summary

The audit's findings were re-validated against the current tree before anything
was implemented, and one of them was wrong in an instructive way: my own
recommendation to rename Discover's "Organizations" button to "My clubs" was
reversed after building the terminology map the audit asked for. "Organization"
is this product's canonical noun — 614 occurrences across the user-facing views,
every page heading, every `PAGE_META` entry — while "club" appears only as
plain-English gloss inside supporting prose. Promoting "clubs" to a *label*
would have created a second name for the canonical concept, which is the problem
rather than the fix. The button reads **"Your organizations"**.

**What was fixed.** Development can no longer casually reach production; a
capability that meant "resolve safety reports" no longer grants a bulk download
of every student's email address; four finished badge endpoints and one finished
message-search endpoint have user interfaces; a latent role is no longer
advertised as a working one; and five places where the product said two things
now say one.

**What was not.** Branch integration is roughly **15% done** — one guard, ported
and then substantially repaired, out of three branches totalling 63 commits. The
Owner Center and the performance work are untouched. That is the honest headline
and §2 says exactly what remains.

**The most valuable thing this phase produced is not a fix.** It is that three
separate "verified" claims turned out to be false, and each was caught by a
different mechanism:

- A guard I wrote to keep mailbox keys out of the browser bundle **did not
  work**, and its verification — `grep 'replyTo:' dist/assets/*.js`, no matches
  — was literally true while testing the wrong thing. It searched for the field
  name that same commit had just renamed away. Rollup had kept the data. Caught
  by a security review; fixed by moving the data into a module the client's
  import graph cannot reach, and by replacing the grep with an **import-graph**
  assertion, because no grep for a name can see a bundler side effect.
- A navigation entry added to the account menu **existed on desktop and not on
  a phone**, because "the account control" is two components. Caught by
  measuring at 375px, not by any test.
- The accessibility sweep was about to report the **wrong panel** as coverage of
  a new page. Caught by running `npm run a11y`.

None of the three was visible by reading the diff.

---

## 2. Branch integration — what actually happened

### Re-verified state

All four branch tips were unchanged since the audit. `origin/main` had not
moved. The audit's branch map held.

### What was integrated

| From | What | Status |
|---|---|---|
| `production-architecture` | `server/db/productionDatabaseGuard.js` + tests + `bin/db-fingerprint.mjs`, wired into `server/db/engine.js` | **Ported, then substantially repaired** — see below |
| `production-architecture` | `csrfGuard`, PostgreSQL backup/restore, R2 off-host upload, liveness/readiness split, bundle secret scanner, `schemaSourceGuard`, nginx config, deployment docs | **Not integrated** |
| `owner-center-certificate` | Everything — `/owner`, `/certificates/:code`, server-side PDF, vendor integrations | **Not integrated** |
| `perf-scaling` | Everything — query optimisation, distributed rate limiting, leader leases, Socket.IO seam, load testing | **Not integrated** |

### The guard was not merged as-is, and should not have been

Porting it and running a security review found **three faults in the branch's
version**, two of which are fail-open:

1. **It fingerprinted a route, not a database.** The hash covered
   `host:port/database`, so every endpoint for one database fingerprinted
   differently and only one was covered. The *uncovered* one matters most:
   `docs/operations/database-credential-rotation.md` tells operators to use the
   direct `db.<ref>.supabase.co` endpoint, so the URL a person is most likely to
   have in a shell was the one the guard passed silently. Its own header claimed
   the opposite — that it saw through "the connection-pooler port swapped for
   the direct one" — which is worse than having no guard, because it invites
   trust it had not earned. `WEV_PRODUCTION_DB_FINGERPRINT` is now a
   comma-separated **list**.
2. **A path-less URL made it inert.** `pg` resolves a connection string with no
   path to a database named after the user, and on Supabase that user is
   `postgres` — whose default database is `postgres`. So the shortest URL
   anybody could type reached production with the guard armed and silent.
3. **It over-matched, and would have refused staging.** The username was
   excluded on the grounds that credentials are excluded — conflating a
   password, which rotates, with a username, which on a managed provider is the
   only part that says *which* database you are reaching. Every Supabase project
   in a region shares one pooler hostname and the default database name, so the
   fingerprint identified a regional pooler and any staging project behind it
   matched production. The hashed material is now `user@host:port/database`.

Verified against the real deployment: all four spellings — session pooler,
transaction pooler on 6543, direct, and direct with no path — are refused from a
development process, and none of them is attempted as a connection.

**Consequence for the merge.** `server/db/productionDatabaseGuard.js` and its
test now conflict `add/add` with the branch. **The version on `main` must win**;
the branch's copies carry the two fail-open bugs.

### Merge state after this phase, measured

| Branch | Commits ahead | Conflicts vs `main` |
|---|---|---|
| `production-architecture` | 9 | 2 — both `add/add` on the guard files. **Take `main`'s.** |
| `owner-center-certificate` | 8 | 4 — `CHANGELOG.md`, `a11y/harness/routes.mjs`, `server/redis.privacy.test.js`, `src/views/ModerationCenter.jsx` |
| `perf-scaling` | 46 | 7 — `server/app.js`, `server/db/engine.js`, `server/db/postgresSchema.js`, `server/migrations/index.js`, `server/redis.privacy.test.js`, `server/routes/issueRoutes.js`, `server/services/notificationService.js` |

My work **added** three of those conflicts: `ModerationCenter.jsx` (I added two
hub tiles; owner-center adds one), `db/engine.js` (guard wiring) and
`issueRoutes.js` (endpoint deletion). All three are mechanical.

### Recommended order, unchanged and now more specific

1. **`production-architecture`** — resolve both conflicts by taking `main`'s
   guard, then take the rest wholesale.
2. **`owner-center-certificate`** — four mechanical conflicts; `ModerationCenter`
   needs all three tiles.
3. **`perf-scaling`** — rebase, not merge. Its `notificationService` and
   migration conflicts need a human deciding intent, and its benchmarks predate
   migrations 062–064, so **re-measure before trusting any documented figure**.

---

## 3. Findings classified (§10)

| # | Finding | Class | Action | Status |
|---|---|---|---|---|
| 1 | `npm test` reaches the production database | D — Security | Root cause + guard | **Fixed** |
| 2 | `/accept-invitation` did not exist | A — Defect | Built the screen | Fixed (prior phase) |
| 3 | Two links to `/admin`, not a route | A — Defect | Repointed + guard | Fixed (prior phase) |
| 4 | Badge administration had no UI | B — Disconnected | Built `/admin/badges` | **Fixed** |
| 5 | Message body search had no UI | B — Disconnected | Wired to the existing box | **Fixed** |
| 6 | Roster export behind `report.resolve` | D — Security | New capability + audit + UI | **Fixed** |
| 7 | `system/status` has no UI | B — Disconnected | Owner Center branch fills it | **Deferred** |
| 8 | Legal Center missing from the Admin hub | C — IA | Tile + derived guard | Fixed (prior phase) |
| 9 | Location prompt on every page | C — IA | Scoped to location-aware tabs | **Fixed** |
| 10 | Partner advertised but not built | E — Decision | Shelved honestly | **Fixed** |
| 11 | "Organizations" meant two things | F→C | "Your organizations" | **Fixed** (audit's own recommendation reversed) |
| 12 | "Release" vs "Can't make it" | C — Consistency | Unified | **Fixed** |
| 13 | Two dead provider buttons | C — UX | Only unbuilt one hidden | **Fixed** |
| 14 | `GET /api/issues/categories` dead | G — Unnecessary | Deleted | **Fixed** |
| — | Student record across five destinations | C — IA | "My hours" in both account controls | **Fixed** |
| — | `GET /api/badges` catalogue unused | E — Decision | Not built — see §7 | **Open** |

---

## 4. Security

Four changes, each reviewed by the `security-review` skill per ENGINEERING_GUIDE
§3.2. **Three reviews, seven findings, all resolved.**

**Development can no longer casually reach production.** `.env` held a live
Supabase `DATABASE_URL`, and `.env` is read by every npm script, by
`bin/resolveDb.mjs` for all seven privileged CLIs, and by the vitest suites. The
seven cases asserting those CLIs *fail closed* without a `DATABASE_URL` failed
by connecting — printing the production host and its migration count, and taking
54 seconds because most of it was network. Two layers now: the credentials moved
to a gitignored `.env.operator` that nothing loads automatically, and the
fingerprint guard refuses a non-production process pointed at production, on the
server path **and** on the privileged CLI path the branch had skipped.

A precedence-based fix was implemented, tested, and **reverted**: two other
cases assert that `.env` *is* how some deployments are configured, and
`bin/reset-2fa.mjs` is the only way to clear a locked-out administrator's second
factor. A rule that refused `.env` outright would make a lost authenticator
unrecoverable at the moment it matters.

**The roster export was behind the wrong capability.** `report.resolve` means
"resolve the safety reports people file"; the endpoint returns every active
student's name, email, school and hours. Now `roster.export`, SUPER_ONLY and
therefore ungrantable, audited on every use, with the internal `id` column
dropped and the filename datestamped.

**Mailbox keys are genuinely out of the bundle** — after two failed attempts,
one of which self-certified. See §1.

**A recovery path I broke, then fixed.** The guard refused the documented
operator command, because `.env.operator` carried no `NODE_ENV`. Caught by
review, fixed, and proven in both directions.

---

## 5. Product and UX

- **Badge administration** at `/admin/badges`: definitions including inactive
  ones, create/edit with the server's own criteria vocabulary and per-type
  units, manual award, and revoke with a confirmation that says which way the
  badge can come back. The criteria list is shared at build time, because a type
  the evaluator does not know produces a badge that is visible and unearnable
  with no error anywhere.
- **Message search** now searches what was *said*. One box, two labelled result
  groups; the halves fail independently.
- **"My hours"** in both account controls, from one shared declaration.
- **The location offer** appears only where location does something.
- **One name per act**: "Can't make it" everywhere for giving up a confirmed
  place; "Withdraw" retained for pending applications, which is a real
  distinction.
- **Sign-in** shows only providers that exist. A *misconfigured* provider stays
  visible — that is the AADSTS900144 signal, and the only indication either a
  school or the operator gets that the deployment is incomplete.

---

## 6. Features connected

| Feature | Before | Now |
|---|---|---|
| Badge define / award / revoke | 4 endpoints, no caller | `/admin/badges` + hub tile |
| Message body search | endpoint, no caller | the existing search box |
| Student roster export | endpoint, no caller, wrong capability | `/admin/roster`, owner-only, audited |
| Student's own record | 5 destinations, none in navigation | "My hours" in both account controls |

Orphaned endpoints: **11 → 4**. Of those four, two are legitimately non-UI
(`POST /api/webhooks/resend`, `GET /health`), one is filled by the Owner Center
branch (`GET /api/admin/system/status`), and one is a product decision
(`GET /api/badges` — see §7).

---

## 7. Decisions taken, and what was deliberately not built

**`GET /api/badges` — not wired.** It is the catalogue of *earnable* badges.
Wiring it would mean showing students badges they have not earned, which is a
feature ("what can I work towards?"), not a connection. It has a plausible case
— the dashboard already frames hours against a goal — and it has an obvious
failure mode: a wall of 27 unearned badges reads as a list of things you have
failed to do. **This needs a product decision, not an implementation.**

**Export fields kept.** The security review's judgement, which I accepted:
`email` is not a new class of access, because `user.contact.read` sits in the
ordinary admin block and every administrator can already read any student's
address one at a time, unaudited. The export adds bulk and a file — and bulk is
what was fixed. Stripping email would leave a file a school cannot reconcile
against its own roster, pushing people toward copying addresses by hand, which
is *unlogged*. Minimisation that displaces the same egress onto an unlogged path
is a net loss.

**Server-side `active` check on badge awards — deliberately not added.** The
only callers who can reach the route can flip `active` back in one request, so
it would add no boundary, and it would break "retire the badge, then give it to
the one straggler who earned it before the cutoff". Recorded at the endpoint so
the client filter is not later mistaken for an invariant.

**The perf branch's benchmarks — not trusted.** Not re-measured either, because
the branch is not integrated. Its figures predate migrations 062–064.

---

## 8. Research, and what it changed

| Source | What it decided |
|---|---|
| [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — "For every combination of user type and resource, determine what operations, if any, the user … must be able to perform on that resource." | That a moderation queue and a roster of minors are different resources, so `report.resolve` could not gate the export. Chose Option A over B/C. |
| [FERPA — School Volunteers](https://studentprivacy.ed.gov/training/school-volunteers-and-ferpa) — access limited to "the purposes for which the disclosure was made" | Sharpened the same point for a K-12 deployment, and made the case for auditing every export. |
| [FERPA — Directory Information](https://studentprivacy.ed.gov/content/directory-information) | That email is *not* typically directory information, so a bulk export of addresses is more sensitive than the "roster" framing suggests. |
| The repository's own terminology map (614 vs 3 occurrences) | **Reversed** the audit's "My clubs" recommendation. |
| The repository's own `pendingInvite.js` | Refused a `?returnTo=` for the invitation flow — a general redirect primitive means maintaining a path validator for ever. |

Comparable-product patterns (SignUpGenius, Slack, Classroom) informed two
choices and were deliberately not copied: one search box rather than two, and
the account menu as the home for "things that are mine". No feature was added
because another product has it.

---

## 9. Testing — exact results

```text
npm test          9741 passed | 122 skipped | 0 failed   (589 files)
npm run lint      PASS (oxlint, zero errors)
npm run build     PASS  (AdminBadges and AcceptInvitation code-split)
npm run a11y      63 passed | 0 failed  (12.0m, Playwright/chromium)
npm ci            NOT RUN — no dependency or lockfile change was made
```

The suite began this phase with **9 pre-existing failures** and ends with zero.
Seven were the privileged-CLI cases, red because the environment defeated the
safety they assert; they pass now because the cause was removed, not because
they were changed.

The accessibility sweep is worth its own line: it went **61 passed / 2 failed →
63 passed / 0 failed**. The two failures were a marker I added on purpose, which
converted a silent false-coverage into a hard gate; the two extra passes are
`/accept-invitation` now being genuinely measured in both the ARIA and focus
sweeps.

**Tests changed rather than added, and why** — every one classified per §34:

| Test | Why it changed |
|---|---|
| `authz.matrix.test.js`, `routes.admin.test.js` | Pinned the old export posture accurately. **Tightened**, not relaxed: `admin: 403`, plus a case reading the audit row back out of the database. |
| `ProviderButtons.test.jsx` ×5 | Pinned three buttons. Now assert the new contract *and* that Apple is absent. One of them caught a **real bug** in my predicate. |
| `navigationConsolidation.test.jsx` | Exact menu list. Stayed `toEqual`; gained a capability case. |
| `EventShiftsTab.test.jsx` | Pinned "Release". Now also asserts the old word is gone. |
| `ModerationCenter.test.jsx` ×2 | Pinned four personas. Now assert three and that partner is absent. |
| `denialDetail.test.js` | Used `event.moderate` as a fixture *because it gated no route* — and `/admin/badges` gated it. Fixture is now **derived** as the complement, so it cannot be taken hostage a fourth time. |
| `serverModuleBoundary.test.js` | Source-text grep replaced with an **import-graph** assertion. |
| `issueReports.test.js` | Covered a deleted endpoint; now pins the property one level lower. |

Guards added this phase, each **proven by reintroducing the defect**:
`serverLinks.test.js` (server-emitted destinations), the `/admin/*` hub-indexing
guard, the account-menu drift guard, and the a11y `QUERY` map guard.

---

## 10. Independent re-audit (§41)

Re-run from scratch against the current tree, not against the previous findings.

**Mechanical sweeps — clean.**
- Every one of the **38 `APP_ROUTES` has a discovery path**; zero orphans.
- Internal link integrity: clean on both guards, only the three known false
  positives (a DEV-only gallery, `/socket.io`, a template hole).
- Orphaned endpoints: 4, all accounted for in §6.

**New problems found by the re-audit, and fixed:** the a11y sweep auditing the
wrong panel (§1), and two identically-labelled reason fields that can be on
screen together — indistinguishable to a screen reader as well as to
`getByLabelText`.

**Responsive:** `/admin/badges` scrolls its table inside `.tablescroll` with no
horizontal page overflow at 375px; the `⋯` sheet is correct.

**Nothing new found** in: role/capability boundaries, cross-user data exposure,
notification and email destinations, empty and error states on changed surfaces,
or navigation duplication.

---

## 11. Product scorecard (§42)

Scored against "would I hesitate to ship this to real users?" — not inflated.

| Category | Score | Reasoning |
|---|---|---|
| Student UX | **9** | Dashboards answer "what next", explain automation unprompted, offer withdrawal. The record is now findable. |
| Organizer UX | **9** | Full workflow with irreversibility warned before the click. No material gaps found in two passes. |
| Admin UX | **7** | Onboarding works and every area is on the hub. Still no service-health surface on trunk. |
| Owner UX | **6** | Can operate the platform, but the operational console lives on an unmerged branch. |
| Partner UX | **n/a** | Latent role, now honestly marked. Not scored because there is nothing to score. |
| Navigation | **9** | Every route discoverable; two account controls now share one declaration. |
| Feature connectivity | **8** | 11 orphans → 4, of which 2 are legitimate and 1 is a branch merge away. |
| Security | **8** | Real hardening this phase; three reviews, seven findings resolved. Held back by §12. |
| Privacy | **8** | Export re-gated and audited; bundle leak closed. Historical PII in published refs is still open. |
| Accessibility | **9** | 63/63 sweep, plus the harness blind spot closed. |
| Reliability | **7** | Suite fully green for the first time; single-instance topology unchanged. |
| Performance | **5** | Untouched. The work exists on a branch whose numbers are stale. |
| Operational readiness | **5** | Backups, restore, CSRF and health-check work all still unmerged; credentials need rotating. |
| Maintainability | **9** | Every fix came with a guard, and four guards were proven by reintroducing the defect. |
| Product coherence | **8** | One name per concept, one home per feature. The Owner Center gap is the visible seam. |

**Weighted view: strong product, incomplete operations.** Nothing in the student
or organizer experience would embarrass this team. Performance and operational
readiness are low *because the work exists and is not merged*, which is a
scheduling fact rather than a quality one.

---

## 12. Risks that could still block launch

1. **The production credentials must be rotated.** They sat in a file `npm test`
   reads. This is an operator action; nothing in this phase can do it.
2. **Backups are unproven on PostgreSQL.** Trunk's `bin/backup.sh` is a SQLite
   `.backup`. The PostgreSQL backup *and a proven restore* are on the unmerged
   branch. Launching without this means the database holding every student's
   service record has no verified recovery path.
3. **Historical PII in published git refs** — pre-existing, recorded before this
   phase, gates publishing rather than launching.
4. **`pilot.db` holds real minors' data** and is untouched by this phase. Every
   walkthrough ran on a scratch database.
5. **Performance is unmeasured at scale** on the current schema.

---

## 13. Recommended next phase

**Not the visual redesign yet.** In order:

1. **Rotate the credentials.** Blocking, and nobody else can do it.
2. **Merge `production-architecture`** — take `main`'s guard on both conflicts.
   This buys backups, a proven restore, CSRF hardening, the health-check split
   and the bundle secret scanner in one move.
3. **Merge `owner-center-certificate`** — four mechanical conflicts. Closes the
   last non-decision orphan and turns certificates into linkable documents.
4. **Rebase `perf-scaling` and re-measure.** Do not trust a documented figure
   that predates migrations 062–064.
5. **Decide `GET /api/badges`** — show earnable badges, or delete the endpoint.

**Then** the visual redesign, against a product whose structure is settled.

---

## Appendix — commits

```
7145403  test(a11y): the sweep was about to audit the wrong panel on /accept-invitation
85fce99  fix(privacy): the mailbox keys were still in the bundle, and my grep could not see it
e4c72bd  fix(security): the student roster export was behind the moderation capability
7cc4373  fix: stop advertising a role nothing can hold, and delete an endpoint nothing calls
004032c  feat(messages): the search box now searches what was said, not only who said it
4874d72  fix(badges): bound the definition text, and say that "active only" is a client rule
9ae0934  feat(admin): badge administration, for four endpoints that had no caller
d989b36  fix(nav): the account control is two components, and only one of them had My hours
1d42de4  fix(ux): five places the product said two things, or said them in the wrong place
b09ddf4  fix(security): resolve the three findings against the production-database guard
89343f6  chore(security): stop development from casually reaching production
39a2ab0  docs(audit): the product coherence audit
5594d9d  Connect three finished features that ended in a 404
bbdf4bc  Merge origin/main
```

60 files changed, 5,226 insertions, 151 deletions. Local only; nothing pushed.
