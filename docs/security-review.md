# WHARF security guidance

WHARF stores SSH credentials and the master secrets for the Supabase instances it
manages. A compromised administrator session, or access to both the metadata
database and `WHARF_MASTER_KEY`, can compromise every managed server. Deploy it
as a privileged administration tool and restrict access to trusted operators.
For vulnerability reporting, see [`SECURITY.md`](../SECURITY.md).

This document explains the security boundaries and remaining limitations. It is
not a penetration-test report or a certification of any deployment.

## Secret storage and recovery

- `lib/crypto.ts` encrypts `*_enc` fields with AES-256-GCM and a fresh 12-byte IV;
  the stored value contains the IV, ciphertext and authentication tag.
- `WHARF_MASTER_KEY` must decode to exactly 32 bytes. Supply it through the
  deployment environment, never the source tree or metadata database.
- List/detail serializers omit encrypted fields. Dedicated reveal routes return
  plaintext only to authorized callers, set `Cache-Control: no-store`, and add
  an audit entry. Treat the browser and administrator device as part of the
  trust boundary.
- The secret-logging check is a guard against common application logging errors;
  it is not a complete secret scanner. Review tool output and service logs before
  sharing them publicly.
- Back up the master key separately from database archives. Archives contain
  encrypted credentials and are unusable for recovery without the original key.
- Key rotation must cover every encrypted schema field. The rotation-targets
  test checks that coverage, but operators must still prove rotation and recovery
  against a disposable deployment. Follow `docs/runbook.md` §7: back up under the
  old key, stop both services, run `--dry-run`, confirm `failed=0`, rotate, then
  prove a credential reveal works under the new key before discarding the old
  one. Preserve the old key for any retained backup encrypted under it.

## Authentication and authorization

- Passwords use bcrypt with cost 12. The credentials flow uses a dummy hash for
  unknown email addresses to reduce login timing differences.
- Encrypted JWT sessions last 12 hours. Cookie flags include `HttpOnly` and
  `SameSite=Lax`; `Secure` depends on an HTTPS `NEXTAUTH_URL`. Configure HTTPS and
  validate the cookie domain before using Studio single sign-on.
- Login failures are rate limited to five failures per 15 minutes per email.
  Rate limits are in memory; process restarts reset them and independent panel
  replicas do not share them.
- Administrator 2FA is not currently implemented. Use access controls around the
  panel appropriate to this limitation.
- `lib/rbac.ts` defines the role matrix, and the API remains authoritative even
  when the UI hides an action. Instance removal, restore and sync require admin
  privileges. Typed-name confirmation is checked against the stored instance.
- Studio and terminal access require operator or admin privileges; viewer access
  does not confer the ability to mutate a managed database through Studio.

## Managed-server boundary

Provisioning can execute commands with root privileges and permanently delete
Docker volumes. Limit registration and credentials to servers you intend WHARF
to administer.

- Panel SSH operations use `lib/ssh.ts`. Host-key pinning uses trust on first use:
  an initial connection must be independently trusted; subsequent fingerprint
  changes block actions until the operator verifies and accepts the new key.
- Preflight checks ports, privilege and disk space before installation. Remote
  paths are re-derived from the instance project name and validated before
  deletion, restore or sync.
- Generated credentials and validated slugs are constrained before shell and
  Compose templating. Keep those checks intact when extending provisioning.
- Job locks are in memory and assume a single panel process. Running multiple
  panel replicas without distributed coordination can weaken exclusion for
  provisioning and teardown.
- Live-sync source credentials are encrypted at rest. Remote scripts supply them
  through environment variables or mode-0600 files rather than logging them.
- An administrator can direct sync to an arbitrary reachable database host.
  This permits outbound connections from a managed server; it is restricted to
  the same role that already has full SSH access. Apply network egress controls
  if the server must not reach other internal systems.
- Orphan detection is read-only. Operators review and remove orphaned resources
  manually.

## Browser and transport protections

- Security middleware applies CSP, HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`. CSP is evaluated
  from deployment configuration and permits only the configured Studio origins
  and gateway endpoint in the relevant directives.
- `script-src` currently permits both `'unsafe-inline'` and `'unsafe-eval'`.
  A nonce-based policy and tighter script execution rules are not currently
  implemented. React's escaping and avoiding user-generated HTML reduce exposure
  but do not replace a strict CSP.
- Middleware rejects browser API mutations with a cross-site Origin or
  `Sec-Fetch-Site`. Non-browser clients without these headers are allowed, so
  protecting session cookies remains essential.
- The gateway verifies authorization before accepting a WebSocket upgrade.
  Terminate public connections at HTTPS/WSS and keep the application listeners
  bound to loopback.
- Use TLS for database connections over untrusted networks. Do not assume a
  self-hosted PostgreSQL server enforces encryption automatically.

## Audit and operator responsibilities

The audit table has an insert-only database trigger, and the application exposes
no audit update/delete route. Audit events cover authentication failures, user
changes, terminal session metadata, credential reveals and infrastructure jobs.
Terminal keystrokes and full transcripts are not recorded; deployments requiring
that evidence need an additional recording solution. Database administrators can
still alter database-level protections, so control access to that account.

Operators remain responsible for the provisioned Supabase stack's own security:
Auth configuration, database roles, RLS policies, application keys and storage
access rules. WHARF's encrypted metadata does not make an unsafe application or
RLS policy safe.

## Dependency and deployment verification

Run `npm audit --omit=dev` for each release and assess advisories against the
actual dependency versions and enabled features. Transitive Next.js image and
CSS dependencies have appeared in prior advisory reviews; do not treat a previous
assessment as evidence that a newer advisory is harmless. Upgrade and re-evaluate
rather than relying solely on the CI severity threshold.

Automated tests do not replace deployment verification. Use a disposable server
to check SSH host-key changes, authorization, provisioning/teardown, key rotation,
backup restoration, gateway rejection, security headers and Studio single sign-on
before relying on a deployment. There is no claim of an independent penetration
test; the provisioning path requires a dedicated assessment for your risk model.
