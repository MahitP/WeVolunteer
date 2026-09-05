# WeVolunteer — Final Hardening and Single-Branch Finalization

**Date:** 2026-09-06
**Scope:** the overnight phase — finish the integration, prove the operational
claims, reduce the repository to one branch, and re-verify everything.

This is the third and last report in a sequence. It does not repeat the other
two; read them for what they cover:

| Report | Covers |
|---|---|
| [`2026-09-05-product-coherence-audit.md`](2026-09-05-product-coherence-audit.md) | The original audit: what the product is, across four branches. A map of findings. |
| [`2026-09-05-remediation-report.md`](2026-09-05-remediation-report.md) | Branch integration, the remediation of those findings, and the first re-audit. |
| **this file** | Finalization, the walkthroughs that were still outstanding, three defects found by doing them, and the honest list of what remains. |

---

## 1. Executive summary

The repository is in the required final state, verified by listing rather than
by assertion: `main` is the only local branch, `refs/heads/main` is the only
remote head, one worktree remains, and the working tree is clean.

The work that was outstanding when this phase began was the part that cannot be
done by reading code: signing in as each persona and looking at the product.
Doing it found three defects that every automated gate had passed over, because
each one is invisible in the session an engineer tests in.

**Found and fixed in this phase**

1. **Three public pages told a signed-in reader they were on the dashboard.**
   `/verify/:code`, `/about` and `/appeal/:token` rendered correctly and titled
   their browser tab "Dashboard · WeVolunteer". A WCAG 2.4.2 (Page Titled,
   Level A) failure, and `/verify` is the page students are told to hand to an
   admissions office.
2. **Refusals promised a grant the authorization kernel forbids.** Eight
   SUPER_ONLY capabilities — `owner.console` among them — told a refused
   administrator that another administrator could grant them access.
   `userCapabilities.js` refuses to store such a grant.
3. **The refusal screen then contradicted itself**, offering an administrator's
   help in one sentence and saying the thing could not be granted in the next.

**Verified, not assumed**

- The Owner Center introduces **no authorization regression**. Proven at three
  layers, including the one that matters: an administrator *with 2FA satisfied*
  is still refused, so the capability gate is genuinely reached rather than
  masked by the 2FA gate in front of it.
- The `security-review` gate was run on the authorization change and returned
  **no findings at or above confidence 8**.

**Two things I could not do.** Both are in §11 and neither is a code problem:
production credentials still need rotating by a human with provider access, and
`main` is 100 commits ahead of `origin/main` and has not been pushed.

---

## 2. The final repository state

Listed, not asserted:

```
current branch : main
HEAD           : the commit adding this report
local branches : 1  -> main
remote heads   : 1  -> refs/heads/main
worktrees      : 1  -> the primary checkout
working tree   : 0 changes
ahead of origin: 100 commits (NOT pushed — see §11)
```

Every branch was reviewed and integrated before deletion, and no worktree
holding uncommitted work was removed. The integration itself, including the
seven semantic conflicts it turned up, is documented in the remediation report
§2 and in [`docs/operations/branch-reconciliation.md`](../operations/branch-reconciliation.md).

---

## 3. The walkthroughs, and what they found

### 3.1 Getting in at all

The owner walkthrough was blocked on a second factor that kept being rejected.
The cause was mine, not the product's: the enrolment script wrote the TOTP
secret encrypted under `cryptoUtils`' development fallback key, because it ran
without `--env-file=.env` while the server had the real key from that file. The
secret decrypted to nothing the authenticator could match.

Worth recording because the failure mode is exactly the one `config.js` already
guards against for duplicate keys, and it presents identically to a wrong code —
a flat "Invalid code." with nothing to say which key was in force.

### 3.2 Owner Center — no authorization regression

Verified at three layers, on a scratch database, against a live instance:

| Layer | Result |
|---|---|
| API, as owner | `/api/owner/{health,monitoring,analytics,infrastructure}` → 200, live data |
| API, as student and organizer | all four → 403 "Access denied" |
| API, as an administrator **without** 2FA | all four → 403, but from the **2FA gate** |
| API, as an administrator **with 2FA satisfied** | all four → 403 "Access denied" |
| Navigation, as an administrator | the Owner Center tile is absent from the Admin hub |
| Direct URL, as an administrator | refused, with an explanation |

