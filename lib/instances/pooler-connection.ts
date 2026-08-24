import type { InstanceSslMode } from "./ssl-mode";

export interface PoolerConnectionInput {
  project: string;
  password: string;
  host: string;
  port: 5432 | 6543;
  sslMode: InstanceSslMode;
}

/** Build the audited connection string shown by the secrets modal. */
export function buildPoolerConnectionString(input: PoolerConnectionInput): string {
  const user = encodeURIComponent(`postgres.${input.project}`);
  const password = encodeURIComponent(input.password);
  const host = input.host.includes(":") && !input.host.startsWith("[")
    ? `[${input.host}]`
    : input.host;
  return `postgres://${user}:${password}@${host}:${input.port}/postgres?sslmode=${input.sslMode}`;
}
