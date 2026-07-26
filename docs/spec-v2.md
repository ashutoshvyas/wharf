# WHARF product specification

WHARF is a self-hosted **hosting control plane** with three modules: Websites,
Servers and Databases. The Databases module provisions, manages and destroys
Supabase Docker stacks over SSH.

**Stack:** Next.js (App Router) + TypeScript + Prisma + Postgres, plus a small standalone WebSocket "Terminal Gateway" service for SSH.

---

## 1. Architecture overview

```
Browser ── HTTPS ──▶ Control Panel (Next.js)
                        │
                        ├── Terminal Gateway (WebSocket + ssh2) ──▶ SSH ──▶ any registered Server
                        │
                        ├── Provisioning Engine ──▶ SSH exec/SFTP ──▶ Server: docker compose up/down
                        │
                        └── Panel metadata DB (Postgres): servers, websites, db_instances, users, audit_log

On each Server that hosts databases:
  Traefik (reverse proxy, Docker provider, Let's Encrypt)
     ├── {slug}.yourdomain.com          → Kong (public Supabase API — used by the live website/app)
     └── studio-{slug}.yourdomain.com   → Studio container (admin UI — gated by Traefik forwardAuth → Panel session)
  Supabase stack #1 (project name sb_xxxx): db, kong, auth, storage, meta, studio, realtime
  Supabase stack #2 (project name sb_yyyy): same, fully isolated
```

**Key design decision:** all server actions (SSH terminal, provisioning, teardown) run over **SSH using the same credentials stored in the Servers module** — no separate Docker remote API, no exposed Docker TCP socket. One credential store, one trust boundary, and it scales naturally to multiple servers later.

**Key design decision #2:** each Supabase instance gets **two subdomains**, not one:
- `{slug}.yourdomain.com` → Kong only. This is what the live website/app actually calls at runtime (anon/service key auth, as normal). Never gated by panel login — it has to keep working even if nobody's logged into the panel.
- `studio-{slug}.yourdomain.com` → the Studio container, exposed directly (bypassing Kong). Gated by Traefik's `forwardAuth` middleware, which checks the panel's own session cookie before letting the request through. Log into the panel once → click "Manage" on any instance → straight into that instance's native Studio, no Supabase login screen, ever. Trying to path-split a single subdomain between "public API" and "admin UI" is fragile (Studio's assets live at `/`, same as some API-adjacent paths); two subdomains avoids that entirely and is basically how hosted Supabase separates project API from dashboard too.

---

## 2. One manual prerequisite (can't be fully automated)

Create **one wildcard DNS record** per database server:
`*.yourdomain.com → <VPS public IP>` (A record). Every new instance's two
subdomains then resolve without per-instance DNS changes. DNS-provider API
integration is not currently included.

---

## 3. Data model

```
servers
  id                uuid pk
  name              text
  host              text
  ssh_port          int default 22
  ssh_user          text
  auth_method       text            -- 'password' | 'private_key'
  ssh_password_enc  bytea (nullable)
  ssh_private_key_enc bytea (nullable)
  linked_panel_url  text (nullable) -- e.g. existing cPanel/Plesk/Cockpit URL to link out to
  bootstrapped       boolean         -- true once Docker + Traefik are installed
  tags              text[]
  created_at        timestamptz

websites
  id            uuid pk
  domain        text
  server_id     uuid fk -> servers.id
  path          text            -- e.g. /var/www/clienta
  db_instance_id uuid fk -> db_instances.id (nullable)
  access_username text (nullable)   -- generic label+value credential
  access_password_enc bytea (nullable)
  credential_label text default 'Admin login'  -- what the username/password actually is (CMS/FTP/etc.)
  notes         text
  created_at    timestamptz

db_instances
  id                    uuid pk
  server_id             uuid fk -> servers.id
  name                  text
  slug                  text unique      -- used in both subdomains
  compose_project_name  text             -- e.g. "sb_4f2a"
  remote_path           text             -- e.g. /opt/db-instances/sb_4f2a on the server
  api_subdomain         text             -- {slug}.yourdomain.com
  studio_subdomain      text             -- studio-{slug}.yourdomain.com
  pg_password_enc       bytea
  anon_key_enc          bytea
  service_role_key_enc  bytea
  jwt_secret_enc         bytea
  status                text            -- provisioning | running | stopped | error | removing
  last_action_log       text            -- last provisioning/teardown log tail, for UI feedback
  created_at            timestamptz

panel_users
  id, email, password_hash, role ('admin'|'operator'|'viewer'), created_at

audit_log
  id, user_id, action, target_type, target_id, metadata jsonb, created_at
```

