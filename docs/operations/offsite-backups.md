# Off-site backups — Backblaze B2

The nightly PostgreSQL backup produces a verified, encrypted archive on the host
that takes it. That protects against a bad migration and an accidental `DELETE`.
It does not protect against losing the host, losing the Oracle tenancy, or losing
access to the Supabase project — which are the scenarios a restore is most often
actually needed for.

This document is the other half: a second copy, somewhere else, that has been
proven to come back.

| Piece | Where |
|---|---|
| Nightly backup, encryption, pruning | `bin/backup-postgres.sh` |
| Upload and verification | `bin/backup-offsite.mjs` |
| The S3/SigV4 client | `bin/lib/object-store.mjs` |
| Recovery — fetch an archive back | `bin/backup-fetch.mjs` |
| Weekly drill — decrypt, restore, compare | `bin/restore-drill-postgres.sh` |
| Carrying the drill's verdict to the host | `bin/backup-drill-publish.mjs` |

---

## 1. Why Backblaze B2 and not Cloudflare R2

R2 was the original plan and was dropped for one reason: **it has no spending
cap.** It has notifications, which tell you afterwards. For a project whose
entire infrastructure budget is zero, "we will email you once you owe money" is
not a budget control.

B2's caps are enforced. A breached cap is refused, not billed:

```
HTTP 403  storage_cap_exceeded
          "Cannot upload files, storage cap exceeded."
HTTP 403  download_cap_exceeded
```

Caps reset at midnight US/Pacific. This is the whole reason for the platform
choice, so `bin/lib/object-store.mjs` classifies those three codes separately
from a credential refusal — they are the same HTTP status, and an operator who
reads "access denied" spends the morning re-issuing a key that was never the
problem. They are never retried: nothing before midnight changes the answer.

Two other B2 facts shape the client, and neither is optional:

- **The region must be real.** SigV4's credential scope must name the bucket's
  region — the `us-west-004` in `s3.us-west-004.backblazeb2.com`. R2 accepts
  `auto`; B2 validates it inside the signature. The R2 client this replaced
  hardcoded `auto`, which means it could never have authenticated to B2 at all.
- **B2 rejects `x-amz-checksum-sha256`** ("Unsupported header"). Integrity is
  carried by the two mechanisms B2 does verify on receipt — `x-amz-content-sha256`,
  which is part of the signature, and `Content-MD5` — plus the SHA-256 written
  into object metadata and re-checked on download.

---

## 2. Retention: 28 days, daily, no tiering

### The decision

One lifecycle rule. One copy per night. Nothing promoted to weekly or monthly.
Objects are gone 28 days after upload.

### Why not shorter

**The weekly drill is what makes a short window safe, and 28 days is four drills.**
Silent corruption is the failure retention exists for, and the drill is what
detects it — a restore that compares row counts, foreign keys and the migration
version against the manifest. With a weekly drill, corruption surfaces within
seven days. Retention then has to cover detection (7 days) plus the time somebody
takes to act, with enough margin that a missed drill does not consume the whole
budget. Four drill cycles means four independent chances to catch a bad archive
before the last good one ages out.

It also has to cover the longest stretch when nobody is looking. This is a school
platform: a two-week winter break, plus a weekend, plus a few days for a student
to notice their hours are wrong and say so, is comfortably inside 28 days and
outside 14.

And — counter-intuitively — **a shorter window can cost more than a longer one.**
B2's free egress allowance is *three times your average stored data*. Shrinking
retention shrinks the allowance while the downloads stay the same:

| Retention | Stored | Free egress/mo | Actual egress/mo | Within free? |
|---|---|---|---|---|
| 7 days | ~1.4 MB | ~4.2 MB | ~6.9 MB | **No** |
| 14 days | ~2.8 MB | ~8.4 MB | ~6.9 MB | Yes, 1.2× margin |
| **28 days** | **~5.6 MB** | **~16.8 MB** | **~6.9 MB** | **Yes, 2.4× margin** |

### Why not longer

The Data Deletion Policy says deletion is **immediate** — "There is no waiting
period and no grace period." A backup holds the pre-deletion record for the
retention window regardless, which is ordinary and defensible, but it is the
reason the window should not drift upwards without somebody deciding it should.

The binding number is the guardian commitment in the Privacy Policy and the Data
Deletion Policy: a guardian's request is acknowledged within **10 business days**
and **completed within 45 days**. If the deletion is performed on day *D* and
backups hold it for *R* more days, completion is not real until *D + R ≤ 45*. At
`R = 28` that leaves `D ≤ 17`, which covers the full acknowledgement window with
slack. At `R = 45` it leaves none at all.

> **A correction to an earlier reading.** Notes from the design of this system
> described the privacy policy as "guaranteeing deletion within 45 days" and
> treated 45 days as a general ceiling. It does not. The 45 days is the
> *guardian-request completion SLA*; separately, hours, certificates and safety
> reports are kept **indefinitely** by deliberate published decision, messages for
> 3 years, audit logs for 1 year, export archives for 7 days. Nothing in the
> published policies mentions backups at all. The 45-day ceiling still binds, but
> through the guardian SLA, not through a general deletion guarantee — and it
> binds `D + R`, not `R` alone.

### Why not daily + weekly + monthly

Tiering exists to save money. Here it saves nothing — storage is 0.06% of a free
tier — and costs a second lifecycle rule, a promotion step that can fail
silently, and a recovery procedure with more than one place to look. The smallest
policy that gives an appropriately strong window is the right one.

### Configuring it

