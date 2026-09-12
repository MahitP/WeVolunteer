# Deployment units

Files here are installed onto the production host. They are not used in
development and nothing in the application reads them.

| File | Purpose |
|---|---|
| `wevolunteer.service` | The main systemd service for the application |
| `wevolunteer.env.example` | Template for server secrets (copied to `/etc/wevolunteer/wevolunteer.env`) |
| `wevolunteer-backup.service` | Runs `bin/backup.sh` once |
| `wevolunteer-backup.timer` | Fires the service nightly at 03:00 |

Everything else about deployment lives in
[`docs/operations/pilot-deployment-runbook.md`](../docs/operations/pilot-deployment-runbook.md).

---

## Install the backup schedule

Both files assume the runbook's layout: code at `/srv/wevolunteer`, uploads and
local state at
`/var/lib/wevolunteer`, service user `wev`. If yours differs, edit the
`Environment=` lines in the `.service` **and** the `User=`/`Group=` before
installing — they must match the running app's `WEV_DB_PATH`.

```bash
sudo install -m 644 /srv/wevolunteer/deploy/wevolunteer-backup.service /etc/systemd/system/
sudo install -m 644 /srv/wevolunteer/deploy/wevolunteer-backup.timer   /etc/systemd/system/

sudo install -d -o wev -g wev -m 700 /var/backups/wevolunteer

sudo systemctl daemon-reload
sudo systemctl enable --now wevolunteer-backup.timer
```

## Verify it works

Do not wait until 03:00 to find out. Run it once by hand:

```bash
sudo systemctl start wevolunteer-backup.service
sudo systemctl status wevolunteer-backup.service
sudo journalctl -u wevolunteer-backup.service -n 20 --no-pager
```

A successful run logs a verification line naming what it found, then `OK`:

```
client pg_dump major=17 against server major=17 — compatible
recording invariants from the live database
live: users=14 credited_hours=3.0 certificates=1 ledger=14
verified: archive parses and carries data for users, events, attendance, certificates
wrote wevolunteer-20260727T030000Z.manifest.json
verified: the encrypted archive decrypts to the original bytes
encrypted to /var/backups/wevolunteer/wevolunteer-20260727T030000Z.dump.enc
uploaded wevolunteer-20260727T030000Z.dump.enc (2614561 bytes)
pruned backups older than 14 days
OK
```

Two lines are the ones worth reading. **`client pg_dump major=N against server
major=M`** must say *compatible* — a mismatch is refused here rather than
producing a zero-byte archive. And if **`WARNING: WEV_BACKUP_PUBKEY is not
set`** appears instead of the encryption lines, the archive on disk is readable
plaintext containing every student's personal data.

Confirm the schedule is armed and see when it next fires:

```bash
systemctl list-timers wevolunteer-backup.timer
```

## Restore

The full procedure — including verifying the restored file **before** starting
the service — is in the runbook under *Backup strategy → Restore procedure*.
The short form:

> **This section described the SQLite restore until 2026-09-12.** The unit
> shipped here runs `bin/backup-postgres.sh` and produces an ENCRYPTED
> PostgreSQL custom-format dump — there is no `.db.gz` to gunzip and no
> `PRAGMA integrity_check` to run. Following the old steps during an outage
> would have wasted the worst possible minutes discovering that.

**Never restore straight over production.** Restore into a scratch database,
check it, and only then decide. `bin/verify-restore-postgres.sh` does exactly
that and drops the scratch database afterwards:

```bash
# 1. Prove the archive is restorable. Creates and drops its own scratch
#    database; never touches the one in DATABASE_URL.
WEV_RESTORE_URL="postgres://<user>@<host>:5432/postgres" \
WEV_BACKUP_TESTKEY=/path/to/backup-key.pem \
WEV_PG_BIN=/usr/lib/postgresql/17/bin \
  /srv/wevolunteer/bin/verify-restore-postgres.sh \
  /var/backups/wevolunteer/wevolunteer-<stamp>.dump.enc

# Expect: counts match the manifest, foreign keys validated, indexes present,
#         "OK — this archive is proven restorable".

# 2. Only then, and only deliberately, promote it. Stop the app first so
#    nothing writes while the data underneath it changes.
sudo systemctl stop wevolunteer
```

The private key (`WEV_BACKUP_TESTKEY`) is what decrypts the archive. It must
**not** live on this host — if the host is what you lost, so is the key. Keep it
in a password manager; the host only needs the public certificate
(`WEV_BACKUP_PUBKEY`) to encrypt.

Promoting a restore over a live Supabase database is a destructive, irreversible
act on real students' records. It is deliberately not a copy-paste command here;
`docs/operations/backup-and-restore.md` and
`docs/operations/postgres-cutover-and-rollback.md` carry the procedure.

**Rehearse a restore before real users exist.** A backup nobody has restored is
an assumption, not a backup.

## What the job guarantees

- Dumps Supabase over TLS with `pg_dump`, and **compares the client and server
  major versions first**. `pg_dump` refuses a server newer than itself, exits
  non-zero *and leaves a zero-byte file*: a job that checked only a pipeline's
  exit status would compress that, encrypt it, prune the previous generation and
  report success. Hence `WEV_PG_BIN` in the unit — Ubuntu's default client is
  not necessarily the one Supabase needs.
- Verifies the archive parses and carries rows for `users`, `events`,
  `attendance` and `certificates` **before** keeping it; a failure exits
  non-zero, so systemd reports a failed unit.
- Encrypts to `WEV_BACKUP_PUBKEY` (an X.509 certificate, via OpenSSL CMS — not
  `age`) and confirms the ciphertext decrypts back to the original bytes before
  deleting the plaintext. With no key configured it still runs, and warns
  loudly that the archive holds every student's personal data in readable form.
- Prunes only after a successful new backup, so a run of failures cannot age out
  the last good copy.
- Retention is `WEV_BACKUP_KEEP_DAYS` (default 14).

## Alerting

systemd will mark the unit failed, but nothing tells a human. Add whatever your
environment uses, e.g. an `OnFailure=` drop-in:

```bash
sudo systemctl edit wevolunteer-backup.service
# [Unit]
# OnFailure=your-alert-unit@%n.service
```

At minimum, check `systemctl list-timers` and the newest file in
`/var/backups/wevolunteer` during the first week.
