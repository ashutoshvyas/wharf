/**
 * Websites module — request validation.
 *
 * Websites are pure metadata (architecture §4.4): domain, server FK,
 * filesystem path, optional db-instance FK, one labeled encrypted credential
 * pair, notes. These schemas gate POST /api/websites (create) and
 * PATCH /api/websites/:id (update).
 *
 * Update semantics for `accessPassword`: an EMPTY string (or the field being
 * absent) means "keep the stored password" — the UI submits '' from the
 * "(unchanged)" placeholder field. Only a non-empty value re-seals.
 */
import { z } from "zod";

/**
 * Bare hostname: dot-separated labels of [a-z0-9-], no leading/trailing
 * hyphen per label, at least two labels (example.com), max 63 chars per
 * label. No scheme, port, path or whitespace.
 */
const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, "domain must be at most 253 characters")
  .regex(
    HOSTNAME_RE,
    "must be a bare hostname like clientb.com (no scheme, port or path)",
  );

/** Absolute unix path: starts with '/', no whitespace. */
const pathSchema = z
  .string()
  .trim()
  .min(1, "path is required")
  .max(300, "path must be at most 300 characters")
  .regex(/^\/\S*$/, "must be an absolute unix path (starts with /)");

const credentialLabelSchema = z
  .string()
  .trim()
  .min(1, "credential label is required")
  .max(40, "credential label must be at most 40 characters");

const usernameSchema = z
  .string()
  .trim()
  .max(200, "username must be at most 200 characters");

const passwordSchema = z
  .string()
  .max(500, "password must be at most 500 characters");

const notesSchema = z.string().max(2000, "notes must be at most 2000 characters");

export const websiteCreateSchema = z.object({
  domain: domainSchema,
  serverId: z.uuid("serverId must be a UUID"),
  path: pathSchema,
  dbInstanceId: z.uuid("dbInstanceId must be a UUID").nullable().optional(),
  credentialLabel: credentialLabelSchema.default("Admin login"),
  accessUsername: usernameSchema.optional(),
  accessPassword: passwordSchema.optional(),
  notes: notesSchema.optional(),
});

export const websiteUpdateSchema = z.object({
  domain: domainSchema.optional(),
  serverId: z.uuid("serverId must be a UUID").optional(),
  path: pathSchema.optional(),
  dbInstanceId: z.uuid("dbInstanceId must be a UUID").nullable().optional(),
  credentialLabel: credentialLabelSchema.optional(),
  accessUsername: usernameSchema.nullable().optional(),
  /** Empty string = keep the currently stored password. */
  accessPassword: passwordSchema.optional(),
  notes: notesSchema.optional(),
});

export type WebsiteCreateInput = z.infer<typeof websiteCreateSchema>;
export type WebsiteUpdateInput = z.infer<typeof websiteUpdateSchema>;
