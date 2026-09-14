#!/usr/bin/env bash
#
# WeVolunteer — nightly PostgreSQL backup.
#
# The PostgreSQL counterpart to bin/backup.sh, which is SQLite-only and cannot
# back up the production database. Every design decision below is carried over
# from that script deliberately, because each one was earned:
#
#   - verify BEFORE keeping (an unverified backup is a hypothesis)
#   - record the invariants the platform exists to protect
#   - public-key encryption, so the host can encrypt and cannot decrypt
#   - fail loudly rather than leave plaintext behind
#   - prune only after a successful new backup
#
# ── The version trap this script exists to survive ──
#
# `pg_dump` refuses to dump a server newer than itself. Observed directly, with
# a PostgreSQL 16.13 client against a 17.9 server:
#
#     pg_dump: error: aborting because of server version mismatch
#
# It exits non-zero AND LEAVES A ZERO-BYTE FILE at the -f path. A script that
# only checked the exit code of a pipeline, or that gzipped whatever appeared,
# would compress an empty file, encrypt it, prune the previous generation, and
# report success. That is the precise shape of the failure this whole file is
# written to prevent: a backup directory full of nothing, discovered during a
# restore.
#
# Supabase currently runs PostgreSQL 17. A host with Homebrew's default
# `postgresql@16` on PATH therefore CANNOT back up production, and the failure
# is silent unless something checks. This script checks, first, and names the
# fix.
#
# ── Usage ──
#
#   DATABASE_URL=postgres://... bin/backup-postgres.sh
#
# Environment:
#   DATABASE_URL            required — the database to back up
#   WEV_BACKUP_DIR          where to write (default /var/backups/wevolunteer)
#   WEV_BACKUP_KEEP_DAYS    retention in days (default 14)
#   WEV_BACKUP_PUBKEY       certificate holding the public key to encrypt to
#   WEV_BACKUP_TESTKEY      optional private key, to prove the archive decrypts
#   WEV_PG_BIN              directory holding a version-compatible pg_dump
#   WEV_OPENSSL             an OpenSSL 3 binary (default: `openssl` on PATH)
#   B2_S3_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY
#                           the off-site copy — see bin/backup-offsite.mjs and
#                           docs/operations/offsite-backups.md. All four, or none.
#
# ── Credentials ──
#
# DATABASE_URL is passed to pg_dump as a connection URI, which places it in the
# process list for the duration of the dump. On a single-tenant host that is
# bounded by who can already read /etc/wevolunteer/wevolunteer.env, i.e. the same
# people. Where that is not acceptable, the right control is not string-hiding
# but least privilege: give this script a dedicated role with only the read
# access a dump needs, so a leaked backup URI cannot write. This script never
# echoes the URL, and every log line below is safe to ship to a log aggregator.
#
set -euo pipefail

DEST="${WEV_BACKUP_DIR:-/var/backups/wevolunteer}"
KEEP_DAYS="${WEV_BACKUP_KEEP_DAYS:-14}"
OPENSSL="${WEV_OPENSSL:-openssl}"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set"

# ─────────────────────────────────────────────────────────────────────────────
# Nothing unencrypted leaves this host — decided before any work is done.
#
# An off-site destination with no encryption key would ship every student's
# record in readable form to a third party. bin/backup-offsite.mjs refuses a
# plaintext archive too; this check makes the refusal happen before a dump is
# taken, rather than after a night's work.
if [ -n "${B2_S3_ENDPOINT:-}${B2_BUCKET:-}${B2_KEY_ID:-}${B2_APPLICATION_KEY:-}" ] && [ -z "${WEV_BACKUP_PUBKEY:-}" ]; then
  fail "an off-site destination (B2_*) is configured but WEV_BACKUP_PUBKEY is not — refusing to produce an archive that could be sent unencrypted"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Locate a pg_dump that can actually dump this server.
#
# WEV_PG_BIN wins if set, so an operator on a host with several client versions
# installed can name the right one without reordering PATH for every process.
if [ -n "${WEV_PG_BIN:-}" ]; then
  [ -x "$WEV_PG_BIN/pg_dump" ] || fail "WEV_PG_BIN=$WEV_PG_BIN contains no executable pg_dump"
  PATH="$WEV_PG_BIN:$PATH"
