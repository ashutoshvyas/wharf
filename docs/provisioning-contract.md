# Provisioning contract

The shared interface between the provisioning engine (backend) and the fleet UI.
Both sides implement exactly this; change it here first.

---

## 1. Instance DTO

Returned by every `/api/db-instances` read. **Allowlist** — no `*Enc` column and
no decrypted value ever appears here; key material comes only from
`/api/db-instances/:id/secrets`.

```jsonc
{
  "id": "uuid",
  "name": "clienta-prod",
  "slug": "clienta",
  "serverId": "uuid",
  "server": { "id": "uuid", "name": "db-01", "host": "192.0.2.10" },   // when included
  "composeProjectName": "sb_4f2a",
  "remotePath": "/opt/db-instances/sb_4f2a",
  "apiSubdomain": "clienta.wharf.example.com",
  "studioSubdomain": "studio-clienta.wharf.example.com",
  "sslMode": "require",                          // require | disable
  "status": "provisioning",                       // see §2
  "lastActionLog": "…tail…" ,                     // null unless an action ran
  "healthCheckedAt": "2000-01-01T18:00:00.000Z",  // nullable
  "createdAt": "2000-01-01T17:55:00.000Z",
  "updatedAt": "2000-01-01T18:00:00.000Z",
  "activeJob": null                              // provision | remove | restore | sync | clone | null
}
```

Lists are returned as a **bare array** (consistent with `GET /api/servers`).
Soft-deleted rows (`deletedAt != null`) are excluded from every list and 404 on
read.

## 2. Status state machine

```
            ┌──────────────► error ──(retry)──┐
            │                                  ▼
(create) ─► provisioning ─────────────────► running ◄──(start)── stopped
            │                                  │                    ▲
            │                                  └────(stop)──────────┘
            └──────────────────────────────────┴──► removing ──► (soft-deleted)

running ──(restore | sync | clone target)──► restoring ──► running
                                  └──────► error
```

Only the engine writes `status`; the UI renders it. `error` is terminal until an
explicit **retry** or **remove** — never auto-retried (spec §6.1).

## 3. Routes

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/db-instances` | viewer | `?serverId=` filter. Bare array. |
| POST | `/api/db-instances` | operator | `{serverId, name, slug, sslMode}` → **202** `{id, jobId}` |
| GET | `/api/db-instances/:id` | viewer | single DTO |
| DELETE | `/api/db-instances/:id` | **admin** | body `{confirmName}` must equal `name`, else 400 → 202 `{jobId}` |
| POST | `/api/db-instances/:id/stop` | operator | → 200 DTO |
| POST | `/api/db-instances/:id/start` | operator | → 200 DTO |
| POST | `/api/db-instances/:id/retry` | operator | only from `error` → 202 `{jobId}` |
| PATCH | `/api/db-instances/:id/ssl-mode` | **admin** | `{sslMode: require \| disable}`; applies to the existing Supavisor tenant → 200 DTO |
| GET | `/api/db-instances/:id/secrets` | operator | audited, `Cache-Control: no-store` |
| GET | `/api/db-instances/:id/provision-log` | viewer | SSE, see §5 |
| POST | `/api/db-instances/:id/restore` | **admin** | raw dump body, `?confirmName=` → 202 `{jobId}` |
| GET/PUT/DELETE | `/api/db-instances/:id/sync-source` | **admin** | live-sync source; secrets never echoed |
| POST | `/api/db-instances/:id/sync-source/test` | **admin** | read-only probe → `{ok, detail}` |
| POST | `/api/db-instances/:id/sync` | **admin** | body `{confirmName}` → 202 `{jobId}` |
| POST | `/api/db-instances/:sourceId/clone` | **admin** | `{targetInstanceId, confirmName}`; exact destination name → 202 `{jobId, targetInstanceId}` |
| GET | `/api/db-instances/:targetId/clone-log` | viewer | Destination clone SSE stream; 404 for missing/deleted destination |
| GET | `/api/db-instances/:id/restore-log` · `/sync-log` | viewer | SSE, see §5 |
| GET | `/api/db-instances/slug-available?slug=` | operator | `{available: boolean}` |

`409` when the target server's single-flight lock is held (message names the
holder). `secrets` returns:

```jsonc
{ "apiUrl": "https://clienta.wharf.example.com", "studioUrl": "https://studio-clienta.wharf.example.com",
  "anonKey": "eyJ…", "serviceRoleKey": "eyJ…", "pgPassword": "…",
  "poolerHost": "db-01.example.com", "sslMode": "require" }
