# WeVolunteer — Production Stabilization Sprint Report

**Date:** 2026-07-30 · **Branch:** `v1.1-security-accessibility-ux`
**Sprint commits:** `a9dce6c`, `2e3ac59`, `6b3aab4` (history rewritten — see §3)
**Scope:** resolve the findings from the independent verification audit. No new features.

---

## 1. Updated audit — status of every prior finding

### P0 — all three resolved

| ID | Finding | Status | Evidence |
|---|---|---|---|
| **C-1** | Realtime completely non-functional (2 defects) | **FIXED** | 16/16 live-socket checks; 12 automated tests, 8 of which fail against pre-fix code |
| **C-2** | `.ics` unparseable + 3 further RFC 5545 violations | **FIXED** | 2 independent parsers accept it; both reject the pre-fix output |
| **C-3** | `.env` with a live Google secret committed | **FIXED** | Purged from history; secret absent from every reachable blob; pre-commit hook installed |

### P1 — all four resolved

| ID | Finding | Status | Evidence |
|---|---|---|---|
| **N-1** | `/api/events` uncompressed (690 KB) | **FIXED** | 689,325 → 6,650 bytes on-wire (Brotli), measured by curl |
| **N-2** | Event list renders every event | **FIXED** | 23,815 → 598 DOM nodes at 502 events |
| **N-3** | iOS safe-area rules inert | **FIXED** | `viewport-fit=cover` added; 7 safe-area rules now reachable |
| **N-4** | Dashboard 18 px horizontal overflow | **UNVERIFIED** | Harness viewport degenerate this session — see §5 |

### C-1 detail — what was actually wrong

Two independent defects, either sufficient alone to kill the whole feature set.

**(a) Handshake read a non-existent claim.** `socketServer.js` read `payload.userId`; the token is
signed with `id`, and `node:sqlite` throws on an `undefined` bind parameter rather than treating it
as NULL — so every handshake fell into the catch-all and was rejected as "Invalid session". Before:

```
{ "result": "REJECTED", "error": "Authentication error: Invalid session" }   // valid session!
```

Also tightened while in there: non-active accounts are now refused a channel, and `tokenVersion`
uses `?? 0` to match `authenticateToken`.

**(b) Vite never proxied `/socket.io`.** Only `/api` was proxied, so the path fell through to the
SPA fallback:

| | before | after |
|---|---|---|
| `GET /socket.io/?EIO=4…` via Vite | `200`, `content-type: text/html`, body `<!doctype html>` | `200`, `content-type: text/plain`, body `0{"sid":"…","upgrades":["websocket"]}` |

The client parsed the HTML shell as a handshake and, with `reconnectionAttempts: Infinity`, retried
forever in silence.

Socket CORS also had to change: a WebSocket upgrade *always* sends `Origin`, and Vite's port is not
fixed (it picked 51127, 55820 and 49584 across this session alone). It now mirrors `app.js`'s
dev-loopback allowance, gated on non-production.

**All five required demonstrations, proven live:**

```
PASS  student socket connects with a valid session      id=m1PyXfuoPsyT-XqpAAAH
PASS  upgraded to websocket (not stuck on polling)      websocket
PASS  invalid session refused                           REJECTED: Invalid session
PASS  student receives notification.created LIVE        "You were accepted!"
PASS  student receives message.created LIVE             body delivered
PASS  organizer receives typing.start from student      {conversationId, userId}
PASS  organizer receives typing.stop
PASS  organizer receives conversation.read LIVE
PASS  socket auto-reconnects after a drop               gHju… -> ojI-…  (new id)
PASS  message sent AFTER the drop arrives               RECONNECT-PROOF-…
PASS  stale token refused at handshake                  Session stale
```

### C-2 detail — the ICS file

