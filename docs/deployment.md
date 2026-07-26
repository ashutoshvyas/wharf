# WHARF deployment

The panel and gateway run **directly on a VPS as node processes — no Docker**.
Deployment is manual; GitHub Actions does not deploy or access your servers.
Keep real environment files and credentials outside the repository.
The panel's metadata database lives on your own Supabase Postgres. Docker exists
only on *managed* servers, where the provisioning engine deploys Supabase stacks.

---

## Domains and the Studio SSO chain

This is the one part of the setup where a wrong value produces a confusing
symptom instead of an error, so it is worth getting right first. The panel
validates it at boot and warns loudly (`lib/config-check.ts`).

### The three settings

| Variable | Example | What it controls |
|---|---|---|
| `INSTANCE_DOMAIN` | `wharf.example.com` | Apex that instance subdomains are created under: `{slug}.wharf.example.com` (public API) and `studio-{slug}.wharf.example.com` (Studio). |
| `COOKIE_DOMAIN` | `.wharf.example.com` | Domain the panel's session cookie is scoped to. |
| `PANEL_URL` / `NEXTAUTH_URL` | `https://panel.wharf.example.com` | Where the panel is served, and the address Traefik calls for forwardAuth. |

### Why they must share an apex

Opening Studio works like this:

```
browser → https://studio-clienta.wharf.example.com
   └─ Traefik `wharf-auth@file` middleware
        └─ GET https://panel.wharf.example.com/api/auth/verify   (browser's cookies forwarded)
             ├─ 200 → request continues to the Studio container
             └─ 401 → browser is sent to the panel login with ?returnTo=…
```

The browser only attaches the `wharf.session` cookie to that subrequest if the
cookie's domain covers `studio-clienta.wharf.example.com`. That means **the panel must
live under the same apex as your instances**, and `COOKIE_DOMAIN` must be that
apex. If you host the panel on an unrelated domain, every Studio request is
denied and the user is bounced to login in a loop — with nothing in any log to
explain it.

Valid combination:

```
INSTANCE_DOMAIN="wharf.example.com"
COOKIE_DOMAIN=".wharf.example.com"
PANEL_URL="https://panel.wharf.example.com"      # panel is under the apex ✓
```

Invalid (panel on a different apex — Studio SSO cannot work):

```
INSTANCE_DOMAIN="wharf.example.com"
COOKIE_DOMAIN=".wharf.example.com"
PANEL_URL="https://wharf.mycompany.io"   # ✗ boot warning
```

In local development leave `COOKIE_DOMAIN` empty — browsers reject
domain-scoped cookies for `localhost`, and Studio SSO cannot be exercised
locally anyway.

### Your reverse proxy must not rewrite X-Forwarded-Host on the way to /api/auth/verify

