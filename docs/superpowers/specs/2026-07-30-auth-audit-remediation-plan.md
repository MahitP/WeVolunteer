# WeVolunteer Auth Remediation — Implementation Plan

**Companion to:** `2026-07-30-auth-audit-phase1-findings.md`
**Decisions taken:** full email + username change flows · rename-newer username migration ·
keep specific login messages, strengthen the bound instead

Work is ordered so that each stage is independently shippable and testable. Every stage ends with
`npm test` green; the whole thing ends with `npm run build` and a runtime walkthrough.

---

## Stage 1 — The four CRITICAL fixes

### 1.1 Auth-flow routes must resolve in every session state (C1, C2)

`/oauth/callback` and `/reset-password` are not "signed-out screens" — they are links arriving
from outside the app, and the sender cannot know whether a session exists. Handle them alongside
the existing `/verify/:code` public-route check in `App.jsx`, *before* the `!currentUser` branch,
so all three session states (none / unverified / verified) reach them.

```
AUTH_FLOW_PATHS = ['/oauth/callback', '/reset-password']
```

Behavioural consequences to get right:

- `auto_linked` currently calls `onLoginSuccess()`, which navigates to `/`. A user who pressed
  Connect in Settings should land back in Settings. Add an `onLinked` callback →
  `/settings?section=security` with the success toast.
- Reset-password success bumps `token_version`, so the in-memory `currentUser` is stale the moment
  it returns. `onSuccess` does a hard `window.location.assign('/login')` rather than a soft
  navigate — correct in both session states, and a full reload on a password reset is appropriate.

**Tests:** mount `App` with a mocked authenticated `getMe` and assert `/oauth/callback` renders
`OAuthCallback` (not a redirect to `/`); same for `/reset-password`. These are the tests whose
absence let both bugs ship.

### 1.2 Logout stops signing out every device (C3)

Drop the `token_version` increment from `POST /api/auth/logout`; clear the cookie only.
`/sign-out-others` already covers the deliberate case and is unchanged.

**Test:** two sessions for one user → logout on session A → session B still authenticates.

### 1.3 Case-insensitive username uniqueness (C4)

New `dedupeCaseInsensitiveUsernames(db)` in `db.js`, modelled directly on the existing
`dedupeCaseInsensitiveEmails`, run *before* index creation:

- Group by `LOWER(username)` having `COUNT(*) > 1`, ordered `created_at ASC` — oldest keeps it.
- Each newer row gets the first free `${base}${n}` (n from 2), with `base` truncated so the result
  respects `USERNAME_MAX` (20). Suffix search is itself `COLLATE NOCASE`.
- Each rename writes a `notification` row (kind `info`) telling the person their username changed
  and why, plus an `admin_audit_logs` entry.

Then:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase
  ON users(username COLLATE NOCASE) WHERE username IS NOT NULL