The fourth row is the one that matters. The first administrator test was
stopped by the two-factor requirement in front of the capability check, which
proves nothing about the capability check itself. Enrolling that account's
second factor and retrying is what actually exercises `owner.console`.

The Owner Center is also reachable through navigation — it is a tile in the
Admin hub — rather than being a URL you have to know.

### 3.3 Certificate verification

`/verify/WEV-UENF-2DM9` returns a correct verified record end to end (student,
hours, event, organizer, completion date).

`/certificates/WEV-UENF-2DM9` correctly refused the same code for the owner:
certificates open only for the volunteer who earned them, and the empty state
says so. The code exists and belongs to another user, so this is the privacy
behaviour working, not a lookup failure.

---

## 4. Defect 1 — three public pages titled themselves "Dashboard"

Measured live, signed in, against the merged tree:

| Path | `<h1>` | Browser tab |
|---|---|---|
| `/verify/WEV-UENF-2DM9` | Verified Certificate | Dashboard · WeVolunteer |
| `/about` | About WeVolunteer | Dashboard · WeVolunteer |
| `/appeal/:token` | This link does not work any more | Dashboard · WeVolunteer |

**Why it happened.** `App.jsx` sets `document.title` from `tabForPath` in an
effect deliberately placed above its early returns, so hook order cannot vary
between renders. That effect therefore runs for standalone public pages too —
and `tabForPath` ends `return 'dashboard'`, with no branch for any of these
three.

**Why nothing caught it.** A signed-out reader is unaffected: `pageMetaFor` with
no account yields the bare product name. Each of these pages is correct in the
session anybody would test it in. `pageTitleCoverage.test.js` exempted all three
under `OUTSIDE_THE_SHELL`, on the reasoning "no topbar, no rail, so no title to
get wrong" — true of the topbar heading, false of the browser tab.

This is the **fifth** instance of a defect `tabForPath`'s own comments already
record four times, and `/verify` is the worst-placed one yet: it is the page
whose entire job is to be trusted by an outsider, sitting in a stranger's
background tab beside several others.

**Fixed** in the views with `useDocumentTitle` rather than with `tabForPath`
branches, because for two of the three the title is a property of the *answer*,
not the route — `/verify` is a search box, a verdict, or a rate-limit notice at
the same URL. `/verify` deliberately keeps a neutral title when rate-limited or
erroring: that page is careful never to present "we could not check" as a
verdict, and a tab reading "Certificate not verified" would undo it in the one
place a reader glances at without reading.

**Guarded** by a new case covering every public route that renders standalone,
accepting either correct remedy. Proven to fail by removing the `/about` fix:
it named the file, the route and both remedies.

---

## 5. Defect 2 — refusals promised an impossible grant

Measured live: an administrator with 2FA satisfied, refused at `/owner`, was
told *"A WeVolunteer administrator can grant it."*

`owner.console` is SUPER_ONLY. `can()` refuses it before per-user grants are
consulted, and `userCapabilities.js` refuses to **store** a grant naming one. So
the sentence is not merely unhelpful — it costs two people their time. The
reader asks, the administrator tries, and the grant is rejected with nothing to
explain why.

`denialDetail.js` already had an `UNREACHABLE_BY_GRANT` set for exactly this
purpose. It was hand-written as `{error.read, error.write}` and correct the day
it was written. SUPER_ONLY has since grown `owner.console`,
`analytics.platform`, `impersonation.start`, `admin.create`, `audit.read`,
`persona.preview`, `legal.edit` and `roster.export`. **Eight capabilities were
making a promise the kernel would refuse** — the new guard names all eight when
the fix is reverted.