B2 lifecycle rules are **two-stage**, and this is the detail that gets retention
wrong if you assume S3-style "expire after N days":

```
day 0                          file uploaded
day daysFromUploadingToHiding  file hidden   (applies to ALL versions, current included)
day  + daysFromHidingToDeleting  file deleted
```

Total retention is the **sum**. For 28 days:

```json
[{ "fileNamePrefix": "wevolunteer/backups/postgres/",
   "daysFromUploadingToHiding": 27,
   "daysFromHidingToDeleting": 1 }]
```

`bin/backup-offsite.mjs` audits this every night against `WEV_OFFSITE_MAX_AGE_DAYS`
(33) by listing **every version, hidden ones included** — a lifecycle rule that
silently stopped working keeps deleted students' records for ever, and a listing
of current objects would report them as gone.

---

## 3. Object Lock: governance, 7 days — deliberately much shorter than retention

Enabled, in **governance** mode, with a **7-day** default bucket retention.

The counter-intuitive part is that a longer lock is *not* safer. Backblaze:

> "When a file is locked, lifecycle settings or an integration setting attempting
> to change or delete the file will fail."

A lock that reaches the lifecycle window does not protect the archives, it makes
them **permanent**: every expiry is refused, storage grows without bound, and
deleted students' records stay off-site indefinitely. The invariant is therefore
`0 < lockDays < retentionDays`, and `bin/backup-offsite.mjs` warns
`lock-blocks-expiry` when it is violated — checked first, because it is the
direction that fails silently.

**What the lock actually buys — and what it does not, on this deployment.** In
the least-privilege design the primary control is key scoping: a writer key with
no `deleteFiles` cannot delete anything even if the
host is fully compromised. The lock is defence in depth against the narrower case
— a key created later with more capability than it needed, or the master key used
by accident. Seven days blocks a deletion during the window in which one would
certainly be noticed (daily backups, a weekly drill), and governance rather than
compliance means a genuine emergency purge is still possible with the master key.

**On this deployment the lock is the only one of the two controls that holds.**
The production credential carries both `deleteFiles` and `bypassGovernance`, so
it can delete a locked object outright — measured, not assumed. The lock still
stops a lifecycle misfire, an accident from a differently-scoped credential, and
anyone who obtains a key without `bypassGovernance`; it does not stop whoever
holds the production credential. §4 records why that trade was made.
Compliance mode was rejected: it cannot be undone by anyone, so a misconfiguration
is permanent, and that is a worse failure than the one it prevents.

---

## 4. Keys: three, each able to do one job

B2 application keys can be restricted to a bucket and to a name prefix. Use both.

| Key | Capabilities | Lives | For |
|---|---|---|---|
| `wev-backup-writer` | `listFiles`, `readFiles`, `writeFiles`, `readFileRetentions` | `/etc/wevolunteer/wevolunteer.env` on the host, mode 0600 | The nightly upload and its verification |
| `wev-backup-recovery` | `listFiles`, `readFiles` | The operator's password manager **only** | Rebuilding after the host is lost |
| `wev-drill` | `listFiles`, `readFiles`, plus `writeFiles` restricted to prefix `wevolunteer/backups/postgres/drills/` | The operator's drill machine | The weekly drill and publishing its verdict |

> ### The credential must be an APPLICATION key, not the account master key — 2026-09-20
>
> This is a platform limitation, not a policy one, and it is invisible until the
> first upload. **Backblaze does not support the account master application key
> over the S3-compatible API** — and the S3 API is the only one the backup path
> speaks. The master key authorizes against the *native* API perfectly, so every
> capability and bucket check passes, and then the nightly run fails at its first
> S3 call:
>
> ```
> FAILED (list): GET refused: HTTP 403 InvalidAccessKeyId — Malformed Access Key Id
> ```
>
> Measured on 2026-09-20 with a real master key. The two APIs take different
> credentials; a master key's id is the 12-character account id, and the S3
> endpoint rejects it as malformed.
>
> **This does not conflict with the decision below.** One privileged credential is
> still one credential — it simply has to be created under **App Keys → Add a New
> Application Key** rather than being the master key the account came with. It may
> hold every capability and span every bucket if that is what is wanted.
>
> `bin/b2-audit.mjs` now probes both APIs, because reporting "authorization:
> VERIFIED" for a credential that cannot take a backup is the same false pass
> everything else here is built to avoid.

> ### The owner has chosen a single privileged credential instead — 2026-09-20
>
> **The three-key layout above is not what production runs, and that is a
> decision rather than a gap.** WeVolunteer's owner has deliberately chosen to
> operate the backup path with one highly privileged Backblaze application key.
> The table above remains the least-privilege design and the thing `b2-audit`
> measures against; this note records that the deviation is intentional, owned,
> and not to be "fixed" by anyone who stumbles on it.
>
> **What the decision costs, stated plainly so it can be revisited knowingly.**
> A credential holding `deleteFiles` and `bypassGovernance` can delete backups
> *and* bypass the Object Lock protecting them — demonstrated on 2026-09-14, when
> a `b2_delete_file_version` with `bypassGovernance: true` removed a
> governance-locked object outright. With `writeBucketLifecycleRules` and
> `writeBucketRetentions` it can also switch off the retention policy and the lock
> default. So the two independent controls in §2 and §3 protect the archives from
> accident and from an outsider, but **not** from anyone who obtains this
> credential. The residual risk of the production host being compromised is
> therefore "every backup can be destroyed", not "the attacker reaches
> ciphertext".
>
> **What still holds.** The bucket is private, Object Lock and the lifecycle rule
> are configured and verified, the archives are encrypted to a public key the host
> does not hold the private half of, and the local copy is independent of B2. The
> encryption story is unaffected by this decision — a stolen credential yields
> ciphertext, and destroying backups is loud rather than silent, because the
> nightly audit and the Owner Center both report on what the bucket holds.
>
> **How `b2-audit` reports it.** It does not pass. Run with
> `--accept-privileged` (or `WEV_B2_ACCEPT_PRIVILEGED_CREDENTIAL=1`) it still
> prints every capability finding, still says `least privilege : NOT SATISFIED`,
> and exits **3** — never 0. There is deliberately no flag that makes this
> credential report as a clean pass, because a report nobody can tell apart from a
> genuinely least-privileged one is how an accepted risk becomes a forgotten one.
> Bucket findings are never acceptable and still exit 1.

