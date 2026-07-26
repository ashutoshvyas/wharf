#!/usr/bin/env bash
#
# WHARF panel database restore.
#
#   ┌──────────────────────────────────────────────────────────────────────┐
#   │ READ THIS BEFORE YOU RUN IT.                                          │
#   │                                                                       │
#   │ 1. THIS OVERWRITES DATA. --clean --if-exists drops and recreates      │
#   │    every object in the dump. Anything written since the dump was      │
#   │    taken is gone.                                                     │
#   │                                                                       │
#   │ 2. THE DUMP IS USELESS WITHOUT WHARF_MASTER_KEY. Every SSH password,  │
#   │    private key, Supabase anon/service_role key, JWT secret and        │
#   │    Postgres password in it is AES-256-GCM ciphertext (architecture    │
#   │    §6). The key is NOT in the dump — it lives only in                 │
#   │    /etc/wharf/.env. Restore the dump under a different key and the    │
#   │    panel starts, logs in, lists your fleet, and cannot open a single  │
#   │    SSH connection or reveal a single secret. Ever.                    │
#   │                                                                       │
#   │    You need BOTH: the dump AND the exact WHARF_MASTER_KEY that was    │
#   │    in force when it was taken. Store them in different places, and    │
#   │    restore-drill them together.                                       │
#   │                                                                       │
#   │ 3. Managed servers and running Supabase instances are NOT affected.   │
#   │    They keep serving traffic throughout. This restores the control    │
#   │    plane's memory of them, nothing else.                             │
#   └──────────────────────────────────────────────────────────────────────┘
#
# Uses DIRECT_URL (port 5432) — pg_restore cannot run through pgbouncer.
set -euo pipefail

# cron hands over a nearly empty PATH; guarantee the standard directories are
# present without discarding one the operator set (Debian keeps newer
# postgresql-client binaries in /usr/lib/postgresql/<ver>/bin, off the default).
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

ENV_FILE="${WHARF_ENV_FILE:-/etc/wharf/.env}"
DRY_RUN=0
ASSUME_YES=0
DUMP=""

