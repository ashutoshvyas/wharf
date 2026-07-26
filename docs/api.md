# WHARF REST API

All routes live under panel auth (NextAuth session cookie). Role gates follow
the RBAC matrix in `lib/rbac.ts`; an unauthenticated or under-privileged
request gets `403 {"error": "Forbidden: ..."}`. Validation failures return
`400 {"error": "Invalid request — <field>: <message>"}`. Unknown ids return
`404 {"error": "Server not found"}`. Every mutation writes an `audit_log` row.

Common error responses:

| Status | Meaning |
|---|---|
| 400 | Body failed schema validation (zod issue summary in `error`) |
| 401 | Handled by NextAuth middleware (no session → redirected/refused) |
| 403 | Session missing or role not permitted for the action |
| 404 | Row not found |
| 409 | Conflict — precondition failed (details in `error`) |

---

## Servers

Serialized server shape (returned by every server endpoint below; encrypted
columns are **never** serialized):

```json
{
  "id": "uuid",
  "name": "web-1",
  "host": "203.0.113.10",
  "sshPort": 22,
  "sshUser": "root",
  "authMethod": "password | private_key",
  "linkedPanelUrl": "https://panel.example.com | null",
  "hasPanelCredential": true,
  "bootstrapped": false,
  "reachable": true,
  "hostKeyFingerprint": "SHA256:... | null",
  "tags": ["prod"],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "counts": { "websites": 3, "dbInstances": 2 }
}
```

### GET /api/servers

- **Role:** viewer+ (`servers.read`)
- **Response:** `200` — array of serialized servers, ordered by `name` asc,
  each with `counts`.

### POST /api/servers

- **Role:** admin (`servers.write`)
- **Request body:**

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, 1–64 chars |
| `host` | string | required, RFC-1123 hostname or IPv4 |
| `sshPort` | int | 1–65535, default `22` |
| `sshUser` | string | required, 1–32 chars, no spaces |
| `authMethod` | enum | `password` \| `private_key` |
| `sshPassword` | string | required iff `authMethod=password` |
| `sshPrivateKey` | string | PEM private key, required iff `authMethod=private_key` |
| `linkedPanelUrl` | string | optional, `http(s)://` URL or `""` |
| `panelUser` | string | optional, ≤128 chars |
| `panelPass` | string | optional, ≤256 chars |
| `tags` | string[] | ≤8 tags, each 1–24 chars, default `[]` |

  Exactly one SSH secret must be supplied and it must match `authMethod`.
  Secrets are sealed (AES-256-GCM) before storage and never echoed back.
- **Response:** `201` — serialized server. Audit: `server.create`.
- **Errors:** 400 (validation), 403.

### GET /api/servers/:id

- **Role:** viewer+ (`servers.read`)
- **Response:** `200` — serialized server with `counts`. Errors: 403, 404.

### PATCH /api/servers/:id

- **Role:** admin (`servers.write`)
- **Request body:** any subset of the POST fields. Secret fields
  (`sshPassword`, `sshPrivateKey`, `panelUser`, `panelPass`) sent as `""` (or
  omitted) mean **keep the existing stored value**; non-empty values are
  re-sealed and replace the old ciphertext.
- **Response:** `200` — serialized server. Audit: `server.update`.
- **Errors:** 400, 403, 404.

### DELETE /api/servers/:id

- **Role:** admin (`server.delete`)
- **Behavior:** refused while any website or DB instance still references the
  server.
- **Response:** `200 {"ok": true}` on success. Audit: `server.delete`.
- **Errors:** 403, 404, and
  `409 {"error": "Server still has linked resources — {\"websites\":2,\"dbInstances\":1}"}`
  (the JSON detail carries the live counts).

### GET /api/servers/:id/panel-credential

- **Role:** operator+ (`secrets.reveal`)
- **Behavior:** the only route that returns the decrypted linked-panel
  credential. Response carries `Cache-Control: no-store`. Every call is
  audited (`server.credential_reveal`).
- **Response:** `200 {"username": string|null, "password": string|null}`
  (nulls when no credential is stored).
- **Errors:** 403, 404.

### POST /api/servers/:id/keypair

- **Role:** admin (`servers.write`)
- **Request body:** `{"confirm": true}` required only when a private key is
  already stored (otherwise the body may be empty).