fi

command -v pg_dump    >/dev/null 2>&1 || fail "pg_dump is not installed"
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not installed"
command -v psql       >/dev/null 2>&1 || fail "psql is not installed"

# Compare major versions before doing any work. `pg_dump --version` prints
# "pg_dump (PostgreSQL) 17.9 (Homebrew)"; the server reports its own via
# server_version_num (170009 -> 17). Majors are what pg_dump enforces.
CLIENT_MAJOR="$(pg_dump --version | sed -E 's/.*PostgreSQL\) ([0-9]+).*/\1/')"
SERVER_NUM="$(psql -tAX -d "$DATABASE_URL" -c 'SHOW server_version_num;' 2>/dev/null || true)"
[ -n "$SERVER_NUM" ] || fail "cannot connect to the database (check DATABASE_URL and network access)"
SERVER_MAJOR=$(( SERVER_NUM / 10000 ))

if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  fail "$(printf 'pg_dump is too old for this server.\n')
  pg_dump major:  $CLIENT_MAJOR
  server major:   $SERVER_MAJOR

  pg_dump refuses to dump a newer server and leaves a zero-byte file behind, so
  continuing would produce an empty backup that looks like a successful one.

  Install a matching client and point this script at it, e.g.:

    WEV_PG_BIN=/opt/homebrew/opt/postgresql@$SERVER_MAJOR/bin bin/backup-postgres.sh

  (Debian/Ubuntu: apt install postgresql-client-$SERVER_MAJOR)"
fi
log "client pg_dump major=$CLIENT_MAJOR against server major=$SERVER_MAJOR — compatible"

mkdir -p "$DEST" || fail "cannot create $DEST"

# ─────────────────────────────────────────────────────────────────────────────
# One backup at a time.
#
# The timer cannot overlap itself, but an operator running this by hand while the
# timer fires can — and two runs racing each other can prune the archive the other
# is about to upload. flock is non-blocking: the second run fails and says why.
# (flock is util-linux; a development Mac without it simply skips the lock.)
if command -v flock >/dev/null 2>&1; then
  exec 9>"$DEST/.backup.lock"
  flock -n 9 || fail "another backup is already running (lock: $DEST/.backup.lock)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Disk space, before a partial dump can fill the disk the application needs.
#
# Three times the newest archive (dump, encrypted copy, headroom) plus 100 MB. A
# pg_dump that runs out of space fails anyway; this fails first, clearly, and
# without taking the host's last free megabytes with it. A here-string rather
# than a pipe, for the SIGPIPE reason recorded further down.
NEWEST="$(ls -1t "$DEST"/wevolunteer-*.dump.enc "$DEST"/wevolunteer-*.dump 2>/dev/null || true)"
NEWEST="$(head -1 <<<"$NEWEST")"
NEWEST_BYTES=0
[ -n "$NEWEST" ] && NEWEST_BYTES="$(wc -c < "$NEWEST" | tr -d ' ')"
NEED_KB=$(( NEWEST_BYTES * 3 / 1024 + 102400 ))
DF_OUT="$(df -Pk "$DEST")"
FREE_KB="$(awk 'NR==2 {print $4}' <<<"$DF_OUT")"
if [ -n "$FREE_KB" ] && [ "$FREE_KB" -lt "$NEED_KB" ]; then
  fail "only ${FREE_KB} KB free in $DEST; a backup needs about ${NEED_KB} KB. Nothing was pruned."
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/wevolunteer-$STAMP.dump"
MANIFEST="$DEST/wevolunteer-$STAMP.manifest.json"

