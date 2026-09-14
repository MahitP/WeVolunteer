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

**What the lock actually buys.** The primary control is already key scoping: the
backup writer's key has no `deleteFiles`, so it cannot delete anything even if the
host is fully compromised. The lock is defence in depth against the narrower case
— a key created later with more capability than it needed, or the master key used
by accident. Seven days blocks a deletion during the window in which one would
certainly be noticed (daily backups, a weekly drill), and governance rather than
compliance means a genuine emergency purge is still possible with the master key.
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

> ### The live account does not match this table yet — 2026-09-14
>
> `wevolunteer-bucket` is reached by **one** application key (`wevolunteer-key`)
> holding **all 26 capabilities**, including `deleteFiles`, `bypassGovernance`,
> `writeBucketLifecycleRules`, `writeBucketRetentions` and `writeBuckets`. It is
> restricted to the bucket, which is the one control that is right; it is not
> restricted by prefix, and it is not restricted by capability.
>
> That is not a theoretical gap. It was demonstrated: a `b2_delete_file_version`
> with `bypassGovernance: true` removed a governance-locked object outright. So
> whoever reaches the production host can delete every backup, and Object Lock
> will not stop them — which removes both of the two independent controls this
> section exists to create.
>
> `bin/b2-audit.mjs` reports each of these, and it is the check to re-run after
> fixing them. Fixing needs the account master key or the console: the current key
> has no `writeKeys`, so it cannot mint the three scoped keys itself.

**No key has `deleteFiles`.** Expiry is the lifecycle rule's job. An application
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