- **Behavior:** generates an ed25519 keypair server-side; the private key
  (PKCS#8 PEM) is sealed into `sshPrivateKeyEnc`, `authMethod` flips to
  `private_key`, and any stored SSH password is cleared. The public key is
  returned **once**, in OpenSSH `authorized_keys` format — it is not stored
  and cannot be retrieved again. Audit: `server.keypair_generate`.
- **Response:**
  `200 {"publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... wharf-panel"}`
  with `Cache-Control: no-store`.
- **Errors:** 403, 404, and
  `409 {"error": "Existing key — pass confirm:true to replace"}`.

### POST /api/servers/:id/check

Reachability probe (operator+, `server.check`). Opens an SSH connection and
runs `true` with a 5s timeout; persists `reachable` on the row. Rate-limited to
one check per server per 10s.

Response `200`:

```json
{ "ok": true, "ms": 214, "reachable": true }
```

On failure `200 {"ok": false, "error": "<ssh error>", "reachable": false}` —
the SSH error is surfaced verbatim so the operator can act on it. `429` when
hammered (retry-after seconds in the message), `404` unknown server.

### POST /api/servers/:id/bootstrap

Start the idempotent Docker + Traefik bootstrap job (admin, `server.bootstrap`).
Returns immediately; the work runs detached under the per-server single-flight
lock (`lib/jobs/lock.ts`). Steps, in order: `installDocker`,
`createTraefikNetwork`, `uploadTraefikConfig`, `startTraefik`, `openFirewall`
(see `lib/bootstrap/steps.ts`; each is check-then-apply, so a re-run reports
skips). On success `servers.bootstrapped` flips to `true` and
`server.bootstrap` is audited; on failure the row is untouched,
`server.bootstrap.failed` is audited, and the log tail stays readable.

An unreachable server is still accepted: bootstrap needs working SSH anyway, so
the attempt either succeeds (flipping `reachable` back) or fails visibly in the
job log.

Response `202`:

```json
{ "jobId": "bootstrap:9f3c…" }
```

`409 {"error": "Server is busy — a 'provision' job is running."}` when the
server lock is held. `404` unknown server.

### GET /api/servers/:id/bootstrap-log

Server-sent events stream for the server's bootstrap job (any authenticated
role, `servers.read`). Buffered lines are replayed on connect, so opening the
page mid-run — or after a refresh — shows the whole log.

```
data: {"ts":1769300000000,"kind":"step","line":"› installDocker"}
data: {"ts":1769300000123,"kind":"ok","line":"✓ installDocker: already done — skipped"}
data: {"done":true,"status":"ok"}
```

`kind` is one of `step | ok | err | info`; a `: hb` comment every 15s defeats
proxy buffering. An unknown or expired job id yields a single
`{"done":true,"status":"error","line":"No such job"}` marker and closes — the
UI treats that as "idle". Wire format is defined in `lib/jobs/stream.ts`.

---

## Websites

Pure metadata CRUD (architecture §4.4) — no SSH actions in this module.
Serialized website shape (returned by every website endpoint below; the
encrypted password AND the username are **never** serialized — both come only
from the audited credential-reveal route):

```json
{
  "id": "uuid",
  "domain": "clienta.com",
  "serverId": "uuid",
  "path": "/var/www/clienta",
  "dbInstanceId": "uuid | null",
  "credentialLabel": "Admin login",
  "hasCredential": true,
  "notes": "",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "server": { "id": "uuid", "name": "vps-01", "host": "192.0.2.10" },
  "dbInstance": { "id": "uuid", "name": "clienta-prod", "slug": "clienta", "status": "running" }
}
```

`server` is always embedded; `dbInstance` is `null` when the website has no
linked instance.

### GET /api/websites

- **Role:** viewer+ (`websites.read`)
- **Query:** optional `?serverId=<uuid>` filters to one server.
- **Response:** `200 {"websites": [ ...serialized websites ]}`, ordered by
  `domain` asc.

### POST /api/websites

- **Role:** operator+ (`websites.write`)
- **Request body:**

| Field | Type | Rules |
|---|---|---|
| `domain` | string | required, bare hostname (`clientb.com` — no scheme/port/path), lowercased |
| `serverId` | uuid | required, must reference an existing server (else 400) |
| `path` | string | required, absolute unix path (starts `/`), ≤300 chars |
| `dbInstanceId` | uuid \| null | optional, must reference an existing instance when set (else 400) |
| `credentialLabel` | string | 1–40 chars, default `"Admin login"` |
| `accessUsername` | string | optional, ≤200 chars |
| `accessPassword` | string | optional, ≤500 chars — sealed (AES-256-GCM) before storage |
| `notes` | string | optional, ≤2000 chars |

- **Response:** `201 {"website": {...}}`. Audit: `website.create` (`{domain}`).
- **Errors:** 400 (validation / unknown `serverId` / unknown `dbInstanceId`), 403.

### GET /api/websites/:id

- **Role:** viewer+ (`websites.read`)
- **Response:** `200 {"website": {...}}`. Errors: 403, 404.

