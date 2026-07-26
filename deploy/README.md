# `deploy/` — WHARF panel VPS operations

Everything needed to run the panel and gateway on a plain VPS. **No Docker.**
The panel and gateway are node processes under systemd; Docker exists only on
*managed* servers, where WHARF's provisioning engine puts it.

Deployment is manual. The repository's GitHub Actions workflows only validate
code and do not connect to servers. Keep deployment credentials in the server's
environment file or your own private secret manager; the repository does not
store VPS credentials.

| File | Purpose |
|---|---|
| `systemd/wharf-panel.service` | Next.js standalone server, port 3000 (loopback) |
| `systemd/wharf-gateway.service` | Terminal Gateway, port 3001 (loopback) |
| `Caddyfile` | Reverse proxy + automatic TLS (recommended) |
| `nginx.conf.example` | Same thing for nginx + certbot |
| `backup.sh` | Nightly `pg_dump` of the panel database, 14-day retention |
| `restore.sh` | Guided restore, with `--dry-run` |
| `deploy.sh <tag>` | Deploy a released git tag; the rollback entry point |
| `.deployed-tag` | Written by `deploy.sh`; the tag currently serving (untracked) |

Read `docs/deployment.md` **first** — it covers the domain/SSO chain, DNS and
the verification checklist, and none of that is repeated here. Scenario
playbooks live in `docs/runbook.md`.

---

## First-time install

Everything below runs as root on a fresh Debian/Ubuntu VPS.

### 1. Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git curl postgresql-client
node -v          # must be v22.x — the units and CI both target 22
```

`postgresql-client` supplies `pg_dump` / `pg_restore` for `backup.sh` and
`restore.sh`. Its major version must be **>= your Supabase Postgres**
(Postgres 15/16 on Supabase today); an older `pg_dump` refuses to dump a newer
server.

### 2. Service user and directories

```bash
useradd --system --home-dir /opt/wharf --shell /usr/sbin/nologin wharf

mkdir -p /opt/wharf /etc/wharf /var/backups/wharf
git clone <repo-url> /opt/wharf
chown -R wharf:wharf /opt/wharf

chmod 700 /etc/wharf /var/backups/wharf   # root-only
```

`--system` gives a no-login account with no password and no home of its own —
the panel never needs a shell, and `ProtectHome=yes` in the units hides
`/home` and `/root` from it anyway.

### 3. The environment file

```bash
cp /opt/wharf/.env.example /etc/wharf/.env
chown root:wharf /etc/wharf/.env
chmod 640 /etc/wharf/.env      # 600 if you prefer; systemd reads it as PID 1
```

Fill in every value — `.env.example` documents each one, and
`docs/runbook.md` → "Environment reference" lists what breaks without it.
Generate the two secrets:

```bash
openssl rand -base64 32     # NEXTAUTH_SECRET
openssl rand -base64 32     # WHARF_MASTER_KEY  — copy this OFF the box, now
```

> **Do not leave a `.env` in `/opt/wharf`.** `next build` copies repo-root
> `.env*` files into `.next/standalone/`, so a stray one turns into a second,
> forgotten copy of your secrets inside the build output. Secrets come from
> `/etc/wharf/.env` via systemd `EnvironmentFile`. `deploy.sh` deletes
> `.next/standalone/.env` after every build for exactly this reason.

### 4. Database + first admin

```bash
cd /opt/wharf
npm ci
npm run db:check     # read-only: connectivity, DIRECT_URL sanity, migration status
npm run db:deploy    # applies migrations over DIRECT_URL
npm run db:seed      # creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD
```

`db:check` exits 0 only if the runtime connection works — run it any time; it
never writes.

### 5. Build

```bash
cd /opt/wharf

# The BUILD needs the environment too — not just the running services.
set -a; . /etc/wharf/.env; set +a

npm run build            # panel  → .next/standalone/server.js
npm run build -w gateway # gateway → gateway/dist/index.js

# `next build` does NOT do this, and the units depend on it:
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public
rm -f .next/standalone/.env

chown -R wharf:wharf /opt/wharf
```

**Why the build needs the env file.** `NEXT_PUBLIC_GATEWAY_WS_URL` is inlined
into the browser bundle, so changing it requires a rebuild. Security middleware
reads the configured instance domain and gateway origin at request time for CSP;
the running services therefore need the same deployment configuration. See
`docs/runbook.md` for the variable reference.

**The proxy must not add duplicate security headers.** Security middleware sets
CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and
`nosniff` on responses. `deploy/Caddyfile` and `nginx.conf.example`
deliberately add none — see the comments in both about how a duplicate CSP at
the proxy kills the Studio iframe.

**Why the copy.** `next.config.ts` sets `output: "standalone"`, which emits a
self-contained `.next/standalone/` (its own `node_modules`, its own
`server.js`). Next deliberately leaves `.next/static` and `public/` out of it,
because they are meant to be served by a CDN in many setups. Here they are
not — the panel serves its own assets. Skip the copy and you get a login page
that renders as unstyled HTML with every JS chunk 404ing, and no error
anywhere that says why.

After the first install, `deploy/deploy.sh` does all of step 5 for you.

### 6. Services

```bash
cp /opt/wharf/deploy/systemd/wharf-panel.service   /etc/systemd/system/
cp /opt/wharf/deploy/systemd/wharf-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wharf-panel wharf-gateway
systemctl status wharf-panel wharf-gateway --no-pager
```

Logs (there are no log files — everything is in journald):

```bash
journalctl -u wharf-panel   -f            # follow
journalctl -u wharf-gateway -f
journalctl -u wharf-panel   -n 100 --no-pager
journalctl -u wharf-panel   --since "10 min ago"
journalctl -u wharf-panel   -p err        # errors only
journalctl -u wharf-panel   --since today | grep 'configuration problems'
```

Health, straight from the box:

```bash
curl -s http://127.0.0.1:3000/api/healthz   # {"ok":true,"service":"wharf-panel"}
curl -s http://127.0.0.1:3001/healthz       # {"ok":true,"uptimeSec":N}
```

A gateway that exits immediately with `refusing to start` is an env problem —
it validates `DATABASE_URL`, `NEXTAUTH_SECRET`, `WHARF_MASTER_KEY` and
`GATEWAY_PORT` at boot and lists exactly what is wrong. With
`Restart=on-failure` it will retry 5 times in 10s and then stay `failed`;
`systemctl reset-failed wharf-gateway` after fixing the env file.

### 7. Reverse proxy + TLS

```bash
apt-get install -y caddy
cp /opt/wharf/deploy/Caddyfile /etc/caddy/Caddyfile
sed -i 's/panel.example.com/panel.yourdomain.tld/' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy obtains and renews the certificate itself; ports 80 and 443 must be open
inbound. nginx users: see `nginx.conf.example` (certbot instructions in its
header).

