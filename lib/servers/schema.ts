/**
 * Servers API request schemas.
 *
 * - serverCreateSchema: full payload; exactly ONE SSH secret, matching
 *   `authMethod` (password → sshPassword, private_key → sshPrivateKey).
 * - serverUpdateSchema: everything optional; empty-string secret fields
 *   mean "keep the existing stored value" and are stripped from the output.
 */
import { z } from "zod";

/** Strict dotted-quad IPv4 (each octet 0-255). */
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** RFC-1123 hostname: dot-separated alnum labels, hyphens inside, ≤253 chars. */
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Loose PEM shape check — full parsing happens at SSH connect time. */
const PEM_RE =
  /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/;

const hostSchema = z
  .string()
  .min(1, "host is required")
  .refine((v) => IPV4_RE.test(v) || HOSTNAME_RE.test(v), {
    message: "must be a valid hostname or IPv4 address",
  });

const nameSchema = z.string().min(1).max(64);

const sshPortSchema = z.number().int().min(1).max(65535);

const sshUserSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^\S+$/, "must not contain spaces");

export const authMethodSchema = z.enum(["password", "private_key"]);

const sshPrivateKeySchema = z
  .string()
  .regex(PEM_RE, "must be a PEM-encoded private key");

const linkedPanelUrlSchema = z.union([
  z.literal(""),
  z
    .string()
    .max(512)
    .regex(/^https?:\/\/\S+$/i, "must be an http(s) URL"),
]);

const tagsSchema = z.array(z.string().min(1).max(24)).max(8);

export const serverCreateSchema = z
  .object({
    name: nameSchema,
    host: hostSchema,
    sshPort: sshPortSchema.default(22),
    sshUser: sshUserSchema,
    authMethod: authMethodSchema,
    sshPassword: z.string().min(1).optional(),
    sshPrivateKey: sshPrivateKeySchema.optional(),
    linkedPanelUrl: linkedPanelUrlSchema.optional(),
    panelUser: z.string().max(128).optional(),
    panelPass: z.string().max(256).optional(),
    tags: tagsSchema.default([]),
  })
  .superRefine((v, ctx) => {
    const hasPassword = v.sshPassword !== undefined;
    const hasKey = v.sshPrivateKey !== undefined;
    if (hasPassword && hasKey) {
      ctx.addIssue({
        code: "custom",
        path: ["sshPassword"],
        message: "provide exactly one of sshPassword or sshPrivateKey",
      });
      return;
    }
    if (v.authMethod === "password" && !hasPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["sshPassword"],
        message: "sshPassword is required when authMethod is 'password'",
      });
    }
    if (v.authMethod === "password" && hasKey) {
      ctx.addIssue({
        code: "custom",
        path: ["sshPrivateKey"],
        message: "sshPrivateKey is not allowed when authMethod is 'password'",
      });
    }
    if (v.authMethod === "private_key" && !hasKey) {
      ctx.addIssue({
        code: "custom",
        path: ["sshPrivateKey"],
        message: "sshPrivateKey is required when authMethod is 'private_key'",
      });
    }
    if (v.authMethod === "private_key" && hasPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["sshPassword"],
        message: "sshPassword is not allowed when authMethod is 'private_key'",
      });
    }
  });

export type ServerCreateInput = z.infer<typeof serverCreateSchema>;

export const serverUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    host: hostSchema.optional(),
    sshPort: sshPortSchema.optional(),
    sshUser: sshUserSchema.optional(),
    authMethod: authMethodSchema.optional(),
    // Empty string = "keep existing secret" (stripped by the transform below).
    sshPassword: z.string().optional(),
    sshPrivateKey: z.union([z.literal(""), sshPrivateKeySchema]).optional(),
    linkedPanelUrl: linkedPanelUrlSchema.optional(),
    panelUser: z.string().max(128).optional(),
    panelPass: z.string().max(256).optional(),
    tags: tagsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sshPassword && v.sshPrivateKey) {
      ctx.addIssue({
        code: "custom",
        path: ["sshPassword"],
        message: "provide at most one of sshPassword or sshPrivateKey",
      });
    }
  })
  .transform(({ sshPassword, sshPrivateKey, panelUser, panelPass, ...rest }) => ({
    ...rest,
    ...(sshPassword ? { sshPassword } : {}),
    ...(sshPrivateKey ? { sshPrivateKey } : {}),
    ...(panelUser ? { panelUser } : {}),
    ...(panelPass ? { panelPass } : {}),
  }));

export type ServerUpdateInput = z.infer<typeof serverUpdateSchema>;
