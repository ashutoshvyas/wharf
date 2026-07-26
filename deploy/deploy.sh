#!/usr/bin/env bash
#
# WHARF release deployment.   Usage: deploy/deploy.sh v1.4.0
#
# Deploys a git tag onto the panel VPS: checkout → npm ci → prisma migrate
# deploy → build panel + gateway → copy standalone assets → restart both
# services → wait for both /healthz. Fails loudly and early at every step.
#
# There are no container images in WHARF's panel runtime. Operators deploy a
# reviewed git tag manually after the validation checks pass. This script is
# never invoked by the repository's GitHub Actions workflows.
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │ ROLLBACK ASYMMETRY — the one thing to internalise about WHARF releases.  │
# │                                                                          │
# │   CODE rolls back.       deploy/deploy.sh v1.3.0   ← done, ~2 minutes.   │
# │   MIGRATIONS DO NOT.     There is no `prisma migrate down`. Rolling the  │
# │                          code back leaves the NEW schema in place.       │
# │                                                                          │
# │ That asymmetry is only survivable if every migration in a release train  │
# │ is ADDITIVE and BACKWARD-COMPATIBLE: add nullable columns, add tables,   │
# │ add indexes. Never drop or rename a column, never narrow a type, never   │
# │ add a NOT NULL without a default, in the same release that starts using  │
# │ it. Drop the old column one release LATER, once the previous version is  │
# │ no longer a rollback target.                                             │
# │                                                                          │
# │ If a release does contain a destructive migration, this script is not a  │
# │ rollback path. The ONLY way back is deploy/restore.sh with a backup      │
# │ taken before the migration ran — and that restore needs         │
# │ WHARF_MASTER_KEY. Take a fresh backup before deploying any such tag.     │
# │                                                                          │
# │ See docs/runbook.md — "Rolling back a release".                          │
# └──────────────────────────────────────────────────────────────────────────┘
set -euo pipefail

# cron hands over a nearly empty PATH; guarantee the standard directories are
# present without discarding one the operator set (Debian keeps newer
# postgresql-client binaries in /usr/lib/postgresql/<ver>/bin, off the default).
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

REPO="${WHARF_REPO_DIR:-/opt/wharf}"
ENV_FILE="${WHARF_ENV_FILE:-/etc/wharf/.env}"
SERVICE_USER="${WHARF_SERVICE_USER:-wharf}"
PANEL_HEALTH="${WHARF_PANEL_HEALTH_URL:-http://127.0.0.1:3000/api/healthz}"
GATEWAY_HEALTH="${WHARF_GATEWAY_HEALTH_URL:-http://127.0.0.1:3001/healthz}"
HEALTH_ATTEMPTS="${WHARF_HEALTH_ATTEMPTS:-45}"   # × 2s ≈ 90s per service
TAG=""

usage() {
  cat <<'USAGE'
Usage: deploy.sh <tag>            e.g.  deploy.sh v1.4.0

Deploys a released git tag to this panel VPS. Run as root (it restarts
systemd units and chowns the tree back to the service user).

Environment overrides:
  WHARF_REPO_DIR            checkout to deploy   (default /opt/wharf)
  WHARF_ENV_FILE            env file to load     (default /etc/wharf/.env)
  WHARF_SERVICE_USER        owner of the tree    (default wharf)
  WHARF_HEALTH_ATTEMPTS     health poll attempts (default 45, 2s apart)
  WHARF_PANEL_HEALTH_URL    default http://127.0.0.1:3000/api/healthz
  WHARF_GATEWAY_HEALTH_URL  default http://127.0.0.1:3001/healthz

Refuses to run if the working tree has modified tracked files, or if the tag
does not exist on the remote.

ROLLBACK: re-run with the previous tag. THAT ROLLS BACK CODE ONLY —
migrations are never reversed. See the banner at the top of this file and
docs/runbook.md.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  "") echo "deploy.sh: no tag given" >&2; usage >&2; exit 2 ;;
  -*) echo "deploy.sh: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  *) TAG="$1" ;;
