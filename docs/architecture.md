# WHARF — Architecture Document

**Product:** WHARF — self-hosted hosting control plane (Websites · Servers · Databases)
**Source spec:** `docs/spec-v2.md`

---

## 1. System overview

WHARF is a control plane, not a data plane. It stores *metadata about* servers, websites, and Supabase instances, and it *acts on* real servers over SSH. The live traffic of hosted websites and Supabase APIs never passes through WHARF — Traefik on each server routes that directly. If the panel is down, everything it manages keeps running.

```
                        ┌─────────────────────────────────────────────┐
                        │                WHARF host                   │
 Browser ── HTTPS ────▶ │  Next.js 15 Panel (App Router, TS)          │
          │             │   ├─ UI (React, Tailwind, shadcn/ui)        │
          │             │   ├─ API routes (/api/*)                    │
          │             │   ├─ Auth (NextAuth credentials + RBAC)     │
          │             │   ├─ Provisioning Engine (lib, SSH-driven)  │
          │             │   └─ Prisma ──▶ Panel Postgres              │
          │             │                                             │
          └─ WSS ─────▶ │  Terminal Gateway (standalone Node, ws+ssh2)│
                        └───────────────────┬─────────────────────────┘
                                            │ SSH (exec / SFTP / shell)
                                            ▼
                        ┌─────────────────────────────────────────────┐
                        │            Managed Server (×N)              │
                        │  Traefik (Docker provider, Let's Encrypt)   │
                        │   ├─ {slug}.domain        → Kong (public)   │
                        │   └─ studio-{slug}.domain → Studio          │
                        │        (forwardAuth → panel /api/auth/verify)│
                        │  Supabase stack sb_xxxx (isolated compose)  │
                        │  Supabase stack sb_yyyy (isolated compose)  │
                        │  Websites (static/CMS, tracked as metadata)  │
                        └─────────────────────────────────────────────┘
```

### 1.1 Components

| Component | Runtime | Responsibility |
|---|---|---|
| **Panel (Next.js)** | Node, long-running (not serverless) | UI, REST API, auth/RBAC, audit log, provisioning orchestration |
| **Terminal Gateway** | Standalone Node service (`ws` + `ssh2`) | Browser ⇄ SSH shell streaming for the in-browser terminal |
| **Panel Postgres** | Postgres 16 + Prisma | All metadata: servers, websites, db_instances, users, audit_log |
| **Traefik (per managed server)** | Docker container, installed by bootstrap | TLS termination, per-instance subdomain routing, forwardAuth gating of Studio |
| **Supavisor pooler (per managed server)** | Docker Compose project `wharf-pooler`, installed by bootstrap | Shared connection pooler fronting every instance's Postgres for direct wire-protocol access (`postgres.{composeProjectName}@server:5432\|6543`) — the same "one shared thing per server, instances register into it" shape as Traefik, but at the TCP layer instead of HTTP (`templates/pooler/`) |
| **Supabase stacks (per instance)** | Docker Compose project `sb_<id>` | The actual provisioned databases: db, kong, auth, storage, meta, studio, realtime |

### 1.2 Core design decisions (inherited from spec, restated as constraints)