**In the least-privilege design, no key has `deleteFiles`** — and production
deliberately departs from it (see the box above), so read the next paragraph as
the design's reasoning rather than as a description of the live credential.
Expiry is the lifecycle rule's job. An application
that cannot delete cannot be made to delete, by a bug or by whoever reaches the
host — and `bin/lib/object-store.mjs` implements no delete operation at all, so
there is nothing to call.

The writer needs `readFiles` because it downloads the object back and compares
hashes. An upload that is never read back is not a verified copy; it is a 200
response.

Never: in the React bundle, in Vite config, in `VITE_*` anything, in git, in a
log, in a test fixture, or in a report. `bin/scan-bundle-secrets.mjs` and
`bin/pre-commit-secret-scan.sh` are the automated backstop.

---

## 5. Encryption: format 2 (AES-256-GCM), and the format 1 archives that came before

### What changed, and why it had to

Archives up to 2026-09-13 used `openssl cms -encrypt -aes-256-cbc`, which produces
CMS `EnvelopedData`: confidential, and **not authenticated**. Measured on a real
archive rather than assumed — flip one byte in the middle of a CBC archive and:

```
$ openssl cms -decrypt -binary -inform DER -in tampered.der -inkey key.pem -out out.bin
$ echo $?
0
$ cmp out.bin original.bin
out.bin original.bin differ: byte 100001, line 1     # 17 bytes silently changed
```

Exit 0. A file that differs from the original, and nothing says so. For a backup
that is the worst property there is: a damaged or tampered archive restores into
subtly wrong data — wrong hours, wrong attendance — and the restore reports
success.

Format 2 is `-aes-256-gcm` with `-keyopt rsa_padding_mode:oaep`, which emits CMS
`AuthEnvelopedData` (`id-smime-ct-authEnvelopedData`). Same three attacks, same
key, same command:

| | format 1 (CBC) | format 2 (GCM) |
|---|---|---|
| Byte flipped mid-ciphertext | **accepted, exit 0, output differs** | rejected, exit 4 |
| Truncated | accepted | rejected |
| Wrong private key | rejected | rejected |

### Migration — nothing is stranded

`openssl cms -decrypt` recognises both formats from the same command line, so
**every archive taken before the change still decrypts with exactly the
procedure in §7.** No re-encryption, no dual path, no flag. Format 1 archives
simply age out of the 28-day window on their own, and by 2026-10-11 none remain.

Until then they carry no integrity protection of their own — which is what
`archive_sha256` in the manifest is for. `bin/verify-restore-postgres.sh` checks
the archive against it before decrypting, and refuses if it disagrees.
Manifests written before 2026-09-13 do not record it; those archives cannot be
integrity-checked at all, and that is one more reason not to keep them.

### One operational consequence, and it bites on a Mac

**LibreSSL cannot read `AuthEnvelopedData`.** macOS's `/usr/bin/openssl` is
LibreSSL:

```
$ /usr/bin/openssl cms -decrypt ... -in archive.dump.enc
Error decrypting CMS using private key
error:2EFFF06B:CMS routines:CRYPTO_internal:content type not enveloped data
```

Recovery needs **OpenSSL 3**. Every script takes `WEV_OPENSSL`:

```bash
brew install openssl@3
export WEV_OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
```

Linux distributions ship OpenSSL 3 as `openssl` and need nothing.

---

## 6. The key that matters more than the bucket

> **If the host dies and the private key died with it, the off-site copies are
> unreadable and the data is gone.** B2 does not help. The bucket is full of
> ciphertext nobody can open.

The arrangement, which is already the decided posture:

- `WEV_BACKUP_PUBKEY` — an X.509 **certificate** (not an `age` key; the runbook
  said `age` until 2026-09-06 and that was wrong). On the host. Encrypts only.
- `WEV_BACKUP_TESTKEY` — the matching **private key**. In the operator's password
  manager, and **not on the host**. If `/root/backup-keys/backup-key.pem` exists,
  the host can decrypt every archive and the encryption is decorative.

Generating a pair:

```bash
openssl req -x509 -newkey rsa:4096 -keyout backup-key.pem \
  -out backup-cert.pem -days 3650 -nodes -subj "/CN=wevolunteer-backup"
chmod 600 backup-key.pem
```

**Before removing a private key from anywhere, prove the copy you are keeping
works** — on a machine that is not the host, run
`bin/verify-restore-postgres.sh` against a recent `.dump.enc` with it and see
`OK — this archive is proven restorable`. Only then `shred -u` the other copy.

**Rotation** is add-then-retire, never replace: generate a new pair, encrypt to
the new certificate, keep the old private key until every archive encrypted to it
has aged out of the 28-day window, then destroy it. There is no re-encryption
step and there does not need to be one.