esac
[ $# -le 1 ] || { echo "deploy.sh: too many arguments" >&2; usage >&2; exit 2; }

step() { echo ""; echo "══ $* "; }
die()  { echo "" >&2; echo "!!!! DEPLOY ABORTED — $* " >&2; exit 1; }

# ---- preconditions ---------------------------------------------------------
step "preflight"
[ -d "$REPO/.git" ] || die "${REPO} is not a git checkout (set WHARF_REPO_DIR)"
cd "$REPO"

for bin in git npm node curl systemctl; do
  command -v "$bin" >/dev/null 2>&1 || die "${bin} not found on PATH"
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node ${NODE_MAJOR} is too old — WHARF targets Node 22 (see deploy/README.md)"

# Load /etc/wharf/.env into THIS shell and export it, because the BUILD needs
# it — not only the running services.
#
#   next.config.ts `headers()` is evaluated at BUILD time and its output is
#   frozen into .next/routes-manifest.json. It reads INSTANCE_DOMAIN (to allow
#   frame-src https://*.INSTANCE_DOMAIN — the Studio iframe) and
#   NEXT_PUBLIC_GATEWAY_WS_URL (to allow connect-src for the terminal socket).
#   Build without them and you ship a CSP that blocks both, with a perfectly
#   healthy panel and no server-side error anywhere. Asserted after the build.
#
# `prisma migrate deploy` needs DIRECT_URL from here too.
[ -r "$ENV_FILE" ] || die "cannot read ${ENV_FILE} — run as root, or set WHARF_ENV_FILE"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
[ -n "${DIRECT_URL:-}" ] || die "DIRECT_URL is not set in ${ENV_FILE} — prisma migrate deploy cannot run through the pooled connection"
[ -n "${INSTANCE_DOMAIN:-}" ] || die "INSTANCE_DOMAIN is not set in ${ENV_FILE} — the build would bake a CSP that blocks the Studio iframe"
[ -n "${NEXT_PUBLIC_GATEWAY_WS_URL:-}" ] || die "NEXT_PUBLIC_GATEWAY_WS_URL is not set in ${ENV_FILE} — the build would bake a CSP that blocks the terminal WebSocket"

# --untracked-files=no on purpose: deploy/.deployed-tag (written at the end of
# this script) is untracked and would otherwise make every second run refuse.
# Modified TRACKED files still abort — those are hand-edits that a checkout
# would silently destroy.
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  die "working tree has uncommitted changes to tracked files:
${DIRTY}

  Deploying would overwrite them. Save or discard them first:
    git -C ${REPO} diff          # see what changed
    git -C ${REPO} checkout -- . # discard"
fi

PREVIOUS="$(cat deploy/.deployed-tag 2>/dev/null || echo "unknown")"
echo "· repo        ${REPO}"
echo "· node        $(node -v)"
echo "· deployed    ${PREVIOUS}"
echo "· deploying   ${TAG}"

# ---- fetch + verify the tag ------------------------------------------------
step "fetching tags"
git fetch --tags --prune --force || die "git fetch failed — check network/credentials"
git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null \
  || die "unknown tag '${TAG}'. Known tags:
$(git tag --list --sort=-v:refname | head -20)"

step "checking out ${TAG}"
git checkout --force --detach "refs/tags/${TAG}" || die "checkout of ${TAG} failed"
echo "· HEAD is now $(git rev-parse --short HEAD) (${TAG})"

# ---- dependencies ----------------------------------------------------------
step "npm ci (root + gateway workspace)"
npm ci || die "npm ci failed"
npx prisma generate || die "prisma generate failed"

# ---- migrations ------------------------------------------------------------
# `migrate deploy` applies pending migrations only; it never resets, never
# prompts, and never generates new ones. It uses DIRECT_URL (prisma/schema.prisma
# datasource `directUrl`) because pgbouncer cannot run DDL in transaction mode.
step "prisma migrate deploy"
echo "· REMINDER: this is the step with no undo. If this release drops or"
echo "  renames anything, a fresh backup must already exist (deploy/backup.sh)."
npx prisma migrate deploy || die "prisma migrate deploy failed.
  The old code is still running (services were not restarted yet).
  Fix the migration, or restore from a backup with deploy/restore.sh."

# ---- build -----------------------------------------------------------------
step "building panel"
npm run build || die "panel build failed — services were not restarted, the previous release is still serving"

step "building gateway"
npm run build -w gateway || die "gateway build failed — services were not restarted"

# ---- standalone asset copy -------------------------------------------------
# next.config.ts sets output:"standalone". `next build` produces a
# self-contained .next/standalone/server.js with its own node_modules, but it
# does NOT copy .next/static or public/ into it — that is documented as the
# caller's job. Skip this and the panel serves HTML with every stylesheet and
# JS chunk 404ing: a working login page with no styling and no interactivity.
step "copying static assets into the standalone bundle"
[ -f .next/standalone/server.js ] || die "expected .next/standalone/server.js after the build — is output:\"standalone\" still set in next.config.ts?"
[ -d .next/static ] || die "expected .next/static after the build"

rm -rf .next/standalone/.next/static
mkdir -p .next/standalone/.next
cp -r .next/static .next/standalone/.next/static
echo "· .next/static → .next/standalone/.next/static"

if [ -d public ]; then
  rm -rf .next/standalone/public
  cp -r public .next/standalone/public
  echo "· public → .next/standalone/public"
else
  echo "· no public/ directory in this repo — nothing to copy"
fi

# `next build` copies any repo-root .env* into the standalone output. Secrets
# belong in /etc/wharf/.env (loaded by systemd), never in the deployed tree.
if [ -f .next/standalone/.env ]; then
  rm -f .next/standalone/.env
  echo "· removed .next/standalone/.env (build artefact — secrets come from ${ENV_FILE})"
fi

# ---- assert the baked-in CSP is the production one -------------------------
# The single failure mode this catches: a build that ran without
# INSTANCE_DOMAIN in its environment produces `frame-src 'self'` and the
# Manage view shows a blank frame in production. Cheaper to fail here.
step "verifying the built Content-Security-Policy"
node -e '
  const m = require("./.next/routes-manifest.json");
  const csp = (m.headers ?? [])
    .flatMap((h) => h.headers ?? [])
    .find((h) => h.key === "Content-Security-Policy");
  if (!csp) { console.log("· no CSP in routes-manifest — next.config.ts headers() may have been removed; skipping check"); process.exit(0); }
  const domain = process.env.INSTANCE_DOMAIN;
  const ws = process.env.NEXT_PUBLIC_GATEWAY_WS_URL;
  const problems = [];
  if (!csp.value.includes(`*.${domain}`)) problems.push("frame-src does not allow the configured instance domain — the Studio iframe will be blocked");
  if (ws && !csp.value.includes(ws)) problems.push("connect-src does not allow the configured gateway endpoint — the terminal WebSocket will be blocked");
  if (problems.length) {
    console.error("built CSP is wrong for this environment:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("· CSP allows the configured instance domain and gateway endpoint");
' || die "the built CSP would break Studio and/or the terminal. The build did not see the right environment — services were NOT restarted."

# ---- ownership -------------------------------------------------------------
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  step "chown ${SERVICE_USER}:${SERVICE_USER} ${REPO}"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "$REPO" || die "chown failed"
else
  echo "! service user '${SERVICE_USER}' does not exist — skipping chown (see deploy/README.md)"
fi

# ---- restart ---------------------------------------------------------------
step "restarting services"
systemctl restart wharf-panel  || die "systemctl restart wharf-panel failed — journalctl -u wharf-panel -n 50"
systemctl restart wharf-gateway || die "systemctl restart wharf-gateway failed — journalctl -u wharf-gateway -n 50"

# ---- health ----------------------------------------------------------------
# app/api/healthz/route.ts   → {"ok":true,"service":"wharf-panel"}
# gateway/src/index.ts       → {"ok":true,"uptimeSec":N}
wait_healthy() {
  local name="$1" url="$2" unit="$3" i=1
  echo "· waiting for ${name} health check (address withheld)"
  while [ "$i" -le "$HEALTH_ATTEMPTS" ]; do
    if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
      echo "✓ ${name} healthy after $((i * 2))s"
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done

  echo "" >&2
  echo "!!!! ${name} DID NOT COME UP after $((HEALTH_ATTEMPTS * 2))s !!!!" >&2
  echo "!!!! The configured health-check address never answered." >&2
  echo "" >&2
  echo "Last 40 log lines:" >&2
  systemctl status "$unit" --no-pager --lines=0 >&2 || true
  journalctl -u "$unit" -n 40 --no-pager >&2 || true
  echo "" >&2
  echo "The migrations for ${TAG} HAVE ALREADY BEEN APPLIED. Rolling the code" >&2
  echo "back (deploy.sh ${PREVIOUS}) does not undo them — read the rollback" >&2
  echo "banner at the top of this script before doing anything else." >&2
  return 1
}

step "health checks"
PANEL_OK=0
GATEWAY_OK=0
wait_healthy "panel"   "$PANEL_HEALTH"   "wharf-panel"   && PANEL_OK=1
wait_healthy "gateway" "$GATEWAY_HEALTH" "wharf-gateway" && GATEWAY_OK=1

if [ "$PANEL_OK" -ne 1 ] || [ "$GATEWAY_OK" -ne 1 ]; then
  die "deployment of ${TAG} is NOT healthy (panel=${PANEL_OK} gateway=${GATEWAY_OK}). deploy/.deployed-tag was left at '${PREVIOUS}'."
fi

# ---- record ----------------------------------------------------------------
# Written last, and only on success, so this file always names the tag that is
# actually serving traffic. Untracked by git on purpose (see the dirty-tree
# check above); add `deploy/.deployed-tag` to .gitignore if you prefer.
printf '%s\n' "$TAG" > deploy/.deployed-tag
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  chown "${SERVICE_USER}:${SERVICE_USER}" deploy/.deployed-tag || true
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "✓ ${TAG} deployed and healthy   (was: ${PREVIOUS})"
echo ""
echo "  logs      journalctl -u wharf-panel -f"
echo "            journalctl -u wharf-gateway -f"
echo "  verify    docs/deployment.md — 'Verifying a deployment'"
echo "  rollback  deploy/deploy.sh ${PREVIOUS}   ← CODE ONLY."
echo "            Migrations applied by ${TAG} stay applied."
echo "════════════════════════════════════════════════════════════"
