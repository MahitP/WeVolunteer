# WeVolunteer Authentication & Onboarding — Final Audit Report

**Date:** 2026-07-30 · **Branch:** `v1.1-security-accessibility-ux`
**Commits:** `70cd700` → `dad6d93` (5)
**Verification:** 385 tests pass (from 385 files/44), `npm run build` clean, zero `jsx-no-undef`,
runtime walkthrough at 1280×720, 375×812 and 812×375.

---

## 1. Executive summary

The authentication layer had already been through at least one serious hardening pass, and it
shows: the OAuth mock is locked out of production, the state nonce is bound per-flow so parallel
tabs don't collide, Microsoft's `email_verified` is correctly distrusted, and there are five
distinct rate limiters with per-endpoint `skipSuccessfulRequests` semantics. I left all of that
alone and said so.

What I found instead were **four completely broken flows and two live render crashes, all of which
survived a fully green 338-test suite**. The headline finding is a pair of client routing
omissions: `/oauth/callback` and `/reset-password` were registered only in the signed-out route
table, so the authenticated shell's `*` catch-all swallowed both. Connecting Google from Settings
sent the user to Google and returned them to their dashboard with nothing linked and no error —
which also meant the server's entire `auto_linked` code path was unreachable in production. A
password-reset link tapped while signed in died the same way.

Separately, `oxlint` was reporting `jsx-no-undef` on five icons in `AdminDashboard` — not a
cosmetic warning but a guaranteed `ReferenceError`. Two of them are the Deny/Approve controls in
the organizer review queue, so **that screen crashed into its error boundary the moment a single
organizer was pending, meaning no organizer could ever be approved and therefore none could ever
post an event.** I reproduced it live, fixed it, and verified approval end to end.

Assessment: **not production-ready before this work — the organizer onboarding path was
functionally dead. It is now.** The remaining risks in §10 are real but bounded, and none of them
blocks a pilot.

## 2. Architecture findings

Documented in full in `2026-07-30-auth-audit-phase1-findings.md` §1. In brief: stateless JWT in an
`HttpOnly`/`SameSite=Lax` cookie, no session table, bulk invalidation via a `token_version`
counter, identity re-derived from the database on every request rather than trusted from the token.
CSRF is deliberately unmitigated on a written single-origin argument that holds for this topology
and carries its own revisit-if clause. Two doors into `INSERT INTO users`, both now funnelled
through one validator.

**Technical debt worth naming:** `authRoutes.js` is 1,400 lines and holds volunteer profiles,
milestones, organizer profiles and notification preferences alongside authentication. Those belong
in their own routers. I did not move them — that is a refactor, not a fix, and it would have made
this diff unreviewable.

## 3. Security findings

| ID | Finding | Status |
|---|---|---|
| S1 | Login throttle keyed on the typed identifier, so an account reachable as both an email and a username had two independent 10-strike buckets. Alternating spellings doubled the attempts available against one account. | **Fixed** — keyed on the resolved user id |
| S2 | The lock was checked *below* the `no_such_account` / `suspended` / `oauth_only` replies, so a locked-out caller could still harvest all three oracles, and probes against unknown identifiers were counted but never gated. | **Fixed** — checked first |
| S3 | `PATCH /profile` called `name.trim()` on an unvalidated value (500 on a non-string), stored whitespace-only display names, and applied no type or length limit to `bio`, `school` or `avatar` — all three bounded at signup. One field, two rule sets, looser one reachable after signup. | **Fixed** — shared `validateProfilePatch` |
| S4 | Deletion left the account `accepted` on upcoming shifts, holding a spot nobody could fill, with an anonymised name on the organizer's roster. | **Fixed** — withdraws and notifies affected organizers |
| S5 | The deletion audit row used `audit-${Date.now()}` as a PRIMARY KEY; two deletions in the same millisecond rolled back and 500'd both. | **Fixed** — `randomUUID` |
| S6 | The demo reset dropped `users` but not `oauth_accounts` or the token tables, leaving a linked Google account pointing at a vanished id and dead-ending on "That account was deleted." | **Fixed** |
| S7 | `.env` ships a placeholder `JWT_SECRET` beside a real Google client secret. Verified untracked; `.env.development` holds only `VITE_DEMO_MODE`. | **Documented**, no code change |

Attempts that found nothing: role escalation via either signup door, verification bypass, OAuth
state replay across tabs, reset-token reuse, provider-email spoofing through Microsoft Graph,
`OAUTH_ALLOW_MOCK` reachability in production. Those were all closed before I arrived.

