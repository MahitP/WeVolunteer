# WeVolunteer roadmap — start here

**Written 2026-08-02.** This is the entry point for anyone — human or agent —
picking up WeVolunteer's platform work with no prior context. Read this file
first, then the plan for the release you are working on.

---

## 1. Where the project actually is

| Release | Contents | State |
|---|---|---|
| **v1.2a** | Capability authorization kernel, versioned migration registry | **Merged to `main`** as `bd00c6d` |
| **v1.2b** | Step-up re-authentication (AAL2) | **Merged to `main`** as `4c01995` (a `--no-ff` merge commit; the forty-one commits underneath it are the audit trail and are meant to be read) |
| **v1.2c** | Error monitoring | Planned — `2026-08-02-v1.2c-error-monitoring.md`. **Plan audited and amended 2026-08-03**; approved with changes, not yet started |
| **v1.3** | Email delivery tracking + PWA | Planned — `2026-08-02-v1.3-trust-and-reach.md` |
| **v1.4** | Taxonomy, dashboards, maps/weather | Planned — `2026-08-02-v1.4-meaning.md` |
| **v2.0** | Service portfolio, QR attendance, super admin | Planned — `2026-08-02-v2.0-platform.md` |

The strategic design for everything from v1.2c on lives in
`2026-07-31-v2-platform-master-plan.md`. **That document is a design record, not
an instruction set** — see §4 below on why you must not trust it uncritically.

### Baseline you should be able to reproduce

```
export PATH="/usr/local/bin:$PATH"   # see §3 — this line is not optional
npm test        # 1737 tests, 120 files, 0 failures
npm run lint    # clean
npm run build   # clean
```

If your numbers are lower than 1737, you are either on a stale checkout or on
the wrong Node. (It was 1706 / 117 files before the audit round below added
`routes.exportDownload.test.js` and `routes.oauthUnlink.test.js`.)

---

## 2. What v1.2b established, because everything later depends on it

Forty commits on `feat/v1.2b-step-up-auth`, `99334a7` … `d7f8123`.

**Seven actions now require a fresh proof of identity**, not merely a session:
`account.delete`, `password.change`, `email.change`, `oauth.link`,
`oauth.unlink`, `data.export`, `data.download`. A grant is bound to one action,
with its arguments, from one sign-in, for five minutes, once.

The last two were added by an independent audit of the finished branch, and the
reason they were missing is worth more than the fix. The step-up MECHANISM was
sound — 33 mutants against its enforcement lines killed 31, and both survivors
were provably equivalent — but its PERIMETER had two holes, each an endpoint
that reached a gated effect by a route the plan had classified under a different
property:

- **`data.download`.** `POST /api/privacy/export` was gated; the download that
  actually emits the archive was not. The gate protected an archive that did not
  exist yet and left the finished one behind a bare session for the seven days
  it is retained.
- **`oauth.unlink`.** `POST /api/oauth/link` was gated; `disconnect` was not. The
  plan did examine `disconnect` and marked it "already correct" — judging it
  against *lockout* (the last-credential guard) rather than *assurance*.

Both escaped `authz.completeness.test.js` because its categories classify a
route by **whose data it touches**, never by **what identity proof it needs**.
That taxonomy cannot express a step-up gap, so a sixth guard would not have
caught these either. When adding a gated action, ask where the effect actually
lands and whether a second endpoint reaches it — see ENGINEERING_GUIDE §6.8.

The rules are written up in full in **`docs/ENGINEERING_GUIDE.md` §6.8**, each
one with the incident behind it. The four that catch people out:

1. **`requireAAL2` is an early refusal, not the check.** The handler must also
   spend the grant with `spendChallenge(...)` inside its own transaction. A gate
   with no spend leaves the grant replayable — and every functional test still
   passes. Guard 5 fails the build on it.
2. **Params must be exactly the keys the registry binds** — no more (they are
   ignored) and no fewer (a missing key hashes as absent and will not match).
   Bind the value the handler is about to write, never the one the client
   claimed.
3. **If two code paths make the same state change, gate both.** Task 6 gated
   `POST /api/oauth/link`; Task 6b had to gate the OAuth callback's
   `auto_linked` branch, which is the door the Settings button actually uses.
4. **Never add an inline `bcrypt.compare` to a route.** Sign-in is the only
   place in the application that compares a password to decide who someone is.

**Also true after v1.2b, and load-bearing:**

- Every session carries a `jti`. `openChallenge` refuses to bind a grant to a
  session without one, so provider sign-ins had to be fixed to use the shared
  `issueSession` — a near-copy that omitted the claim would have locked every
  provider-signed-in user out of every one of the gated actions.
- A provider-only account can now set a first password and link a second
  provider. Both were previously impossible, because a password was the only
  credential those endpoints could check.
- `server/authz.completeness.test.js` now holds **six** build-failing guards.
  Read them before adding a route; they will fail your build otherwise, and
  the failure message tells you what to declare.

---

## 3. The environment trap that will cost you an hour