### 8. Backups

```bash
chmod +x /opt/wharf/deploy/*.sh
/opt/wharf/deploy/backup.sh                      # prove it works now
crontab -e   # as root:
```

```cron
# WHARF panel database backup — nightly 03:15, 14-day retention
15 3 * * * /opt/wharf/deploy/backup.sh >> /var/log/wharf-backup.log 2>&1
```

The script sets its own `PATH` (cron's is nearly empty) and writes to
`/var/backups/wharf`. Add `WHARF_BACKUP_RCLONE_REMOTE=...` to the crontab line
or to root's environment for an offsite copy.

**And back up `WHARF_MASTER_KEY` separately, somewhere that is not this VPS
and not the same store as the dumps.** The dump contains only ciphertext for
every SSH credential and Supabase secret. Dump + key = recovery. Dump alone =
a panel that can list your fleet and touch none of it. `restore.sh` says this
too, at the top, because it is the single fact that decides whether a bad day
is a bad hour.

---

## Connecting to the Supabase Postgres

The panel's metadata database is **your own Supabase project's Postgres**, not
something WHARF installs. Two connection strings, and they are not
interchangeable.

| Variable | Port | Used by | Why |
|---|---|---|---|
| `DATABASE_URL` | **6543** (pooled / pgbouncer) | the running panel + gateway | Prisma opens a connection per process; the pooler keeps that off the database's connection limit. Keep `?pgbouncer=true` — it tells Prisma to stop using prepared statements, which transaction-mode pooling cannot support. |
| `DIRECT_URL` | **5432** (direct) | `prisma migrate deploy`, `pg_dump`, `pg_restore` | DDL, advisory locks and `pg_dump` all need a real session. Through pgbouncer in transaction mode they fail with confusing errors (`prepared statement "s0" already exists`, migration advisory-lock timeouts). |

```bash
# Supabase → Project Settings → Database → Connection string
DATABASE_URL="postgresql://postgres.<ref>:<PASSWORD>@<host>:6543/postgres?pgbouncer=true&sslmode=require"
DIRECT_URL="postgresql://postgres:<PASSWORD>@<host>:5432/postgres?sslmode=require"
```

**Always `sslmode=require`.** The connection crosses the public internet
between two VPSs. Without it libpq will happily fall back to plaintext, and
every query — including the ciphertext blobs and the session JWT lookups —
crosses unencrypted. Supabase-hosted projects enforce TLS server-side; a
self-hosted Supabase may not.

**Egress allowlist.** If the database restricts inbound connections (Supabase
Network Restrictions, a cloud firewall, or `pg_hba.conf` on a self-hosted
box), allow this VPS's **egress** IP — which is not always the IP its DNS
record points at:

```bash
curl -s https://api.ipify.org        # the address the database will actually see
```

Add it as a `/32`. Both ports 5432 and 6543 must be reachable — a common
failure is allowing only 6543, which leaves the panel running fine and
`prisma migrate deploy` (and every backup) timing out.

Diagnose in this order:

```bash
npm run db:check                       # Prisma's view: both URLs, migrations
psql "$DIRECT_URL" -c 'select 1'       # raw direct connectivity
psql "$DATABASE_URL" -c 'select 1'     # raw pooled connectivity
```

Inspect diagnostic output privately before sharing it: database tools and
service logs may include deployment addresses, account names or SQL errors.
Remove those details and any credentials before posting a public issue.

---

## Everyday commands

```bash
# deploy a released tag (and the rollback path — code only, see deploy.sh)
sudo /opt/wharf/deploy/deploy.sh v1.4.0

# what is running right now
cat /opt/wharf/deploy/.deployed-tag

# restart without deploying (e.g. after editing /etc/wharf/.env)
sudo systemctl restart wharf-panel wharf-gateway

# backup now, verify a dump, restore
sudo /opt/wharf/deploy/backup.sh
sudo /opt/wharf/deploy/restore.sh --dry-run /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump
sudo /opt/wharf/deploy/restore.sh          /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump
```

Anything stranger than this — a changed host key, a stuck provision, Let's
Encrypt refusing to issue, rotating the master key — is in `docs/runbook.md`.