1. **SSH is the only channel to managed servers.** Terminal, bootstrap, provisioning, teardown — all use the credentials stored in the Servers module. No Docker remote API, no exposed Docker TCP socket, one trust boundary.
2. **Two subdomains per instance.** `{slug}.domain` → Kong, never gated (live apps depend on it). `studio-{slug}.domain` → Studio, gated by Traefik forwardAuth against the panel session. No path-splitting.
3. **Native Studio, not a rebuilt one.** "Manage" opens the gated Studio in an iframe inside the panel shell (new-tab fallback if frame headers block it). A custom unified dashboard is a documented later layer, not part of this build.
4. **One manual prerequisite:** a wildcard DNS record `*.domain → server IP` per managed server. Everything else per-instance is zero-touch (Traefik labels + on-demand Let's Encrypt HTTP-01).
5. **The panel is disposable; the servers are not.** Panel DB holds secrets and metadata but every running instance survives panel loss. Recovery = restore panel DB backup.

---

### Phone OTP delivery through WHARF

Twilio and MSG91 use Supabase Auth's signed Send SMS hook. The instance generates
and verifies OTPs; WHARF delivers them. Twilio uses the per-instance SMS/WhatsApp
selection and optional SMS fallback. This delivery path requires the panel to be
reachable even though the managed stack continues running independently.

Twilio status callbacks authenticate with the Twilio SDK against the original
public callback URL and encrypted credential snapshot. `phone_deliveries` stores
short-lived encrypted delivery payloads and durable send claims, not user sessions
or verification outcomes. PostgreSQL locks and conditional updates prevent duplicate
hook requests or concurrent failure callbacks from sending multiple fallbacks.
Fallback sends the same unexpired code once after a definite WhatsApp failure;
unknown delivery or unread messages do not trigger a timed fallback. Terminal or
superseded payloads are cleared immediately, expired payloads on a one-minute sweep
while the panel is running, and replay records after 24 hours.

Existing native Twilio instances move to this path when their Auth settings are
next saved/reapplied. Deploy the migration first. See the public `/docs/sms/twilio`
guide for sender setup, application integration, and operational limitations.

## 2. Deployment topology

> The panel itself is not containerized.
> It deploys directly on a VPS as plain node processes, and its metadata DB is the
> Postgres of the owner's own Supabase server. Docker exists only on *managed*
> servers, where the provisioning engine deploys Supabase stacks — that is the
> product's job, not this app's runtime.

**Panel VPS** (can itself be one of the managed servers; processes are independent):

```
VPS
├─ panel    — Next.js production server (`next build && next start`),
│             long-running node process under systemd/pm2. Not serverless:
│             provisioning runs multi-minute SSH jobs in-process.
├─ gateway  — Terminal Gateway node process (ws + ssh2), systemd/pm2.
└─ caddy/nginx — TLS + reverse proxy:
     panel.domain      → localhost:3000
     panel.domain/ws/* → localhost:3001 (WebSocket upgrade passthrough)

Panel metadata DB → owner's Supabase server Postgres (external):
  DATABASE_URL  = pooled connection (pgbouncer :6543, pgbouncer=true) at runtime
  DIRECT_URL    = direct connection (:5432) for prisma migrate
  TLS required (sslmode=require)
```

Secrets (`WHARF_MASTER_KEY`, `NEXTAUTH_SECRET`) live in `/etc/wharf/.env` (mode 600,
owned by the service user) loaded via systemd `EnvironmentFile` — never in the repo.
A copy of the master key is stored off-VPS: the DB backup is undecryptable without it.

**Managed servers** need nothing pre-installed except sshd. Bootstrap (§4.2) installs Docker, the Compose plugin, the shared `traefik` network, and the Traefik container.

**Scaling model:** vertical on the panel (it's an admin tool for one team, not multi-tenant SaaS); horizontal on managed servers by registering + bootstrapping more of them. Each managed server is fully independent (own Traefik, own wildcard/A records) — adding one changes no architecture.

---

## 3. Data model

Prisma schema mirrors spec §3 exactly. Notes beyond the spec:

- All `*_enc` columns are `bytea` holding `iv ‖ ciphertext ‖ authTag` (AES-256-GCM, §6).
- `db_instances.status` state machine: `provisioning → running ⇄ stopped`, `provisioning → error`, `running|stopped|error → removing → (soft-deleted)`. Transitions only via the engine; UI reads, never writes status.
- `db_instances` gains `deleted_at timestamptz` (soft-delete grace period, spec §6.4) and `health_checked_at` (fleet dashboard freshness).
- `audit_log` is insert-only: enforced by a Postgres trigger raising on UPDATE/DELETE, plus the Prisma layer simply never exposing update/delete for it.
- `websites.credential_label` default `'Admin login'` keeps the credential pair generic (CMS vs FTP vs other — per-site meaning).
- Uniqueness: `db_instances.slug` globally unique (subdomains are global under one wildcard domain per server); `(server_id, remote_path)` unique.

---

## 4. Module architecture

### 4.1 Servers

**SSH connection service (`lib/ssh.ts`)** — the single choke point for all SSH:

- `withConnection(serverId, fn)` — decrypts credentials in-memory, opens an `ssh2` client, runs `fn(conn)`, always closes. Nothing else in the codebase touches `ssh2` directly.
- `exec(conn, cmd, {timeout, onData})` — command with streamed stdout/stderr and hard timeout.
- `sftpWrite(conn, remotePath, content, mode)` — used by bootstrap and provisioning.
- Host key policy: TOFU — first successful connection stores the host key fingerprint on the `servers` row; later mismatches hard-fail with an explicit "host key changed" error (MITM guard).
- Keypair generation: panel can generate ed25519 keypairs server-side (`crypto.generateKeyPair`), store the private key encrypted, and show the public key once for the user to paste into `authorized_keys` — the recommended path over password storage.

**Bootstrap — when it runs.** Servers are **never bootstrapped up-front**. Registering a server for the Websites module or SSH terminal does not install the database stack. Preparation is lazy and implicit:

- Registering a server does nothing to it. There is no "prepare this server" step in the onboarding flow, and the server page shows database-hosting state as information, not as a call to action.
- The **first time a database instance is provisioned onto a server**, the provisioning pipeline prepares that server as its opening phase: preflight, then the bootstrap steps below, then the instance itself — all in one job, one log stream, under the same per-server lock.
- Subsequent instances on that server skip preparation (`servers.bootstrapped` is already true).
- A manual re-run remains available for servers that *already* host databases: it re-uploads Traefik config (how a changed `PANEL_URL` or Let's Encrypt email reaches the server) and installs the pooler on a server bootstrapped before the pooler existed. It is a maintenance action, not an onboarding one.

**Preflight (runs before anything is installed).** Because preparation now happens inside provisioning, it must fail *before* mutating a server that cannot work as a database host: check that nothing is already listening on **80/443/5432/6543** (the conflict that ruled out the nginx box — open question §5; 5432/6543 for the same reason, ahead of the pooler bootstrap step), that the SSH user can act as root, and that there is adequate disk. A failed preflight aborts with an explanatory error and leaves the server untouched.

**Bootstrap steps (`POST /api/servers/:id/bootstrap`, also invoked in-process by the provisioning pipeline)** — idempotent script executed step-by-step over SSH (each step checked before applied, safe to re-run):

1. Install Docker Engine + Compose plugin (skip if `docker compose version` succeeds).
2. `docker network create traefik` (skip if exists).
3. `docker network create wharf-pooler` (skip if exists) — the network the shared Supavisor pooler and every instance's `db` join (never Traefik's network — Postgres stays off the public-facing one).
4. SFTP Traefik static config + compose file to `/opt/wharf/traefik/`; `docker compose up -d`. Config enables: Docker provider (label-driven), entrypoints 80/443, HTTP→HTTPS redirect, Let's Encrypt resolver (HTTP-01), and a `wharf-auth` forwardAuth middleware pointed at the panel's public `/api/auth/verify` URL.
5. SFTP the pooler's compose file to `/opt/wharf/pooler/` (secrets generated once and persisted on the `servers` row, reused on every re-run — see `lib/bootstrap/pooler-secrets.ts`); `docker compose up -d`. A one-shot init service creates a persistent per-server certificate/key and Supavisor uses them for PostgreSQL TLS negotiation. Ports 5432 (session mode) and 6543 (transaction mode) remain directly published; each tenant independently enforces or permits plaintext according to its instance `sslMode`.
6. Open firewall 80/443/5432/6543 (ufw if present; report-only otherwise).
7. Set `servers.bootstrapped = true`. Step results streamed to the UI (same SSE mechanism as provisioning, §4.3).

**Linked panel:** `linked_panel_url` renders as a plain "Open panel ↗" deep link (new tab). Explicitly *not* SSO — third-party panels would need their own token APIs.

### 4.2 Terminal Gateway

Separate long-lived Node service — WebSocket duplex streams don't fit Next.js API routes.

```
Browser (xterm.js) ── WSS /ws/terminal/:server_id ──▶ Gateway ── ssh2 shell ──▶ Server
```

- **Auth on upgrade:** gateway validates the panel's NextAuth session (shared `NEXTAUTH_SECRET`, JWT session strategy so the gateway can verify the cookie without a DB round-trip). Invalid/missing session → connection refused before upgrade. Role `viewer` is refused; `operator`/`admin` allowed.
- **Credential handling:** gateway reads the server row + decrypts credentials itself (same master key) — credentials never transit the browser or the panel↔gateway boundary.
- **Protocol:** binary frames = terminal bytes both directions; JSON control frames for `{resize: {cols, rows}}` and `{ping}`. Idle timeout (30 min) and max session duration configurable.
- **Audit:** session open/close rows in `audit_log` (user, server, duration). Metadata only — no keystroke transcripts (spec's recommendation; revisit only for a compliance need).

### 4.3 Provisioning Engine (`lib/provision/`)

Runs inside the panel process as an async job per instance; because jobs are multi-minute, the panel is deployed as a long-running Node server (§2). Single-flight lock per server (one provision/teardown at a time per host) via a Postgres advisory lock.

**Provision pipeline** (status = `provisioning`, every step appends to a log buffer streamed via SSE and persisted to `last_action_log`):

1. **Validate:** target server bootstrapped, slug unique + `[a-z0-9-]`, no path collision.
2. **Generate secrets:** Postgres password, JWT secret; sign anon + service_role HS256 JWTs (`role` claims) with that secret.
3. **Render artifacts:** `docker-compose.yml` + `.env` from the official Supabase self-hosting template (checked into the repo under `templates/supabase/`, version-pinned — never fetched at provision time). Parameterized with `compose_project_name`, secrets, and Traefik labels:
   - `kong`: `` Host(`{slug}.{domain}`) ``, TLS resolver, **no** auth middleware.
   - `studio`: `` Host(`studio-{slug}.{domain}`) ``, TLS resolver, `wharf-auth` forwardAuth middleware.
   - Both joined to the external `traefik` network; `db` additionally joins the external `wharf-pooler` network under alias `{project}-db` (step 7 below); every other internal service stays on the project-private network only.
4. **Deploy:** SFTP both files to `remote_path` (`/opt/db-instances/sb_xxxx/`), then `docker compose -p sb_xxxx up -d`.
5. **Health poll with backoff, ~3–5 min cap:** `docker compose exec db pg_isready` / `SELECT 1`, then Kong health route — checked from *inside the server* over SSH exec (no dependency on DNS/TLS having settled yet).
6. **Finalize:** success → encrypt + store secrets, subdomains, status `running`. Failure → status `error`, log tail kept visible, **no silent retry**; user chooses Retry (safe: `up -d` is idempotent) or Remove. **Retry reuses the instance's stored secrets** and never regenerates them: `up -d` does not re-initialise an existing Postgres volume, so a fresh `POSTGRES_PASSWORD` would land in `.env` while `pg_authid` kept the old one, breaking every container's login; rotating `jwtSecret` would additionally invalidate the `anon`/`service_role` keys every client app holds. Secrets are generated only when the row has none.
7. **Pooler:** `PUT` this instance into the server's shared Supavisor as tenant `{composeProjectName}` (`lib/provision/pooler.ts`, admin API reached via `curl localhost:4000` over the same SSH connection), including `enforce_ssl` from the stored instance mode. It is reachable as `postgres://postgres.{composeProjectName}:{pgPassword}@{server host}:5432|6543/postgres?sslmode=require|disable` — no new tenant secret, reuses the instance's generated `pgPassword`.

**Stop / Start:** `docker compose -p sb_xxxx stop` / `start` over SSH; status flips accordingly. Stop leaves volumes intact; Traefik routers vanish while containers are down (subdomains go quiet) — reversible.

**Remove permanently** (admin-only, type-the-name confirmation): best-effort deregister from the shared pooler (failure here is logged, never blocks removal) → `docker compose -p sb_xxxx down -v` → `rm -rf remote_path` (path validated against the DB row, never user input) → soft-delete row (`deleted_at`) + audit entry; hard purge after grace period. Confirmation copy states plainly that volume data is unrecoverable even though the metadata row lingers.

**Replace an instance's data — two sources, one pipeline** (admin-only, type-the-name confirmation, status `restoring`). Both take a `pg_dump` of the current data first and leave it on the server under `{remote_path}/backups/` — that snapshot is the only way back, and the confirmation copy says so.

- **Restore from an uploaded dump** (`lib/provision/restore.ts`, `restore:{id}`, phases `upload → snapshot → restore → cleanup`): the operator's file is POSTed to the panel, SFTP'd to the host, then `docker compose cp`'d into the `db` container.
- **Sync from a live source database** (`lib/provision/sync.ts`, `sync:{id}`, phases `connect → dump → snapshot → restore → storage → cleanup`): a hosted Supabase project or any reachable Postgres, addressed by stored (encrypted) connection details. `pg_dump` runs **inside the instance's own `db` container** against the source, so the client tools are version-matched, nothing is installed on the host, and the dump never transits the panel — the control-plane/data-plane split of §1 holds. Storage objects are copied the same way: a generated script on the managed server `curl`s them from the source's Storage API into this instance's, so storage-api owns its own on-disk layout.

  Every target-side pg_dump/pg_restore/psql runs as **`supabase_admin`**, not `postgres` — in `supabase/postgres` the `postgres` role is not a real superuser (supautils marks the service roles reserved) and, since PG15, cannot create objects in `public` at all (owned by `pg_database_owner`). Restoring as `postgres` fails on every CREATE and silently leaves an empty schema. Because a non-zero pg_restore exit is otherwise tolerated as cross-environment noise, the main pass is verified afterwards by counting tables in the restored schemas: errors *plus* nothing created is a hard failure, not a warning.

  After the data is in, both engines re-assert the instance's OWN role passwords (`postgres`, `authenticator`, `pgbouncer`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_storage_admin`). A dump belongs to a cluster whose roles had different credentials, and a cross-environment load can leave the instance's own containers unable to authenticate against their own database — Studio reporting `password authentication failed for user "postgres"` is the first visible symptom, but PostgREST, GoTrue and storage-api share the mechanism. The password is read from the db container's own environment (the same psql idiom `roles.sql` uses), so it never enters the SQL, the command line or the log.

  Three dump passes, loaded in a deliberate order: data-only `auth.*`, then data-only `storage.*`, then the full `public` (+ extra schemas) dump. Data-only for auth/storage because the local GoTrue/storage-api containers own those *schemas* and their migration state; identity first because clearing `auth.users` needs `TRUNCATE … CASCADE`, which would delete app rows if the main pass had already loaded them.

Because both engines write `restoring`, the instance DTO carries a derived `activeJob` naming the live job's kind — that is what tells a client which log stream to follow.

**Crash consistency:** if the panel dies mid-provision, the row is stuck in `provisioning`. On boot, the engine sweeps rows older than the timeout → marks `error` with "interrupted" note; Retry re-runs the idempotent pipeline. The same sweep covers `removing` and `restoring` (a restore or sync interrupted the same way), checking all four job ids for liveness first so a genuinely long job is never swept out from under itself. Orphan detection (compose projects on a server with no matching row) is surfaced on the server detail page, resolution manual.

### 4.4 Websites

Pure CRUD over `websites` (§3): domain, server FK, filesystem path, optional `db_instance` FK, one labeled encrypted credential pair, notes. The server detail page joins websites + db_instances for the per-server "everything hosted here" view. No SSH actions in this module.

### 4.5 Studio SSO gating

```
Browser → https://studio-{slug}.domain
  → Traefik: wharf-auth forwardAuth → GET https://panel.domain/api/auth/verify
      (browser's panel session cookie forwarded — requires panel + studio
       subdomains to share a cookie domain, or cookie set on the apex)
  → 200 → request passes to Studio container
  → 401 → Traefik redirects to panel login with returnTo
```

- `/api/auth/verify` checks: valid session AND role ≥ operator. Cheap (JWT verify, no DB) since it runs on every Studio asset request.
- **Cookie domain is a hard requirement:** the panel session cookie must be scoped to `.domain` so the browser sends it to `studio-*.domain`. If the panel lives on a different apex, forwardAuth can't see the session — deployment docs must state this.
- "Manage" renders the Studio URL in an iframe inside the panel shell. Build-time check: if Studio/Kong emit `X-Frame-Options`/CSP `frame-ancestors` that block it, strip via Traefik response-header middleware on the studio router; if that proves fragile, fall back to "open in new tab" (still zero-login). One config check, not a design risk.

---

## 5. API surface

All routes under panel auth; role gates as listed. Mutations write `audit_log`.

| Route | Method(s) | Role | Notes |
|---|---|---|---|
| `/api/servers`, `/api/servers/:id` | GET / POST / PATCH / DELETE | GET: viewer · write: admin | DELETE blocked while server has instances/websites |
| `/api/servers/:id/bootstrap` | POST | admin | SSE progress stream |
| `/api/servers/:id/keypair` | POST | admin | Generate ed25519 keypair, return public key once |
| `/ws/terminal/:server_id` | WS (gateway) | operator | Session-authenticated upgrade |
| `/api/websites`, `/api/websites/:id` | GET / POST / PATCH / DELETE | GET: viewer · write: operator | |
| `/api/db-instances` | GET / POST | GET: viewer · POST: operator | POST starts provisioning, returns id immediately |
| `/api/db-instances/:id` | GET / DELETE | DELETE: **admin** | DELETE = permanent remove, name-confirmation enforced server-side |
| `/api/db-instances/:id/stop` · `/start` | POST | operator | |
| `/api/db-instances/:id/ssl-mode` | PATCH | **admin** | Applies `require`/`disable` to the existing shared-pooler tenant; audited |
| `/api/db-instances/:id/provision-log` | GET (SSE) | viewer | Live log during provision/bootstrap/teardown |
| `/api/auth/verify` | GET | — | Called by Traefik forwardAuth; 200/401 only |
| `/api/auth/*` | — | — | NextAuth handlers |

Decrypted secrets (anon/service_role keys, PG password) are returned **only** by an explicit reveal endpoint (`GET /api/db-instances/:id/secrets`, operator+, audited) — never embedded in list/detail payloads.

---

## 6. Security architecture

- **AuthN:** NextAuth credentials provider, bcrypt (cost ≥ 12), JWT session strategy (needed by gateway + forwardAuth verification without DB access). Admin 2FA is not currently implemented; see `docs/security-review.md` for the remaining security limitations.
- **AuthZ (RBAC):** `viewer` read-only · `operator` day-to-day (websites, provision, stop/start, terminal, secret reveal) · `admin` everything (servers, credentials, bootstrap, permanent remove, users). Enforced in a single API-layer guard, mirrored in UI affordances.
- **Secrets at rest:** AES-256-GCM via Node `crypto`; random 12-byte IV per value; master key from Docker secret/env, never logged, never persisted outside the secret store; decryption transient in-memory per request. Key-rotation utility: re-encrypt all `*_enc` columns under a new key (offline command).
- **Blast radius controls:** permanent remove is admin-only + typed-name confirmation + audited; teardown paths come from the DB row, never request input; audit log insert-only at the DB level; single-flight lock prevents concurrent destructive jobs on one server.
- **Network posture:** managed servers expose only 22/80/443. No Docker socket exposure. Panel Postgres not publicly bound. Gateway refuses unauthenticated upgrades pre-handshake.
- **Terminal:** metadata-only auditing (no transcripts) — deliberate privacy/compliance trade-off per spec.

---

## 7. Failure modes & recovery

| Failure | Behavior |
|---|---|
| Provision step fails / times out | status `error`, log tail preserved and visible; explicit Retry (idempotent) or Remove |
| Panel crashes mid-provision | Boot-time sweep marks stale `provisioning` rows as `error` ("interrupted"); Retry available |
| SSH unreachable | Server card shows unreachable state; queued actions fail fast with the SSH error verbatim |
| Host key changed | Hard-fail all actions on that server until an admin re-confirms the fingerprint |
| Let's Encrypt issuance delayed | Instance is `running` (health checks are server-local); UI notes certs are issued on first request and may take ~a minute |
| Studio blocks iframing | Traefik header-strip middleware; fallback "open in new tab" |
| Panel DB lost | Managed workloads unaffected; restore from backup. Without backup: instances keep running but panel loses keys/metadata — documented as *the* thing to back up |
| Accidental Remove | Metadata soft-deleted with grace period; **volume data is gone** — the confirmation copy says exactly that |

---

## 8. Repository layout

```
wharf/
├─ app/                      # Next.js App Router
│  ├─ (auth)/login/
│  ├─ (panel)/servers/  websites/  databases/     # the three modules
│  └─ api/                   # routes per §5
├─ components/               # ui kit (per Design doc) + module components
├─ lib/
│  ├─ crypto.ts              # AES-256-GCM seal/open
│  ├─ ssh.ts                 # single SSH choke point
│  ├─ provision/             # pipeline, compose templating, health checks
│  ├─ auth.ts  rbac.ts  audit.ts  db.ts
├─ gateway/                  # standalone Terminal Gateway service
├─ prisma/schema.prisma
├─ templates/
│  ├─ supabase/              # pinned official compose template + .env template
│  ├─ traefik/               # bootstrap artifacts
│  └─ pooler/                # shared per-server Supavisor pooler (bootstrap artifact)
└─ docs/                     # spec-v2.md, architecture.md, design.md
```

## 9. Managed-server prerequisites

Database servers need ports 80 and 443 free so Traefik can own the public edge.
Use a dedicated server when another reverse proxy already owns those ports.
Bootstrap checks port ownership before installing or changing anything and
rejects a conflicting host rather than displacing its existing services.

General-purpose servers can still be registered for the Websites module and SSH
terminal. Registering them does not bootstrap them; selecting an unsuitable
server for database provisioning fails preflight.

Each database server needs its own wildcard DNS record, and the panel must be
hosted under the same apex domain as the managed subdomains so the forwardAuth
session cookie reaches Studio. Linked third-party panels are deep links rather
than single sign-on integrations. Website credentials remain a flexible labeled
username/password pair.
