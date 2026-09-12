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

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set"

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
read -r USERS HOURS CERTS LEDGER <<EOF
$(psql -tAX -F' ' -d "$DATABASE_URL" -c "
  SELECT (SELECT COUNT(*) FROM users),
         (SELECT COALESCE(ROUND(SUM(hours_awarded)::numeric,2),0) FROM attendance WHERE present = 1),
         (SELECT COUNT(*) FROM certificates),
         (SELECT COUNT(*) FROM hours_ledger);" 2>/dev/null || echo "ERR ERR ERR ERR")
EOF
[ "$USERS" != "ERR" ] || fail "could not read the invariant counts — is this a WeVolunteer database?"
log "live: users=$USERS credited_hours=$HOURS certificates=$CERTS ledger=$LEDGER"

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

cat > "$MANIFEST" <<JSON
{
  "created_utc": "$STAMP",
  "server_major": $SERVER_MAJOR,
  "client_major": $CLIENT_MAJOR,
  "invariants": {
    "users": $USERS,
    "credited_hours": $HOURS,
    "certificates": $CERTS,
    "hours_ledger": $LEDGER
  }
}
JSON
log "wrote $(basename "$MANIFEST")"
log "wrote $OUT ($(du -h "$OUT" | cut -f1))"

# ─────────────────────────────────────────────────────────────────────────────
# Encryption — identical reasoning to bin/backup.sh, deliberately.
#
# What is in this file: every student's name, email address, school, year group,
# service record, private messages, and every safety report ever filed. A public
# key means the host can encrypt and cannot decrypt, so an attacker who reaches
# the host reaches ciphertext. The private key lives with the operator, offline.
#
# If a key is configured and encryption fails, the run FAILS and the plaintext is
# deleted. Falling back to plaintext would be the worst outcome: the operator
# believes the backups are encrypted and nothing says otherwise.
if [ -n "${WEV_BACKUP_PUBKEY:-}" ]; then
  [ -f "$WEV_BACKUP_PUBKEY" ] || fail "WEV_BACKUP_PUBKEY is set but $WEV_BACKUP_PUBKEY does not exist"

  if ! openssl cms -encrypt -binary -aes-256-cbc -in "$OUT" -out "$OUT.enc" \
       -outform DER "$WEV_BACKUP_PUBKEY" 2>/dev/null; then
    rm -f "$OUT" "$OUT.enc"
    fail "encryption failed — refusing to leave an unencrypted backup behind"
  fi

  # Prove it decrypts to the same bytes before throwing the plaintext away.
  if [ -n "${WEV_BACKUP_TESTKEY:-}" ] && [ -f "$WEV_BACKUP_TESTKEY" ]; then
    if ! openssl cms -decrypt -binary -inform DER -in "$OUT.enc" \
         -inkey "$WEV_BACKUP_TESTKEY" 2>/dev/null | cmp -s - "$OUT"; then
      rm -f "$OUT" "$OUT.enc"
      fail "the encrypted backup did not decrypt back to the original"
    fi
    log "verified: the encrypted archive decrypts to the original bytes"
  fi

  rm -f "$OUT"
  log "encrypted to $OUT.enc ($(du -h "$OUT.enc" | cut -f1))"
else
  log "WARNING: WEV_BACKUP_PUBKEY is not set — this backup is NOT encrypted."
  log "WARNING: it contains every student's personal data in readable form."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Copy it off this host.
#
# Everything above produced a verified archive on the same machine the database
# is reached from and, on the Oracle deployment, the same machine the
# application runs on. That protects against a bad migration and an accidental
# DELETE. It does not protect against losing the host, losing the Oracle
# tenancy, or losing access to the Supabase project — which are the scenarios a
# restore is most often actually needed for.
#
# Non-fatal by design when nothing is configured: a local-only backup is worth
# far more than no backup, and refusing to finish would discard the archive that
# was just verified. It is fatal when a destination IS configured and the upload
# fails, because that is the case where an operator believes off-site copies
# exist. bin/backup-upload.mjs draws exactly that distinction in its exit code.
UPLOAD_TARGET="$OUT"
[ -f "$OUT.enc" ] && UPLOAD_TARGET="$OUT.enc"
if ! node "$(dirname "$0")/backup-upload.mjs" "$UPLOAD_TARGET" "$MANIFEST"; then
  fail "the off-site upload failed — the local archive is kept at $UPLOAD_TARGET"
fi

# Prune only after a successful new backup, so a run of failures can never age
# out the last good copy. Manifests are pruned on the same schedule as the
# archives they describe.
find "$DEST" \( -name 'wevolunteer-*.dump' -o -name 'wevolunteer-*.dump.enc' \
                -o -name 'wevolunteer-*.manifest.json' \) \
     -type f -mtime "+$KEEP_DAYS" -delete
log "pruned backups older than $KEEP_DAYS days"

log "OK"
