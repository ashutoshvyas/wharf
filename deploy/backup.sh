#!/usr/bin/env bash
#
# WHARF panel database backup.
#
# Dumps the panel's metadata database (custom format, compressed) to
# /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump, verifies the dump is readable,
# prunes dumps older than the retention window, and optionally pushes a copy
# off-box with rclone.
#
#   ┌──────────────────────────────────────────────────────────────────────┐
#   │ THE DUMP ALONE IS NOT A BACKUP.                                      │
#   │ Every SSH credential, Supabase key and Postgres password in it is    │
#   │ AES-256-GCM ciphertext encrypted with WHARF_MASTER_KEY. Restoring     │
#   │ without that exact key gives you a panel that can log in and show     │
#   │ rows, and cannot connect to a single managed server.                  │
#   │ Back the key up SEPARATELY, off this machine. Both are required.      │
#   └──────────────────────────────────────────────────────────────────────┘
#
# Uses DIRECT_URL (port 5432). pg_dump cannot run through pgbouncer in
# transaction pooling mode, which is what DATABASE_URL points at on Supabase.
#
# Requires: postgresql-client (pg_dump/pg_restore) matching the server's major
# version or newer. Optional: rclone.
set -euo pipefail

# cron hands over a nearly empty PATH; guarantee the standard directories are
# present without discarding one the operator set (Debian keeps newer
# postgresql-client binaries in /usr/lib/postgresql/<ver>/bin, off the default).
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

ENV_FILE="${WHARF_ENV_FILE:-/etc/wharf/.env}"
BACKUP_DIR="${WHARF_BACKUP_DIR:-/var/backups/wharf}"
RETENTION_DAYS="${WHARF_BACKUP_RETENTION_DAYS:-14}"
# Optional offsite hook, e.g. WHARF_BACKUP_RCLONE_REMOTE="b2:my-bucket/wharf".
RCLONE_REMOTE="${WHARF_BACKUP_RCLONE_REMOTE:-}"

usage() {
  cat <<'USAGE'
Usage: backup.sh [--help]

Environment (all optional except a readable env file):
  WHARF_ENV_FILE               env file to source   (default /etc/wharf/.env)
  WHARF_BACKUP_DIR             output directory     (default /var/backups/wharf)
  WHARF_BACKUP_RETENTION_DAYS  prune older than N   (default 14)
  WHARF_BACKUP_RCLONE_REMOTE   rclone destination   (default: offsite copy disabled)

Reads DIRECT_URL from the env file. Exits non-zero on any failure.

crontab (as root — /var/backups is root-owned):
  15 3 * * * /opt/wharf/deploy/backup.sh >> /var/log/wharf-backup.log 2>&1

Restore with deploy/restore.sh. The dump is USELESS without WHARF_MASTER_KEY.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  "") ;;
  *) echo "backup.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
esac

fail() {
  echo "" >&2
  echo "!!!! WHARF BACKUP FAILED — $(date -u '+%Y-%m-%dT%H:%M:%SZ') !!!!" >&2
  echo "!!!! $* " >&2
  echo "!!!! No new dump was written. The previous dumps in ${BACKUP_DIR} are untouched." >&2
  echo "" >&2
  exit 1
}

[ -r "$ENV_FILE" ] || fail "cannot read env file ${ENV_FILE} (run as root, or set WHARF_ENV_FILE)"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

[ -n "${DIRECT_URL:-}" ] || fail "DIRECT_URL is not set in ${ENV_FILE} — pg_dump needs the DIRECT (port 5432) connection string, not the pooled DATABASE_URL"

command -v pg_dump >/dev/null 2>&1 || fail "pg_dump not found — install postgresql-client"
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore not found — install postgresql-client"

mkdir -p "$BACKUP_DIR" || fail "cannot create ${BACKUP_DIR}"
chmod 700 "$BACKUP_DIR" || fail "cannot chmod ${BACKUP_DIR}"

STAMP="$(date '+%Y%m%d-%H%M')"
TARGET="${BACKUP_DIR}/wharf-${STAMP}.dump"
# Write to a partial file first so a crashed dump can never be mistaken for a
# good one by the pruner or by restore.sh.
PARTIAL="${TARGET}.partial"
trap 'rm -f "$PARTIAL"' EXIT

echo "› wharf backup $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "› source  configured DIRECT_URL (connection details withheld)"
echo "› target  ${TARGET}"

# -Fc  custom format: compressed, and restorable selectively with pg_restore.
# --no-owner/--no-acl keep the dump portable across Supabase projects, whose
# role names differ from a self-hosted instance's.
if ! pg_dump --format=custom --no-owner --no-acl --file="$PARTIAL" "$DIRECT_URL"; then
  fail "pg_dump exited non-zero (see the error above)"
fi

# Prove the archive's table of contents parses before we trust it enough to
# prune older dumps. Cheap, and catches truncation/disk-full immediately.
if ! pg_restore --list "$PARTIAL" >/dev/null 2>&1; then
  fail "the dump was written but pg_restore --list could not read it — treating as corrupt"
fi

mv "$PARTIAL" "$TARGET"
trap - EXIT
chmod 600 "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "✓ dump written (${SIZE})"

# ---- optional offsite copy -------------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    fail "WHARF_BACKUP_RCLONE_REMOTE is set but rclone is not installed"
  fi
  echo "› offsite  rclone copy to configured destination"
  if ! rclone copy --no-traverse "$TARGET" "$RCLONE_REMOTE"; then
    fail "rclone copy to the configured destination failed — the local dump at ${TARGET} is good, but there is NO offsite copy of it"
  fi
  echo "✓ offsite copy done"
else
  echo "· offsite copy disabled (set WHARF_BACKUP_RCLONE_REMOTE to enable)"
fi

# ---- retention -------------------------------------------------------------
# Only reached when the dump above succeeded, so a broken backup job can never
# delete the last good dump.
PRUNED=0
while IFS= read -r old; do
  rm -f -- "$old" && PRUNED=$((PRUNED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'wharf-*.dump' -mtime "+${RETENTION_DAYS}")

KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'wharf-*.dump' | wc -l | tr -d ' ')"
echo "✓ retention: pruned ${PRUNED}, kept ${KEPT} (window ${RETENTION_DAYS} days)"
echo "· reminder: this dump is unusable without WHARF_MASTER_KEY — keep a copy of the key off this machine"