**This machine's default `node` is v25. The project pins `>=24.0.0 <25`.**

On Node 25, roughly 13 tests fail — `nodeVersion.test.js`, all of
`shutdown.test.js`, and the `useTheme` suite — and they look exactly like real
breakage in code you just touched. They are not.

```bash
export PATH="/usr/local/bin:$PATH"   # node v24.14.0
node --version                       # verify before believing a red suite
```

Do this in every shell. If a suite goes red unexpectedly, check `node --version`
**before** debugging anything else.

Other environment facts worth having up front:

- **Always `npm install` from the repository root, never inside `server/`.**
  `server` is a workspace; the root lockfile is the only one, and CI fails the
  build if any `package-lock.json` exists elsewhere. A nested lockfile made
  `main` uninstallable for four days (ENGINEERING_GUIDE §5.4).
- The API port is **`API_PORT`** (default 5050). `PORT` is Vite's.
- `/health` reads its version from **`server/package.json`**, not the root.
- `npm run build` must not delete `dist/` — two `server/app.ordering.test.js`
  tests depend on it existing.

---

## 4. How to read the master plan (and every plan here)

`2026-07-31-v2-platform-master-plan.md` opens, in §0, by explaining that the
brief it was written from was out of date. **The same is now true of the master
plan itself**, and of any plan in this directory that has not been executed yet.

This is not a criticism of the documents; it is how planning at a distance
works. It does mean one rule is absolute:

> **Verify every route path, file path, table name and capability name against
> the code before you build on it.**

Concrete evidence for why. Across v1.2a and v1.2b, review found **13 real
defects in the plans** — including a test that could not pass as written, routes
that did not exist, and a two-capability gate that would have 403'd every
student. The implementations were consistently solid; the plans were where the
mistakes lived.

Specific corrections already found and folded into the v1.2c+ plans:

- `event_categories`, `event_tags`, `event_tag_map` and `user_tag_interests`
  **do not exist.** Categories are a `CHECK` constraint on `events.category`,
  and SQLite cannot alter a CHECK. v1.4 §4 weighs a full rebuild against an
  additive `category_id` and recommends the latter — the `events` rebuild would
  touch every event, application and attendance row, and the benefit is
  tidiness.
- `notification_jobs` and `notification_preferences` **already exist**, so W2's
  queue is partly built. Do not reinvent it.
- The master plan states that `tokens.test.js` will guard the PWA manifest's
  colours. **It will not** — all three client guards walk `src/` only, and a
  manifest cannot use `var()`. That needs a new test.
- `admin_audit_logs` exists but there is **no audit helper function anywhere**
  and no severity column; all eight call sites are raw inline INSERTs.

### What has and has not been verified in these plans

The same treatment was then applied to the four plans themselves. **Every route
path, file path, table name, capability name and cited line number was checked
against the code and holds.** Five design claims did not, all in v1.4 and v2.0 —
which is where the plans interact most with code that already exists, so it is
where there was most to get wrong:

| Plan | Was claimed | Actually |
|---|---|---|
| v1.4 | additive `category_id` lets a category be added with no migration | `events.category` is **`NOT NULL`** as well as CHECK-constrained, so every insert must still supply one of five legal strings. Needs a `legacy_value` compatibility column — now specified |
| v1.4 | the `events` rebuild touches "five child tables" (list of seven) | **eight**: the list omitted `conversations`. The plan now says to derive it from `pragma foreign_key_list`, which is what §8.3's fifth guard is for |
| v1.4 | distance filtering is new work, done as a coarse bbox so no precise position is sent | **already fully built** in `server/eventQuery.js` — haversine in SQL, in miles — and precise positions *are* sent, by design, so the server can paginate. They are neither logged nor stored, which is the fact that matters |
| v1.4 | "verify the geocode limiter is ≤1/s server-wide" | it is **per-IP, 30/min** — a live Nominatim policy breach, now **TD-19**. The cache and User-Agent the plan asked for already exist |
| v2.0 | rebuild `hours_ledger` to widen three CHECKs | `event_id` and `slot_id` are **`NOT NULL`** too, and external hours have neither. Both changes must happen in the **same** migration or the audit table is rebuilt twice |

Two generalisations worth carrying:

1. **When a plan says "additive, no rebuild", check the `NOT NULL`s as well as
   the CHECKs.** A nullable new column does not relax an existing constraint on a
   different one. Three of the five findings are that mistake.
2. **Check whether the thing is already built.** Two of the five were features the
   plan treated as new. Reading the module beats grepping for a name, because the
   name a codebase uses is rarely the name a plan uses — the master plan missed
   the whole of step-up by grepping for `reauth` and `step-up`, neither of which
   this codebase used.

**What has NOT been verified:** that the task sequences are executable. Verifying
that means executing them. Expect the plans to be right about the codebase and
merely plausible about the order of work.

---

## 5. The methodology that has been working

Stated because it is the reason the defect count is where it is, not as
ceremony.

