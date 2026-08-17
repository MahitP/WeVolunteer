# Demo Reset Procedure

Use this procedure to reset a **disposable demo database** to a clean state for
the next group of testers.

> **This procedure does not apply to the pilot database.** Read the next section
> before running anything. An earlier version of this document described
> `pilot.db` as disposable and told you to delete it; following it would have
> destroyed both owner accounts, the demo-administrator tombstone, and the
> append-only administrative audit trail.

## Which database am I looking at?

Three different things get called "the database" and only one of them may be
reset with this procedure.

| | What it is | Where it lives | May be reset? |
|---|---|---|---|
| **Disposable demo** | A throwaway file you create for a demo or a test run | Wherever you point `WEV_DB_PATH` — use `/tmp` | **Yes** — that is what this document is for |
| **Pilot** | The real database the pilot runs on. Holds the owner accounts, real service hours, and the audit trail | `pilot.db` at the repository root | **No.** Restore from a backup instead |
| **Production** | A real deployment | `/var/lib/wevolunteer/` on the server | **No.** Restore from a backup instead |

The distinguishing test is contents, not filename. A disposable demo database has
no owner (`super_admin`) accounts, no deleted-account tombstones, and no
administrative audit records. The pilot database has all three.

`bin/seed-pilot.js` enforces this itself — see *The safety guard* below — but the
guard is a backstop, not a substitute for knowing which file you are pointing at.

## Resetting a disposable demo database

Point `WEV_DB_PATH` at a throwaway file. Do not run the command without it: the
script's default target is `pilot.db` at the repository root, which is the live
pilot database.

```bash
WEV_DB_PATH=/tmp/wevolunteer-demo.db node bin/seed-pilot.js
```

The script prompts for confirmation. Add `--yes` for scripted use.

Then run the server against the same file:

```bash
WEV_DB_PATH=/tmp/wevolunteer-demo.db npm run dev
```

### What the seed creates

- **Accounts:** 26 — 1 administrator, 5 organizers, 20 students. All share the
  password `pilotpassword2026`; the administrator is `pilot-admin@example.org`.
  Credentials are listed in `docs/operations/pilot-credentials.md`.
- **Events:** 6 realistic test events, some open, some past.
- **Applications:** the simulated applications, waitlists, and withdrawals.
- **Hours & certificates:** a baseline 5 ledger entries and 5 certificate codes
  on the past events.

A 27th row, `system-cli`, is also present. It is a reserved audit actor seeded by
migration 022, not a usable account, and it is deliberately marked deleted.

This seed does **not** create `admin@example.gov`. That account comes from the
`DEMO_MODE` seed path in `server/db.js`, which `bin/seed-pilot.js` explicitly
disables before seeding. The two are different demo administrators, and only the
`DEMO_MODE` one carries the password published in the README.

## The safety guard

`bin/seed-pilot.js`, `bin/simulate-pilot.js`, and `bin/reset-dev-db.mjs` all
refuse to touch a database that holds real data. The check lives in
`bin/lib/db-safety.mjs` and it looks at contents rather than at the path, because
the pilot database sits at a workstation path under an innocuous name and passes
every filename and location heuristic.

A refusal names what it found:

```
REFUSING: /path/to/pilot.db

  That database contains real data — 2 owner (super_admin) accounts,
  2 deleted-account tombstones, 12 administrative audit records.
  pilot data seed only ever runs against a disposable demo database.
```

If you are certain you want to destroy a database the guard has refused, set
`WEV_ALLOW_DESTROYING_REAL_DATA=1`. It is an environment variable rather than a
flag specifically so that it cannot be reached by pasting a command line out of
this document.

Regression cover lives in `server/tooling.scriptSafety.test.js`, which asserts
the refusal against every destructive tool, asserts the file is left
byte-identical afterwards, and asserts that a freshly seeded demo database can
still be reset again — the last of these being what stops the guard from being
tightened into something people work around.

## Resetting the pilot environment

Do not use this procedure. Restore from a backup:
`docs/operations/pilot-deployment-runbook.md` § Backup strategy.

## Restarting the server

Reseeding replaces the database file, so a server already running against it is
holding a deleted inode and will keep serving the old data. Restart it after a
reset.
