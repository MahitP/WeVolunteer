# The privileged CLI scripts were changing the wrong database

Found 2026-08-07, during browser verification of the Audit Explorer. Fixed in the
same session. This document exists because the fix is small and the reasoning is
not, and because the same class of bug has now occurred twice in this repository.

## Summary

The four privileged command-line scripts —

```
bin/grant-ownership.mjs
bin/revoke-ownership.mjs
bin/make-admin.mjs
bin/bootstrap-owners.mjs
```

— resolved the database path in a way that could not agree with the running
server, and would create a new empty database rather than refuse when the path was
wrong. `bin/grant-ownership.mjs` is the **only sanctioned way to create an owner**
(owner decision Q1), so the failure mode was: an operator grants ownership, reads
`Successfully granted ownership`, signs in, and is not an owner.

Severity: **high**. Not a vulnerability — it grants nothing to an attacker — but it
silently produces a false success on the most privileged operation the platform has,
and it had already run.

## How it was found

Not by a test. By trying to look at the Audit Explorer in a browser.

`audit.read` is in `SUPER_ONLY`, and `SUPER_ONLY` is checked *before* per-user
grants, so the Explorer is reachable only by an owner — a per-user grant cannot
open it. `DEMO_MODE` never creates an owner (Q1), and the two real owner accounts
hold an unknowable password hash by design (Q2). So the only way to see the page in
development is to grant ownership with the CLI, which is what surfaced this.

The first run failed:

```
A database error occurred: Error: The reserved 'system-cli' account is missing
from this database.
```

That refusal was luck. `assertSystemActor` is a guard added earlier this week for an
unrelated reason (Q-A: attributing CLI actions to a reserved actor). It happened to
fire because the *wrong* database predated migration 022. Against a wrong database
that had run 022, the grant would have committed and reported success.

## The two defects

### 1. `.env` was never loaded

Every entry point in the repository that honours `.env` does it with
`node --env-file-if-exists=.env`, which is a flag on an npm script:

| Entry point | Loads `.env` |
|---|---|
| `server` `start` / `dev` | yes |
| `verify:hours` | yes |
| `db:reset:dev` | yes |
| the four privileged scripts | **no** |

They were invoked as plain `node bin/grant-ownership.mjs`, so `WEV_DB_PATH` — the
variable whose entire job is to say which database is live — was simply absent, and
each script fell back to `server/wevolunteer.db`.

They could not have been right even in principle.

### 2. A relative path resolved against the working directory

`.env` in this repository says:

```
WEV_DB_PATH=../pilot.db
```

A relative path means nothing on its own. It resolves against `process.cwd()`, and
the two callers do not share one:

| Caller | cwd | `../pilot.db` means | State |
|---|---|---|---|
| `npm run dev` (server) | `server/` | `<repo>/pilot.db` | 23 migrations, 18 users — **live** |
| `node bin/*.mjs` | `<repo>/` | `<repo>/../pilot.db` | 15 migrations, 14 users — stale |

Both files exist on the machine where this was found. The second one is outside the
repository entirely. Nobody copied it there: `new DatabaseSync(path)` **creates** an
absent file, so a privileged script wrote a fresh empty database and then reported
success about it. Its 15 migrations date it to when the repository had 15.

The bug had already run. This is the evidence, not a hypothetical.

## The fix

One shared resolver, `bin/resolveDb.mjs`, exporting `openPrivilegedDb(command)`.
The four scripts no longer mention `WEV_DB_PATH` or `DatabaseSync` at all.

Three properties, each independently mutation-tested in
`server/tooling.privilegedDbPath.test.js`:

1. **`.env` is read**, via `process.loadEnvFile`, with an explicit environment
   variable still winning (which is what the test suites and `reset-dev-db.mjs`
   depend on).
2. **A relative value is anchored at `server/`** — deliberately not at the
   repository root and not at `process.cwd()`. `server/` is how the value is
   *already* interpreted by the process that owns the data; any other anchor would
   silently repoint whichever side currently matches the operator's intent, and the
   server is the side that must not move.
3. **An absent file is refused, never created.** A privileged command must not be
   the thing that invents a database. A file with no `users` table is also refused,
   because otherwise opening a backup by mistake produces `User with email x not
   found` — a sentence about the user, for a problem that has nothing to do with
   them.

And the path is printed on every run, including successful ones:

```
Database: /…/SBVolunteers App/pilot.db (23 migrations applied)
```

The whole failure was invisibility. The cheapest durable fix is for the operator to
be told.

## Why the earlier fix did not prevent this

`server/tooling.dbPath.test.js` records the first occurrence: `verifyHours.js`
ignored `WEV_DB_PATH`, opened a stale `server/wevolunteer.db`, and printed
`PASS — ledger matches attendance` about a file nobody cared about.

That fix made the tool read the variable. It did not address either half of what
happened here, because each script kept its **own copy** of the resolution
expression — so there was no single place a fix could land. That is why the new test
file ends with a guard asserting no privileged script resolves or opens a database
itself: the thing to prevent is a fifth script copying its nearest neighbour.

## Verified after the fix

Against the live `pilot.db`, using the real scripts:

- `Database:` line identical when run from the repository root and from `/tmp`.
- `grant-ownership` → role `super_admin`, audit row `OWNER_GRANTED`.
- Audit Explorer rendered the row as **"Ownership granted"**, actor **"System
  (command line)"**, details `method=CLI; command=bin/grant-ownership.mjs;
  operator=…; subject=…; previousRole=admin; reason=…`.
- `revoke-ownership` → role back to `admin`, audit row `OWNER_REVOKED`, same actor.

Both audit rows carry `admin_id = 'system-cli'`, a `target_user_id`, and
`method=CLI`, which is owner decision Q3 satisfied end-to-end against a real
database rather than a fixture.

## Two smaller things fixed alongside

- **`grant-ownership.mjs` claimed ownership was "irrevocable"** while
  `bin/revoke-ownership.mjs` sits next to it. Overstating a consequence is not a
  harmless scare — an operator either avoids a grant they should make, or learns
  the warning was wrong and reads the next one less carefully. Replaced with what
  is actually true: total authority while held, not restrainable by an
  administrator, reversible only by somebody with shell access.
- **The nav called the page "Audit Log"** while the heading and the
  permission-denied message both said "Audit Explorer" — and the nav is exactly
  where somebody looks after being told which feature they lack.

## Left alone deliberately

The stale `pilot.db` outside the repository was **not deleted**. It is the only
physical evidence of what the bug did, it sits outside the repository where this
work has no business writing, and deleting a database that might hold the only copy
of something is not a call to make autonomously. Recommend inspecting and removing
it manually.
