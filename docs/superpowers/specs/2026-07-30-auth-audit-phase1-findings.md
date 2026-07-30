# WeVolunteer Authentication & Onboarding — Phase 1 Discovery

**Date:** 2026-07-30
**Branch:** `v1.1-security-accessibility-ux`
**Baseline:** `npm test` → 40 files, 338 tests, all passing
**Method:** Zero-trust read of every file on the auth surface. No fixes applied yet.

---

## 1. Architecture as it actually is

### Session model
Stateless JWT in an `HttpOnly` / `SameSite=Lax` cookie (`wev_session`, 7d), `secure` only in
production. No server-side session table. Bulk invalidation via a `users.token_version` counter
compared on every request (`utils.js:27`). Identity is re-derived from the database on each
request rather than trusted from the token payload — correct, and unusual enough to be worth
saying out loud.

CSRF is deliberately unmitigated, on the documented reasoning that SPA and API share one origin
in both topologies so `Lax` covers the whole surface (`config.js:131-155`). That reasoning holds
for the current deployment. It is written down with an explicit "REVISIT THIS IF" clause. Accepted.

### The two doors into `INSERT INTO users`
`POST /api/auth/signup` and the OAuth callback's auto-signup path. Both now funnel through
`accountValidation.js`, which is what closed the historical `role: "admin"` self-registration.
Verified: `SELF_ASSIGNABLE_ROLES` is `['student','organizer']` and both paths call
`validateAccountFields`.

### Email verification
On by default (`REQUIRE_EMAIL_VERIFICATION`), enforced in middleware with a minimal path
allowlist (`config.js:106-116`), not merely in the SPA. Google's `email_verified` is trusted;
Microsoft's Graph directory attributes are explicitly *not* — a Microsoft signup still confirms by
mail. That distinction is correct and well-reasoned (`microsoft.js` closing comment).

### Rate limiting
Five distinct limiters with different `skipSuccessfulRequests` semantics per endpoint class
(`app.js:184-280`). The password-oracle endpoints that aren't `/login` — `/api/oauth/link`,
`/change-password`, `DELETE /account` — are explicitly pulled under `authLimiter`. Plus an
in-process per-identifier login throttle layered over the per-IP limiter.

### Rated strong, no action needed
- OAuth mock transport is opt-in and refuses to boot in production (`config.js:41-48`)
- `state` is a signed JWT bound to a per-flow nonce cookie whose *name* carries the nonce prefix,
  so parallel tabs don't clobber each other (`oauthRoutes.js:181-193`)
- No plaintext password anywhere in a URL or in `oauth_signup_sessions`
- CSP with no `unsafe-inline` on `script-src`
- Reset and verification tokens: 32 random bytes, single-use, one-live-per-user, expiry enforced,
  `token_version` bumped on reset
- `APP_URL` and `JWT_SECRET` are fatal-on-missing in production; `email.js` refuses to boot
  production without SMTP

---

## 2. Findings

### CRITICAL — flows that do not work at all

**C1. Connecting a provider from Settings is a silent no-op.**
`/oauth/callback` is registered *only* in the signed-out route table (`App.jsx:401`). The
authenticated shell's `<Routes>` (`App.jsx:540-651`) has no such path, so its `*` catch-all
returns `<Navigate to="/" replace />`.

Trace: signed-in user presses Connect (`ConnectedAccounts.jsx:52`) → provider → returns to
`/oauth/callback?code=…&state=…` → `refreshAll()` restores the session → authenticated shell
renders → catch-all bounces to `/`. `OAuthCallback` never mounts. The code is never exchanged, no
provider is linked, and no error is shown. The user lands on their dashboard believing it worked.

This also means the server's entire `action: 'auto_linked'` branch (`oauthRoutes.js:279-292`) —
the *only* path that links a provider without demanding a password — is unreachable in practice.

**C2. Password-reset links are dead for anyone already signed in.**
Same root cause. `/reset-password` exists only in the signed-out table (`App.jsx:391`). The global
intercept at `App.jsx:90` navigates there; the authenticated catch-all bounces to `/`. A student
signed in on their phone who taps the reset link from their email silently lands on the dashboard.

**C3. `POST /api/auth/logout` signs the user out on every device.**
`authRoutes.js:391` increments `token_version` on an ordinary logout. Signing out of a shared
library computer therefore also kills the session on your own phone. A correct, separate
`/api/auth/sign-out-others` already exists for the deliberate case — this one should only clear
the cookie.

**C4. Username uniqueness has no case-insensitive database constraint.**
`username TEXT UNIQUE` (`db.js:132`) and `idx_users_username` (`db.js:531`) are both
case-*sensitive*. Every application-level check uses `COLLATE NOCASE`
(`authRoutes.js:102`, `:169`, `oauthRoutes.js:348`).

Failure: two concurrent signups for `Alice` and `alice` both pass their `SELECT` and both `INSERT`
successfully. Login then runs `WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE`
with `.get()` (`authRoutes.js:291`), which returns one arbitrary row of the two. One of those two
people can never sign in with their username again — they get "Incorrect password." forever.

This is precisely the bug already found and fixed for email (`dedupeCaseInsensitiveEmails` +
`idx_users_email_nocase`, `db.js:534-541`) and left unfixed for username.

### HIGH / MEDIUM — security hardening