All `*_enc` columns: AES-256-GCM, master key from env/Docker secret, decrypted only in-memory per request.

---

## 4. Module: Servers

**Registration**
- Name, host, SSH port, SSH user, auth method (password or private key — key strongly recommended; the panel can generate a keypair and show you the public key to paste into the server's `authorized_keys` instead of ever storing a password).
- Optional `linked_panel_url` — if the server already runs cPanel/Plesk/Webmin/Cockpit, store its URL here; the Server card shows a "Open [PanelName]" button that opens it in a new tab. True SSO into third-party panels isn't generally possible without that panel's own token system, so this is a deep link, not an auto-login — worth being upfront about.
- "Bootstrap this server" button (optional, needed once per server before it can host databases): SSHes in and installs Docker + Compose plugin, creates the shared Traefik network, deploys Traefik with the Let's Encrypt resolver, opens firewall ports 80/443. Idempotent — safe to re-run.

**In-browser SSH terminal**
- Frontend: `xterm.js` terminal component.
- Transport: dedicated WebSocket endpoint (separate small Node service using `ws`, since long-lived duplex streams don't fit typical serverless API routes) — authenticated by checking the panel's session cookie before upgrading the connection.
- Backend: `ssh2` opens a real SSH session to the target server using the stored (decrypted in-memory) credentials, pipes the shell stream to/from the WebSocket. No credentials ever reach the browser.
- Every terminal session logged (opened/closed, user, server, duration) in `audit_log`; full keystroke logging is a judgment call — recommend session metadata only, not full transcript recording, unless you have a specific compliance need.

**API routes**
```
GET/POST/PATCH/DELETE  /api/servers[, /:id]
POST                   /api/servers/:id/bootstrap
WS                     /ws/terminal/:server_id
```

---

## 5. Module: Websites

Simple CRUD, but this is the "map" tying a domain to where it actually lives.

- Add/edit/delete site: domain, server, filesystem path, optional link to a `db_instance` (if it uses one of your provisioned Supabase backends), and a generic credential field (label + username + encrypted password) since "username/password" could mean CMS admin, FTP, or something else per site — stored as one flexible pair rather than assuming which.
- Per-server view: everything hosted there (websites + database instances) in one glance.

```
GET/POST/PATCH/DELETE  /api/websites[, /:id]
```

---

## 6. Module: Databases (Supabase Fleet — provision, manage, destroy)

### 6.1 "New" — provisioning flow

1. Modal: pick target Server (must be bootstrapped), instance name → auto-suggest a slug (editable, must be unique, lowercase/alphanumeric/hyphen).
2. Backend, on submit (status = `provisioning`, streamed to the UI):
   - Generate: Postgres password, JWT secret, and the anon/service_role keys (standard Supabase HS256 JWTs signed with that JWT secret, `role: anon` / `role: service_role` claims).
   - Render a `docker-compose.yml` from the official Supabase self-hosting template, parameterized with: `compose_project_name`, the generated secrets, and Traefik labels:
     - on the `kong` service → router for `Host(\`{slug}.yourdomain.com\`)`, TLS via the Let's Encrypt resolver, no auth middleware.
     - on the `studio` service → router for `Host(\`studio-{slug}.yourdomain.com\`)`, TLS via Let's Encrypt, **`forwardAuth` middleware pointed at the panel's own `/api/auth/verify` endpoint**.
   - SFTP the rendered compose file (+ `.env`) to `remote_path` on the target server.
   - SSH-exec `docker compose -p sb_xxxx up -d`.
   - Poll Postgres (`SELECT 1`) and Kong's health route over SSH-tunneled checks (or have the server report back) with backoff, up to a timeout (~3–5 min); stream log tail to the UI.
   - On success: status → `running`, save encrypted secrets + subdomains to `db_instances`. On failure: status → `error`, keep the log tail visible, don't silently retry.
3. Because Traefik auto-discovers via Docker labels and Let's Encrypt issues certs on demand per hostname (HTTP-01 challenge — needs port 80 reachable, already true from bootstrap), **there is zero manual reverse-proxy or cert work per instance** — it just works the moment the container is up.

### 6.2 Fleet dashboard

Card/table per instance: name, server, status badge, created date, and three actions: **Manage**, **Switch to** (same action, framed as the "pick which one I'm working in" affordance — see 6.3), **Stop**, **Remove**.

### 6.3 "Manage" / switching between instances

Recommendation: **native Studio, gated by the SSO layer described above — not a rebuild of Studio.** Reasoning: you already have the provisioning engine, the SSH terminal, and the reverse-proxy automation to build — re-implementing Studio's table editor/SQL runner/auth/storage screens on top of that is a lot of extra surface for what native Studio already does well. Clicking Manage opens `studio-{slug}.yourdomain.com` in an iframe inside the panel shell (keeps your nav/sidebar, feels like one app); Traefik's forwardAuth already confirmed you're logged into the panel, so Studio loads straight in — no separate prompt.
- If Kong/Studio's response headers ever block iframing (`X-Frame-Options`), the fallback is "open in new tab" — still zero extra login, just a tab instead of an iframe. This is a config check to do once during build, not a design risk.
- **Documented upgrade path, not required now:** if later you want one true merged UI (e.g. run a query across instances without switching tabs), the earlier fully-custom dashboard design (postgres-meta for schema, direct `pg` for queries, GoTrue/Storage admin APIs) still applies — it can be layered in later without touching the provisioning/teardown engine at all.

### 6.4 "Remove"

Two distinct actions, not one, because "click and it's gone" is a scary button to have only one version of:
- **Stop** — `docker compose -p sb_xxxx stop`. Containers stop, volumes/data untouched, Traefik routers disappear (so the subdomains go quiet) until restarted. Reversible.
- **Remove permanently** — confirmation requires typing the instance name. Then: `docker compose -p sb_xxxx down -v` (removes containers **and** named volumes), delete the `remote_path` directory from the server, delete the `db_instances` row (soft-delete flag + audit entry kept for a grace period before hard purge, so an accidental removal isn't instantly unrecoverable at the metadata level — the actual data is gone once volumes are removed, which the confirmation copy should say explicitly).
- No DNS cleanup needed either way, since the wildcard record already covers every slug.

### 6.5 API routes
```
GET/POST          /api/db-instances
GET/DELETE        /api/db-instances/:id
POST              /api/db-instances/:id/stop
POST              /api/db-instances/:id/start
GET               /api/db-instances/:id/provision-log     -- streamed (SSE) status/log during creation
GET               /api/auth/verify                          -- called by Traefik forwardAuth
```

---

## 7. Cross-cutting concerns

**Panel auth/RBAC:** NextAuth (credentials provider), bcrypt hashes, roles `admin` (servers, provisioning, removal) / `operator` (day-to-day management, no removal) / `viewer` (read-only). Traefik's forwardAuth call reuses this same session — one login covers panel + every Studio instance.

**Secrets:** AES-256-GCM at rest for SSH creds and Supabase secrets; master key via Docker secret/env, never logged, decrypted only transiently in-memory.

**Audit log:** every provision, stop, remove, and terminal session recorded with user + timestamp + target.

**Blast radius of the provisioning engine:** it has SSH exec rights on real servers and can run `docker compose down -v`, which deletes data. Restrict "Remove permanently" to `admin` role only, and keep the audit log immutable (insert-only).

---

## 8. Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15, App Router, TypeScript |
| Panel auth | NextAuth (Credentials), bcrypt, role-based |
| Panel DB / ORM | Postgres + Prisma |
| SSH | `ssh2` (exec + SFTP + shell streams) |
| Terminal transport | small standalone `ws` WebSocket service, session-authenticated |
| Terminal UI | `xterm.js` |
| Compose templating | plain string/YAML templating (`js-yaml`) over the official Supabase compose reference |
| Reverse proxy | Traefik (Docker provider, labels-driven, built-in Let's Encrypt) — deployed once per server via the bootstrap action |
| Secrets encryption | Node `crypto`, AES-256-GCM |
| UI components | Tailwind + shadcn/ui, TanStack Query for polling/status |

---

## 9. Operating assumptions

- Linked third-party panels open as deep links in a new tab. WHARF does not
  implement those products' single sign-on protocols.
- Website credentials are stored as a flexible labeled username/password pair.
- Each database server has its own Traefik instance and wildcard DNS record.
- The panel runs as one process. Rate limiting and job locks are in memory;
  multiple panel replicas require additional coordination.
- Administrator 2FA is not currently implemented. Read
  `docs/security-review.md` before exposing a deployment.
