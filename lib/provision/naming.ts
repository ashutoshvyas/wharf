/**
 * Provisioning naming rules — the single source of truth for every
 * derived identifier in docs/provisioning-contract.md §7.
 *
 * Nothing here touches the network or the database: these are pure functions
 * (plus one CSPRNG draw) so the validate phase can reject bad input before the
 * pipeline writes anything to a server.
 */
import { randomBytes } from "node:crypto";

/**
 * Instance slug: lowercase alphanumerics and hyphens, must start with an
 * alphanumeric. Also bounded at SLUG_MAX_LENGTH (see isValidSlug).
 *
 * This regex is a security boundary, not a nicety — the slug is interpolated
 * into a Traefik `Host(...)` rule and into a `.env` file, so allowing a
 * backtick, quote, newline or space here would be a template-injection hole.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Contract §7: slugs are capped at 40 characters. */
export const SLUG_MAX_LENGTH = 40;

/** Shape of a `composeProjectName`: `sb_` + exactly 4 lowercase hex chars. */
export const PROJECT_RE = /^sb_[0-9a-f]{4}$/;

/** Root directory holding one sub-directory per provisioned instance. */
export const INSTANCES_ROOT = "/opt/db-instances";

/** True when `slug` satisfies both the charset and the length rule. */
export function isValidSlug(slug: string): boolean {
  return (
    typeof slug === "string" &&
    slug.length > 0 &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_RE.test(slug)
  );
}

/**
 * Fresh compose project name, `sb_` + 4 hex chars (contract §7).
 *
 * 16 bits of entropy is deliberately small — it keeps `docker compose -p`
 * invocations and remote paths readable. Uniqueness is enforced per server by
 * the caller (unique index + retry on collision), not by the entropy alone.
 */
export function composeProjectName(): string {
  return `sb_${randomBytes(2).toString("hex")}`;
}

/** Remote directory for an instance's compose + .env (contract §7). */
export function remotePathFor(project: string): string {
  if (!PROJECT_RE.test(project)) {
    throw new Error(
      `Invalid compose project name ${JSON.stringify(project)} — expected sb_ followed by 4 hex characters.`,
    );
  }
  return `${INSTANCES_ROOT}/${project}`;
}

export interface InstanceSubdomains {
  /** Public Supabase API host, routed to kong. */
  apiSubdomain: string;
  /** Studio host, routed to studio behind the wharf-auth middleware. */
  studioSubdomain: string;
}

/** The two hostnames an instance claims under the panel's INSTANCE_DOMAIN. */
export function subdomainsFor(slug: string, domain: string): InstanceSubdomains {
  return {
    apiSubdomain: `${slug}.${domain}`,
    studioSubdomain: `studio-${slug}.${domain}`,
  };
}