### PATCH /api/websites/:id

- **Role:** operator+ (`websites.write`)
- **Request body:** any subset of the POST fields. `accessPassword` sent as
  `""` (or omitted) means **keep the stored password**; a non-empty value is
  re-sealed. `accessUsername: null` (or `""`) clears the username;
  `dbInstanceId: null` unlinks the database instance.
- **Response:** `200 {"website": {...}}`. Audit: `website.update`.
- **Errors:** 400, 403, 404.

### DELETE /api/websites/:id

- **Role:** operator+ (`websites.write`)
- **Behavior:** removes **only** the metadata record and its stored
  credential. Nothing on the server's filesystem is touched.
- **Response:** `200 {"ok": true}`. Audit: `website.delete` (`{domain}`).
- **Errors:** 403, 404.

### GET /api/websites/:id/credential

- **Role:** operator+ (`secrets.reveal`)
- **Behavior:** the only route that returns the decrypted website credential
  (decrypted in memory, never logged). Response carries
  `Cache-Control: no-store`. Every call is audited
  (`website.credential_reveal`).
- **Response:** `200 {"label": string, "username": string|null, "password": string}`
- **Errors:** 403, 404 (unknown website **or** no password stored).

---

## Databases

Supabase instances provisioned onto a server by the provisioning engine
(architecture §4.3). The wire contract — DTO field names, statuses, job ids
and the SSE phase protocol — is pinned in `docs/provisioning-contract.md`;
this section documents the HTTP surface over it.

Serialized instance shape (returned by every read below). Strict allowlist:
the encrypted columns (`pgPasswordEnc`, `anonKeyEnc`, `serviceRoleKeyEnc`,
`jwtSecretEnc`) and every decrypted value are **never** serialized — key
material comes only from the audited secrets route:

```json
{
  "id": "uuid",
  "name": "clienta-prod",
  "slug": "clienta",
  "serverId": "uuid",
  "server": { "id": "uuid", "name": "db-01", "host": "192.0.2.10" },
  "composeProjectName": "sb_4f2a",
  "remotePath": "/opt/db-instances/sb_4f2a",
  "apiSubdomain": "clienta.wharf.example.com",
  "studioSubdomain": "studio-clienta.wharf.example.com",
  "status": "provisioning | running | stopped | error | removing | restoring",
  "activeJob": "provision | remove | restore | sync | clone | null",
  "lastActionLog": "…tail… | null",
  "healthCheckedAt": "ISO-8601 | null",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

`activeJob` is derived, not a column: it names which engine holds a live job
for this instance right now, and is `null` when none does (including after a
panel restart, since the job registry is in-process). It exists because
`status: "restoring"` is shared by uploaded-file restore, live-source sync,
and managed database clone. They stream under different job ids, so a client
needs `activeJob` to know which log to follow. A clone is associated with its
destination; the source remains `running` while its server is locked.

`server` is embedded only when the relation was included. Soft-deleted rows
(`deletedAt != null`) are excluded from every list and `404` on read, so
`deletedAt` is not part of the wire shape.

Only the engine writes `status`. `error` is terminal until an explicit
**retry** or **remove** — nothing is ever auto-retried. `409` is the
single-flight signal: one provision/teardown/bootstrap at a time per server
(`lib/jobs/lock.ts`), and the message names the holder.

Lifecycle actions (provision, retry, stop, start, remove) are audited by the
engine itself, so the routes below add no audit rows of their own — the two
exceptions are noted inline.

### GET /api/db-instances

- **Role:** viewer+ (`instances.read`)
- **Query:** `?serverId=<uuid>` — optional filter.
- **Response:** `200` — **bare array** of serialized instances (consistent
  with `GET /api/servers`), ordered by `createdAt` desc, each with `server`
  embedded. Soft-deleted rows excluded.

### POST /api/db-instances

- **Role:** operator+ (`instance.provision`)
- **Request body:**

| Field | Type | Rules |
|---|---|---|
| `serverId` | uuid | required, target server |
| `name` | string | required, 1–64 chars — display name |
| `slug` | string | required, ≤40 chars, `^[a-z0-9][a-z0-9-]*$`, globally unique |
| `sslMode` | `require \| disable` | optional; defaults to `require`. Required rejects plaintext pooler connections; disable preserves legacy compatibility. |

- **Behavior:** starts the provisioning job and returns immediately; watch it
  via `…/:id/provision-log`. The slug becomes a DNS label
  (`{slug}.{INSTANCE_DOMAIN}`).
- **Response:** `202 {"id": "uuid", "jobId": "provision:uuid"}`
- **Errors:** 400 (validation, unknown/unprepared server, slug taken — the
  engine's `validate` phase), 403, 409 (server busy).

### GET /api/db-instances/:id

- **Role:** viewer+ (`instances.read`)
- **Response:** `200` — a single serialized instance.
- **Errors:** 403, 404 (unknown **or** soft-deleted).

### PATCH /api/db-instances/:id/ssl-mode

- **Role:** **admin** (`instance.ssl-mode.write`).
- **Request body:** `{"sslMode":"require"}` or `{"sslMode":"disable"}`.
- **Behavior:** updates the instance's existing Supavisor tenant in place; it
  does not rebuild the Supabase stack or rotate credentials. `require`
  rejects plaintext connections and first converges the server's shared TLS
  listener when needed. `disable` restores plaintext-compatible behavior.
  The runtime change must succeed before the new mode is persisted, and a
  persistence failure triggers a best-effort runtime rollback.
- **Response:** `200` — the refreshed serialized instance.
- **Errors:** 400 (unsupported mode), 403, 404, 409 (server busy or the
  instance never stored its database password), 500 (SSH/pooler failure).
- **Audit:** `instance.ssl-mode.update` with `{sslMode}`.

### DELETE /api/db-instances/:id

- **Role:** **admin** (`instance.remove`)
- **Request body:** `{"confirmName": "<the instance's name>"}` — a
  type-the-name confirmation enforced server-side.
- **Behavior:** permanent teardown — `docker compose down -v` → `rm -rf`
  `remotePath` → soft-delete the row. **Volume data is unrecoverable**, even
  though the metadata row lingers until its hard purge. Runs as a job;
  stream it via `…/provision-log`.
- **Response:** `202 {"jobId": "remove:uuid"}`
- **Errors:** 400 (`"Confirmation does not match the instance name"`), 403,
  404, 409 (server busy).

### POST /api/db-instances/:id/stop · /start

- **Role:** operator+ (`instance.stopstart`)
- **Behavior:** `docker compose stop` / `start` over SSH. Stop leaves volumes
  intact and the Traefik routers vanish while the containers are down (the
  subdomains go quiet) — fully reversible with Start.
- **Response:** `200` — the refreshed serialized instance.
- **Errors:** 403, 404, 409 (server busy), 500 (SSH/compose failure — detail
  lands in `lastActionLog`).

### POST /api/db-instances/:id/retry

- **Role:** operator+ (`instance.retry`)
- **Behavior:** re-runs the idempotent pipeline for an instance in `error`
  (`up -d` is safe to repeat). Only valid from `error`.
- **Response:** `202 {"jobId": "provision:uuid"}`
- **Errors:** 403, 404, 409 — **both** for a wrong status (message names the
  current one) and for a busy server.

### GET /api/db-instances/:id/secrets

- **Role:** operator+ (`secrets.reveal`)
- **Behavior:** the only route that returns decrypted instance key material.
  Ciphertext is opened in memory and never logged. Response carries
  `Cache-Control: no-store`. **Every call is audited** (`secret.reveal`,
  metadata `{instanceId}`).
- **Response:**

```json
{
  "apiUrl": "https://clienta.wharf.example.com",
  "studioUrl": "https://studio-clienta.wharf.example.com",
  "anonKey": "eyJ…",
  "serviceRoleKey": "eyJ…",
  "pgPassword": "…",
  "poolerHost": "db-01.example.com",
  "sslMode": "require"
}
```

- **Errors:** 403, 404, 409 (secrets not stored yet — the instance never got
  past the pipeline's `secrets`/finalize step).

### GET /api/db-instances/:id/provision-log

Server-sent events for whichever job currently owns the instance:
`provision:{id}` (provision **and** retry) or `remove:{id}` (teardown). Any
authenticated role (`instances.read`). An active `remove:` job wins; otherwise
the provision job is streamed, so a just-finished run still replays its buffer
(ended jobs are retained for an hour).

```
data: {"ts":1769300000000,"kind":"step","line":"› prepare"}
data: {"ts":1769300000123,"kind":"info","line":"docker compose version → 2.29.1"}
data: {"ts":1769300004500,"kind":"ok","line":"✓ prepare"}
data: {"done":true,"status":"ok"}
```

Phase boundaries are `step`/`ok`/`err` events whose `line` begins with a
marker glyph plus the exact phase id — `validate`, `prepare`, `secrets`,
`render`, `upload`, `start`, `health` for provisioning; `stop`, `volumes`,
`files`, `metadata` for teardown. Everything else is free-form `info` detail,
and the UI derives its checklist purely from these events (never timers). When
no such job exists the stream emits the single
`{"done":true,"status":"error","line":"No such job"}` marker and closes — read
that as "idle". Full protocol: `docs/provisioning-contract.md` §5.

### POST /api/db-instances/:id/restore

- **Role:** admin (`instance.restore`)
- **Body:** the raw dump bytes — **not** JSON. `confirmName` travels as a
  query param and the original filename as an `X-Backup-Filename` header,
  since the body is reserved for the upload (≤2 GiB; the panel vhost needs a
  larger `client_max_body_size` on just this path, see
  `docs/deployment.md`).
- **Behavior:** loads the dump into a `running` instance, replacing its data.
  A `pg_dump` of the current data is taken first and kept on the server under
  `{remotePath}/backups/pre-restore-{ts}.backup`.
- **Response:** `202 {"jobId": "restore:<id>"}` — stream it via `…/restore-log`.
- **Errors:** 400 (missing confirmName/filename, empty body), 403, 404,
  409 (not `running`, unusable file, confirmName mismatch, server busy).

### GET/PUT/DELETE /api/db-instances/:id/sync-source

Where a live-database sync pulls **from**. Admin-only on every verb
(`instance.restore`): the stored credentials grant full read of the source,
and the sync they drive overwrites this instance in place.

- **GET** → `200` with the config, or `null` if none is configured. Secrets
  are never echoed — only `pgPasswordConfigured` / `serviceRoleKeyConfigured`,
  the same rule as the secrets route.

```json
{
  "kind": "supabase | postgres",
  "label": "",
  "pgHost": "db.abcdefghijklm.supabase.co",
  "pgPort": 5432,
  "pgDatabase": "postgres",
  "pgUser": "postgres",
  "pgPasswordConfigured": true,
  "pgSslMode": "require",
  "projectUrl": "https://abcdefghijklm.supabase.co",
  "serviceRoleKeyConfigured": true,
  "includeAuthUsers": true,
  "includeStorageObjects": false,
  "extraSchemas": [],
  "lastSyncedAt": "ISO-8601 | null",
  "lastSyncStatus": "ok | error | null",
  "lastSyncSummary": "… | null"
}
```

- **PUT** — create or replace. Same fields minus the `*Configured` booleans,
  plus `pgPassword` / `serviceRoleKey`. An omitted or empty secret **keeps**
  the stored one, so `pgPassword` is required only on create.
  `projectUrl` must be `https://` (the service_role key travels on it) and is
  required when `includeStorageObjects` is on. `extraSchemas` may not contain
  `public` (always copied), `auth` or `storage` (this instance owns those
  schemas — use the two flags to copy their *data*). Audited as
  `instance.sync-source.write`; the metadata records the source's identity,
  never its credentials. → `200` with the GET shape.