```

The pre-existing case-sensitive `idx_users_username` stays — the new index is strictly stricter,
and dropping an index on live pilot data buys nothing. Deletion tombstones are
`deleted_user-<uuid>`, unique by construction, so they cannot collide.

**Tests:** seed two case-variant usernames directly, run `initDatabase`, assert the older keeps
it, the newer is suffixed, a notification exists, and a subsequent case-variant `INSERT` now
throws.

---

## Stage 2 — Security hardening

### 2.1 Login throttle: key on the account, check first (S1, S2)

Restructure `POST /api/auth/login` to: resolve the identifier → derive the throttle key from the
**resolved user id** (falling back to the normalised identifier only when no account matched) →
**check the lock before any account-shape branch** → then `no_such_account` / `suspended` /
`oauth_only` → then bcrypt.

This closes the alias-doubling (one bucket per account, not per spelling) and stops a locked-out
caller still harvesting the three shape oracles.

**Tests:** exhaust the limit using the email, then assert the *username* for the same account is
also locked; assert a locked account returns 429 rather than `oauth_only`/`suspended`.

### 2.2 `PATCH /api/auth/profile` uses the shared validators (S3)

Add `validateProfilePatch()` to `accountValidation.js` reusing the same `NAME_MAX` / `BIO_MAX` /
`SCHOOL_MAX` / avatar constants the signup path already enforces, and route the PATCH handler
through it. Fixes the 500 on a non-string `name`, the empty-display-name write, and the
one-field-two-rulesets split.

### 2.3 Deletion completeness (S4, S5)

Inside the existing deletion transaction:

- Set every non-terminal application (`pending`, `waitlisted`, `accepted`) to `withdrawn`, so a
  deleted volunteer stops occupying a spot and leaves the organizer's roster.
- Notify the organizer of each affected event that still has an upcoming slot — they are staffing
  something and need to know.
- `attendance` rows stay untouched. That is the verified service record and its preservation is
  already promised to the user in the delete dialog.
- `admin_audit_logs` id becomes `audit-${crypto.randomUUID()}` (audit the file for other
  `Date.now()`-keyed ids while there).

### 2.4 Demo reset drops the auth tables too (S6)

Add `oauth_accounts`, `email_verification_tokens`, `password_reset_tokens` and
`oauth_signup_sessions` to the drop list so a reset cannot leave a linked Google account pointing
at a user id that no longer exists.

### 2.5 Runbook note (S7)

`.env` is untracked and clean, but ships a placeholder `JWT_SECRET` beside a real Google client
secret. Document the pre-deploy check; no code change.

---

## Stage 3 — Email change (U2)

The mistyped-address dead end is the single worst onboarding failure in the product: the account
holds an email its owner cannot read and a username they cannot reuse.

**Schema:** `email_change_tokens (token TEXT PRIMARY KEY, user_id, new_email, expires_at)`.

**`POST /api/auth/change-email`** — authenticated, `mailLimiter`:
`validateEmail(newEmail)` → reject if unchanged → reject if held by another active account (409,
`field: 'newEmail'`) → require and verify the current password *if the account has one* (OAuth-only
accounts prove intent with the session, consistent with `change-password`) → one live token per
user → mail a confirm link to the **new** address, and a no-link heads-up to the **old** one
("someone asked to move this account to a…@…; if that wasn't you, change your password"). That
second mail is the security-critical half and is not optional.

**`POST /api/auth/confirm-email-change`** — unauthenticated, because the link may open on a device
with no session (exactly like `verify-email`): validate token and expiry → re-check the address is
*still* free → in one transaction set `email`, set `email_verified = 1`, bump `token_version`,
delete the token and any outstanding password-reset tokens (those were mailed to the old address)
→ issue a fresh session.

**Both paths join `EMAIL_GATE_ALLOWLIST`.** This is load-bearing: the user who most needs to change
their address is precisely the one the gate is currently confining.

**Client:** new `Account` section in Settings (email + username, alongside the existing Security
section), a "That's not my address" path on `VerifyEmailWall`, and an `?emailchange=<token>`
intercept in `App.jsx` mirroring the existing `verify` / `reset` handling — including the
single-presentation `useRef` guard that the other two already need.

---

## Stage 4 — Username change (U3)

**Schema:** `users.username_changed_at TEXT`.

**`POST /api/auth/change-username`** — authenticated, `authLimiter`: `validateUsername` →
availability `COLLATE NOCASE` excluding self → 30-day cooldown, returning the exact date it lifts.

One deliberate exception: a **case-only** change (`alice` → `Alice`) is free and does not start a
cooldown. It cannot collide with anyone and refusing it would be pedantry.

No `token_version` bump — a username change does not invalidate sessions.

---

## Stage 5 — UX and accessibility

| Item | Fix |
|---|---|
| U1 | `forgot-password` matches email **or** username; response stays byte-identical either way, so no new enumeration. Copy and the field label follow. |
| U4 | `refreshAll` only clears `currentUser` when `getMe()` itself fails. Data-fetch failures warn and leave the session intact. |
| U5 | Login sub-modes move to `?mode=forgot` etc. so the phone back button works and a refresh mid-flow survives. |
| U6 | Google `prompt: 'consent'` → `'select_account'`. |
| U7 | Dead `href="#"` links replaced with config-driven links that render only when a URL is set — the pattern `PRIVACY_URL` already uses on Welcome. |
| U8 | Delete the unused Microsoft photo fetch. |
| A1 | `DeleteAccountModal` moves onto the `Modal` / `useModal` shell: Escape, focus trap, focus restore, scroll lock, `role="dialog"`, named close control. |
| A2 | Replace both `window.confirm` security gates with the in-app confirm dialog. |
| A3 | `Login` consumes the server's `field` attribution — `aria-invalid` and a message beside the input that is actually wrong, as `Signup` already does. |

---

## Stage 6 — Verification

Not "it compiles". In order:

1. `npm test` — all existing 338 plus the new ones.
2. `npm run build`.
3. Runtime walkthrough against the dev server with `OAUTH_ALLOW_MOCK=true`, driving the browser:
   signup → verify → login (email **and** username) → forgot/reset → Google signup → Google login
   → **link from Settings** (the C1 regression) → unlink → email change → username change →
   delete → re-signup with the freed username.
4. Mobile audit at 375×812 and in landscape — the one area Phase 1 could not assess from a code
   read. Touch targets, safe areas, keyboard overlap, and the new Account section.
5. Keyboard-only pass over every auth screen and both dialogs.

## Out of scope, stated explicitly

- Apple Sign-In stays an honest 501. Implementing it needs a Services ID, team ID, a `.p8` key and
  `form_post` callback handling — a project, not a fix.
- No CSRF token. The `SameSite=Lax` + single-origin reasoning in `config.js` is sound for this
  deployment and carries its own revisit-if clause.
- No per-device session list. It would require a session table; the current screen honestly says so
  rather than inventing rows.
