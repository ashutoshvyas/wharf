# Vendored Supabase self-hosting stack — provenance & upgrade playbook

WHARF provisions instances from **checked-in** templates, never from a network
fetch at provision time. This file records exactly what was vendored, what was
changed, and how to move to a newer upstream release.

## Provenance

| | |
|---|---|
| Upstream repo | `supabase/supabase` |
| Ref | `9cf6ae1f6779efcef70dcc94d64e5d8e1cee8304` (commit dated 2026-07-08) |
| Files | `docker/docker-compose.yml` → `docker-compose.yml`, `docker/.env.example` → `.env.template` |
| Vendored on | 2026-07-24 |

Auxiliary config used by the stack (Kong declarative config, DB init SQL,
storage/functions fixtures) lives under `volumes/` exactly as upstream ships it.

## Pinned images

Every image carries an explicit tag — never `:latest`, so a re-provision a year
from now produces the same stack as today.

| Service | Image |
|---|---|
| studio | `supabase/studio:2026.07.07-sha-a6a04f2` |
| kong | `kong/kong:3.9.1` |
| auth | `supabase/gotrue:v2.189.0` |
| rest | `postgrest/postgrest:v14.12` |
| realtime | `supabase/realtime:v2.102.3` |
| storage | `supabase/storage-api:v1.60.4` |
| imgproxy | `darthsim/imgproxy:v3.30.1` |
| meta | `supabase/postgres-meta:v0.96.6` |
| db / db-config | `supabase/postgres:17.6.1.136` |

## Deliberate divergences from upstream

