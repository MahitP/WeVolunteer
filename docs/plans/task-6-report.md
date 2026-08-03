# Task 6 — Convert the four inline checks, and add the fifth gate

**Branch:** `feat/v1.2b-step-up-authentication` · **Parent:** `b017613`

**Gates:** `npm test` 109 files / **1632 tests**, all passing (baseline **1602** — +30).
`npm run lint` clean. `npm run build` clean, `dist/` intact.
`grep -n "bcrypt.compare" server/routes/*.js` → `authRoutes.js:414` (login) only.

---

## 1. What each endpoint now does

| Endpoint | Removed | Added |
|---|---|---|
| `DELETE /api/auth/account` | inline `bcrypt.compare`; the whole `confirmUsername` branch | `requireAAL2('account.delete')`, `spendChallenge` first inside the existing deletion transaction |
| `POST /api/auth/change-password` | `currentPassword` field + its compare; the `!isOauthOnly` branch that skipped the check | `requireAAL2('password.change')`, `spendChallenge` inside the transaction. **Kept** the "already your password" rule, moved to `isCurrentPassword` in `accountValidation.js` |
| `POST /api/auth/change-email` | `password` field + its compare | `requireAAL2('email.change')` with `newEmail` bound; the two `email_change_tokens` statements are now in a transaction with the spend. Double-confirmation flow untouched |
| `POST /api/oauth/link` | `password` field + its compare; the provider-only 409; the `issueSession` call | `authenticateToken` + `requireAAL2('oauth.link')` with `provider` bound; a 403 when the link token names another account; `spendChallenge` in a transaction with the insert |
| `POST /api/privacy/export` | — | `requireAAL2('data.export')` (new gate), before `exportLimiter`; the job + audit inserts wrapped in a transaction with the spend |

`POST /api/oauth/disconnect`'s last-credential guard is untouched, and
`routes.oauth.test.js` still asserts it. `POST /api/auth/change-username` is
deliberately not gated (reversible, authenticates nothing, has a cooldown).

**Middleware order** is `authenticateToken → requireAAL2 → (limiter) → handler`
on all five. None of the five carries a `capabilityGate`, so nothing moved; each
is declared in Guard 2's `ROUTE_REGISTRY` as `SELF_ONLY`.

**A failed consume answers through the shared refusal table**, never 500 and
never by proceeding. `spendChallenge` throws `ChallengeNotSpent`, which rolls the
transaction back; each handler's existing `catch` maps it with `refuseReauth`
before its own 500 branch. In practice the reachable one is `params_mismatch` →
409 (`requireAAL2` has already refused a wrong action, an expired grant and a
foreign session on the way in). A second identical request answers 403
`reauth_required`, because a consumed challenge no longer resolves to AAL2.

---

## 2. Deviations from the brief, and why

1. **`consumeChallenge` is now synchronous** (`server/reauth.js`). The brief
   requires the consume to happen inside the handler's `inTransaction(...)`, and
   `bcryptAsync.test.js` fails the build on any `await` between `inTransaction(`
   and its closing brace — correctly, because an await inside a synchronous
   SQLite transaction lets unrelated statements interleave with an open one. The
   function awaited nothing (its own docstring said so), so dropping `async` was
   the smallest change that satisfies both. Every existing `await
   consumeChallenge(...)` still works; no call site or test changed.

2. **New module `server/reauthResponses.js`.** The refusal table lived in
   `reauthRoutes.js`, whose header insists there be exactly one of it. Five more
   endpoints in three other files now need it, and `reauthRoutes.js` imports
   `resolveProvider` from `oauthRoutes.js`, so importing back would have made a
   cycle. It could not go in `reauth.js` (documented as knowing nothing about
   HTTP). The module holds the table, `refuseReauth`, `ChallengeNotSpent`, and
   `spendChallenge(db, req, action, params)` — the single place that reads the
   three bindings off the request, so no route can pick up two of three.

3. **`isCurrentPassword` in `accountValidation.js`.** The brief says to keep the
   "don't reuse your current password" rule *and* that `bcrypt.compare` must
   disappear from `server/routes/`. Both hold with the rule moved to a named
   policy function. It refuses any hash not in bcrypt's `$2…` form, which handles
   the `!OAUTH_ONLY!` sentinel by shape rather than by value, so the provider-only
   first-password path is correct by assertion rather than by luck.

4. **`POST /api/oauth/link` gained `authenticateToken` and a caller check.**
   `requireAAL2` reads `req.principal`, so the route had to become
   authenticated. That made a second change mandatory: the link token names the
   `userId` to link, and the password used to be what tied that name to the
   person presenting it. Without a `decoded.userId === req.user.id` comparison,
   someone controlling a provider account bearing a victim's address could sign
   in as themselves, verify with their own credential, and attach their provider
   identity to the victim's account. It now answers 403
   `link_token_other_account`. Tested.

5. **`POST /api/oauth/link` no longer issues a session.** The caller already has
   one, and `oauthRoutes.js`'s `issueSession` minted tokens with no `jti` — so
   re-issuing would have silently cost the user per-device sign-out and the
   ability to verify anything else.

6. **`oauthRoutes.js` now uses `authRoutes.js`'s `issueSession`** (deleting its
   own near-copy). **This was load-bearing, not tidying.** The copy omitted
   `jti`; `openChallenge` refuses to bind a grant to a jti-less session; so with
   Task 6 in place every provider-signed-in user would have been answered
   `session_not_bindable` on all five sensitive actions — locked out of deleting
   their own account, setting a first password, linking a provider and exporting
   their data. Those are precisely the capabilities this release exists to give
   provider-only accounts. The plan never mentions it.