### The 2026-09-24 rotation, and what it found

The pair generated on 2026-09-12 was never put in the password manager. Preparing
the pre-upgrade restore drill, its private half could not be found on the operator
machine — searched by filename *and* by PEM private-key header across the project
tree, Desktop, `~/Documents`, `~/Downloads`, `~/.ssh` and the asset archive. The
only private keys there are the host SSH key, whose public half
(`d97f8dbb…f108ad0`) does not match the certificate (`f61f0162…b6f968`).

**It was on the host**, at `/root/backup-keys/backup-key.pem` — the exact file the
section above says must not exist, because a host that can decrypt its own archives
is a host where the encryption is decorative. Its public half matches the retired
certificate, so the archives were never unreadable; they were readable by anyone
who reached the box, and by nobody who did not. Both failure modes at once: no
operator copy, and a copy in the one place it must not be.

Two archives were decrypted with it and restored into isolated scratch databases —
`wevolunteer-20260912T193009Z` (users=3) and the pre-upgrade
`wevolunteer-20260924T144416Z` (users=4) — both `OK — this archive is proven
restorable`, counts matching their manifests. That is what makes the rollback path
real rather than assumed.

Add-then-retire was followed, with the retire step left to the operator:

1. A new RSA-4096 pair, `CN=wevolunteer-backup`, SHA1
   `9E:47:81:20:8B:4B:20:BF:F6:0A:02:B1:48:AC:BE:94:B7:19:E6:F6`, valid to
   2036-09-21. **The new private key was never placed on the host.**
2. The old certificate kept at `/etc/ssl/wevolunteer-backup.crt.retired-20260924`;
   the new one installed at the path `WEV_BACKUP_PUBKEY` already names, so no unit
   file changed and the nightly job needed no edit.
3. `wevolunteer-20260924T232114Z.dump.enc` taken, fetched, decrypted with the new
   private key and restored into an isolated scratch database — again `OK`.
4. The 2026-09-12 private key is still on the host. It opens archives up to
   `20260924T144416Z` and none after. It should be copied to the password manager
   and then `shred -u`'d from `/root/backup-keys/`, in that order.

**The rule this produces:** generating a pair is not the step that matters, and
neither is a green nightly job. Encryption needs only the certificate, so every
check that runs on the host passes whether or not a usable private key exists
anywhere — the backups look perfect right up until the first restore. The gate is
a restore performed with the copy you intend to keep, from a machine that is not
the host.

### And then it happened again, three days later

The pair from 2026-09-24 (`9E:47:81:…`) was generated into a temporary working
directory and never moved anywhere durable. That directory was cleaned. On
2026-09-27 the private half was gone — from the same machine, for the same
reason, three days after the rule above was written into this file.

Four archives are encrypted to it and cannot be opened: `20260924T232114Z`,
`20260925T030420Z`, `20260926T030409Z` and `20260927T030312Z`. They are
pre-launch — 4 accounts, 0 credited hours, 0 certificates, 0 ledger rows — and
are left to age out of the 14-day window rather than deleted. Archives up to
`20260924T144416Z` are unaffected: their key is still in `/root/backup-keys/`.

Replaced with `50:35:41:A5:D0:C1:77:5A:42:E2:4D:A7:22:62:ED:20:FC:2A:97:77`,
valid to 2036-09-24, **private half at `~/keys/backup-key.pem` on the operator
machine, not on the host and not in a temp directory.**
`wevolunteer-20260927T172224Z.dump.enc` decrypted with it and restored into an
isolated scratch database: counts matching the manifest, migration 68.

**What the first version of this section got wrong:** it treated "the key is
durable" as something you decide, when it is something you verify. A path under
`/tmp`, a scratch directory, a shell that is still open, a file you mean to move
later — each of these is a copy that can be gone before the next backup runs,
with nothing anywhere reporting it. The check is not "did I put it somewhere
sensible", it is `test -f ~/keys/backup-key.pem` *after* a reboot, and a restore
that used that exact path. Until then, treat the backups as unverified no matter
how many times the nightly job logged OK.

### Closed out 2026-09-27

- **The host no longer holds a private key.** `/root/backup-keys/backup-key.pem`
  was copied off, proven by restoring `20260924T144416Z` with the copy being
  kept, and only then `shred -u`'d — the order this document asks for.
  `/root/backup-keys/` now holds the certificate alone, and
  `WEV_BACKUP_TESTKEY` is unset on the host, so the nightly job encrypts and
  cannot decrypt. That is the posture §6 has described since it was written; it
  is now also true.
- **Two operator copies**, `~/keys/` and a second folder beside the SSH keys,
  with a README naming which certificate each one matches and which archives it
  opens. Both are on one disk, so the password manager copy is still the one
  that survives losing the laptop.
- **The BACKUP heartbeat is live**, and the alarm had been ringing the whole
  time. The heartbeat was created in Better Stack on 2026-09-14 (period 1 day,
  grace 2 h, email) and never written into `/etc/wevolunteer/heartbeats.env`.
  It did exactly what a dead man's switch is for: `Missed heartbeat`
  2026-09-15 → 09-20, a manual `fail`/`ok` test on 09-20, then `Missed
  heartbeat` 2026-09-21 19:40 held open for **six days**, resolved only by the
  first run that could finally report. Now configured; the failure path was
  already correct — `OnFailure=` reaches the template, which maps the unit to
  `BACKUP` and reports `fail`, verified by firing that unit on 2026-09-27.

