# WeVolunteer roadmap — start here

**Written 2026-08-02.** This is the entry point for anyone — human or agent —
picking up WeVolunteer's platform work with no prior context. Read this file
first, then the plan for the release you are working on.

---

## 1. Where the project actually is

| Release | Contents | State |
|---|---|---|
| **v1.2a** | Capability authorization kernel, versioned migration registry | **Merged to `main`** as `bd00c6d` |
| **v1.2b** | Step-up re-authentication (AAL2) | **Complete on `feat/v1.2b-step-up-auth`, unmerged, unpushed** |
| **v1.2c** | Error monitoring | Planned — `2026-08-02-v1.2c-error-monitoring.md` |
| **v1.3** | Email delivery tracking + PWA | Planned — `2026-08-02-v1.3-trust-and-reach.md` |
| **v1.4** | Taxonomy, dashboards, maps/weather | Planned — `2026-08-02-v1.4-meaning.md` |
| **v2.0** | Service portfolio, QR attendance, super admin | Planned — `2026-08-02-v2.0-platform.md` |

The strategic design for everything from v1.2c on lives in
`2026-07-31-v2-platform-master-plan.md`. **That document is a design record, not
an instruction set** — see §4 below on why you must not trust it uncritically.

### Baseline you should be able to reproduce

```
export PATH="/usr/local/bin:$PATH"   # see §3 — this line is not optional
npm test        # 1679 tests, 114 files, 0 failures
npm run lint    # clean
npm run build   # clean
```

If your numbers are lower than 1679, you are either on a stale checkout or on
the wrong Node.

---

## 2. What v1.2b established, because everything later depends on it

Eleven commits on `feat/v1.2b-step-up-auth`, `ae04ca4` … `401d93f` (the last two
being the sign-out cleanup and these plans).

**Five actions now require a fresh proof of identity**, not merely a session:
`account.delete`, `password.change`, `email.change`, `oauth.link`, `data.export`.
A grant is bound to one action, with its arguments, from one sign-in, for five
minutes, once.

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
  provider-signed-in user out of all five actions.
- A provider-only account can now set a first password and link a second
  provider. Both were previously impossible, because a password was the only
  credential those endpoints could check.
- `server/authz.completeness.test.js` now holds **five** build-failing guards.
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
  and SQLite cannot alter a CHECK — so W7 needs a full table rebuild.
- `notification_jobs` and `notification_preferences` **already exist**, so W2's
  queue is partly built. Do not reinvent it.
- The master plan states that `tokens.test.js` will guard the PWA manifest's
  colours. **It will not** — all three client guards walk `src/` only, and a
  manifest cannot use `var()`. That needs a new test.
- `admin_audit_logs` exists but there is **no audit helper function anywhere**
  and no severity column; all eight call sites are raw inline INSERTs.

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