**Fixed** by deriving the set from `SUPER_ONLY` instead of restating it, which
is the same remedy as commit `7cc4373` ("stop advertising a role nothing can
hold"). `src/authz.js` already re-exports the server table for precisely this
reason, so this adds no second copy.

### 5.1 The contradiction underneath it

Fixing that exposed the next layer. Each theme's 403 body ended with the same
offer in its own vocabulary, so the screen then read:

> "…a WeVolunteer administrator can pin you up."
> "This one is reserved for the platform owner and cannot be granted."

Two adjacent sentences, disagreeing. The offer is now its own `offer` field in
the three themes carrying a 403, dropped by the renderer when the capability is
unreachable by grant — so no theme has to know what a capability is, and a theme
without an offer is not a broken theme. `body` is asserted to stand alone as a
sentence, because that is all the reader gets when the offer is withheld.

`requiresVerified` deliberately keeps its offer: an organizer awaiting approval
is in a queue an administrator really does resolve, not waiting on a grant.
Verified live in both directions.

---

## 6. Security

**The gate.** `CLAUDE.md` makes the `security-review` skill a blocking gate for
any change touching authorization. It was run on both commits and returned **no
findings at or above confidence 8**, with the three specific questions answered
from evidence:

- **No new disclosure.** `SUPER_ONLY` was already re-exported client-side and
  every capability name already shipped in the bundle before this change —
  confirmed by finding the frozen array verbatim in `dist/assets/`. The refusal
  now says something *more accurate*, not something *more revealing*.
- **No bundle-boundary breach.** `server/authz.js` has zero imports and no
  `process.env` at module scope; the import is of `src/authz.js`, which was
  already an entry point. `src/serverModuleBoundary.test.js` passes and
  `bin/scan-bundle-secrets.mjs` reports CLEAN.
- **No authorization decision changed.** Neither `server/authz.js` nor
  `src/authz.js` was modified. The new `grantable` field has exactly one
  consumer, a string concatenation in a `<p>`.

**Standing security posture** is unchanged from the remediation report §4:
`roster.export` moved to SUPER_ONLY with an audit row; the mailbox-key bundle
leak was closed by `server/issueRouting.js` and pinned by an import-graph
assertion; two dead endpoints were deleted with 404-pinning tests.

---

## 7. Database and production safety

No production database was touched at any point in this phase. Every
walkthrough ran against a scratch SQLite database under the session scratchpad;
`pilot.db` was never opened.

Two accounts were created or modified **on that scratch database only** — a TOTP
enrolment for the seeded owner, and a plain `admin`-role user to prove the
capability gate refuses one. Neither exists anywhere else.

The isolation work itself — the `productionDatabaseGuard`, the fingerprint list,
and why `.env` precedence was deliberately *not* changed — is in the remediation
report §4 and remains in force.

**Backups** are proven rather than claimed: an archive was restored into a
throwaway database, its counts compared against the manifest, its foreign keys
checked as validated rather than merely present, and a row inserted before the
backup read back afterwards. See
[`backup-and-restore.md`](../operations/backup-and-restore.md), including the
three things the drill did **not** prove.

---

## 8. Performance

Re-measured against the merged tree rather than trusted from the branch's own
documentation, which predated migrations 062–066. See
[`post-integration-measurements.md`](../operations/post-integration-measurements.md).

The headline: the default browse sort is now index-backed —
**95.6 ms → 17.9 ms at p50** on identical data in the same run — and every
non-events read path is comfortably fast at 20,000 users.

The honest half: **filtered browse is not fixed at scale.** It costs 90–180 ms
p50 at 10,000 events and still scans `slots`, and across fourteen filter and
sort cases no candidate rewrite is uniformly faster. There is no rewrite to
adopt on this evidence. At pilot scale the entire browse surface is single-digit
milliseconds, so this is a scaling question, not a launch blocker.

---

## 9. Accessibility

The Playwright sweep passes: **64 passed, 0 failed**.

The three page-title defects in §4 are accessibility defects in the most
literal sense — a screen reader announces the document title on navigation, so
three public pages announced themselves as the dashboard. They were found by
looking at the browser, not by the sweep, which is worth recording: the sweep
walks the shell, and all three of these render outside it.

---

## 10. Testing — exact results

| Gate | Result |
|---|---|
| `npm test` | **10,293 passed · 176 skipped · 0 failed** (614 files) |
| `npm run lint` | clean (oxlint, no output) |
| `npm run build` | green |
| `npm run a11y` | **64 passed · 0 failed** |
| `npm ci` | succeeds (567 packages) |
| `npm audit --omit=dev` | 0 vulnerabilities |

The 176 skips are pre-existing and classified in the remediation report §9;
none were introduced or widened here.

Every fix in this phase ships with a guard that was **proven to fail** when the
fix is reverted. That is deliberate: a guard nobody has seen fail is a guard
nobody has tested.

---

## 11. Remaining human actions

These are the two things I could not do. Neither is a code change.

### 11.1 Rotate the production database credentials — REQUIRED BEFORE LAUNCH

Live Supabase credentials were present in `.env`, which is a file `npm test`
reads. They must be treated as exposed regardless of what has since been done to
that file. They have been removed from `.env` and the operator path now lives in
a gitignored `.env.operator`, but **removal is not rotation**.

I cannot perform this: it needs provider console access I do not have. I have
not attempted it and I am not reporting it as done. The procedure is
[`docs/operations/database-credential-rotation.md`](../operations/database-credential-rotation.md).

### 11.2 Push `main`

`main` is **100 commits ahead of `origin/main`** and has not been pushed, per the
standing policy that autonomous runs commit locally and never push. Everything
in this report exists only on this machine until somebody pushes it.

### 11.3 Close the three gaps in the backup drill

Encryption round-trip, off-host upload, and a restore against production-sized
data. All three need real credentials.

---

## 12. Decisions left to you

**Commit attribution — decide before pushing.** 32 of the 100 unpushed commits
carry a `Co-Authored-By: Claude Opus 5` trailer. This conflicts with the
recorded convention that commits in this repository read as human work. I
followed the instruction that was in force during this session rather than
resolving the conflict myself, and I have not rewritten history — that is not a
call to make while you are asleep, and nothing is pushed, so it is still cheap
to change. To strip them:

```bash
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --msg-filter 'grep -v "^Co-Authored-By: Claude" || true' origin/main..main
```

That rewrites every commit hash on the branch, so it must happen **before** the
push in §11.2, not after. Take a backup ref first (`git branch pre-strip main`)
and delete it once you are satisfied.

**Filtered browse at scale.** 90–180 ms p50 at 10,000 events, no rewrite yet
worth adopting. Fine at pilot scale. The decision is whether to spend on it
before the platform is that size.

**`partner` role.** Removed from the persona previewer as a role nothing can
hold. If a partner-organization concept is genuinely wanted, it needs designing
rather than reviving.

---

## 13. Remaining risks

| Risk | Severity | Status |
|---|---|---|
| Production credentials not rotated | **High** | Blocks launch. Needs a human with provider access. |
| Work exists only locally (100 commits unpushed) | **High** | One `git push` from resolved. |
| Backup drill unproven at production scale | Medium | Mechanism proven; duration and encryption path are not. |
| Filtered browse at 10k events | Low at pilot scale | Measured, documented, no rewrite justified. |
| Historical PII in published refs | Medium | Gates publishing the repository, not launching the product. Pre-existing. |

---

## 14. Final recommendation

**The codebase is release-ready. The deployment is not, and the gap is entirely
operational.**

Every gate passes, the branch work is integrated into a single branch, the
authorization model has been exercised by hand rather than only by assertion,
and the operational claims that were previously asserted — backups, performance
— have been demonstrated or explicitly qualified.

What stands between this and launch is two human actions: rotate the exposed
credentials, and push. Do them in that order.

One closing observation. All three defects found in this phase had passed every
automated gate, and each was invisible for the same structural reason: it only
appears in a session state nobody tests in — signed in, on a public page; an
administrator who has cleared the second factor. The tests were not wrong. They
were answering a question narrower than the one that mattered, which is the
failure mode this codebase's own comments keep recording, and the argument for
walking the product as each persona before calling it finished.