usage() {
  cat <<'USAGE'
Usage: restore.sh [--dry-run] [--yes] <dump-file>

  --dry-run   Verify only. Reads the archive's table of contents with
              `pg_restore --list` and prints what it contains. Connects to
              NOTHING and writes NOTHING. Run this first, every time.
  --yes       Skip the interactive confirmation. For scripted DR drills only;
              on a production database, type the confirmation by hand.
  --help      This text.

Environment:
  WHARF_ENV_FILE   env file to source (default /etc/wharf/.env); DIRECT_URL is
                   read from it.

Typical sequence:
  systemctl stop wharf-panel wharf-gateway
  deploy/restore.sh --dry-run /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump
  deploy/restore.sh           /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump
  # confirm WHARF_MASTER_KEY in /etc/wharf/.env is the key this dump was
  # taken under — see the banner at the top of this script
  systemctl start wharf-panel wharf-gateway
  npm run db:check
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "restore.sh: unknown option '$1'" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$DUMP" ]; then
        echo "restore.sh: more than one dump file given" >&2
        exit 2
      fi
      DUMP="$1"; shift ;;
  esac
done

die() { echo "restore.sh: $*" >&2; exit 1; }

[ -n "$DUMP" ] || { echo "restore.sh: no dump file given" >&2; usage >&2; exit 2; }
[ -f "$DUMP" ] || die "no such file: ${DUMP}"
[ -r "$DUMP" ] || die "cannot read ${DUMP} (try as root)"

command -v pg_restore >/dev/null 2>&1 || die "pg_restore not found — install postgresql-client"

# ---- verification (always, both modes) -------------------------------------
echo "› archive  ${DUMP}  ($(du -h "$DUMP" | cut -f1))"
TOC="$(pg_restore --list "$DUMP" 2>&1)" || die "pg_restore --list failed — this file is not a readable custom-format dump:
${TOC}"

TABLES="$(printf '%s\n' "$TOC" | grep -c ' TABLE ' || true)"
echo "✓ archive is readable — ${TABLES} TABLE entries in its table of contents"
printf '%s\n' "$TOC" | grep -E ' TABLE (DATA )?(public )?(servers|websites|db_instances|panel_users|audit_log)' || true

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "· dry run — nothing was connected to and nothing was written."
  echo "· REMINDER: a readable dump is only half a restore. The other half is"
  echo "  the WHARF_MASTER_KEY it was encrypted under. Verify you have it"
  echo "  BEFORE you need it."
  exit 0
fi

# ---- real restore ----------------------------------------------------------
[ -r "$ENV_FILE" ] || die "cannot read env file ${ENV_FILE} (run as root, or set WHARF_ENV_FILE)"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
[ -n "${DIRECT_URL:-}" ] || die "DIRECT_URL is not set in ${ENV_FILE} — pg_restore needs the DIRECT (port 5432) connection string, not the pooled DATABASE_URL"
[ -n "${WHARF_MASTER_KEY:-}" ] || die "WHARF_MASTER_KEY is not set in ${ENV_FILE}. Restoring now would produce a panel that cannot decrypt anything it restored. Put the key back first."

# Restoring under a running panel corrupts nothing at the DB level (the
# restore is transactional per object) but the panel will serve half-dropped
# tables and its in-memory job registry will point at rows that no longer
# exist. Refuse rather than explain that later.
if command -v systemctl >/dev/null 2>&1; then
  for unit in wharf-panel wharf-gateway; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      die "${unit} is running. Stop both services first:
    systemctl stop wharf-panel wharf-gateway"
    fi
  done
fi

echo ""
echo "  TARGET   DIRECT_URL configured in ${ENV_FILE} (connection details withheld)"
echo "           Review the target in that file privately before confirming."
echo "  SOURCE   ${DUMP}"
echo ""
echo "  This DROPS AND RECREATES every object in the dump on the target"
echo "  database. Any panel data written after $(basename "$DUMP") was taken"
echo "  is permanently lost."
echo ""
echo "  It does NOT touch managed servers or running Supabase instances."
echo ""
echo "  The restored rows decrypt ONLY under the WHARF_MASTER_KEY currently"
echo "  in ${ENV_FILE}. If that is not the key the dump was taken under,"
echo "  stop now and fix it — there is no recovery from a key mismatch."
echo ""

if [ "$ASSUME_YES" -eq 1 ]; then
  echo "· --yes given, skipping confirmation"
else
  [ -t 0 ] || die "not a terminal — refusing to restore without an interactive confirmation (use --yes only for automated DR drills)"
  printf 'Type RESTORE to proceed: '
  read -r reply
  [ "$reply" = "RESTORE" ] || die "aborted — nothing was written"
fi

echo "› restoring…"
# --clean --if-exists: drop each object before recreating; tolerate objects
#   that are not there yet (a restore into an empty database).
# --no-owner --no-acl: ignore role/grant metadata; the Supabase project's role
#   names differ from wherever the dump came from.
# --exit-on-error: stop at the first failure instead of leaving a half-restored
#   database that looks like it worked.
# Note the audit_log immutability trigger (migration 20260724000002) is part of
# the dump and is restored with it — audit rows come back insert-only.
if ! pg_restore \
  --clean --if-exists \
  --no-owner --no-acl \
  --exit-on-error \
  --dbname="$DIRECT_URL" \
  "$DUMP"; then
  echo "" >&2
  echo "!!!! RESTORE FAILED — the database may be partially restored. !!!!" >&2
  echo "!!!! Do NOT start the panel. Investigate the error above, then re-run." >&2
  exit 1
fi

echo "✓ restore complete"
echo ""
echo "Next:"
echo "  1. npm run db:check          # connectivity + all migrations applied"
echo "  2. systemctl start wharf-panel wharf-gateway"
echo "  3. Open a server's Terminal tab and run \`id\`. That is the real test:"
echo "     it proves WHARF_MASTER_KEY still decrypts the restored credentials."
echo "     If it fails with a decryption error, the key does not match the dump."