# ─────────────────────────────────────────────────────────────────────────────
# Record the invariants BEFORE dumping.
#
# bin/backup.sh could sanity-check a SQLite backup by querying the backup file
# directly — it is a database. A custom-format pg dump is not queryable without
# restoring it, so the equivalent check has to be split in two: capture the
# numbers from the live database here, and compare them after a real restore in
# bin/verify-restore-postgres.sh.
#
# That split is worth more than the original single check, because the manifest
# turns "the restore produced a database" into "the restore produced THIS
# database". A dump that silently lost rows passes a structural check and fails
# this one.
# `present = 1`, not `WHERE present`. The APPLICATION schema
# (server/db/postgresSchema.js) declares it INTEGER CHECK(present IN (0,1)),
# deliberately, so one codebase serves SQLite and PostgreSQL. Only the
# historical baseline in supabase/migrations declares it BOOLEAN — and a
# database built from that one is refused at boot. Writing `WHERE present`
# here worked against the baseline and failed against production with
# "argument of WHERE must be type boolean, not type integer".
log "recording invariants from the live database"
read -r USERS HOURS CERTS LEDGER MIGRATION <<EOF
$(psql -tAX -F' ' -d "$DATABASE_URL" -c "
  SELECT (SELECT COUNT(*) FROM users),
         (SELECT COALESCE(ROUND(SUM(hours_awarded)::numeric,2),0) FROM attendance WHERE present = 1),
         (SELECT COUNT(*) FROM certificates),
         (SELECT COUNT(*) FROM hours_ledger),
         (SELECT COALESCE(MAX(version), 0) FROM schema_migrations);" 2>/dev/null || echo "ERR ERR ERR ERR ERR")
EOF
[ "$USERS" != "ERR" ] || fail "could not read the invariant counts — is this a WeVolunteer database?"
log "live: users=$USERS credited_hours=$HOURS certificates=$CERTS ledger=$LEDGER migration=$MIGRATION"

# ─────────────────────────────────────────────────────────────────────────────
# Dump.
#
# -Fc (custom) rather than plain SQL: it is compressed already, it can be
# restored selectively, and pg_restore can list its table of contents without a
# server — which is what makes the structural verification below possible.
#
# --no-owner / --no-privileges: the restore target is a scratch database owned by
# whoever is restoring, and on a managed provider the production role names do
# not exist locally. Without these, a restore drill fails on role errors that
# have nothing to do with the data.
log "dumping -> $OUT"
# --schema=public: OUR data, not the provider's infrastructure.
#
# A managed Postgres carries schemas we neither own nor want in a backup. On
# Supabase that is auth (23 tables), storage, realtime, vault, graphql and
# pgbouncer, plus provider-only extensions. Dumping them made the archive
# UNRESTORABLE anywhere but Supabase: a drill against stock PostgreSQL 17 died on
#
#   pg_restore: error: could not execute query: ERROR: extension
#   "supabase_vault" is not available
#
# — which meant the disaster-recovery story was "restore onto the provider you
# just lost". Observed on the live host 2026-09-12; the drill is the only thing
# that could have found it, because the archive verified fine structurally.
#
# Restricting to `public` also halves the archive (400K -> 196K here) and keeps
# the provider's own auth tables out of a file we encrypt and ship off-host.
#
# The restore side must create any extension `public` depends on — pg_trgm for
# the four trigram indexes. verify-restore-postgres.sh does this.
if ! pg_dump --format=custom --no-owner --no-privileges --compress=9 \
     --schema=public \
     -d "$DATABASE_URL" -f "$OUT" 2>/tmp/wev-pgdump-err.$$; then
  ERRTXT="$(head -c 2000 /tmp/wev-pgdump-err.$$ || true)"; rm -f /tmp/wev-pgdump-err.$$
  rm -f "$OUT"
  fail "pg_dump returned non-zero: $ERRTXT"
fi
rm -f /tmp/wev-pgdump-err.$$

[ -s "$OUT" ] || { rm -f "$OUT"; fail "the dump is empty — refusing to keep a zero-byte backup"; }

# ─────────────────────────────────────────────────────────────────────────────
# Verify BEFORE keeping it.
#
# `pg_restore --list` parses the archive's table of contents. It fails on a
# truncated or corrupt file, which is the cheap structural check available
# without a server. It is NOT proof the data is intact — that is what the
# restore drill is for — so the log line says what was and was not established.
if ! TOC="$(pg_restore --list "$OUT" 2>&1)"; then
  rm -f "$OUT"
  fail "pg_restore could not read the archive it just wrote: $(printf '%s' "$TOC" | head -c 500)"
fi

# The tables the platform cannot be reconstructed without. A dump that parsed
# cleanly but contains no `users` table is a dump of the wrong database.
for t in users events attendance certificates; do
  # A here-string, NOT `printf ... | grep -q`.
  #
  # `grep -q` exits the moment it matches. In a pipeline `printf` is then still
  # writing and takes SIGPIPE (141), and `set -o pipefail` at the top turns that
  # into the pipeline's exit status — so a SUCCESSFUL match was reported as a
  # failure, and the archive it had just verified was deleted.
  #
  # Size-dependent, which is how it survived. With a small table of contents
  # `printf` finishes before `grep` exits and the race never happens: the local
  # drill (70 tables) passed every time. Production's TOC is 846 lines, because a
  # Supabase dump carries that provider's own `auth` schema alongside ours, and
  # there it failed on the FIRST table, every night. Observed on the live host
  # 2026-09-12 — "the archive has no data for table 'users'" one line after
  # "live: users=3", with "printf: Broken pipe" between them. Same event.
  grep -qE "TABLE DATA public $t( |$)" <<<"$TOC" \
    || { rm -f "$OUT"; fail "the archive has no data for table '$t' — wrong database, or a partial dump"; }
done
log "verified: archive parses and carries data for users, events, attendance, certificates"

log "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# ─────────────────────────────────────────────────────────────────────────────
# Encryption.
#
# What is in this file: every student's name, email address, school, year group,
# service record, private messages, and every safety report ever filed. A public
# key means the host can encrypt and cannot decrypt, so an attacker who reaches
# the host reaches ciphertext. The private key lives with the operator, offline.
#
# ── AES-256-GCM with RSA-OAEP, not the AES-256-CBC this used until 2026-09-13 ──
#
# `openssl cms -encrypt -aes-256-cbc` produces CMS EnvelopedData: confidential,
# but NOT authenticated. Measured, not assumed: flipping one byte in the middle of
# a CBC archive still "decrypted" with exit 0, into a file that silently differed
# from the original. For a backup that is the worst property there is — a
# corrupted or tampered archive restores into subtly wrong data and nothing says
# so. With `-aes-256-gcm` OpenSSL emits AuthEnvelopedData: a flipped byte, a
# truncated file or the wrong key all fail with a non-zero exit and no output.
# RSA-OAEP replaces PKCS#1 v1.5 for the key transport. Archives written before
# this change stay readable — `openssl cms -decrypt` recognises both — so no
# history is lost by upgrading.
#
# Requires OpenSSL 3 on both sides. macOS's /usr/bin/openssl is LibreSSL and
# cannot read AuthEnvelopedData; the runbook says to use OpenSSL 3 for recovery.
#
# If a key is configured and encryption fails, the run FAILS and the plaintext is
# deleted. Falling back to plaintext would be the worst outcome: the operator
# believes the backups are encrypted and nothing says otherwise.
ENCRYPTION="none"
if [ -n "${WEV_BACKUP_PUBKEY:-}" ]; then
  [ -f "$WEV_BACKUP_PUBKEY" ] || fail "WEV_BACKUP_PUBKEY is set but $WEV_BACKUP_PUBKEY does not exist"

  if ! "$OPENSSL" cms -encrypt -binary -aes-256-gcm -outform DER -in "$OUT" -out "$OUT.enc" \
       -recip "$WEV_BACKUP_PUBKEY" -keyopt rsa_padding_mode:oaep 2>/dev/null; then
    rm -f "$OUT" "$OUT.enc"
    fail "encryption failed (AES-256-GCM/RSA-OAEP needs OpenSSL 3; set WEV_OPENSSL) — refusing to leave an unencrypted backup behind"
  fi

  # Prove it decrypts to the same bytes before throwing the plaintext away.
  if [ -n "${WEV_BACKUP_TESTKEY:-}" ] && [ -f "$WEV_BACKUP_TESTKEY" ]; then
    if ! "$OPENSSL" cms -decrypt -binary -inform DER -in "$OUT.enc" \
         -inkey "$WEV_BACKUP_TESTKEY" -out "$OUT.check" 2>/dev/null || ! cmp -s "$OUT.check" "$OUT"; then
      rm -f "$OUT" "$OUT.enc" "$OUT.check"
      fail "the encrypted backup did not decrypt back to the original"
    fi
    rm -f "$OUT.check"
    log "verified: the encrypted archive decrypts to the original bytes"
  fi

  rm -f "$OUT"
  ENCRYPTION="cms-authenveloped-aes-256-gcm-rsa-oaep"
  log "encrypted to $OUT.enc ($(du -h "$OUT.enc" | cut -f1))"
else
  log "WARNING: WEV_BACKUP_PUBKEY is not set — this backup is NOT encrypted."
  log "WARNING: it contains every student's personal data in readable form."
fi

UPLOAD_TARGET="$OUT"
[ -f "$OUT.enc" ] && UPLOAD_TARGET="$OUT.enc"

# ─────────────────────────────────────────────────────────────────────────────
# The manifest, written LAST, so it can describe the archive that actually exists.
#
# `archive_sha256` is what makes every later check meaningful: the off-site
# upload, the fetch in a disaster and the weekly drill all compare the bytes they
# hold against it. The counts are what the restore drill compares a restored
# database against. Nothing here identifies a person — counts, versions, a hash.
ARCHIVE_SHA256="$(sha256sum "$UPLOAD_TARGET" 2>/dev/null || shasum -a 256 "$UPLOAD_TARGET")"
ARCHIVE_SHA256="${ARCHIVE_SHA256%% *}"
ARCHIVE_BYTES="$(wc -c < "$UPLOAD_TARGET" | tr -d ' ')"
RELEASE="unknown"
[ -f "$(dirname "$0")/../.deployed-sha" ] && RELEASE="$(tr -d ' \t\r\n' < "$(dirname "$0")/../.deployed-sha")"
cat > "$MANIFEST" <<JSON
{
  "format_version": 2,
  "created_utc": "$STAMP",
  "archive": "$(basename "$UPLOAD_TARGET")",
  "archive_bytes": $ARCHIVE_BYTES,
  "archive_sha256": "$ARCHIVE_SHA256",
  "encryption": "$ENCRYPTION",
  "dump": "pg_dump custom format, schema public, no owner or privileges",
  "server_major": $SERVER_MAJOR,
  "client_major": $CLIENT_MAJOR,
  "migration_version": ${MIGRATION:-0},
  "release": "$RELEASE",
  "invariants": {
    "users": $USERS,
    "credited_hours": $HOURS,
    "certificates": $CERTS,
    "hours_ledger": $LEDGER
  }
}
JSON
log "wrote $(basename "$MANIFEST") (sha256 ${ARCHIVE_SHA256:0:16}...)"

# ─────────────────────────────────────────────────────────────────────────────
# Copy it off this host, and prove the copy.
#
# Everything above produced a verified archive on the same machine the database
# is reached from and, on the Oracle deployment, the same machine the
# application runs on. That protects against a bad migration and an accidental
# DELETE. It does not protect against losing the host, losing the Oracle
# tenancy, or losing access to the Supabase project — which are the scenarios a
# restore is most often actually needed for.
#
# bin/backup-offsite.mjs uploads to Backblaze B2, checks B2's own record of the
# object, downloads it back and compares hashes, and records each level it
# reached in status/offsite.json. Non-fatal when nothing is configured: a
# local-only backup is worth far more than no backup. Fatal when a destination IS
# configured and any level fails, because that is the case where an operator
# believes off-site copies exist — and a failed run prunes nothing.
if ! node "$(dirname "$0")/backup-offsite.mjs" "$UPLOAD_TARGET" "$MANIFEST"; then
  fail "the off-site copy failed — the local archive is kept at $UPLOAD_TARGET and nothing was pruned"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Prune only after a successful new backup, so a run of failures can never age
# out the last good copy. Manifests are pruned on the same schedule as the
# archives they describe.
find "$DEST" \( -name 'wevolunteer-*.dump' -o -name 'wevolunteer-*.dump.enc' \
                -o -name 'wevolunteer-*.manifest.json' \) \
     -type f -mtime "+$KEEP_DAYS" -delete
log "pruned backups older than $KEEP_DAYS days"

log "OK"