**The correction worth keeping.** The first version of this entry said the
heartbeat "sat `down` and alerted on nothing". That was wrong, and wrong in the
convenient direction: it blamed an absent alarm for a gap that an alarm had in
fact reported, twice, by email, for eleven of the previous thirteen days. The
monitoring was the one part of this system that worked. What failed was that its
output — a `Missed heartbeat` incident sitting open — was never connected to its
cause, which was three lines of missing configuration on the host.

So the lesson is not "add monitoring". It is that an incident nobody closes is
indistinguishable from an incident nobody raised, and the backups were unverified
for the same reason either way. Check for open incidents before concluding a job
is unmonitored; the answer may be that it is monitored and shouting.

---

## 7. Recovery, after losing the host entirely

On any machine with Node 24, OpenSSL 3 and PostgreSQL 17 client tools. Nothing
here needs the old host, the Oracle tenancy, or a database URL.

```bash
# 1. Credentials — the read-only recovery key, from the password manager.
export B2_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
export B2_BUCKET=wevolunteer-bucket
export B2_KEY_ID=...  B2_APPLICATION_KEY=...

# 2. What is there.
node bin/backup-fetch.mjs --list

# 3. Fetch the newest, verified against both the manifest and B2's own metadata.
node bin/backup-fetch.mjs --out ./recovered --latest

# 4. Restore into a scratch cluster and compare it against the manifest.
export WEV_BACKUP_TESTKEY=~/keys/backup-key.pem
export WEV_OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl   # macOS only
bin/verify-restore-postgres.sh ./recovered/wevolunteer-*.dump.enc
```

`backup-fetch.mjs` refuses to hand over anything it cannot vouch for: the archive
must hash to the SHA-256 in its manifest **and** to the one B2 stored with the
object. A file failing either is deleted and the exit code is 1.

### What a restore does and does not reconstruct

`pg_dump` captures the **application database**: schema, data, indexes,
constraints, sequences, functions and triggers in `public`, and the
`schema_migrations` version the drill compares. That is everything WeVolunteer
needs to run.

It is **not** a Supabase project restore. Supabase-managed pieces — the project
itself, its API gateway, connection pooling, auth configuration, and any
`extensions`-schema installation the provider owns — are provisioned, not
restored. Plan for a new project plus this dump, not for the old project
reappearing.

One concrete incompatibility, already handled: Supabase installs `pg_trgm` in the
`extensions` schema; a self-hosted PostgreSQL installs it in `public`. A drill on
2026-09-13 failed with `operator class "public.gin_trgm_ops" does not exist`
because of exactly this. `bin/verify-restore-postgres.sh` now asks the archive
where it expects `pg_trgm` and restores in sections so the extension can be
created between `pre-data` and the indexes that use it.

---

## 8. What gets monitored, and how a failure looks

Three facts, three states, deliberately never collapsed into one "backup OK" —
they fail independently, and a night where only the upload failed leaves a local
archive directory that looks flawless.

| Owner Center row | Source | Green means |
|---|---|---|
| Backups (this host) | the archive directory | A recent nightly archive exists here |
| Off-site copy | `status/offsite.json` | Uploaded, HEAD-verified, **and downloaded back and hashed** |
| Restore drill | `status/restore-drill.json` | A restore actually ran and matched the manifest |

The levels are recorded separately because they are different claims:

```
1 uploaded           B2 accepted it, SHA-256 (signed) and Content-MD5 checked on receipt
2 head-verified      B2 reports the expected size and the SHA-256 we stored
3 download-verified  fetched back; hashes to the local bytes
4 decrypted          the archive B2 holds opens with the recovery key
5 restored           pg_restore --exit-on-error into an empty PostgreSQL 17
6 compared           tables, foreign keys, invariant counts and migration version match
```

1–3 are the nightly job's, on the host. 4–6 are the weekly drill's, on the
operator's machine — see §9.

`server/alerting.js` emails on a failure at either, at most twice a day, with a
subject that distinguishes them. An off-site failure on a host whose nightly
archive is fine does **not** say "Backups are not running": an operator who reads
that, checks the timer and finds it running perfectly learns the alert is noise.

A deliberate local-only deployment (no `B2_*` set) is muted and silent. It is a
choice, not a fault — but it is never shown as an off-site copy that exists.

### The heartbeat, which catches what none of the above can

The three rows are read by the application, so they all share one blind spot: a
failure that happens before the application sees anything. The timer disabled,
the host down at 03:00, the unit killed — the archive directory simply stops
changing, and an alerter running inside that host is not running either.

`wevolunteer-backup.service` closes that from the other side:

```
OnFailure=wevolunteer-heartbeat-fail@%n.service     # the unit ran and failed
ExecStartPost=/usr/local/sbin/wevolunteer-heartbeat.sh BACKUP ok   # it ran and worked
```

Better Stack raises an incident on the explicit failure **and** when the expected
interval passes with no ping at all, which is the case nothing on the host can
report about itself.

**The heartbeat exists** — created 2026-09-14, `WeVolunteer nightly backup`,
id `493230`. Its window is **24 h period + 2 h grace = 26 hours**, deliberately
the same threshold as `BACKUP_STALE_HOURS` in `server/backupStatus.js` and the
runbook's alerting table: three surfaces that each pick their own idea of "late"
is how a dashboard comes to be green while the pager is going off. Two hours
absorbs `RandomizedDelaySec=5m` and a `Persistent=true` catch-up run after a
reboot, without absorbing a genuinely missed night.