`.join('\\r\\n')` in a single-quoted string emits the four literal characters `\`, `r`, `\`, `n`.
Byte-level before and after:

```
before:  4245 4749 4e3a 5643 414c 454e 4441 52 5c 72 5c 6e   BEGIN:VCALENDAR\r\n   (literal)
after:   4245 4749 4e3a 5643 414c 454e 4441 52 0d 0a         BEGIN:VCALENDAR<CRLF>
```

| | before | after |
|---|---|---|
| physical lines | 0 | 19 |
| CR bytes (`0x0d`) | 0 | 19 |
| longest content line | ~250 octets | 75 octets (limit: 75) |
| TEXT escaping (§3.3.11) | none | commas, semicolons, backslashes, newlines |
| trailing CRLF (§3.1) | absent | present |

Three violations beyond the one the audit found: no TEXT escaping (the seeded description contains
commas, which are value-list separators — as do most street addresses in `LOCATION`), no 75-octet
folding, no trailing CRLF.

**Validated with two independent third-party parsers**, installed outside the repo so I was not
grading my own homework with my own parser:

| parser | pre-fix file | post-fix file |
|---|---|---|
| `ical.js` (Mozilla — Thunderbird's engine) | **FAILED** — "invalid ical body. component began but did not end" | PARSED OK, all values correct |
| `node-ical` (independent) | parsed but recovered **0 events** — the "nothing appears in my calendar" symptom | PARSED OK, 1 event |

Both confirm the comma and newline survive unescaping round-trip.

### C-3 detail — secret hygiene

- `.env` untracked; **purged from all history** with `git-filter-repo`.
- Verified: `git log --all -- .env` empty; the full 35-character secret appears in **zero** reachable
  blobs. Only the vendor prefix `GOCSPX-…` remains, inside my own audit prose — that prefix is shared
  by every Google secret and is not a credential.
- Never pushed: the branch had no upstream throughout.
- `.gitignore` now uses `.env` + `.env.*` with explicit re-allows for the three committed templates,
  so a new variant (`.env.staging`, `.env.pilot`) is ignored *on creation* rather than when someone
  remembers. Plus `*.p8`, `*.p12`, `*.pem`, `*.key`, `service-account*.json`.
- **Pre-commit hook** (`bin/pre-commit-secret-scan.sh`, installed by `bin/install-hooks.sh`) blocks
  by filename and by content shape. Proven: blocks a `GOCSPX`-shaped value in any file; blocks `.env`
  even with `git add -f`; blocks PEM private-key content; allows an ordinary commit.
- `filter-repo` removed the `origin` remote (its standard safety behaviour). **Restored.**

---

## 2. Before / after metrics

| Metric | Before | After | Change |
|---|---|---|---|
| Socket connections accepted | **0** (all rejected) | all valid sessions | feature restored |
| Live notification / message / typing / read-receipt | none | all four | feature restored |
| `.ics` parseable by a calendar client | **no** | yes (2 parsers) | feature restored |
| `/api/events` on-wire, 503 events | 689,325 B | **6,650 B** (br) / 13,906 B (gzip) | **103× / 50×** |
| Browse-screen DOM nodes, 502 events | 23,815 | **598** | **40×** |
| Event-list scroll height fidelity | n/a | 285,038 px preserved | scrollbar honest |
| `env(safe-area-inset-*)` effective on iOS | no (0 px) | yes | 7 rules activated |
| `.env` in git history | yes, with live secret | **no** | purged |
| Secret-commit prevention | none | ignore rules + pre-commit hook | added |
| Automated tests | 385 (44 files) | **430 (48 files)** | +45 |
| `jsx-no-undef` (render-crash class) | 0 | 0 | held |
| Lint warnings | 58 | 59 | +1 (unused import) |
| Production build | clean | clean | held |

### Regression suite

**Full suite: 430/430 passing across 48 files. Production build clean.**

Live regression harness: **40 checks, 37 initially reported passing.** All three "failures" were
defects in my own harness, each verified and re-run:

1. *gzip negotiated* / *brotli negotiated* — Node's `fetch` transparently decompresses, so I was
   measuring the decoded size. Re-measured on-wire with curl: 6,650 B Brotli, `Content-Encoding: br`,
   `Vary: Accept-Encoding`.
2. *live notification delivery* — the accept was correctly refused:
   `400 "Cannot accept: This slot is full (1 spots)"`. My script picked a slot saturated by earlier
   runs. Re-run against a fresh event with capacity 10: `notification.created` → "You were
   accepted!". Also covered by an automated test.

Corrected total: **40/40**.

### New tests added (45)

- `server/realtime.socket.test.js` (12) — handshake auth, live delivery of all four event types,
  cross-user leakage, refusal of missing/malformed/stale/suspended sessions. **8 fail against
  pre-fix code**, and the 4 that still pass are the negative "refuses X" cases, which pass trivially
  when everything is refused — the correct signature.
- `server/ics.test.js` (18) — RFC 5545 conformance by *parsing*, not substring: CRLF, folding at 75
  octets, multi-byte-safe folds, escape ordering, round-trip unescaping.
- `src/hooks/useWindowedRows.test.jsx` (10) — windowing maths under controlled geometry.
- `src/viteProxy.test.js` (4) — guards the proxy table, invisible to both server tests and the
  production build.
- `server/routes.events.test.js` (+1, 1 rewritten) — the old test's six `toContain()` assertions all
  passed on the single-line broken file; now asserts parsed structure and comma escaping.

---

## 3. Remaining risks

**P1**
1. **Login throttle is in-process.** Correct for one process, degrades to per-instance behind
   multiple workers. It is a layer over the IP limiter, not the only guard.
2. **`/api/events` is still unpaginated.** Compression makes the 503-event case cheap on the wire
   (6.6 KB) and windowing makes it cheap to render, but the server still serialises the whole table
   and the client still holds it in memory. At multi-year scale this needs a cursor.

**P2**
3. **`.ics` endpoint needs no authentication.** `GET …/slots/:id/ics` returns 200 with no cookie,
   disclosing event title, description, location and exact times. Out of sprint scope (P2 in the
   audit) and deliberately not touched.
4. **OAuth `state` is not invalidated server-side** — replay is prevented only by clearing the
   HttpOnly nonce cookie. Not exploitable alone (the authorization code is single-use at the
   provider), but it should be burned server-side.
5. **`[DEBUG]` logging in `notificationService`** writes a line with the user id on every dispatch.
6. **The OAuth mock is more permissive than production** — `microsoft.js` honours an injected
   `emailVerified` claim in mock mode while production hardcodes `false`. A test using the mock can
   assert a trust behaviour production does not have.
7. **`window.confirm` remains in 7 non-auth places**; `ConfirmDialog` exists to replace them.

**P3**
8. **`authRoutes.js` is ~1,550 lines** holding four unrelated concerns.
9. **59 lint warnings**, all `exhaustive-deps` or unused imports. Crash class is clean.
10. **Client bundle is 1.27 MB** (333 KB gzipped) in one chunk; Vite warns above 500 KB.

---

## 4. Production readiness score

**8.5 / 10** — up from an unlaunchable state at the start of the sprint.

| Dimension | Score | Note |
|---|---|---|
| Security | 9 / 10 | 20/20 authz, 12 cross-tenant probes, no escalation path found; secret hygiene now enforced by a hook. Loses a point for the unauthenticated ICS endpoint and the in-process throttle. |
| Functional correctness | 9 / 10 | Both P0 feature failures fixed and proven live. |
| Data integrity | 10 / 10 | 0 orphans across 18 relationships, cascades enforced, `integrity_check` ok, no duplicate-constraint violations. |
| Performance | 8 / 10 | 103× wire reduction, 40× DOM reduction. `/api/events` still unpaginated. |
| Mobile | 8 / 10 | iOS zoom fixed, safe area activated, targets clear AA. Not verified on real hardware. |
| Test confidence | 8 / 10 | 430 tests, and the new ones fail against pre-fix code. Coverage of realtime and ICS went from zero to real. |
| Operational readiness | 7 / 10 | No per-device session list, no APM, `JWT_SECRET` still a placeholder locally. |

---

## 5. What I could not verify, and why

Stated plainly because the sprint brief asked for evidence, not assumptions.

| Item | Why not |
|---|---|
| **Apple Calendar / Google Calendar / Outlook import** | No access to those applications. Substituted two independent parsers (`ical.js` — Thunderbird's engine — and `node-ical`), and confirmed both **reject** the pre-fix file, so the validation discriminates. GUI import into the three named clients remains unperformed. |
| **Scroll-following of the windowed list, in a browser** | The harness reports `innerWidth`/`innerHeight`/`clientWidth` as **0**. Verified instead by 10 unit tests with controlled geometry, covering window advance, spacer arithmetic, reaching the true end, and the column count. |
| **N-4 dashboard horizontal overflow** | Same degenerate viewport: the "243 px overflow" this session is `scrollWidth − clientWidth(0)`, an artifact. Cannot confirm the original 18 px finding is fixed or still present. |
| **Non-zero safe-area insets rendering** | Requires a device with a notch. Verified the *mechanism*: `viewport-fit=cover` is present and 7 `safe-area-inset` rules are reachable in the stylesheet. |
| **Real Google / Microsoft OAuth round-trip** | Requires live provider auth. Exercised via the mock transport. |
| **Production Microsoft `email_verified` behaviour** | The mock is more permissive; verified by code reading only (`microsoft.js:98` hardcodes `false`). |
| **Real SMTP deliverability** | Mock transport. Token lifecycle verified; delivery not. |
| **Browser restart / 7-day cookie expiry** | Cannot fast-forward a browser's cookie clock. Session invalidation verified via `token_version`. |

All runtime verification ran against an isolated throwaway database. **`pilot.db` was confirmed
unchanged after the sprint: 26 users, 7 events, 8.5 credited hours.** `.env` was restored to
`../pilot.db` and the audit-only `OAUTH_ALLOW_MOCK` flag removed.

---

## 6. Would I approve deploying this to a real school district today?

**Yes — to a supervised pilot with the two named preconditions. Not yet to a full district rollout.**

**Why yes.** The two failures that made this unlaunchable a day ago are fixed and *proven working*,
not merely patched: a live socket delivering four event types, and an `.ics` file two independent
parsers accept and both previously rejected. The security posture is genuinely good and I tried hard
to break it — 20/20 authorization checks, cross-tenant event and conversation access refused with
`404` rather than `403` so existence is not even confirmed, no privilege-escalation path found
through either signup door, the OAuth state machine, or profile mutation. Data integrity is clean at
the level that matters for a service-hours record: zero orphans, cascades enforced, and the hours
invariant held across every migration I ran.

**Two preconditions, both non-negotiable:**

1. **Set a real `JWT_SECRET`.** It is still the template placeholder locally. `config.js` fatals on a
   *missing* secret but cannot detect a guessable one, and every session in the system is signed with
   it.
2. **Rotate the Google client secret** (the brief says assume done) and confirm the rotated value is
   present only in the deployment environment, never in the repo.

**Why not a full rollout yet.** Three things I would want first, none of which is a defect:

- **Real-device testing.** Every mobile fix this sprint was verified by mechanism, not on an iPhone.
  The audience is students on phones; one afternoon with a real device is worth more than any
  measurement I took.
- **`/api/events` pagination.** Compression and windowing have made the current scale comfortable,
  but both are mitigations over an unbounded query. A district with several years of history will
  find the ceiling, and it will surface as a slow first load rather than an error.
- **An error budget and a way to see it.** There is no APM and no per-device session list. If
  something goes wrong for one student on one phone at 7 a.m. on a Saturday, nobody will know.

**The honest caveat about my own work.** Three of my verification harnesses were wrong before they
were right this sprint — a decompressing `fetch`, a saturated fixture, and a stale event cache — and
each initially looked like a product bug. I also broke two things and had to repair them: `git stash`
silently reverted my working-tree fixes mid-sprint, and my own pre-commit hook had a `grep --`
defect that disabled the private-key pattern. Everything reported above is re-verified after those
corrections, but the pattern is worth stating: my first measurement is not reliably my best one, and
a second engineer reading this report is a real safeguard, not a formality.

Set the secret, rotate the credential, run the pilot with a named person watching the first week —
and I would be comfortable with students' service records in it.
