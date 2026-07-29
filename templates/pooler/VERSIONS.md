# Shared per-server Supavisor pooler — provenance & upgrade playbook

Unlike `templates/supabase/` (one stack per tenant instance, vendored verbatim
from upstream and trimmed), this template is deployed **once per managed
server** by bootstrap, the same way `templates/traefik/` is. It is a
WHARF-authored compose file that runs upstream's `supabase/supavisor` image in
its **dynamic multi-tenant** mode (the HTTP admin API, `PUT/DELETE
/api/tenants/:external_id`) rather than the single co-located-tenant mode
`docker/docker-compose.yml` in `supabase/supabase` wires up via a static
`pooler.exs` file — that mode assumes one Supavisor per one `db`, which is the
wrong shape for "one shared pooler fronting N independently provisioned
tenant databases."

## Provenance

| | |
|---|---|
| Modeled on | `supabase/supabase` @ `9cf6ae1f6779efcef70dcc94d64e5d8e1cee8304` (docker/docker-compose.yml `supavisor` service) — the same ref already pinned in `templates/supabase/VERSIONS.md` |
| Image tags taken from that ref's compose file | `supabase/supavisor:2.9.5` |
| Vendored on | 2026-07-29 |

## Pinned images

| Service | Image | Role |
|---|---|---|
| `supavisor` | `supabase/supavisor:2.9.5` | The shared pooler — proxies Postgres wire protocol on :5432 (session mode) / :6543 (transaction mode), multiplexing tenants by the `<db_user>.<external_id>` username convention. Admin API on :4000, loopback-only. |
| `pooler-db` | `postgres:17.6-alpine` | Supavisor's **own** metadata store (tenant/cluster/user config — an Ecto-migrated schema, not tenant data). Deliberately the plain official Postgres image, not `supabase/postgres` — see the divergence note below. Independently versioned from `templates/supabase/`'s pinned Postgres since it holds no tenant data. |

## Deliberate divergences from the upstream `supavisor` service definition

| Change | Rationale |
|---|---|
| **No `pooler.exs` / `POOLER_TENANT_ID` / `POOLER_POOL_MODE` static env** | Those wire up exactly one tenant at container boot. Tenants here are registered/deregistered dynamically at runtime by `lib/provision/pipeline.ts` (`pooler` phase) and `lib/provision/teardown.ts`, one HTTP call per instance, via the admin API — see `docs/provisioning-contract.md` §5/§7. |
| **`DATABASE_URL` points at a dedicated `pooler-db`, not the `_supabase` database on a tenant's own `db`** | Upstream's single-tenant compose reuses the one Postgres it's already fronting for its own metadata. A shared pooler must outlive any single tenant (provisioned/torn down independently), so it needs its own persistent metadata store. |
| **Admin API (4000) published as `127.0.0.1:4000:4000`, not left unpublished or opened to the world** | `lib/provision/pipeline.ts`/`teardown.ts` reach it with `curl` over the same SSH connection already open for that phase (`localhost:4000` from the host) — the panel itself never calls it directly over the network, and the API must never be internet-reachable (it can register a tenant pointing at an arbitrary `db_host`). |
| **Session/transaction ports (5432/6543) published directly on the host, not routed through Traefik** | Supavisor speaks the raw Postgres wire protocol, not HTTP — there is nothing for Traefik's HTTP/TLS-terminating routers to do here. Opened once per server by the `openFirewall` bootstrap step, the same way 80/443 are. |
| **Second Docker network (`internal`, project-private) between `supavisor` and `pooler-db`** | Keeps Supavisor's own metadata database off `POOLER_NETWORK` entirely — no tenant `db` container can ever reach it, even though every tenant `db` shares `POOLER_NETWORK` with `supavisor` itself. |
| **`pooler-db` is the plain `postgres` image, not `supabase/postgres`** | `supabase/postgres` only gets its `supabase_admin`/`authenticator`/etc. roles from the init scripts `templates/supabase/docker-compose.yml` mounts (`roles.sql`, `jwt.sql`, …) — none of which apply here. The official image's own `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` bootstrap is sufficient for a metadata-only database with no Supabase-specific schema requirements. |

## Known implication worth re-stating (see `lib/bootstrap/constants.ts` `POOLER_NETWORK` doc comment)

Every tenant instance's `db` service now joins one Docker network (`POOLER_NETWORK` /
`wharf-pooler`) shared with every *other* tenant's `db` on the same server, so
that the one shared `supavisor` container can reach all of them. This narrows
— it does not eliminate — the "Postgres unreachable from other tenants"
invariant `lib/provision/render.ts` otherwise guarantees for `kong`/`studio`:
reaching another tenant's `db` still requires that tenant's own Postgres
password, which a peer container never has. This is the same trade-off
Supabase Cloud's own multi-tenant pooler fleet makes at a much larger scale.

## Re-vendoring playbook

1. Check `supabase/supabase`'s current `docker/docker-compose.yml` `supavisor`
   service definition for a newer pinned image tag or a new required env var.
2. Re-apply the divergences above (all deletions/additions, not structural
   changes to Supavisor's own protocol).
3. Update this file: image tags, date.
4. Run `npx vitest run lib/bootstrap` — covers the render/idempotency of this
   template the same way `lib/provision` tests cover `templates/supabase/`.
5. **Provision one throwaway instance on a real database server** and confirm:
   `docker compose -p wharf-pooler ps` shows both containers healthy, `ufw
   status` shows 5432/6543 open, the `pooler` phase registers the tenant
   (`curl localhost:4000/api/tenants/{project}` on the server returns it), and
   `psql "postgres://postgres.{project}:{pgPassword}@{server-ip}:6543/postgres"`
   connects from off-server. Tear the instance down and confirm the tenant is
   deregistered. **Not yet performed** — same status as `templates/supabase/`,
   pending the dedicated database server (see the project's `[[wharf-managed-server-port-conflict]]`
   memory).
