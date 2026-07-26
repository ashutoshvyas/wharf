# WHARF — Hosting Control Plane

Self-hosted control plane with three modules — **Websites**, **Servers** (in-browser SSH
terminal), and **Databases** (provision, manage and destroy real self-hosted Supabase
stacks over SSH, fronted by Traefik with automatic TLS).

- [Product specification](docs/spec-v2.md)
- [Architecture](docs/architecture.md)
- [Design system](docs/design.md)
- [Deployment guide](docs/deployment.md) and [operations guide](deploy/README.md)
- [Security policy](SECURITY.md) and [security guidance](docs/security-review.md)

## Stack

Next.js 15 (App Router, TS) · Prisma + Postgres · NextAuth (credentials, JWT) ·
standalone `ws`+`ssh2` Terminal Gateway · Tailwind v4 · AES-256-GCM secret storage.

## Deployment model

The panel and gateway run **directly on a VPS as node processes — no Docker**.
The panel metadata DB lives on **your own Supabase server's Postgres** (pooled
connection at runtime, direct connection for migrations). Docker exists only on
*managed* servers, where the provisioning engine deploys Supabase stacks
(spec §6) — that is the product, not this app's runtime.

## Setup (local dev or VPS)

```bash
cp .env.example .env        # fill in: Supabase DATABASE_URL + DIRECT_URL,
                            # NEXTAUTH_SECRET + WHARF_MASTER_KEY (openssl rand -base64 32)
npm install
npm run db:check            # dry-run: connectivity + migration status (never writes)
npm run db:deploy           # apply migrations (uses DIRECT_URL)
npm run db:seed             # creates the admin from ADMIN_EMAIL/ADMIN_PASSWORD
npm run dev                 # panel on :3000
npm run dev -w gateway      # terminal gateway on :3001
```

Production on the VPS: `npm run build && npm start` (panel) and
`npm run build -w gateway && npm start -w gateway`, each under systemd or pm2,
behind Caddy/nginx for TLS. Every environment variable is documented in
`.env.example`.

Deployment is manual: run the installation or deployment commands on your own
server. GitHub Actions validates code only; it has no deployment workflow or
server credentials. Keep real environment files, SSH keys, database backups and
deployment credentials outside the repository.

## Repository layout

```
app/            Next.js App Router (panel UI + API routes)
components/     UI kit + module components
lib/            crypto, ssh, rbac, audit, provisioning engine
gateway/        standalone Terminal Gateway service (ws + ssh2)
prisma/         schema, migrations, seed
templates/      pinned Supabase compose + Traefik bootstrap artifacts
docs/           spec, architecture, design, runbooks
deploy/         manual deployment, service, reverse-proxy and backup tooling
```

## License and attribution

WHARF is developed by **INITQUBE** and distributed under the
[Apache License 2.0](LICENSE). Preserve the license and INITQUBE attribution
notice in [NOTICE](NOTICE) when redistributing WHARF or a derivative. The
attribution is: **“WHARF is developed by INITQUBE.”**

Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