```

## 4. Job ids

- provision / retry → `provision:{instanceId}`
- remove → `remove:{instanceId}`
- restore from an uploaded dump → `restore:{instanceId}`
- sync from a live source database → `sync:{instanceId}`
- clone another WHARF database → `clone:{targetInstanceId}`
- standalone server prep → `bootstrap:{serverId}` (existing)

Restore, sync and clone put the destination row in `restoring`, so the status alone does not
say which is running — the DTO's derived `activeJob` field does, and a client
picks the log route from it.

All use `lib/jobs/stream.ts`; all hold the per-server lock from
`lib/jobs/lock.ts` for their duration.
Clone holds both source and destination server locks (one lock when they share
a server), while the source instance stays `running`. The request carries only
instance ids and a confirmation; connection credentials are resolved internally.

## 5. Phase protocol (drives the UI checklist)

The pipeline publishes phase boundaries as `step`/`ok`/`err` events whose
`line` **begins with a marker glyph and the exact phase id** — the same
convention bootstrap already uses (`› installDocker`). Everything else is
free-form `info` detail.

```
data: {"kind":"step","line":"› prepare"}          // phase started
data: {"kind":"info","line":"docker compose version → 2.29.1"}
data: {"kind":"ok","line":"✓ prepare"}            // phase completed
data: {"kind":"err","line":"✗ health: timed out after 300s"}   // phase failed
data: {"done":true,"status":"error"}
```

Phase ids, in order:

| id | Checklist label | Notes |
|---|---|---|
| `validate` | Validate | slug/regex/uniqueness/path |
| `prepare` | Prepare server | **emitted only when the server is not yet prepared**; expands to bootstrap's own step lines as nested `info` |
| `secrets` | Generate secrets | pg password, JWT secret, anon + service_role |
| `render` | Render compose | template + Traefik labels |
| `upload` | Upload to server | SFTP compose + .env |
| `start` | Start containers | `docker compose up -d` |
| `health` | Health checks | Postgres then Kong, server-side |
| `pooler` | Register with pooler | `PUT` this instance's `db` into the server's one shared Supavisor as tenant `{composeProjectName}` (`lib/provision/pooler.ts`) — see §7 for the resulting connection string. **The only phase whose failure doesn't leave secrets unsaved**: by this point Kong/Studio/db are already up and health-checked, so a `pooler` failure still ends the job `error` (Retry stays available) but secrets are sealed and persisted regardless — the instance is fully usable via its REST API either way. |

Teardown (`remove:*`) uses phases: `stop` → `volumes` → `files` → `metadata`. The
`stop` phase also best-effort deregisters the instance from the shared pooler
(`DELETE /api/tenants/{composeProjectName}`) — failure there is logged and does
not block removal (there is nothing left to protect once containers are
stopped and volumes are gone).

Restore (`restore:*`) uses: `upload` → `snapshot` → `restore` → `cleanup`.

Sync (`sync:*`) uses: `connect` → `dump` → `snapshot` → `restore` → `storage` →
`cleanup`. `storage` always appears; it reports itself as skipped when the
source is not copying objects, so the checklist shape is fixed.

A sync's failure status depends on WHERE it failed. Failing **before** the
`restore` phase has written nothing to the instance — `connect`/`dump`/`snapshot` only read the source and write scratch
files — so the row returns to `running`, not `error`. `error` is terminal until
an explicit retry or remove, and is reserved for an instance whose data was
actually being replaced when the job died; its pre-sync snapshot is the way
back. Failing **after** `restore` completed (copying storage object files,
cleanup) also returns the row to `running`: the database is correct and only
the object files are incomplete, so the log says which, and re-running the sync
finishes the job. The job itself still ends `error` in all three cases.

The UI derives checklist state purely from these events (never timers): a phase
is *active* after its `›`, *done* after its `✓`, *failed* after its `✗`.

## 6. Preflight

Runs before anything is installed or written on a server being prepared:

1. **Ports 80/443 free** — else abort `port 80 is in use by nginx — a database
   server must own 80/443 (architecture open question §5)`.
2. **Effective root** — `id -u` = 0 or passwordless sudo.
3. **Disk** — ≥10 GB free on `/opt`.

A preflight failure aborts the provisioning job with the instance row set to
`error` and **the server unmodified**.

## 7. Naming

- `composeProjectName` = `sb_` + 4 hex chars, unique per server.
- `remotePath` = `/opt/db-instances/{composeProjectName}`.
- `apiSubdomain` = `{slug}.{INSTANCE_DOMAIN}`, `studioSubdomain` =
  `studio-{slug}.{INSTANCE_DOMAIN}` where `INSTANCE_DOMAIN` is a panel env var.
- Slug: `^[a-z0-9][a-z0-9-]*$`, globally unique, ≤40 chars.
- Pooler tenant id = `composeProjectName` (the `sb_xxxx` value, also shown as
  "Tenant ID" in the credentials modal). A registered instance is reached
  directly over Postgres wire protocol as
  `postgres://postgres.{composeProjectName}:{pgPassword}@{server host}:5432/postgres?sslmode={sslMode}`
  (session mode) or `:6543` (transaction mode) — the username convention the
  shared Supavisor pooler (§5 `pooler` phase) uses to tell tenants apart on
  one shared host/port pair per server.
- `sslMode=require` sets Supavisor's per-tenant `enforce_ssl` policy and rejects
  plaintext clients. `sslMode=disable` preserves plaintext compatibility.
  Existing rows migrate to `disable`; newly created instances default to
  `require`.
