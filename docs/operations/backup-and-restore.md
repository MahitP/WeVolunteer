# Backups and restore

The PostgreSQL backup path, and the drill that proves it works.

> **A backup is a hypothesis until it has been restored.** This document exists
> so that "we have backups" is never said on the strength of a directory
> listing. `bin/backup-postgres.sh` verifies its own archive before keeping it;
> `bin/verify-restore-postgres.sh` is what turns that into a proof.

---

## The two scripts

| Script | What it does |
|---|---|
| `bin/backup-postgres.sh` | Records the live invariants, dumps, **verifies the archive parses and carries data**, writes a manifest, encrypts if a public key is configured, uploads off-host if R2 is configured, prunes older generations only after a successful new one. |
| `bin/verify-restore-postgres.sh` | Restores an archive into a throwaway database, compares the restored counts against the manifest, and checks the schema, foreign keys and indexes came back. |

`bin/backup.sh` is the SQLite original and **cannot back up a PostgreSQL
deployment**. It is kept for the SQLite era and for the demo database.

---

## The version trap — read this before anything else

`pg_dump` refuses to dump a server newer than itself, exits non-zero, **and
leaves a zero-byte file at the `-f` path**. A script that checked only a
pipeline's exit code would compress that empty file, encrypt it, prune the
previous generation, and report success — a backup directory full of nothing,
discovered during the restore that needed it.

`backup-postgres.sh` compares the client and server major versions before it
dumps anything and refuses loudly. Verified on 2026-09-05:

```
FAILED: pg_dump is too old for this server.
  pg_dump major:  16
  server major:   17
```

Supabase runs PostgreSQL 17. A host with Homebrew's default `postgresql@16`
first on `PATH` therefore **cannot** back up production. Point the script at a
matching client:

```bash
WEV_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bin/backup-postgres.sh
# Debian/Ubuntu: apt install postgresql-client-17
```

---

## Running a backup

```bash
DATABASE_URL="…" \
WEV_BACKUP_DIR=/var/backups/wevolunteer \
WEV_PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
  bin/backup-postgres.sh
```

| Variable | Meaning |
|---|---|
| `WEV_BACKUP_DIR` | Where archives are written. Default `/var/backups/wevolunteer`. |
| `WEV_BACKUP_KEEP_DAYS` | Prune age. Default 14. Pruning happens **only** after a verified new backup. |
| `WEV_BACKUP_PUBKEY` | `age` public key. Without it the script warns loudly — an unencrypted archive contains every student's personal data in readable form. |
| `R2_*` | Off-host destination. Without it the script warns that the backup exists only on the host it protects. |

Both warnings are deliberate and must not be silenced on a real deployment.

---

## Running the drill — the part that matters

```bash
WEV_RESTORE_URL="postgres://user@host:5432/postgres" \
WEV_BACKUP_DIR=/var/backups/wevolunteer \
PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH \
  bin/verify-restore-postgres.sh /path/to/wevolunteer-….dump
```

`WEV_RESTORE_URL` points at a server, not a database: the script creates
`wev_restore_drill_$$`, restores into it, checks it, and drops it. **Never point
it at production.**

---

## Drill record — 2026-09-05

Performed against a local PostgreSQL 17 server and two scratch databases.
Production was not touched at any point.

**Backup**

```
client pg_dump major=17 against server major=17 — compatible
recording invariants from the live database
live: users=2 credited_hours=0 certificates=0 ledger=0
verified: archive parses and carries data for users, events, attendance, certificates
wrote wevolunteer-20260905T213301Z.dump (192K)
pruned backups older than 14 days
OK
```

**Restore**

```
creating scratch database wev_restore_drill_22982
restore completed with no errors
restored schema: 70 tables
verified: every table the platform cannot be reconstructed without is present
restored: users=2 credited_hours=0 certificates=0 ledger=0
verified: restored counts match the manifest exactly
verified: 96 foreign keys (all validated), 193 indexes
OK — this archive is proven restorable
```

**Application against the restored database**

The scripts prove the schema and the counts. This is the third question — can
the application actually read it:

```
migration ledger rows : 67
users                 : 2
active badges         : 1
indexes               : 193
UNVALIDATED fks       : 0
drill row survived    : Backup Drill <drill@example.invalid>
```

A row inserted before the backup came back with its data intact, every foreign
key is validated rather than merely present, and the migration ledger survived —
so a restored database will not try to re-run migrations it has already had.

**What this drill did NOT prove**

- Encryption round-trip: `WEV_BACKUP_PUBKEY` was unset, so the `age` path was
  not exercised. Warned about correctly.
- Off-host upload: `R2_*` unset, so `bin/backup-upload.mjs` was not exercised.
  Warned about correctly.
- Scale: two users. The drill proves the mechanism, not the duration of a
  restore against a year of production data.

Those three are the next things to close, and they need real credentials.

---

## When to drill

- Before launch. **Not yet done against a production-sized dataset.**
- After any migration that adds or changes a table.
- After changing the PostgreSQL major version on either side.
- Quarterly otherwise.

A drill that has not been run this quarter should be treated the same as no
backup at all, because operationally that is what it is.
