/**
 * Per-instance CPU/memory budget.
 *
 * Every container of one instance runs inside a single systemd slice
 * (compose `cgroup_parent`, see lib/provision/render.ts), and the slice
 * carries the limit — so it bounds the whole Supabase stack together, unlike
 * the per-container caps in render.ts's SERVICE_LIMITS, which only stop one
 * container from taking every core. Client-safe: imported by the panel UI.
 */
import { z } from "zod";

/** `null` on either field means unlimited. */
export interface ResourceLimits {
  /** Cores, e.g. 1.5 → systemd CPUQuota=150%. */
  cpuLimit: number | null;
  /** Hard memory ceiling (systemd MemoryMax) in MiB. */
  memoryLimitMb: number | null;
}

/** Matches the database column defaults (prisma/schema.prisma). */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { cpuLimit: 1, memoryLimitMb: 3072 };

export const CPU_LIMIT_MIN = 0.25;
export const CPU_LIMIT_MAX = 64;
/** An idle Supabase stack uses roughly 1–1.5 GiB; less than this OOM-kills it at boot. */
export const MEMORY_LIMIT_MIN_MB = 1536;
export const MEMORY_LIMIT_MAX_MB = 262_144;

/**
 * MemoryHigh as a fraction of MemoryMax: above it the kernel throttles the
 * slice and reclaims its memory, so a growing stack slows down well before
 * the hard ceiling forces an OOM kill.
 */
export const MEMORY_HIGH_RATIO = 0.9;

/** PATCH /api/db-instances/:id/resource-limits */
export const updateResourceLimitsSchema = z.object({
  cpuLimit: z
    .number()
    .min(CPU_LIMIT_MIN)
    .max(CPU_LIMIT_MAX)
    // systemd's CPUQuota is a whole percentage of one core.
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, "Use at most two decimal places")
    .nullable(),
  memoryLimitMb: z.number().int().min(MEMORY_LIMIT_MIN_MB).max(MEMORY_LIMIT_MAX_MB).nullable(),
});

export type UpdateResourceLimitsInput = z.infer<typeof updateResourceLimitsSchema>;

/** Same shape lib/provision/naming.ts mints; duplicated so this module stays client-safe. */
const PROJECT_RE = /^sb_[0-9a-f]{4}$/;

/**
 * The instance's systemd slice. The `-` makes it a child of `wharf.slice`
 * (systemd slice names encode their hierarchy), which groups every WHARF
 * instance on the server under one parent.
 */
export function instanceSliceName(project: string): string {
  if (!PROJECT_RE.test(project)) {
    throw new Error(`Invalid compose project name ${JSON.stringify(project)} for a systemd slice.`);
  }
  return `wharf-${project}.slice`;
}

/** systemd resource-control assignments for `limits`, in a stable order. */
export function sliceProperties(limits: ResourceLimits): string[] {
  const { cpuLimit, memoryLimitMb } = limits;
  return [
    // An empty assignment resets CPUQuota to unlimited.
    cpuLimit === null ? "CPUQuota=" : `CPUQuota=${Math.round(cpuLimit * 100)}%`,
    memoryLimitMb === null
      ? "MemoryHigh=infinity"
      : `MemoryHigh=${Math.floor(memoryLimitMb * MEMORY_HIGH_RATIO)}M`,
    memoryLimitMb === null ? "MemoryMax=infinity" : `MemoryMax=${memoryLimitMb}M`,
  ];
}

/** Human-readable budget, e.g. "1.5 CPU · 3 GB" or "Unlimited". */
export function formatResourceLimits(limits: ResourceLimits): string {
  const cpu = limits.cpuLimit === null ? null : `${limits.cpuLimit} CPU`;
  const mem =
    limits.memoryLimitMb === null
      ? null
      : limits.memoryLimitMb % 1024 === 0
        ? `${limits.memoryLimitMb / 1024} GB`
        : `${limits.memoryLimitMb} MB`;
  if (!cpu && !mem) return "Unlimited";
  return [cpu ?? "unlimited CPU", mem ?? "unlimited memory"].join(" · ");
}
