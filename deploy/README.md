# Deployment units

Files here are installed onto the production host. They are not used in
development and nothing in the application reads them.

| File | Purpose |
|---|---|
| `wevolunteer.service` | The main systemd service for the application |
| `wevolunteer.env.example` | Template for server secrets (copied to `/etc/wevolunteer/wevolunteer.env`) |
| `wevolunteer-backup.service` | Runs `bin/backup-postgres.sh` once |
| `wevolunteer-backup.timer` | Fires the service nightly at 03:00 |
| `wevolunteer-cf-ip-refresh.sh` | Rebuilds the Cloudflare allowlist in the host firewall |
| `wevolunteer-cf-ip-refresh.service` | Runs the refresh once |
| `wevolunteer-cf-ip-refresh.timer` | Fires it weekly, Monday 05:00 plus up to 2h of jitter |
| `make-release.sh` | Builds a release archive from a committed tree and ships it |
| `provision.sh` | Idempotent host provisioning; `audit` first, always |

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

Every scheduled job on this host reports to a **Better Stack heartbeat** — a
dead man's switch, which is the only kind of check that notices a job that
never ran:

| Heartbeat | Pinged by | On failure | Configure in Better Stack |
|---|---|---|---|
| `BACKUP` | `wevolunteer-backup.service` after a verified archive (`ExecStartPost=`) | `OnFailure=` reports `/fail` | every 1 day, grace 2 h |
| `CF_REFRESH` | `wevolunteer-cf-ip-refresh.service` after a successful refresh | `OnFailure=` reports `/fail` | every 7 days, grace 1 day |
| `HOST` | `wevolunteer-host-check.timer`, every 15 min | the check reports `/fail` with its findings | every 15 min, grace 15 min |

`HOST` checks disk (≥ 90%), memory (< 5% available), `wevolunteer` and `nginx`
being active, restart loops (≥ 3 restarts between checks), `/ready`, the origin
certificate (< 21 days), and the newest backup (> 26 hours).

The URLs live in `/etc/wevolunteer/heartbeats.env` (0640 root:wev), created from
`deploy/heartbeats.env.example` by `provision.sh app`. They are **unset until a
human fills them in**; until then each job runs normally and logs that it is not
monitored. `deploy/wevolunteer-heartbeat.sh` always exits 0, so a monitoring
outage can never fail a backup.

Tested by running both scripts against fake `curl`, `systemctl`, `df` and
`openssl` (`server/deploy.heartbeats.test.js`). systemd's own behaviour —
`OnFailure=`, `ExecStartPost=` ordering — needs the host: after filling in the
file, run `sudo systemctl start wevolunteer-host-check.service` and confirm the
heartbeat turns green, and `sudo systemctl start wevolunteer-heartbeat-fail@wevolunteer-backup.service`
once to confirm a failure alert reaches a person.

---

## Cloudflare origin allowlist

Installed by `sudo ./deploy/provision.sh cloudflare-firewall`. **Run it only
after DNS is proxied through Cloudflare and a real Origin CA certificate is
installed.** Run it earlier and you cut the origin off from the only thing
allowed to reach it.

### What problem it solves

With a proxied DNS record, visitors reach Cloudflare and Cloudflare reaches the
origin. Nothing stops somebody who learns the origin IP from skipping that first
hop. That matters beyond "they can see the site": nginx trusts
`CF-Connecting-IP` to identify the real client, so a direct caller can *choose*
the header's value and pick which rate-limit bucket to spend. The allowlist is
what makes trusting that header sound.

### The layer this changes

Host `iptables`/`ip6tables` only, persisted by `netfilter-persistent` — the same
mechanism the Oracle image already uses. **Not ufw**, which is not installed and
would add a second, competing set of chains. Nothing here touches the OCI
Security List; that is a separate filter in front of the host, editable only
from the Oracle Console or CLI.

Two chains are added, `CF-HTTPS` and `CF-HTTPS6`, each holding one `ACCEPT` per
published Cloudflare range followed by a terminal `DROP`. A single `INPUT` rule
jumps to them for `state NEW --dport 443`. Everything else in `INPUT` — port 22,
loopback, `ESTABLISHED,RELATED`, ICMP, port 80, and Oracle's `InstanceServices`
chain — is never addressed and therefore never disturbed.

`DROP`, not `REJECT`, is deliberate: silence makes origin discovery by scanning
slower and never confirms the host is listening.

### Why port 80 stays open

The scope of this change is 443. Port 80 serves only a 301 to HTTPS. Closing it
too is defensible, but it is a separate decision and is not made here.

### The weekly refresh, and why it exists

Cloudflare adds ranges. A range the firewall does not know about is silently
dropped, which reaches visitors as an intermittent Cloudflare **522** — a
timeout that looks like application trouble and sends you debugging the wrong
thing. `wevolunteer-cf-ip-refresh.timer` re-fetches weekly.

Each run:

1. Fetches `cloudflare.com/ips-v4` and `ips-v6`, retrying three times.
2. Validates every entry: strict CIDR parse, correct family, count within sane
   bounds, and **no prefix broader than `/8` (v4) or `/19` (v6)** — a truncated
   or tampered response yielding `0.0.0.0/0` would otherwise silently undo the
   entire allowlist.
3. Diffs against what is live. **If nothing changed it exits without touching
   the firewall.**