- **DELETE** → `204`, or `404` when nothing was configured. Audited.
- **Errors:** 400 (invalid body, no password on create), 403, 404.

### POST /api/db-instances/:id/sync-source/test

- **Role:** admin (`instance.restore`)
- **Behavior:** read-only probe — `select current_database(), version()` run
  against the source **from the instance's own db container**, so it proves
  the exact path a sync will take (that server's egress, that TLS mode, those
  credentials) rather than something the panel can reach. Writes nothing, but
  briefly takes the target server's single-flight lock. It reads the *saved*
  row, so save before testing.
- **Response:** `200 {"ok": true, "detail": "postgres · PostgreSQL 17.4"}`.
  A reachable-but-refusing source is `ok: false` with the source's own error
  text in `detail` — not an HTTP error.
- **Errors:** 403, 404, 409 (no source configured, instance not `running`,
  server busy).

### POST /api/db-instances/:id/sync

- **Role:** admin (`instance.restore`) — the same overwrite as restore, just
  fed from a live database.
- **Body:** `{"confirmName": "clienta-prod"}` — must equal the instance name.
- **Behavior:** dumps the configured source and loads it into this instance,
  replacing its data. The dump runs inside the instance's own `db` container
  and the storage-object copy runs on the managed server, so **nothing large
  passes through the panel**. A safety snapshot is taken first, at
  `{remotePath}/backups/pre-sync-{ts}.backup`. Audited by the engine as
  `instance.sync` / `instance.sync.failed`.
- **Response:** `202 {"jobId": "sync:<id>"}` — stream it via `…/sync-log`.
- **Errors:** 400 (bad/mismatched confirmName), 403, 404, 409 (not `running`,
  no source configured, storage copying enabled without the keys it needs,
  server busy).

### GET /api/db-instances/:id/restore-log · /sync-log

