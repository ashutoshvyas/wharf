/**
 * PUT /api/db-instances/:id/sync-source body schema.
 *
 * These values end up in a connection string that is interpolated into a
 * command run on a managed server. lib/provision/sync.ts shell-quotes them and
 * percent-encodes the URL components, but this schema is the FIRST layer: host,
 * user, database, sslmode and extra schema names are restricted to a
 * conservative charset here, so anything odd gets a clean 400 at the boundary
 * instead of relying on quoting alone (same defence-in-depth argument as
 * lib/instances/auth-settings-schema.ts's no-line-break rule for .env values).
 *
 * Secrets (`pgPassword`, `serviceRoleKey`) follow this codebase's established
 * convention: an empty string means "keep the stored value" and is stripped by
 * the transform, so an untouched secret never reaches the update handler. On
 * CREATE the route requires `pgPassword` to be present — the schema cannot
 * know whether a row already exists.
 */
import { z } from "zod";

/** Hostname or IP: letters, digits, dot, hyphen, colon (IPv6). No shell metachars. */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;
/** Postgres role/database names, incl. Supabase's `postgres.<project-ref>` form. */
const IDENT_RE = /^[A-Za-z0-9_$.-]+$/;

/**
 * libpq's documented sslmode values. `disable` is allowed (a source on a
 * private network may not speak TLS) but the UI defaults to `require`.
 */
const SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"] as const;

/**
 * Schemas a sync must never copy as an EXTRA schema, and why.
 *
 * The main dump pass runs `pg_restore --clean`, so naming one of these would
 * drop the target's own version and replace it with the source's. Each entry
 * is owned by something on the instance that is not the data being migrated:
 * a container that manages its own migrations, an extension, or — for
 * `vault` — an encryption key that lives only on this instance, which makes
 * copied rows undecryptable ciphertext rather than data.
 *
 * `auth` and `storage` are here too, but they are the ones with an
 * alternative: their DATA is copied by the two toggles instead.
 */
export const RESERVED_SCHEMAS: Record<string, string> = {
  auth: "this instance's GoTrue container owns it — turn on 'Auth users' to copy its data instead",
  storage:
    "this instance's storage-api container owns it — turn on 'Storage objects' to copy its data instead",
  realtime: "this instance's realtime container owns it and manages its own migrations",
  _realtime: "created by this instance's own database init scripts",
  _analytics: "created by this instance's own database init scripts",
  _supavisor: "created by this instance's own database init scripts",
  supabase_functions: "created by this instance's own database init scripts",
  vault:
    "its secrets are encrypted with a key that exists only on this instance, so copied rows " +
    "would be ciphertext nothing can decrypt",
  pgsodium: "owned by the pgsodium extension, whose key is instance-local",
  pgsodium_masks: "owned by the pgsodium extension, whose key is instance-local",
  extensions: "extension-owned — the target instance already provides its own",
  graphql: "extension-owned — the target instance already provides its own",
  graphql_public: "extension-owned — the target instance already provides its own",
  pgbouncer: "connection-pooler state, meaningless on another host",
};

export const syncSourceSchema = z
  .object({
    kind: z.enum(["supabase", "postgres"]).default("supabase"),
    label: z.string().max(120).regex(/^[^\r\n]*$/, "label must not contain line breaks").optional(),

    pgHost: z
      .string()
      .min(1, "pgHost is required")
      .max(253)
      .regex(HOST_RE, "pgHost must be a hostname or IP address"),
    pgPort: z.number().int().min(1).max(65_535).default(5432),
    pgDatabase: z
      .string()
      .min(1)
      .max(63)
      .regex(IDENT_RE, "pgDatabase must be a plain Postgres identifier")
      .default("postgres"),
    pgUser: z
      .string()
      .min(1, "pgUser is required")
      .max(63)
      .regex(IDENT_RE, "pgUser must be a plain Postgres role name"),
    /** Empty string = keep the stored password (stripped by the transform). */
    pgPassword: z.string().max(1024).optional(),
    pgSslMode: z.enum(SSL_MODES).default("require"),

    /**
     * Only used to copy storage objects, so https-only: the service_role key
     * travels on this URL as a bearer token and must never go out in clear.
     */
    projectUrl: z
      .string()
      .max(2048)
      .refine(
        (v) => v === "" || /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v),
        "projectUrl must be an https:// URL",
      )
      .optional(),
    /** Empty string = keep the stored key (stripped by the transform). */
    serviceRoleKey: z.string().max(4096).optional(),

    includeAuthUsers: z.boolean().default(true),
    includeStorageObjects: z.boolean().default(false),
    extraSchemas: z
      .array(
        z
          .string()
          .min(1)
          .max(63)
          .regex(IDENT_RE, "schema names must be plain Postgres identifiers"),
      )
      .max(20)
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.includeStorageObjects && !v.projectUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["projectUrl"],
        message: "projectUrl is required when includeStorageObjects is on",
      });
    }
    if (v.extraSchemas.includes("public")) {
      ctx.addIssue({
        code: "custom",
        path: ["extraSchemas"],
        message: "'public' is always included — remove it from extraSchemas",
      });
    }
    for (const schema of v.extraSchemas) {
      const reason = RESERVED_SCHEMAS[schema];
      if (reason) {
        ctx.addIssue({
          code: "custom",
          path: ["extraSchemas"],
          message: `'${schema}' cannot be an extra schema — ${reason}.`,
        });
      }
    }
  })
  .transform(({ pgPassword, serviceRoleKey, ...rest }) => ({
    ...rest,
    ...(pgPassword ? { pgPassword } : {}),
    ...(serviceRoleKey ? { serviceRoleKey } : {}),
  }));

export type SyncSourceInput = z.infer<typeof syncSourceSchema>;

/**
 * True for a schema the sync engine must refuse to copy. Exported because
 * rows saved before this rule existed can still name one, so the engine
 * re-checks a STORED source rather than trusting that it came through this
 * schema (lib/provision/sync.ts).
 */
export function isReservedSchema(name: string): boolean {
  return name === "public" || name in RESERVED_SCHEMAS;
}

/** POST /api/db-instances/:id/sync — type-the-name confirmation, like remove. */
export const startSyncSchema = z.object({
  confirmName: z.string().min(1, "confirmName is required"),
});