4. Snapshots both tables to `/root/fw-backup/` (ten retained).
5. Builds complete replacement chains, unreferenced, then checks their rule
   count and terminal `DROP` before going near `INPUT`.
6. Swaps with a single `iptables -R` on the existing jump — one rule replaced in
   place, so there is no instant where 443 has no rule at all.
7. **Verifies `https://app.wevolunteers.org/health` returns 200 through
   Cloudflare.** Only then are the old chains retired and the new ones renamed
   into place.
8. Persists with `netfilter-persistent save`, then re-checks health.

### Rollback

**Automatic.** The old chain is deliberately *not* deleted before the health
check passes, so rollback is a second `iptables -R` back onto a chain that is
still resident — no restore, no flush, and the previous ranges are live again
immediately. The script then removes its own `-new` chains and exits non-zero.

**Manual**, if you need to undo a run after the fact:

```bash
sudo iptables-restore  < /root/fw-backup/rules.v4.<timestamp>
sudo ip6tables-restore < /root/fw-backup/rules.v6.<timestamp>
sudo netfilter-persistent save
```

To drop the restriction entirely and return 443 to the whole internet:

```bash
sudo systemctl disable --now wevolunteer-cf-ip-refresh.timer
sudo iptables -R INPUT "$(iptables -L INPUT -n --line-numbers | awk '$2=="CF-HTTPS"{print $1}')" \
     -p tcp -m state --state NEW --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### Failure modes, and what each does

| Failure | Behaviour |
|---|---|
| Cloudflare endpoint unreachable | Three retries, then exit non-zero. **Firewall untouched.** A stale-but-working allowlist beats a broken one. |
| Response fails validation | Exit non-zero before any firewall call. |
| New chain fails its structural check | Exit non-zero; the jump still points at the old chain. |
| Health check fails after the swap | Automatic rollback, exit non-zero. |
| `netfilter-persistent save` fails | Rollback rather than leave the boot configuration disagreeing with the live rules. |

The unit exits non-zero on failure on purpose, so `systemctl --failed` shows it.
A job that quietly exits 0 for six months while the allowlist rots is the exact
failure this is meant to prevent. **There is no alerting on this unit until you
add it**, for the same reason the backup unit says so — see *Alerting* above and
use the same drop-in pattern.

### What is and is not tested

`server/deploy.cloudflareFirewall.test.js` is a **static** test. It reads these
files and asserts the properties that make the design safe — validation bounds,
terminal `DROP`, atomic `-R` swap, health check before commit, rollback before
failure, no flush, `ProtectSystem=strict`, the timer's schedule and jitter, and
that `provision.sh` installs everything with the right mode and owner. It runs
no firewall commands and proves nothing about runtime packet handling.

The runtime behaviour was exercised against the live host on 2026-09-13: the
no-op path, a real range change, an unreachable-endpoint run (firewall checksum
identical before and after), and a forced health-check failure that rolled back
to the exact prior chain. Those results are recorded in the deployment history,
not reproduced by `npm test`.

---

## Shipping a release

Production is **not** a git checkout, and should not become one.

The runbook used to say `git clone <your-remote-url> /srv/wevolunteer`. For a
private repository that puts a deploy key or access token on the public-facing
host — a credential that is never used at runtime, because nothing in the
application reads git metadata. `/health` takes its version from
`server/package.json`. A credential that does nothing but sit there is a
credential that exists only to be stolen.

So a release is an archive of a **committed** tree, stamped with the commit it
came from:

```bash
./deploy/make-release.sh --to ubuntu@<host> -i ~/path/to/ssh-key
```

Then on the host:

```bash
sudo /srv/wevolunteer/deploy/provision.sh app
sudo /srv/wevolunteer/deploy/provision.sh verify
```

To produce a tarball instead of shipping directly, omit `--to`. To ship a tag
rather than `HEAD`, pass `--ref v1.2.0`.

### Why the archive is safe to ship

`git archive` emits **tracked files only**. `.env` is ignored, so it is
structurally impossible for it to appear in a release — there is no exclusion
list to maintain and nothing to forget. The script checks the built artifact for
`.env`, `.pem` and private-key filenames anyway, and refuses to send one that
contains them: "structurally impossible" is worth testing once per release.

It also refuses to build from a **dirty working tree**. `git archive` ships what
is committed, so a release built beside uncommitted fixes would silently not
contain them — which is precisely the 2026-07-30 failure the release checklist
exists to prevent. `--allow-dirty` overrides it and states plainly which changes
are being left out.

The host needs no git remote, no deploy key, and no `git` binary.

### How provisioning knows what is deployed

`provision.sh` resolves identity in this order, and never fails:

1. `.deployed-sha` — written into the archive by `make-release.sh` → `release <sha> (archive)`
2. git metadata, if a checkout happens to be there → `checkout <sha> on <branch>`
3. otherwise → `unknown`

The stamp wins when both exist, because it records what was deliberately
*shipped*; a checkout's `HEAD` only records what someone last fetched into the
directory.

`provision.sh app` requires `package.json` and `package-lock.json` — what
`npm ci` actually needs. It does **not** require `.git`. The old check was a
proxy for "did somebody put the code here", and it rejected the only deployment
form production uses, creating pressure to put a credential on the host purely
to satisfy it.

Both forms are exercised by `server/deploy.provisioning.test.js`, which sources
`provision.sh` and calls the real functions against fixture directories — one
stamped archive, one git checkout, one empty.