The URL carries the heartbeat's token, so it is not written down here. It lives
in the Better Stack console, and `deploy/wevolunteer-heartbeat.sh` refuses any
URL that is not `https://uptime.betterstack.com/api/v1/heartbeat/…`, so a pasted
wrong value cannot send job output somewhere else.

**Installing it** — on the host, as root:

```bash
printf 'HEARTBEAT_URL_BACKUP=%s\n' '<url from the Better Stack console>' \
  >> /etc/wevolunteer/heartbeats.env
chown root:wev /etc/wevolunteer/heartbeats.env && chmod 0640 /etc/wevolunteer/heartbeats.env
systemctl start wevolunteer-backup.service     # the ping proves the whole path
```

Until that line exists, `wevolunteer-heartbeat.sh` logs that the job is
unmonitored and **exits 0** — deliberately, because a heartbeat that could fail
its parent would turn a monitoring outage into a failed backup. The backup still
runs and the Owner Center still reports; nothing outside the host is watching.

### Runaway guards

| Guard | Default | On breach |
|---|---|---|
| `WEV_OFFSITE_MAX_BYTES` | 250 MB | Refuses to upload. Uploads are immutable for the lock window, so an unexpectedly large object is refused rather than stored |
| `WEV_OFFSITE_MAX_UPLOADS_PER_DAY` | 4 | Refuses. Stops a job running in a loop; `WEV_OFFSITE_FORCE=1` allows one deliberate extra run |
| `WEV_OFFSITE_MAX_TOTAL_BYTES` | 5 GB | Warns |
| `WEV_OFFSITE_MAX_AGE_DAYS` | 33 | Warns — the lifecycle rule is missing or not working |

None of these deletes anything. A suspicious archive is preserved as evidence and
reported; automatic cleanup of the thing you do not yet understand is how the
evidence disappears.

---

## 9. The weekly drill — and why it must not run on the host

**It runs on the operator's machine. There is deliberately no systemd unit.**

The drill has to decrypt, so it needs the private key. Installing that on the host
to automate a weekly drill would hand every archive to anyone who reaches the
host, including the off-site ones, and make the encryption decorative.

Running it off the host is also the better drill: it fetches from B2, so the path
exercised every week is exactly the path a real disaster uses — a machine that is
not the host, reaching the off-site copy, with a key from the password manager. A
drill on the host would prove the one recovery that does not need to work.

```bash
WEV_BACKUP_TESTKEY=~/keys/backup-key.pem \
WEV_OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl \
WEV_DRILL_LABEL=ops-laptop \
B2_S3_ENDPOINT=... B2_BUCKET=... B2_KEY_ID=... B2_APPLICATION_KEY=... \
bin/restore-drill-postgres.sh
```

It restores into a throwaway cluster in a private temporary directory listening
on a unix socket only — no TCP port at all — and deletes it afterwards. It never
reads `DATABASE_URL`; it `unset`s it. That is the strongest form of "never restore
over production" available.

Its verdict is published to `wevolunteer/backups/postgres/drills/latest.json` and picked
up by the next nightly run, so the Owner Center on the host can show it. The
object is rebuilt field by field rather than forwarded, so nothing added to the
local record later is published without somebody deciding it should be. A failure
is published the same way — it is the one the host most needs to hear.

---

## 10. Cost

Measured production figures, September 2026 — **re-measure before relying on
these**: database ~14 MB, application schema ~2.5 MB, encrypted archive ~200 KB,
nightly run ~3 seconds.

| | Per month | B2 price | Cost |
|---|---|---|---|
| Storage (28 × ~201 KB) | ~5.6 MB | $6.95/TB/mo, **first 10 GB free** | $0 |
| Class A (uploads) | ~60 | free on pay-as-you-go | $0 |
| Class B (downloads, HEAD) | ~160 | free on pay-as-you-go | $0 |
| Class C (listings) | ~60 | free on pay-as-you-go | $0 |
| Class D | 0 — none used | $0.004/10k, 2,500/day free | $0 |
| Egress | ~6.9 MB | free up to 3× stored (~16.8 MB) | $0 |

**Headroom:** 5.6 MB is 0.06% of the free tier. The database would have to grow
roughly **1,800×** before 28-day retention touched 10 GB.

**Can $0 be guaranteed?** Yes — but by the cap, not by the free tier. The free
tier means nothing is *expected* to be billable; the enforced cap is what makes it
*guaranteed*, because B2 refuses rather than bills. A new account has **no caps by
default**: "If you do not set up data caps, your Backblaze B2 Cloud Storage
account usage is unlimited, and unlimited charges can accrue."

**So the first thing to do after creating the bucket is set the caps.** Caps &
Alerts → set the daily storage, download and transaction caps to $0 (or the
lowest the console accepts) and the alert thresholds to 75%/100%. Until that is
done, "$0" is a forecast and not a guarantee. No credit card is required for the
free tier.

---

## 11. Setting it up, once

1. Create the account. **Set the caps first** (§10).
2. Create a **private** bucket — the live one is `wevolunteer-bucket` — with **Object Lock
   enabled at creation** — it cannot be added later — and a default governance
   retention of **7 days** (§3).
3. Add the lifecycle rule from §2: prefix `wevolunteer/backups/postgres/`, hide 27,
   delete 1.