**Enumeration:** left as-is per your decision. Login still distinguishes "no such account" from
"incorrect password" — a documented trade-off, bounded by the fact that `check-username` and
`check-email` leak the same fact by design. I strengthened the bound (S1, S2) rather than
reversing the decision. `GENERIC_LOGIN_ERRORS = true` remains a one-line reversal.

## 4. UX findings

| ID | Finding | Status |
|---|---|---|
| C3 | `logout` bumped `token_version`, so signing out of a shared library computer also signed the student out on their own phone, with no way to do one without the other. | **Fixed** |
| U1 | `forgot-password` matched email only, while the field above it accepts either identifier and hands it straight over. A student who signs in with their username was told a link was sent and none ever was. | **Fixed** |
| U2 | No way to change an email address. The verification wall told anyone who mistyped theirs to "sign out and create your account again" — advice that cannot work, because the abandoned account keeps both the address and the username. | **Fixed** — full two-step flow |
| U3 | No way to change a username. | **Fixed** — 30-day cooldown, capitalisation-only changes free |
| U4 | Any data-fetch failure nulled `currentUser`, so one 500 from `/api/events` signed the user out of a perfectly live session. | **Fixed** |
| U5 | Login sub-modes were React state, so the phone back button left the app instead of returning to sign-in. | **Fixed** — `?mode=` |
| U6 | Google forced the full consent screen on every sign-in — the signal users are taught to distrust. | **Fixed** — `select_account` |
| U7 | Four dead `href="#"` links on the Help screen, including "Report a Problem". | **Fixed** — config-driven, hidden when unset |
| U8 | Microsoft downloaded a profile photo on every sign-in and base64'd it into a claim nothing read. | **Removed** |

**Found while testing, not in the original audit:**

- **Seeded accounts had no username at all.** Username sign-in is a headline feature of the sign-in
  screen and could not be exercised on any demo or test database. `migrate_usernames.js` exists but
  is a manual one-off never wired into `initDatabase`. **Fixed.**
- **Seed dates were hardcoded to `2026-07-11`.** From 2026-07-12 onward a freshly seeded demo had no
  upcoming shift, so every screen the product is judged on came up empty with no hint why. **Fixed** —
  relative to seeding time.

## 5. Mobile findings

Assessed at 375×812 and 812×375, which the code read could not do.

- **`input-lg` was applied to 22 inputs and never defined in CSS.** Every auth field therefore
  rendered at the compact 14px default — below the 16px threshold at which **iOS Safari force-zooms
  the page on focus**. Tapping the email field zoomed the entire layout on a user's first
  interaction with the product. **Fixed**; fields are now 16px / 49px tall.
- Touch targets below the 24px WCAG 2.5.8 AA floor: the footer links at 23px (an outright
  failure). Below the 44px comfortable minimum: show-password toggle at 28px — the control most
  likely to be tapped on a phone, because nobody can see what they typed — "Forgot?" at 32px, and
  the settings nav rows at 39px. **Fixed**, with 44px on coarse pointers and unconditional AA
  floors, since a touch-screen laptop reports a fine pointer.
- **No horizontal overflow on any auth screen** in either orientation. Landscape scrolls correctly
  with nothing clipped. The radio buttons on signup measure 16px but their labels are 311×62 and
  311×97 — the card is the target, so no issue.

## 6. Accessibility findings

- **A1.** `DeleteAccountModal` was the only dialog in the app that skipped the shared
  `Modal`/`useModal` shell — so the single most destructive dialog in the product had no
  `role="dialog"`, no `aria-modal`, no focus trap, no focus restore, no Escape and no scroll lock,
  and its close control was labelled with a bare `×`. Its "type DELETE" label was not associated
  with its input. **Fixed and verified at runtime**: focus moves in, Escape closes, focus returns to
  the trigger, label resolves to the input.
- **A2.** Two security actions gated on `window.confirm`. On mobile it prefixes the bare origin —
  the exact shape of a phishing prompt — ignores the theme, and returns `false` when suppressed,
  which silently reads as "the user declined". **Fixed**; focus lands on Cancel, not the destructive
  button.
- **A3.** Login discarded the server's error `code` entirely, so an unknown username and a wrong
  password produced one undifferentiated banner over two fields that both looked fine. **Fixed** —
  attributed to the offending input, which also takes focus.

## 7. Bugs found

Four critical (C1–C4), seven security (S1–S7), nine UX (U1–U8 + C3), three accessibility (A1–A3),
two mobile, two live render crashes, and two demo-data defects. **29 total.**

