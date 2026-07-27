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

Both files assume the runbook's layout: code at `/srv/wevolunteer`, database at
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
verified: users=14 credited_hours=3.0 certificates=1
wrote /var/backups/wevolunteer/wevolunteer-20260727T030000Z.db.gz ( 12K)
pruned backups older than 14 days
OK
```

Confirm the schedule is armed and see when it next fires:

```bash
systemctl list-timers wevolunteer-backup.timer
```

## Restore

The full procedure — including verifying the restored file **before** starting
the service — is in the runbook under *Backup strategy → Restore procedure*.
The short form:

```bash
sudo systemctl stop wevolunteer
sudo -u wev mv /var/lib/wevolunteer/wevolunteer.db /var/lib/wevolunteer/wevolunteer.db.pre-restore
sudo -u wev sh -c 'gunzip -c /var/backups/wevolunteer/wevolunteer-<stamp>.db.gz > /var/lib/wevolunteer/wevolunteer.db'
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA integrity_check;'   # expect: ok
sudo systemctl start wevolunteer
```

**Rehearse a restore before real users exist.** A backup nobody has restored is
an assumption, not a backup.

## What the job guarantees

- Uses SQLite's online `.backup` API, so it is safe against a running server and
  correctly captures the WAL. A plain `cp` of the `.db` does not — it produces a
  file that opens without error and is missing recent writes.
- Integrity-checks each backup **before** keeping it; a failed check deletes the
  file and exits non-zero, so systemd reports a failed unit.
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