7. **The email-verification gate now allowlists `/api/auth/reauth/`**
   (`EMAIL_GATE_ALLOWLIST_PREFIXES` + `isEmailGateAllowed` in `config.js`).
   `DELETE /api/auth/account` and `POST /api/auth/change-email` are on that
   allowlist because an account whose address has a typo in it can reach nothing
   else. Gating them on `requireAAL2` without allowlisting the step-up routes
   would have re-closed both doors for exactly that account. A prefix rather than
   exact entries because `GET /api/auth/reauth/oauth/:provider` has a parameter,
   and that route is not optional: a Microsoft-provider account arrives
   `email_verified = 0` with no password, so re-consent is its only proof. The
   widening is bounded — nothing under the prefix performs a sensitive action,
   and the three actions not already on the allowlist stay behind the gate.
   `routes.identityChange.test.js`'s unconfirmed-account test covers it.

8. **`exportLimiter` gained the `DEMO_MODE` ceiling every other limiter has**
   (`limit: Number(process.env.EXPORT_RATE_LIMIT) || (DEMO_MODE ? 1000 : 3)`). It
   was the one limiter in the app without that escape; three-per-window was
   survivable with two export tests and is not with nine. Production limit
   unchanged.

9. **`email.change` binds the RAW `newEmail` from the body, not the normalised
   `target`.** The grant's hash was computed by the challenge endpoint over the
   string the client sent it; deriving the expectation from a lower-cased value
   would refuse an honest client whose address contains a capital letter —
   `params_mismatch` on every attempt, looping the UI back to the modal it just
   came from. **Client contract for Task 7: send the identical string to both
   endpoints.** It is not weaker — normalisation only ever merges raw values, so
   binding the raw one is if anything tighter.

10. **New Guard 5 in `authz.completeness.test.js`**: every `requireAAL2` gate is
    paired with a `spendChallenge` for the same action in the same file, and every
    registered action has a gate. The brief warns that a route which gates and
    never consumes defeats single use *invisibly* — every functional test still
    passes. Both halves were proved by injecting the bug (removing the spend, then
    removing the gate) and watching them fail, not by reading the regex. Its
    per-file scope is stated in the docstring.

11. **Test-harness additions to `server/testServer.js`**: a fifth `headers`
    parameter on `call` (positional, so ~1,500 existing call sites are untouched),
    plus `stepUp`, `stepUpOAuth`, `reauthHeader`, `verified`. Every fixture drives
    the real endpoints — open, grant, present the header — rather than writing a
    `reauth_challenges` row, for the same reason `confirmEmail` posts a token
    instead of setting `email_verified`.

12. **Added tests for `POST /api/auth/change-password`, which had none at all.**
    Placed in `routes.identityChange.test.js`.

---

## 3. Test counts

| | Before | After |
|---|---|---|
| Full suite | 109 files / 1602 | 109 files / **1632** |
| `routes.deletion.test.js` | 6 | 11 |
| `routes.identityChange.test.js` | 20 | 29 |
| `routes.oauth.test.js` | 17 | 25 |
| `routes.privacy.test.js` | 22 | 29 |
| `privacyExportIdor.test.js` | 4 | 4 (untouched — it only exercises the download route) |
| `authz.completeness.test.js` | 5 | 7 (Guard 5) |

Each converted endpoint has: no header → 403 `reauth_required` with the right
`action`; a grant for a different action → 403; single use (a replay fails, and
the row's `consumed_at` is asserted); a provider-only account succeeding via
OAuth re-consent; and — for `email.change` and `oauth.link` — a grant whose bound
params differ from the request → 409 `params_mismatch`. Three endpoints also
assert that a refusal *before* the spend (409 active events, 409 export in
progress, 409 address taken) leaves the grant unspent, which is the whole reason
the consume is not in the middleware.

---

## 4. Found, out of scope

1. **`auto_linked` in the OAuth callback adds a provider with no step-up.**
   `POST /api/oauth/:provider/callback` links immediately when the caller's
   session already belongs to the account holding the returned address
   (`oauthRoutes.js`, the `decodedState.userId === existingUser.id` branch) — a
   live session and one provider round trip, no re-verification. It is the same
   state change `POST /api/oauth/link` is now gated on, reached by a different
   door, and it is the door the Settings UI actually uses. **This is the most
   significant gap left.** Gating it means either requiring a grant before
   starting the redirect or moving the write behind `/link`; both are design
   decisions beyond this brief.

2. **The callback's *other* provider-only 409 is still there.** Line ~325 answers
   `link_requires_other_provider` when a signed-out caller's address belongs to a
   password-less account, so such an account can never obtain a link token — which
   makes the 409 deleted from `/link` (per the brief, which named only that one)
   unreachable through the real flow. `/link`'s own capability is covered by a
   test that mints the token exactly as the callback signs it, and the reason is
   commented there. Deleting the callback 409 as well would make the plan's
   "provider-only can link a second provider" claim reachable end to end, and its
   reasoning is now identical to the one already deleted.

3. **Linking a provider whose address differs from the account's is broken,
   independent of this work.** The callback finds no user for the provider's
   address and falls into the brand-new-person path, answering
   `signup_required` to someone who is already signed in.

4. **`server/test_oauth.js`** is a stray scratch harness at the top of `server/`
   that mounts `oauthRoutes` in its own express app. Not a test file, not
   imported by anything.

5. **The client is not wired** — `src/utils/api.js` still sends `currentPassword`,
   `password` and `confirmUsername`, and `DeleteAccountModal.jsx` still treats the
   typed username as the server's credential. That is Task 7 by design; the five
   endpoints answer 403 `reauth_required` until then.