Server-sent events for `restore:{id}` / `sync:{id}` respectively. Any
authenticated role (`instances.read`), same wire format as `provision-log`.
Phase ids are `upload`, `snapshot`, `restore`, `cleanup` for a restore, and
`connect`, `dump`, `snapshot`, `restore`, `storage`, `cleanup` for a sync
(`storage` always appears — it reports itself as skipped when the source is
not copying objects).

### POST /api/db-instances/:id/clone

Copies this managed **source** into an existing managed destination, on the
same WHARF server or another registered server. No database URLs, passwords,
or uploaded backup are required in the request.

- **Role:** admin (`instance.restore`).
- **Body:** `{"targetInstanceId": "destination-uuid", "confirmName": "clienta-staging"}`.
  `confirmName` must exactly match the **destination** name. Unknown fields
  are rejected.
- **Requirements:** distinct, provisioned, running instances; both servers
  available for an exclusive job; matching database stack image versions.
  Preflight rejects source subscriptions,
  foreign servers, scheduled jobs, populated Vault secrets or pgsodium keys.
  Source-only roles or unavailable extensions cause a strict restore failure
  before activation; cluster roles/passwords are never imported.
- **Behavior:** takes a consistent source archive and a destination safety
  archive, restores into a fresh staging database, preserves destination
  runtime schemas and database settings, then briefly stops destination
  services and connections for an atomic database swap. Destination-only
  schemas/tables disappear from the active database. Activation health
  failures attempt to restore the original database automatically.
- **Copy scope:** PostgreSQL schemas and rows, including Auth data, Storage
  metadata, functions, triggers, constraints, indexes, sequences, views,
  large objects, ownership, grants and RLS. Destination runtime schemas
  (`_realtime`, `_analytics`, `_supavisor`, `pgbouncer`) and database identity
  stay local. Uploaded Storage files, filesystem volumes, database URLs,
  passwords, API/JWT keys and WHARF configuration are not copied. Values
  inside application rows/functions are copied as stored, including any
  application-specific URLs.
- **Transfer:** same-server archives are copied locally; cross-server
  archives stream through the panel over the two authenticated SSH/SFTP
  connections, with bounded memory and no panel-side archive file. Sources
  require no publicly exposed PostgreSQL port.
- **Safety archive:** `{destination.remotePath}/backups/pre-clone-{token}.backup`,
  retained with mode `0600`. Temporary archives/staging databases are removed
  after successful recovery or activation; unresolved recovery preserves
  evidence and puts the destination in `error`.
- **Audit:** `instance.clone` or `instance.clone.failed` on the destination,
  with source/destination server identities, snapshot path and recovery state.
- **Response:** `202 {"jobId": "clone:<destination-id>", "targetInstanceId": "destination-id"}`.
- **Errors:** 400 (invalid body, identical IDs, destination-name mismatch),
  403, 404 (source/destination missing), 409 (instance not ready, server busy,
  invalid managed directory). Compatibility/restore/activation failures after
  acceptance are reported through the job stream.

### GET /api/db-instances/:id/clone-log

The `:id` here is the **destination**, unlike the clone-start endpoint's source
ID. Any authenticated role (`instances.read`) may follow `clone:{id}` using
the same SSE format as `provision-log`. Phases are `preflight`, `dump`,
`transfer`, `snapshot`, `restore`, `verify`, `cleanup`. Closing the modal does
not cancel the job. A recovered failure can leave the destination `running`
while the stream's final status is `error`; inspect the log to distinguish
that from a completed clone.

### GET /api/db-instances/slug-available?slug=

- **Role:** operator+ (`instance.provision`)
- **Behavior:** live availability check for the create form. A slug is
  unavailable if **any** row holds it — including soft-deleted ones, because
  the subdomains and their certificates linger after a remove. A
  syntactically invalid slug is reported as unavailable rather than 400.
- **Response:** `200 {"available": true|false}`
- **Errors:** 403.

### GET /api/servers/:id/orphans

- **Role:** admin (`servers.write`)
- **Behavior:** read-only orphan detection (architecture §4.3) — runs
  `docker compose ls` over SSH and reports `sb_`-prefixed compose projects on
  the server that no instance row claims. Soft-deleted rows count as known, so
  an instance awaiting its hard purge is not flagged. Projects the operator
  put there themselves (no `sb_` prefix) are ignored. **This route never
  deletes or stops anything — resolution is manual.** Unreadable docker output
  yields an empty list rather than a false positive.
- **Response:** `200 {"orphans": [{"project": "sb_4f2a", "path": "/opt/db-instances/sb_4f2a/docker-compose.yml"}]}`
  (`path` is omitted when docker does not report a config file).
- **Errors:** 403, 404 (unknown server), 500 (server unreachable over SSH).

