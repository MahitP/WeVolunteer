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
| `WEV_BACKUP_PUBKEY` | Path to an **X.509 certificate in PEM form** holding the public key to encrypt to. Without it the script warns loudly — an unencrypted archive contains every student's personal data in readable form. |
| `WEV_BACKUP_TESTKEY` | Path to the matching **private key**. Optional on backup, where it makes the script prove the archive decrypts before keeping it; **required** to restore an encrypted archive. |
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

- Encryption round-trip: `WEV_BACKUP_PUBKEY` was unset. Warned about correctly.
- Off-host upload: `R2_*` unset, so `bin/backup-upload.mjs` was not exercised.
  Warned about correctly.
- Scale: two users. The drill proves the mechanism, not the duration of a
  restore against a year of production data.

**All three were closed on 2026-09-06. See the drill below.**

---

## Drill record — 2026-09-06, at scale, encrypted, through the upload path

The 2026-09-05 drill proved the mechanism on two rows and named three gaps. This
one closes all three. Production was not touched: every row is generated by
`bin/backup-drill.mjs`, which refuses any host that is not loopback and any
database holding an account whose address is not on a reserved domain.

**The synthetic database** — 257,201 rows across the twelve tables the platform
cannot be reconstructed without:

```
users 20,001 · events 10,000 · slots 20,000 · applications 80,000
attendance 20,000 · hours_ledger 20,000 · notifications 40,000
certificates 10,000 · conversations 5,000 · messages 30,000
admin_audit_logs 2,000 · organizations 200
```

Generated against the real schema, so every `CHECK` and every `UNIQUE` had to be
satisfied — the seed was wrong four times before it was right, on
`events_category_check`, `applications(user_id, slot_id)`,
`hours_ledger_source_check` and the `conversations` shape rules. A fixture that
the schema would reject proves nothing about a restore.

**Measured**

| Stage | Result |
|---|---|
| Seed | 5.0 s |
| Backup (dump + verify + encrypt) | < 1 s |
| Encrypted archive | 2.5 MB (2,614,561 bytes) |
| Restore + validation | 3.5 s |
| Restore into a kept database | 2.3 s |

Small, because 257k rows is small for `pg_dump`. The number worth carrying
forward is the SHAPE — the archive is ~10 bytes per row and the restore is
seconds, not hours — not the absolute clock on a laptop.

**Encryption round-trip — CLOSED**

```
verified: the encrypted archive decrypts to the original bytes
encrypted to wevolunteer-20260906T065616Z.dump.enc (2.5M)
decrypting
restored: users=20001 credited_hours=60000.00 certificates=10000 ledger=20000
verified: restored counts match the manifest exactly
verified: 96 foreign keys (all validated), 193 indexes
OK — this archive is proven restorable
```

The plaintext dump is removed once encryption succeeds, so the only archive left
on disk is the encrypted one.

**Off-host upload — CLOSED as an integration test, NOT as a provider drill**

This distinction is the point, so it is stated before the evidence: no
Cloudflare R2 credentials exist on this machine, and none were invented. The
upload path was exercised against a LOCAL object-storage stub with
`R2_ENDPOINT` pointed at it.

What that does prove, end to end through the real script:

```
uploaded wevolunteer-20260906T065753Z.dump.enc (2614561 bytes)
uploaded wevolunteer-20260906T065753Z.manifest.json (212 bytes)
```

The stub recorded both objects at `/<bucket>/<key>`, carrying
`AWS4-HMAC-SHA256` authorization, byte-identical to what was written locally.
Restoring from the RETRIEVED copy — not the local one — succeeded with counts
matching the manifest, which closes the loop
`backup → encrypt → upload → retrieve → decrypt → restore`.

`bin/lib/r2-upload.test.mjs` covers the signing itself: 13 cases, including the
SigV4 key derivation checked against the published AWS test vector, and two that
assert the secret never appears in a thrown error.

**What is still NOT proven:** that Cloudflare R2 accepts these requests. A stub
that speaks S3 and a provider that does are not the same claim, and only real
credentials can settle it.

**Production-scale restore — CLOSED for mechanism, at 257k rows**

Beyond schema and counts, the restored database was exercised as a database:

```
derived hours invariant: attendance*3 = 60000 | ledger sum = 60000 | MATCH=YES
browse page (50 events, soonest)   50 rows    4.6 ms
roster for one event                          0.3 ms
certificate lookup by code                    0.2 ms
messages in one conversation                  0.2 ms
write-then-read (user + application + attendance)   committed and read back
foreign key on a missing user                 REFUSED
events.category = 'NotACategory'              REFUSED
```

The derived-hours invariant surviving the restore is the one that matters most:
`attendance` and `hours_ledger` agreed exactly afterwards, so a restored database
credits the same hours it did before. Constraints are still enforced, not merely
present — a restore that dropped them would look identical until the first bad
write.

**Still not proven at production scale:** a year of real production data is a
different distribution from a generated one, and the restore duration on a
managed provider over a network is not this laptop's.

---

## When to drill

- Before launch. **Not yet done against a production-sized dataset.**
- After any migration that adds or changes a table.
- After changing the PostgreSQL major version on either side.
- Quarterly otherwise.

A drill that has not been run this quarter should be treated the same as no
backup at all, because operationally that is what it is.
