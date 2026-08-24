/**
 * Database-instances API request schemas.
 *
 * Mirrors docs/provisioning-contract.md §3 (request bodies) and §7 (naming):
 * a slug is `^[a-z0-9][a-z0-9-]*$`, globally unique, ≤40 chars — it becomes a
 * DNS label (`{slug}.{INSTANCE_DOMAIN}`), so uppercase, underscores, dots and
 * a leading hyphen are all rejected here rather than at provision time.
 */
import { z } from "zod";
import { INSTANCE_SSL_MODES } from "./ssl-mode";

/** DNS-label-safe slug: lowercase alnum start, then alnum or hyphen. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const slugSchema = z
  .string()
  .min(1, "slug is required")
  .max(40, "must be at most 40 characters")
  .regex(SLUG_RE, "must be lowercase letters, digits and hyphens, starting with a letter or digit");

export const createInstanceSchema = z.object({
  serverId: z.uuid("serverId must be a UUID"),
  name: z.string().min(1, "name is required").max(64, "must be at most 64 characters"),
  slug: slugSchema,
  sslMode: z.enum(INSTANCE_SSL_MODES).default("require"),
});

export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;

/** PATCH /api/db-instances/:id/ssl-mode — an explicit pooler TLS policy. */
export const updateInstanceSslModeSchema = z.object({
  sslMode: z.enum(INSTANCE_SSL_MODES),
});

export type UpdateInstanceSslModeInput = z.infer<typeof updateInstanceSslModeSchema>;

/**
 * DELETE /api/db-instances/:id body — a type-the-name confirmation
 * (architecture §4.3 "admin-only, type-the-name confirmation"). The value is
 * compared against the stored `name` in the route; the schema only enforces
 * that a string was supplied.
 *
 * `force`: skip the SSH-based cleanup phases entirely (stop/volumes/files)
 * and only remove WHARF's own metadata row — for an instance whose server is
 * permanently unreachable (bad/missing credentials, decommissioned box), the
 * normal remove can never succeed since it requires connecting first. Only
 * valid from `error` status (lib/provision/teardown.ts enforces this), and
 * leaves anything that might exist on the remote server untouched.
 */
export const removeSchema = z.object({
  confirmName: z.string().min(1, "confirmName is required"),
  force: z.boolean().optional(),
});

export type RemoveInput = z.infer<typeof removeSchema>;