**A green suite is not evidence.** Three role-string comparisons on the v1.2a
branch evaded static guards by being spelled differently, and each was caught by
*injecting the bug* to confirm the detector fired — never by reading the regex.
Two Criticals in `server/reauth.js` were invisible to 1600 passing tests: one
manifested only in a post-grant state no test constructed, and the other was a
comment asserting the opposite of the code.

So:

1. **Write the test first, and watch it fail.** `CLAUDE.md` requires this for
   any bug fix, and requires a test at all for any auth/authz change, anything
   touching credited hours, any migration, any new boot guard, any security fix.
2. **Mutation-test every guard you add.** Delete the check, confirm its test
   goes red, put it back. A guard that cannot be shown to fire is not a guard.
   This is done throughout v1.2b and is worth continuing.
3. **Coverage of a branch is not coverage of the states that reach it.** The
   account-deletion hole existed because every deletion test used a
   password-holding account, so the provider-only path — which asked for nothing
   at all — was never exercised. This exact shape of mistake recurred four times
   on the branch.
4. **Comments are part of the diff.** One of the two T3 Criticals was purely a
   comment that claimed a predicate existed when it did not. A missing check
   with a comment saying it is present is worse than either alone, because the
   next reader checks the comment.
5. **Order `can()` cascades most-privileged-first and end in an explicit deny.**
   `super_admin` holds `'*'`, so `can()` returns true for everything and an
   `else if (can(...))` chain is not mutually exclusive. This produced a real
   data leak (`partner` reading every application).

---

## 6. Recommended order, and why

```
v1.2b (done) ──▶ v1.2c errors ──▶ v1.3 email+PWA ──▶ v1.4 meaning ──▶ v2.0 platform
                                        │                                  ▲
                                        └── service-worker outbox ─────────┘
                                            (W9 offline attendance)
```

- **v1.2c before anything else** because every release after it is bigger, and
  going into them without error visibility means finding out from users.
- **v1.3 before v2.0** because W9's offline attendance needs the service
  worker's outbox. The v2.0 plan says what W9 does if v1.3 has not shipped, but
  the cheaper path is shipping it.
- **W7 before W5** (both inside v1.4) because category analytics built on the
  current CHECK constraint would have to be rebuilt. This is a hard edge.
- **v1.2b before v2.0's W8 and W10** — already satisfied. External-hours
  verification writes to a student record, and impersonation without step-up is
  a backdoor.
- **Inside v1.2c: the retention sweep before the unauthenticated intake.** The
  plan originally had the sweep last and the public write path fifth, while also
  calling the release shippable before the sweep landed. The audit moved the
  sweep to Task 4. The generalisation is worth carrying into every later
  release: **nothing that accepts writes from the public internet ships before
  the thing that expires them.** v1.3's PWA outbox and v2.0's QR attendance both
  have this shape.

---

## 7. Open decisions that belong to a human

Carried from the master plan's §15, with Q1 now closed. **None of these block
starting v1.2c**, but each changes work later. Each plan repeats the ones it
depends on, with the assumption it proceeds under if unanswered.

- **Q2 — What happens to a graduated or deleted student's hours?** Determines
  FK behaviour on roughly six new tables. *Assumption: anonymise and retain
  aggregates* — the only option that keeps impact numbers honest over time.
- **Q3 — Is there a persistent disk on the deploy target?** (W8 evidence
  files.) *Assumption: local persistent disk with the caps in W8.*
- **Q4 — Does the district have Google Workspace?** If so its SMTP relay beats
  any third-party provider. *Assumption: a no-card provider.*
- **Q5 — Who grants `service.verify.external` to an NHS advisor?**
  *Assumption: the school admin, audit-logged.*
- **Q6 — Is a second district a real near-term prospect?** If so, `school`
  should become a first-class `organizations` entity in v1.4 rather than the
  `TEXT` column it is today; retrofitting tenancy after W5's analytics and W8's
  scoped capabilities ship is significantly more expensive. *Assumption: single
  district through v2.0, with `scope` columns already shaped to accept a tenant
  id later.*
- **New — is Playwright being adopted?** `tests/e2e/` holds a spec but
  `@playwright/test` is not a dependency and there is no npm script. A service
  worker is very hard to test honestly without a real browser. This is a cost
  decision, not a technical one.

---

## 8. Before you start

1. `git log --oneline -5` and `git status`. Two or three assistant sessions have
   shared this repository; if work landed that you did not do, read it and adapt
   rather than redoing it. If there are uncommitted changes that are not yours,
   stop and ask.
2. `bin/install-hooks.sh` — required after a clone; installs the pre-commit
   secret scan.
3. Read `CLAUDE.md`, then `docs/ENGINEERING_GUIDE.md` §6 (security) and §7
   (testing). The guide is the authoritative process document and **every rule
   in it is annotated with the incident that produced it** — read the reasoning
   before overriding anything.
4. One concern per branch, Conventional Commits, squash-merge, never rewrite
   pushed history.