**Crash recovery.** Job state lives in memory, so a panel restart mid-job
would strand rows in `provisioning`/`removing` forever. The root
`instrumentation.ts` runs `sweepStaleJobs()` once at boot: rows in those
statuses, untouched for 10 minutes and with no live job, flip to `error` with
`✗ interrupted — panel restarted before this job finished` appended to
`lastActionLog` and an `instance.job.interrupted` audit row. Retry then
re-runs the idempotent pipeline.

---

## Terminal

Interactive SSH sessions do not go through the panel's REST API — they use
the Terminal Gateway WebSocket:

```
ws(s)://<gateway>/ws/terminal/:serverId?cols=<n>&rows=<n>
```

- **Role:** operator+ (`terminal`), authenticated via the `wharf.session`
  cookie before the upgrade completes.
- **Client:** `components/terminal/terminal.tsx` (+
  `use-terminal-socket.ts`), pointed at `NEXT_PUBLIC_GATEWAY_WS_URL`
  (dev `ws://localhost:3001`).
- **Protocol:** binary frames are raw terminal bytes; JSON text frames carry
  `resize`/`ping` (client→server) and `ready`/`pong`/`error`/`exit`
  (server→client). Close codes: 4001 auth, 4002 unknown server, 4003 SSH
  error, 4008 timeout, 4009 session limit. Full contract:
  `docs/terminal-protocol.md`.
- **Audit:** the gateway writes `terminal.open` / `terminal.close` rows;
  keystrokes are never recorded.

---

## Users

Admin-only (`users` in the RBAC matrix) except `POST /api/users/set-password`,
which is public by necessity. Serialized user shape — an explicit allowlist;
`passwordHash` is **never** serialized and has no reveal endpoint:

```json
{
  "id": "uuid",
  "email": "ada@example.com",
  "role": "admin | operator | viewer",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

### How invites are stored (no migration required)

`PanelUser` has exactly one credential column, so a pending invite is encoded
*into* `password_hash` as a sentinel:

```
invite$<sha256-hex-of-token>$<expiryEpochMs>
```

- **Unambiguous.** Every bcrypt hash starts with `$2`; the sentinel starts with
  the letter `i`. The two namespaces are disjoint at the first character, so no
  value can be read as both.
- **Sign-in is impossible while it stands.** `lib/auth.ts` calls
  `bcrypt.compare(password, user.passwordHash)`, which returns `false` for a
  malformed salt (it resolves false, it does not throw). An invited user
  therefore fails login exactly like a wrong password — same message, same
  timing path — and `lib/auth.ts` needs no knowledge of invites.
- **Only the digest is persisted.** The raw token is returned once, in the
  create/reset response, and cannot be recovered from the database. SHA-256 is
  the right primitive here: the token is 256 bits of CSPRNG output, so there is
  no low-entropy secret for a slow KDF to protect.
- **Single use.** Redemption overwrites the column with a real bcrypt hash
  (cost 12), so the sentinel — and the token — cease to exist.
- **TTL:** 48 hours, expiry inclusive (an invite is dead the instant it
  expires). Implementation: `lib/users/invite.ts`.

### GET /api/users

- **Role:** admin (`users`)
- **Response:** `200` — array of serialized users, ordered by `email` asc.
- **Errors:** 403.

### POST /api/users

- **Role:** admin (`users`)
- **Request body:**

| Field | Type | Rules |
|---|---|---|
| `email` | string | required, trimmed + lowercased, valid address, ≤160 chars |
| `role` | enum | required — `admin` \| `operator` \| `viewer` |

- **Behavior:** creates the user with a 48-hour single-use invite sentinel in
  place of a password. Audits `user.create`.
- **Response:** `201` — the serialized user **plus** `inviteUrl`:

```json
{
  "id": "uuid",
  "email": "ada@example.com",
  "role": "operator",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "inviteUrl": "${PANEL_URL}/invite/<rawToken>"
}
```

  `inviteUrl` is returned **once and only here** — it is unrecoverable
  afterwards. Losing it means issuing a new one via `/reset`.
- **Errors:** 400 (validation), 403, 409 (email already a panel user).

### PATCH /api/users/:id

- **Role:** admin (`users`)
- **Request body:** `{"role": "admin" | "operator" | "viewer"}` — the email is
  immutable (it is the login identity and the audit-log join key).
- **Behavior:** the guard and the admin count run in **one SERIALIZABLE
  transaction**. Read Committed would not be enough — two concurrent
  demotions would each observe "2 admins", neither seeing the other's
  uncommitted write, and both would commit to zero admins. Under Serializable
  the second one fails (`P2034`) and is returned as a retryable 409 rather
  than a 500. Audits `user.update` with `previousRole`.
- **Response:** `200` — the serialized user.
- **Errors:** 400, 403, 404, **409** — `"You cannot change your own role…"`,
  `"This is the last admin…"`, or `"Another admin changed this user at the
  same moment…"` (serialization conflict — safe to retry). Demoting to the
  same role is a no-op and is always allowed.