4. Create the three application keys from §4. Each is shown **once**.
5. Put the writer key on the host in `/etc/wevolunteer/wevolunteer.env`:
   ```
   B2_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
   B2_BUCKET=wevolunteer-bucket
   B2_KEY_ID=...
   B2_APPLICATION_KEY=...
   ```
   All four or none. A half-configured destination is refused rather than skipped,
   because silently skipping the upload is how an operator comes to believe
   off-site copies exist that do not.

   **Four variables, and no fifth.** `B2_PREFIX` exists but must NOT be set here.
   The canonical prefix ships in the code (`DEFAULT_PREFIX`) precisely so that a
   recovery machine can find the archives with nothing but these four credentials
   from the password manager — in a real disaster the host's environment file is
   the thing that was lost. A `B2_PREFIX` set only on the host would leave
   `bin/backup-fetch.mjs` on a clean laptop listing the wrong place and printing
   `the bucket holds no archives`, which is a false "there is no backup" on the one
   day that sentence is read literally. Use it only for a deliberately different
   layout — a second deployment sharing one bucket, or a migration — and when you
   do, put it on the recovery machine too.
6. Put the other two keys in the password manager, with the backup private key.
7. Run one backup by hand and read the log to the end. Then run the drill from
   §9 and see it pass from the `offsite` copy.
8. Confirm the Owner Center shows all three rows green.

---

## 11a. Why there are not three keys

**Superseded 2026-09-20 by an owner decision: production uses one highly
privileged credential.** See the box in §4 for what that costs and what still
holds. This section is kept because the reasoning below is what makes the
decision a choice rather than an accident, and because it is the procedure to
follow if the decision is ever revisited.

An application key cannot mint another one unless it holds `writeKeys`. A scoped
writer does not, which is why `b2-audit` lists `writeKeys` as over-privileged —
a backup writer that can create keys makes every other limit on it advisory. So
scoped keys are created in the Backblaze console, by a person.

> **A correction worth keeping.** The first version of this section asked for a
> drill key restricted to `wevolunteer/backups/postgres/drills/` and expected it
> to fetch archives from `…/daily/`. A Backblaze key carries **one `namePrefix`,
> applying to every capability it holds** — there is no per-capability prefix.
> Confine it to `drills/` and it cannot read the archive it is meant to drill;
> let it read `daily/` and it is not confined at all. The key as specified cannot
> exist. Anyone following that table would have created it, watched the drill
> fail, and widened the prefix until it worked — ending with exactly the
> unrestricted key the section existed to prevent.

Were the three-key layout adopted, it would be **App Keys → Add a New
Application Key**, three times:

| Key name | Bucket | File name prefix | Capabilities | Lives |
|---|---|---|---|---|
| `wev-backup-writer` | `wevolunteer-bucket` | *(none)* | Read Files, Write Files | host env file |
| `wev-backup-recovery` | `wevolunteer-bucket` | *(none)* | **Read Files only** | password manager, and the drill machine |
| `wev-drill-publish` | `wevolunteer-bucket` | `wevolunteer/backups/postgres/drills/` | Read Files, Write Files | drill machine, as `B2_DRILL_*` |

with `readFileRetentions` included in the writer's read group (or the nightly job
cannot see the Object Lock and reports `lock-not-observed` for ever), no Delete
Files on any of them, nothing bucket-level or key-level, and the drill machine
holding the recovery key for fetching alongside its confined write key. Each
would be verified by `node bin/b2-audit.mjs --role=writer|recovery|drill`.

**What is not optional either way:** deleting a credential that has been exposed.
Creating replacements revokes nothing. On 2026-09-14 replacement keys were
reported as created while the exposed one still authorized with all 26
capabilities; it was confirmed deleted on 2026-09-20, when
`b2_authorize_account` began answering `401 unauthorized`. A rotation is not
finished until the old key is refused.

## 12. What has been verified, and what has not

Honesty about this is the point of the document.

### The drill that was actually run — 2026-09-13

Not a unit test: the real scripts, a real PostgreSQL 17 cluster, the real
OpenSSL, a 70-table WeVolunteer schema at migration 67 with synthetic data, and
the archive travelling through the object store before coming back.

```
source cluster    PostgreSQL 17.9, pg_trgm installed in `extensions`
                  (Supabase-shaped on purpose — see §7)
                  70 tables · 193 indexes · migration 67
                  40 users · 300.00 credited hours · 25 certificates · 120 ledger rows

bin/backup-postgres.sh
  live: users=40 credited_hours=300.00 certificates=25 ledger=120 migration=67
  verified: archive parses and carries data for users, events, attendance, certificates
  wrote wevolunteer-20260914T012300Z.dump (196K)
  encrypted to wevolunteer-20260914T012300Z.dump.enc (200K)
  uploaded wevolunteer/backups/postgres/daily/2026/09/14/...dump.enc (201327 bytes)
  verified: B2 reports the expected size and SHA-256
  verified: downloaded copy is byte-identical (SHA-256)

bin/restore-drill-postgres.sh   (WEV_DRILL_SOURCE=offsite)
  fetched ...dump.enc (201327 bytes), SHA-256 verified against manifest and B2 metadata
  archive expects pg_trgm in: extensions
  restore completed with no errors
  restored: users=40 credited_hours=300.00 certificates=25 ledger=120 migration=67
  verified: restored counts match the manifest exactly
  verified: 96 foreign keys (all validated), 193 indexes
  OK — restore drill passed from the offsite copy in 2s
```

All six levels, from the off-site copy, on a cluster that did not exist when the
backup was taken. The ~200 KB figure in §10 is this measurement, not an estimate.

**Then the same archive was attacked**, with the restore refusing each time:

| Attack | Result |
|---|---|
| One byte flipped mid-ciphertext | refused — `SHA-256 does not match its manifest` |
| The same flip, **with the manifest's SHA-256 rewritten to agree** | refused — `Error decrypting CMS structure` |
| Truncated by 2 KB | refused — SHA-256 mismatch |
| Wrong private key | refused — `Error decrypting CMS structure` |
| Control: untouched archive | `OK — this archive is proven restorable` |

The second row is the one that matters, and it is the whole case for format 2:
the manifest hash was forged to match the tampered bytes, so only the AEAD tag
stood between a corrupted archive and a "successful" restore — and it held. The
same file in format 1 would have restored, exit 0, into silently altered data.

**And the rule that outranks the rest was proven end to end.** With
`WEV_BACKUP_KEEP_DAYS=0` and the only good archive dated 2025-01-01 — so any
prune at all would have taken it — the destination was killed mid-run:

```
retrying listing (attempt 1 failed: ... ECONNREFUSED; waiting 177 ms)
retrying listing (attempt 2 failed: ... ECONNREFUSED; waiting 1321 ms)
retrying listing (attempt 3 failed: ... ECONNREFUSED; waiting 1919 ms)
FAILED (list): GET failed before a response: ECONNREFUSED
FAILED: the off-site copy failed — the local archive is kept at ... and nothing was pruned
```

Both archives survived, the retry was bounded at four attempts over ~4 seconds,
`lastVerified` still named the last proven off-site copy, and the Owner Center
read `local: ok · off-site: failed · overall: failed` — the exact case that used
to report healthy backups.

### Verified, locally, against a server that refuses what B2 documents refusing

(`bin/lib/fake-b2.mjs` recomputes SigV4 independently, checks the payload hash and
`Content-MD5`, enforces capabilities per operation, keeps versions, and refuses
`x-amz-checksum-*`):

- The SigV4 chain against AWS's own published test vector.
- Upload → HEAD → download → hash comparison, idempotent re-runs, and refusal to
  write a second differing version under an existing name.
- Failure classification: wrong key, wrong region, missing capability, spending
  caps, timeouts, a connection destroyed mid-request, a refused connection, a name
  that does not resolve, clock skew, `BadDigest`.
- That a failed night prunes nothing, deletes nothing, keeps the local archive,
  and preserves the last verified record.
- That the encryption change does what §5 claims — tested against real archives
  with a real key, including the CBC tamper case.

### Against the real Backblaze account — 2026-09-14

The previous revision of this section said no request had ever reached
`backblazeb2.com`. That is no longer true. Bucket `wevolunteer-bucket`,
region `us-east-005`, one key:

| Claim | How it was settled |
|---|---|
| Upload | `bin/backup-postgres.sh` end to end; 201,471 bytes at `wevolunteer/backups/postgres/daily/2026/09/14/…dump.enc` |
| Download | fetched back and hashed; byte-identical to the local archive |
| Restore | `bin/restore-drill-postgres.sh` with `WEV_DRILL_SOURCE=offsite` — decrypted, restored into a scratch PostgreSQL 17, **70 tables, 96 validated foreign keys, 193 indexes**, counts and migration version matching the manifest |
| Recovery from nothing | `env -i` with only the four credentials listed and fetched the archive; SHA-256 matched the recorded one |
| Object Lock, per object | archive **and** manifest both `governance`, `retainUntil` exactly **7.00 days** after upload, read back through Backblaze's own API rather than our S3 header parsing |
| Object Lock, enforced | an ordinary `b2_delete_file_version` on a locked object was **refused** (`401 access_denied`) |
| Object Lock, immutability | overwriting the key created a **new version**; the locked original survived with its bytes and its retention intact |
| Lifecycle | rule present on `wevolunteer/backups/postgres/`, hide 27 + delete 1 = **28 days**, read back from `b2_list_buckets` |
| Lock/lifecycle compatibility | lock 7 d < hide 27 d, so no expiry can be refused for being locked |
| Failure behaviour | a real Backblaze refusal (`404 NoSuchBucket`) with `WEV_BACKUP_KEEP_DAYS=0` and the only good archive dated 2025-01-01: the run failed, **nothing was pruned**, `lastVerified` still named the last proven copy, and the Owner Center read local `ok` / off-site `failed` / overall `failed` |

**Both bucket settings were absent when first inspected** — Object Lock enabled
with a null default retention, and an empty lifecycle rule set. They were applied
while the bucket was still empty, which is the only free moment either has. This
is what `bin/b2-audit.mjs` now exists to catch.

**Still not verified:**

- **Key scoping.** One over-privileged key, not three scoped ones — see the box
  in §4. `bin/b2-audit.mjs` reports five findings against it today.
- **The spending caps.** There is no public API that reports them, so they cannot
  be confirmed from here at all; the console is the only place. Until they are
  set, "$0" is a forecast rather than the guarantee B2 was chosen to provide
  (§10). Nothing in this verification exceeded the free tier: ~200 KB stored, and
  Class A/B/C calls only, all free on pay-as-you-go.
- **Lifecycle expiry actually happening.** The rule is confirmed present and
  correctly shaped, and the semantics are Backblaze's documented ones, but no
  object has yet reached 27 days. The first real expiry is 2026-10-12.
- **Production timings at real scale;** §10's figures are from a ~14 MB database.
- **A 28-day floor does not exist.** `daysFromUploadingToHiding` applies to the
  current version too, so if backups stop, the newest one is deleted 28 days
  later and the bucket empties. That is the policy working as specified, not a
  bug — the mitigations are the local copy and the 26-hour staleness alert — but
  it is worth knowing before reading "28-day retention" as "we always have one".
