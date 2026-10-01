import { z } from "zod";

/** Shared by the browser and API. Never interpolate unvalidated ranges into commands. */
export const ipRangeSchema = z.string().trim().max(64).pipe(
  z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()], {
    error: "Enter an IPv4/IPv6 address or CIDR range, such as 192.0.2.10 or 192.0.2.0/24.",
  }),
).transform((value) => {
  const normalized = value.toLowerCase();
  return normalized.includes("/") ? normalized : `${normalized}/${normalized.includes(":") ? 128 : 32}`;
});

export const allowedCidrsSchema = z.array(ipRangeSchema).min(1, "Add at least one allowed address, or choose Block all.")
  .max(100, "Use at most 100 addresses or ranges.")
  .transform((values) => [...new Set(values)]);

/** Optional migration baseline: an empty list means keep the default allow-all policy. */
export const baselineAllowedCidrsSchema = z.array(ipRangeSchema)
  .max(100, "Use at most 100 addresses or ranges.")
  .transform((values) => [...new Set(values)])
  .default([]);

export const networkAccessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("restricted"), allowedCidrs: allowedCidrsSchema }).strict(),
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("blocked") }).strict(),
]);

export type NetworkAccessPolicy = z.infer<typeof networkAccessSchema>;
export const DEFAULT_NETWORK_ACCESS: NetworkAccessPolicy = { mode: "all" };
export const ALL_NETWORKS = ["0.0.0.0/0", "::/0"];

export function readNetworkAccess(value: unknown): NetworkAccessPolicy {
  // Null is the pre-network-access value. Treat it as the safe-for-availability
  // default so old rows and manually-created rows do not unexpectedly lose access.
  // Invalid persisted policies still fail rather than silently becoming all.
  return value == null ? DEFAULT_NETWORK_ACCESS : networkAccessSchema.parse(value);
}

export const enableNetworkAccessSchema = z.object({
  confirmName: z.string().min(1),
  baselineAllowedCidrs: baselineAllowedCidrsSchema,
}).strict();

export interface NetworkAccessDto {
  policy: NetworkAccessPolicy | null;
  appliedAt: string | null;
  applyError: string | null;
  server: {
    id: string;
    name: string;
    firewallManaged: boolean;
    unconfiguredInstances: { id: string; name: string }[];
  };
}

export interface NetworkAccessResult {
  applied: boolean;
  applyError?: string;
}