### DELETE /api/users/:id

- **Role:** admin (`users`)
- **Behavior:** guard + admin count in one Serializable transaction, as above.
  Audit rows
  written by the removed user are retained — the trail is insert-only and is
  never rewritten. Audits `user.delete`.
- **Response:** `200 {"ok": true}`
- **Errors:** 403, 404, **409** — `"You cannot remove your own account…"` or
  `"This is the last admin…"`.

### POST /api/users/:id/reset

- **Role:** admin (`users`)
- **Behavior:** overwrites `password_hash` with a fresh invite sentinel. This
  invalidates any outstanding link **and** the user's current password
  immediately — the intended semantic for "this person lost their password".
  Audits `user.reset` with `hadPassword`.
- **Response:** `200 {"inviteUrl": "${PANEL_URL}/invite/<rawToken>"}` — again,
  shown once.
- **Errors:** 403, 404.

### POST /api/users/set-password

**PUBLIC** — the only unauthenticated mutation in the panel (allowlisted in
`middleware.ts`, alongside the `/invite/<token>` screen). The token *is* the
credential.

- **Request body:**

| Field | Type | Rules |
|---|---|---|
| `token` | string | required, the raw token from the invite URL |
| `password` | string | required, 12–72 chars (bcrypt truncates past 72 bytes) |

- **Behavior:** scans every row whose `password_hash` is an invite sentinel and
  compares each with `timingSafeEqual`, **without an early exit**, so the work
  does not depend on which row matches. A live match is redeemed with a
  compare-and-swap (`updateMany` keyed on both the id and the exact sentinel
  read), which makes concurrent redemption of one link produce exactly one
  winner. Audits `user.password_set` against the redeeming user.
- **Response:** `200 {"ok": true}`
- **Errors:** 400 — one **generic** message for every rejection (unknown,
  expired, already used, lost the race):
  `"This link is invalid, already used, or has expired. Ask an admin for a new one."`
  The response never names an account and never says which check failed, so the
  endpoint cannot be used to probe whether an address is a panel user. A
  validation failure on `password` still returns the normal zod 400.

---

## Audit log

### GET /api/audit

- **Role:** any authenticated role (`audit.read`).
- **Query parameters** (all optional; empty values are ignored):

| Param | Type | Rules |
|---|---|---|
| `actionPrefix` | string | `startsWith` match — `server.`, `website.`, `instance.`, `terminal.`, `secret.`, `auth.`, `user.` |
| `userEmail` | string | case-insensitive substring match |
| `targetType` | string | exact match — `server`, `website`, `db_instance`, `user`, `auth` |
| `from` | ISO date | `createdAt >= from` |
| `to` | ISO date | `createdAt <= to` |
| `cursor` | string | opaque compound cursor from a previous `nextCursor` |
| `limit` | int | > 0, default 50, **clamped** to 100 (an oversized value is not an error) |

- **Ordering + pagination:** `(createdAt DESC, id DESC)` with a **compound**
  cursor. A timestamp-only cursor would be wrong — audit rows written inside
  one request share a `created_at`, so `createdAt < cursor` would skip the
  siblings while `<=` would repeat them. The predicate is therefore

  ```sql
  createdAt < c.createdAt OR (createdAt = c.createdAt AND id < c.id)
  ```

  which is exact for every tie. The cursor is base64url-encoded
  `<epochMs>:<id>` and should be treated as opaque.
- **Response:**

```json
{
  "entries": [
    {
      "id": "uuid",
      "userEmail": "ada@example.com | null",
      "action": "instance.remove",
      "targetType": "db_instance",
      "targetId": "uuid | null",
      "metadata": { "slug": "sb_4f2a" },
      "createdAt": "ISO-8601"
    }
  ],
  "nextCursor": "opaque string | null"
}
```

  `nextCursor` is `null` on the last page. The internal `userId` is
  deliberately withheld — the screen shows the email, and the id adds only a
  cross-reference handle.
- **Errors:** 400 (bad `limit`/date/cursor), 403.

**There is no POST, PATCH or DELETE on `/api/audit`, and there never will be.**
Rows are written only by `lib/audit.ts`; `audit_log` rejects UPDATE and DELETE
at the database level (trigger, migration `20260724000002_audit_immutable`).
The UI mirrors this — the audit screen carries no edit or delete affordance
anywhere (design §5.10).