Look back at the diagram above: Traefik's forwardAuth subrequest carries its
own `X-Forwarded-Host`/`X-Forwarded-Uri`, describing the `studio-clienta.…`
request it's actually gating — that's the only way `/api/auth/verify` knows
where to send the user back to after login. That subrequest travels through
**your** reverse proxy in front of the panel VPS before it reaches the app,
and if that proxy sets those same header names itself — which nginx doesn't
by default, but Caddy does, and so do most control-panel-generated vhosts
(CloudPanel, Plesk, etc.) — it silently overwrites Traefik's value with its
own idea of the current host (i.e. the panel's own hostname). The symptom is
exactly what it sounds like: Studio bounces to `/login`, and after signing in
you land on the panel's dashboard instead of back in Studio, with nothing in
any log to explain why.

`deploy/nginx.conf.example` and `deploy/Caddyfile` both carry a dedicated
`/api/auth/verify` block that passes Traefik's original header through
unmodified for this one route (and only this route — every other request
still gets your proxy's own, correct values). If you're on a different proxy
or a control-panel-managed vhost you don't fully control, add the equivalent:
forward the *incoming* `X-Forwarded-Host` for this path instead of
overwriting it with the proxy's own host.

This can't be turned into an open redirect by a forged header, direct or
otherwise: `/api/auth/verify` only ever trusts a forwarded host that falls
under `INSTANCE_DOMAIN` and isn't the panel's own host — anything else is
dropped and the user just lands on a bare `/login` with no `returnTo`.

### Restoring a backup needs a larger upload limit on one route

Every other panel route is deliberately capped small (`client_max_body_size
4m` in `deploy/nginx.conf.example`'s server block — "nothing large is ever
uploaded to the panel"). Restoring a Postgres backup is the one
exception: the upload can be up to 2 GiB, so it needs its own override rather
than loosening the limit everywhere.

`deploy/nginx.conf.example` carries a dedicated `location` block for
`/api/db-instances/*/restore` with a much larger `client_max_body_size` and
longer read timeouts, plus adds `restore-log` to the existing SSE location so
the restore progress stream gets the same unbuffered, long-read-timeout
treatment as provisioning/bootstrap logs. If you're on a control-panel-managed
vhost (not this repo's example file), add the equivalent override for that
one path before attempting a real restore — otherwise the upload is silently
truncated at whatever the surrounding limit is. Caddy needs no change: it has
no default body-size limit.

### Syncing from a live database needs no upload limit, but does need egress

Sync is the same overwrite fed from a live source instead of a file,
and it deliberately never routes the data through the panel: `POST
/api/db-instances/:id/sync` carries a few hundred bytes of JSON, and the dump
happens on the managed server. So the panel vhost needs only one change —
`sync-log` added to the SSE `location` regex (already done in the example
file), so the progress stream is unbuffered like the others.

The requirements move to the **managed server** instead:

- **Outbound to the source database** — TCP to the source's Postgres port
  (5432, or 6543 for a Supabase pooler). Hosts that egress-filter need that
  opened, otherwise the sync fails cleanly in its `connect` phase.
- **Reaching its own instance over HTTPS**, but only when the source is
  copying storage objects: the copy script uploads to
  `https://{slug}.{INSTANCE_DOMAIN}`, which resolves to the server's own
  public IP. Most setups hairpin fine; a host that blocks that needs a
  hosts-file entry pointing the instance's API subdomain at `127.0.0.1`.
- **`curl` installed.** The copy script uses it; the sync fails with an
  explicit message if it is missing.

### Direct Postgres access needs inbound 5432/6543 on the managed server

Per-database IP policies and adoption of existing Docker firewall restrictions
are available through **Network access**. See [Database network access](network-access.md)
for the migration, one-time server setup, and live validation procedure. New
instances start with PostgreSQL client connections allowed from all reachable
addresses; use Network access to add restrictions when needed.

Unrelated to the egress above — this is inbound, for clients connecting
*into* a provisioned instance's Postgres directly (`psql`, an ORM's
`DATABASE_URL`), rather than through the REST API. Bootstrap opens both ports
once per managed server (`ufw allow 5432/tcp && ufw allow 6543/tcp`) for the
one shared Supavisor pooler (`templates/pooler/`, docs/architecture.md §4.1);
a cloud firewall/security-group in front of the host needs the same two ports
opened manually, the same way 80/443 already need to be. See
docs/provisioning-contract.md §7 for the resulting connection-string
convention.

### DNS

Two records:

| Record | Points at | Why |
|---|---|---|
| `panel.wharf.example.com` A | panel VPS | serves the control panel |
| `*.wharf.example.com` A | **database server** | every instance's two subdomains, forever — created once, never touched again |

The wildcard is the one manual prerequisite of the whole system (spec §2).

---

## Panel VPS

Requirements: Node 22, a reverse proxy for TLS, and network access to your
Supabase Postgres.

```bash
git clone <repo> /opt/wharf && cd /opt/wharf
cp .env.example /etc/wharf/.env      # fill in; chmod 600, owned by the service user
npm ci
npm run db:check                     # read-only: connectivity + migration status
npm run db:deploy                    # applies migrations via DIRECT_URL
npm run db:seed                      # creates the first admin
npm run build && npm run build -w gateway
```

> ⚠️ `npm run build` already assembles the standalone bundle (it runs
> `scripts/prepare-standalone.sh`). Use `deploy/deploy.sh`, which also runs
> migrations, restarts both services and health-checks them.
> `deploy/README.md` has the full first-time install.

Run both processes under systemd (`deploy/systemd/`), with
`EnvironmentFile=/etc/wharf/.env`. Front them with Caddy:

```
panel.wharf.example.com {
    handle /ws/* {
        reverse_proxy localhost:3001   # Terminal Gateway (WebSocket upgrade)
    }
    reverse_proxy localhost:3000       # Panel
}
```

**Secrets:** `WHARF_MASTER_KEY` and `NEXTAUTH_SECRET` belong only in
`/etc/wharf/.env` (mode 600). Keep a copy of the master key **off** the VPS —
a database backup is undecryptable without it.

---

## Database server

A **separate** machine from anything already serving web traffic. Requirements:

- **Nothing bound to ports 80 or 443** — Traefik must own the edge. The
  provisioning preflight aborts before touching the server if these are taken.
- SSH access for the panel (an ed25519 key generated from the server page is
  the recommended path).
- The `*.INSTANCE_DOMAIN` wildcard record pointing at its IP.
- Reasonable disk: each Supabase stack is a few GB.

You do **not** prepare this server manually. Register it in the panel, then
provision the first database onto it — preparation (Docker, the shared
`traefik` network, Traefik with Let's Encrypt, firewall) runs automatically as
the first phase of that first provision, and is skipped for every instance
after (architecture §4.1).

---

## Verifying a deployment

1. `npm run db:check` — connected, all migrations applied.
2. Panel boot logs contain **no** `[wharf] configuration problems` block.
3. Sign in; the Servers, Websites and Databases pages render.
4. Register the database server; open its Terminal tab and run `id`.
5. Provision a throwaway instance. Watch the phase checklist reach `health`.
6. Visit `https://{slug}.INSTANCE_DOMAIN/rest/v1/` with the anon key — the API
   answers (certificate issued on first request).
7. Click **Manage** — Studio loads inside the panel with no second login. That
   proves the whole forwardAuth chain.
8. Remove the throwaway instance; confirm the volumes are gone on the server.

---

## Building by hand

`deploy/deploy.sh <tag>` does everything in this section, and asserts the
result. Read it if you are building manually — both steps fail *silently*,
in the browser, with a clean server log.

```bash
cd /opt/wharf
set -a; . /etc/wharf/.env; set +a          # NEXT_PUBLIC_* is baked in at build

npm run build                              # includes scripts/prepare-standalone.sh
npm run build -w gateway

rm -f .next/standalone/.env                # build artefact; secrets live in /etc/wharf/.env

chown -R wharf:wharf /opt/wharf
```

**1. Security headers are applied at RUNTIME, not build time.** The CSP
(including `frame-src` for the Studio iframe and `connect-src` for the
terminal socket) is built per request in `middleware.ts` from `INSTANCE_DOMAIN`
and `GATEWAY_WS_URL`. Changing either takes a **restart**, not a rebuild, and a
build that ran without them cannot ship a broken policy. Check what is live:

```bash
curl -sI https://panel.<domain>/login | grep -i content-security-policy
```

Note `NEXT_PUBLIC_GATEWAY_WS_URL` is still inlined at build time — it is what
the browser bundle uses to open the terminal socket — so keep it in sync with
`GATEWAY_WS_URL`.

**2. `next build` does not populate the standalone bundle's assets.**
`output: "standalone"` emits a self-contained `.next/standalone/server.js`,
but deliberately leaves `.next/static` and `public/` out of it. Skip the copy
and the panel serves unstyled HTML with every JS chunk 404ing.

**3. The reverse proxy must add no security headers.** The application sets
CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and
`nosniff` itself. A CSP added in Caddy *replaces* the app's; one added in
nginx is enforced *alongside* it. Either kills the Studio iframe, invisibly.
`deploy/Caddyfile` and `deploy/nginx.conf.example` ship with none, and say why.

---

## Day-two operations

This document ends where the system is running. From there:

| Need | Go to |
|---|---|
| First-time VPS install, systemd, backups, cron, Supabase connection | `deploy/README.md` |
| Something is broken — host key changed, stuck provision, LE not issuing, restore, key rotation | `docs/runbook.md` |
| Deploying and rolling back a release | `deploy/deploy.sh` header + `docs/runbook.md` → "Rolling back a release" |

One fact worth carrying out of this document: **the panel database backup is
ciphertext without `WHARF_MASTER_KEY`.** Back the key up separately from the
dumps, and drill restoring them together.