| Change | Rationale |
|---|---|
| **Removed top-level `name:`** | The compose project name comes from `docker compose -p sb_xxxx`; a `name:` key would be a second source of truth and break per-instance isolation. |
| **Removed the `functions` (edge runtime) service** | WHARF does not provision Deno edge functions; it drags in a large image and a volume mount WHARF never writes. Re-add here if edge functions become a product requirement. |
| **Removed the connection pooler (supavisor)** | Instances are reached over their own subdomain through Kong; the pooler adds two published host ports (5432/6543) that would collide between instances on one server. |
| **Removed analytics / vector (logflare) if present upstream** | Log shipping is out of scope; the panel streams provisioning logs itself (`lib/jobs/stream.ts`). |
| **Published host `ports:` stripped at render time** | Not edited here — `lib/provision/render.ts` removes them from kong/studio so several instances coexist on one host without port conflicts. Traefik reaches both over the shared `traefik` network. |
| **`API_EXTERNAL_URL` has no `/auth/v1` suffix** | GoTrue appends `MAILER_URLPATHS_*` (which already begin with `/auth/v1`) to this value; upstream's example double-prefixes and produces broken mail links. |
| **SMTP left unconfigured** | A fresh instance should not silently send mail through a half-configured relay. Operators set SMTP per project. |
| **`PGRST_DB_EXTRA_SEARCH_PATH=public,extensions`** (upstream: `public`) | PostgREST overrides the database's own `search_path`, and operators — unlike types and functions — can only be resolved through it. With `public` alone, every RPC using a bare extension operator fails (`operator does not exist: extensions.vector <=> extensions.vector`) while the identical query succeeds over a direct/pooler connection. Hosted Supabase has `extensions` on the path, so any project synced in from there depends on this. |
| **`GOTRUE_EXTERNAL_*` uncommented for Google / GitHub / Azure / Apple** | Upstream ships these commented out. makes them admin-configurable from the panel, which needs GoTrue to read them on every start; `.env.template` renders each as `false`/empty until an operator sets credentials, so an unconfigured provider is a no-op rather than a startup error. Re-add these on a re-vendor — they are the one **addition** in this table. |
| **`GOTRUE_EXTERNAL_*_REDIRECT_URI` is `${OAUTH_CALLBACK_URL}`** (upstream: `${API_EXTERNAL_URL}/callback`) | This is the URL the *provider* redirects the browser to, and `volumes/api/kong.yml` only routes `/auth/v1/callback` to the auth container. Upstream's form works only because upstream's `API_EXTERNAL_URL` already ends in `/auth/v1`; against ours (bare origin, row above) it yields `https://host/callback`, which nothing serves, and every OAuth sign-in dies at `redirect_uri_mismatch`. The panel renders the whole URL into one `OAUTH_CALLBACK_URL` shared by all four providers — `https://<api-subdomain>/auth/v1/callback` unless an operator overrode it for a custom domain fronting the instance. |
| **`GOTRUE_SMS_*` uncommented** | Upstream ships the SMS block commented out, which left phone sign-up unable to send a code at all. `SMS_PROVIDER` renders empty because configured providers use the signed hook — safe, because GoTrue resolves the provider when sending, not at config load. `SMS_OTP_EXP`/`OTP_LENGTH`/`MAX_FREQUENCY` are **never** rendered empty: they parse as `uint`/`int`/`time.Duration`, where an empty string is a load-time parse error, so the panel always writes concrete values (GoTrue's own defaults when unconfigured). |
| **`GOTRUE_HOOK_SEND_SMS_*` uncommented, then conditionally stripped** | How MSG91 and Twilio are delivered: GoTrue has no MSG91 driver (`GetSmsProvider` knows only twilio/twilio_verify/messagebird/textlocal/vonage), so it POSTs the OTP to a panel route which holds the credentials and calls the selected provider. Twilio uses WHARF routing for SMS/WhatsApp selection and optional SMS fallback; credentials no longer render into the instance. An enabled hook bypasses `GOTRUE_SMS_PROVIDER` entirely, so the two are never both live. `lib/provision/render.ts` **removes** these three keys from the rendered compose unless a hook-delivered provider is selected, so an instance not using one carries no hook config at all. |
| **`SITE_URL` is operator-set, not the instance's own origin** | One server hosts many instances, each backing a different web application, so GoTrue's post-auth landing URL (and the base for its email links) can't be derived from the Supabase subdomain. Falls back to `https://<api-subdomain>` when unset, which is what was hardcoded before. |
| **`GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK` / `_EMAIL_OPTIONAL`, `GOTRUE_EXTERNAL_APPLE_EMAIL_OPTIONAL` added** | Real per-provider fields on GoTrue's `OAuthProviderConfiguration`, surfaced by Supabase Studio next to the credentials. Panel-configurable like the rest; both default to `false`, which is the behavior before they existed. |

## What the renderer injects (not stored here)

`lib/provision/render.ts` adds, per instance:

- **kong** — `traefik.enable=true`, router `Host({slug}.{domain})`, entrypoint
  `websecure`, `certresolver=letsencrypt`, loadbalancer port 8000, and **no auth
  middleware** (this is the public API; live apps depend on it).
- **studio** — router `Host(studio-{slug}.{domain})`, same TLS settings,
  loadbalancer port 3000, **plus** `middlewares=wharf-auth@file` (constant
  `WHARF_AUTH_MIDDLEWARE` from `lib/bootstrap/constants.ts`) so Studio is gated
  by the panel session.
- **networks** — kong and studio join the external `traefik` network; every
  other service, **notably `db`**, stays on the project-private network only.

## Re-vendoring playbook

1. Fetch the new `docker/docker-compose.yml` and `docker/.env.example` from the
   target upstream tag.
2. Re-apply the divergences in the table above (deletions, the
   `API_EXTERNAL_URL` note, and the uncommented `GOTRUE_EXTERNAL_*` provider
   block; the Traefik wiring is code, not template).
3. Update this file: ref, date, image table, and any new divergence.
4. Run `npx vitest run lib/provision` — the render tests assert the label sets,
   that `db` is off the Traefik network, that no host ports survive, and that
   `.env` has no unsubstituted placeholders. A new upstream variable that
   `render.ts` does not know about fails the render **loudly** rather than
   shipping a literal placeholder as a password.
5. **Provision one throwaway instance on a real database server** and confirm:
   both subdomains serve, Studio loads through forwardAuth, and the anon key
   authenticates against the REST endpoint. Only then promote the new tag.

Validate each pinned stack in your own deployment environment before use.
Unit tests do not replace the real-server acceptance checks above.
