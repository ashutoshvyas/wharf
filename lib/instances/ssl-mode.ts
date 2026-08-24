/** PostgreSQL client TLS policies offered for WHARF-managed pooler tenants. */
export const INSTANCE_SSL_MODES = ["require", "disable"] as const;

export type InstanceSslMode = (typeof INSTANCE_SSL_MODES)[number];

export function isInstanceSslMode(value: unknown): value is InstanceSslMode {
  return typeof value === "string" && INSTANCE_SSL_MODES.includes(value as InstanceSslMode);
}