**S1. The per-account login throttle can be doubled by alias.**
`failureKey()` (`authRoutes.js:39`) keys on the *typed* identifier. An account with email
`a.b@school.org` and username `ab` has two independent 10-strike buckets. Key on the resolved
user id instead.

**S2. The throttle is checked after the account-shape branches.**
`loginLockState` is consulted at `authRoutes.js:334`, but `no_such_account` (`:297`), `suspended`
(`:309`) and `oauth_only` (`:322`) all return before it. A locked-out attacker still gets those
three oracles, and probes against nonexistent identifiers are never gated by the lock.

**S3. `PATCH /api/auth/profile` bypasses the shared validators.**
`authRoutes.js:1067` calls `name.trim()` on an unvalidated value — a non-string `name` throws and
returns 500, and `name: "   "` stores an empty display name. `bio`, `school` and `avatar` get no
type or length check here at all, though `validateAccountFields` enforces all three at signup. One
field, two rule sets, and the looser one is the one reachable after signup.

**S4. Account deletion leaves live records behind.**
`authRoutes.js:449-514` anonymises the user row and clears preferences, favorites, notifications,
oauth links and both token tables — but never touches `applications`, `messages`,
`event_comments` or `conversation_participants`. A deleted student stays confirmed on tomorrow's
shift and their name stays on the organizer's roster.

**S5. Audit-log id collision can fail a deletion outright.**
`audit-${Date.now()}` (`authRoutes.js:513`) inside the deletion transaction. Two deletions in the
same millisecond → UNIQUE violation → rollback → the entire deletion 500s.

**S6. The DEMO_MODE reset leaves orphaned auth rows.**
`authRoutes.js:823-834` drops `users` but not `oauth_accounts`, `email_verification_tokens`,
`password_reset_tokens` or `oauth_signup_sessions`. After a reset, a previously-linked Google
account matches a stale `oauth_accounts` row, finds no user, and is told "That account was
deleted." (`oauthRoutes.js:246-251`) — a dead end on the demo path most likely to be shown to a
district.

**S7. Local `.env` signs sessions with a placeholder secret.**
Verified untracked (`git ls-files` clean; `.env.development` contains only `VITE_DEMO_MODE`), so
nothing is leaked. But `JWT_SECRET` is the literal template value while a real
`GOOGLE_CLIENT_SECRET` sits beside it. Worth a loud note in the runbook rather than a code change.

### MEDIUM — UX and product gaps

**U1. "Forgot password" silently fails for a username.**
`Login.jsx` carries `identifier` straight into forgot mode, but `/forgot-password` matches on
email only (`authRoutes.js:545`). Enter your username, get "a reset link is on its way", receive
nothing — with no way to tell that's what happened.

**U2. There is no way to change your email address.**
The verify wall tells a user who mistyped their address to "sign out and create your account again
with the right address" (`App.jsx:898`). But the abandoned account keeps that email *and* that
username, so the second attempt can reuse neither. No email-change endpoint exists, and the wall
offers no self-delete — even though `/api/auth/account` is on the email-gate allowlist precisely
so that escape hatch can exist.

**U3. There is no way to change your username.** Nothing in the app or the API can.

**U4. A transient API failure signs you out.**
`App.jsx:210-212` catches any rejection from the `Promise.all` over events/applications/favorites
and sets `currentUser = null`. One 500 from `/api/events` drops a perfectly valid session to the
sign-in screen.

**U5. Login's sub-modes are not routable.**
`forgot`, `forgot-success` and `link` are React state, so on a phone the system back button leaves
the app instead of returning to sign-in, and a refresh mid-link-flow loses `linkData` entirely.

**U6. Google forces the consent screen on every sign-in.** `prompt: 'consent'` (`google.js:17`).

**U7. Four dead `href="#"` links** in Settings → Help & Support (`Settings.jsx:246-261`).

**U8. The Microsoft avatar fetch is dead code.** `microsoft.js` downloads the profile photo and
base64s it into `claims.avatar` on every sign-in; `oauthRoutes.js` never reads it.

### Accessibility

**A1. `DeleteAccountModal` has no dialog semantics.** The app has a correct shell —
`Modal.jsx` + `useModal` giving Escape, focus trap, focus restore, scroll lock and
`role="dialog" aria-modal="true"`. The single most destructive dialog in the product hand-rolls
`.modal-overlay` and gets none of it. Its close control is `<button>×</button>` with no
accessible name.

**A2. `window.confirm` gates two security actions** — sign-out-others (`Settings.jsx:54`) and
provider disconnect (`ConnectedAccounts.jsx:61`). Unstyled, unthemed, and on iOS shows the bare
origin.

**A3. Server field attribution is discarded on login.** The API returns `field` on validation
failures; `Signup.jsx` uses it (`:188-192`), `Login.jsx` ignores it entirely — no `aria-invalid`,
no `aria-describedby`, no message beside the input that's actually wrong.

### Not yet assessed
Mobile layout, touch targets, safe areas, keyboard behaviour and landscape orientation need
runtime verification against a running dev server, not a code read. Deferred to its own phase.

---

## 3. What the passing test suite does not cover

All four CRITICAL findings survive a green run of 338 tests. C1 and C2 are client routing table
omissions, and there is no test that mounts `App` and asserts which routes resolve for an
authenticated user. C3 and C4 are behavioural — no test asserts that logout leaves other sessions
alive, and none attempts a concurrent case-variant username insert. Test coverage here is a map of
what was thought about, not of what works.