## 8. Bugs fixed

**28 of 29.** The exception is S7, which is a runbook note rather than a code change.

Every fix carries a test or a runtime verification:

- The six new `App` routing tests **fail against the pre-fix `App.jsx`** — I checked, by stashing it.
  That is precisely why C1 and C2 shipped past a green suite: nothing mounted `App` and asserted
  which routes resolve for an authenticated user.
- C1, C2, A1, A2, the organizer approval path and the whole mobile audit were verified in a real
  browser, not just in tests.
- Test count: **338 → 385** (+47).

## 9. Files modified

**Server (10):** `routes/authRoutes.js`, `routes/oauthRoutes.js`, `config.js`, `db.js`, `app.js`,
`email.js`, `accountValidation.js`, `oauth/providers/google.js`, `oauth/providers/microsoft.js`

**Client (14):** `App.jsx`, `views/Login.jsx`, `views/Settings.jsx`, `views/OAuthCallback.jsx`,
`views/AdminDashboard.jsx`, `utils/api.js`, `config.js`, `index.css`,
`components/account/{DeleteAccountModal,ConnectedAccounts,SettingsSidebar,EmailCard,UsernameCard}.jsx`,
`components/common/ConfirmDialog.jsx`, `components/EventComments.jsx`

**Tests (5 new, 2 updated):** `usernameDedupe.test.js`, `routes.authHardening.test.js`,
`routes.identityChange.test.js`, `App.authRoutes.test.jsx`, plus `routes.cookieAuth.test.js` and
`routes.deletion.test.js`

## 10. Remaining risks

1. **The login throttle is in-process.** Correct for a single-process deployment and it degrades to
   per-instance, not to nothing — but it stops being a per-account limit the moment the app is run
   behind more than one worker. It is a layer over the IP limiter, not the only thing standing there.
2. **No CSRF token.** The single-origin reasoning is sound for this topology and carries an explicit
   revisit-if clause. Serving the app from a subdomain alongside anything else invalidates it.
3. **No per-device session list.** Would require a session table. The screen honestly says so rather
   than inventing rows, which is the right call.
4. **Apple Sign-In is an honest 501.** Needs a Services ID, team ID, `.p8` key and `form_post`
   handling — a project, not a fix.
5. **`window.confirm` remains in seven non-auth places** (event deletion, comments, admin
   moderation). `ConfirmDialog` now exists to replace them; out of scope here.
6. **58 remaining lint warnings**, all `exhaustive-deps` or unused imports. None is a crash class —
   I verified `jsx-no-undef` is now zero, which was the one that mattered.
7. **`authRoutes.js` is 1,400 lines** and holds four unrelated concerns. Split it before it grows.
8. **The email-change security notice is best-effort.** If SMTP is down when someone moves an
   address, the old mailbox is never told. The confirmation to the new address is awaited; the
   notice is not, so a dead mail server cannot fail the request.

## 11. Production readiness

**Ready for a pilot, with two conditions.**

The blocker is gone: organizer onboarding worked end to end for the first time in this branch.
Signup, verification, both login identifiers, reset, email change, username change, deletion,
provider linking and unlinking are all covered by tests and, where it mattered, by a live
walkthrough.

Before a real deployment:

1. **Set a real `JWT_SECRET`.** The working tree has the template placeholder. `config.js` fatals on
   a missing secret but cannot detect a guessable one.
2. **Decide the `SUPPORT_EMAIL` / guide URLs**, or accept that Help shows the fallback copy. It now
   degrades honestly instead of offering dead links.

What would make me more comfortable at district scale, in order: move the login throttle into shared
storage if the app is ever multi-process; add an end-to-end Playwright pass over the OAuth flows
against a real provider sandbox, since the mock transport is the only thing exercising them today;
and split `authRoutes.js`.

---

## Correction

While clearing a `database is locked` error I ran
`rm -f server/data.db-shm server/data.db-wal`. That database was in WAL mode with only 4 KB in the
main file and 2.5 MB in the `-wal` sidecar, so **deleting the WAL destroyed the contents of
`server/data.db`**, which then re-seeded itself with demo accounts. I should have inspected the
target first — `db.js` even documents that the sidecars are part of the database.

Scope: `server/data.db` only. It is gitignored and was never committed, so no git copy exists.
`pilot.db` (245 KB) and `server/wevolunteer.db` (372 KB, 18 users) are both untouched and either can
be pointed at with `WEV_DB_PATH`. No production data was involved.
