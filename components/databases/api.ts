/**
 * Databases module — client-side fetch helpers + wire DTOs
 * (…, docs/provisioning-contract.md §1 + §3).
 *
 * The DTO is the contract's allowlist: no `*Enc` column and no decrypted value
 * ever appears on a read — key material comes only from
 * `GET /api/db-instances/:id/secrets`.
 *
 * Lists are a BARE array (like GET /api/servers); an envelope is tolerated
 * defensively so a backend that wraps the payload does not blank the screen.
 */

/** Contract §2 state machine. */
export type InstanceStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "error"
  | "removing";

/** Statuses that mean "a job is in flight" — drives the 5s poll (design §6). */
const TRANSITIONAL: readonly InstanceStatus[] = [
  "provisioning",
  "removing",
] as const;

export interface InstanceServerRef {
  id: string;
  name: string;
}

/** Contract §1. */
export interface InstanceDto {
  id: string;
  name: string;
  slug: string;
  serverId: string;
  /** Present when the API includes the relation (it does on list + read). */
  server?: InstanceServerRef;
  composeProjectName: string;
  remotePath: string;
  apiSubdomain: string;
  studioSubdomain: string;
  status: InstanceStatus;
  /** Tail of the last action's log — errors keep their evidence (design §6). */
  lastActionLog: string | null;
  healthCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Contract §3 — POST /api/db-instances and POST /:id/retry. */
export interface JobAcceptedDto {
  /** Present on create; retry/remove return only a jobId. */
  id?: string;
  jobId: string;
}

export interface CreateInstancePayload {
  serverId: string;
  name: string;
  slug: string;
}

/** Contract §3 — GET /api/db-instances/:id/secrets. */
export interface InstanceSecretsDto {
  apiUrl: string;
  studioUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  pgPassword: string;
}

export interface SlugAvailabilityDto {
  available: boolean;
}

/** Error carrying the HTTP status so callers can branch on 400 / 403 / 409. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // fall through to the generic message
  }
  return `Request failed (${res.status}).`;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Unwrap `{dbInstances:[…]}` / `{instances:[…]}` envelopes defensively. */
function asArray(data: unknown): InstanceDto[] {
  if (Array.isArray(data)) return data as InstanceDto[];
  if (data && typeof data === "object") {
    for (const key of ["dbInstances", "instances", "data"]) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as InstanceDto[];
    }
  }
  return [];
}

export function isTransitional(status: InstanceStatus): boolean {
  return TRANSITIONAL.includes(status);
}

export const INSTANCES_QUERY_KEY = ["db-instances"] as const;

export async function fetchInstances(serverId?: string): Promise<InstanceDto[]> {
  const url = serverId
    ? `/api/db-instances?serverId=${encodeURIComponent(serverId)}`
    : "/api/db-instances";
  return asArray(await apiFetch<unknown>(url));
}

export async function fetchInstance(id: string): Promise<InstanceDto> {
  const data = await apiFetch<unknown>(`/api/db-instances/${id}`);
  // Tolerate a {dbInstance:{…}} envelope; the contract says bare object.
  if (data && typeof data === "object") {
    for (const key of ["dbInstance", "instance", "data"]) {
      const value = (data as Record<string, unknown>)[key];
      if (value && typeof value === "object") return value as InstanceDto;
    }
  }
  return data as InstanceDto;
}

/** 202 → {id, jobId}; the caller then streams {@link instanceLogUrl}. */
export async function createInstance(
  payload: CreateInstancePayload,
): Promise<JobAcceptedDto> {
  return apiFetch<JobAcceptedDto>("/api/db-instances", jsonInit("POST", payload));
}

export async function stopInstance(id: string): Promise<InstanceDto> {
  return apiFetch<InstanceDto>(`/api/db-instances/${id}/stop`, { method: "POST" });
}

export async function startInstance(id: string): Promise<InstanceDto> {
  return apiFetch<InstanceDto>(`/api/db-instances/${id}/start`, { method: "POST" });
}

/** Only valid from `error` (contract §2) → 202 {jobId}. */
export async function retryInstance(id: string): Promise<JobAcceptedDto> {
  return apiFetch<JobAcceptedDto>(`/api/db-instances/${id}/retry`, {
    method: "POST",
  });
}

/**
 * `confirmName` must equal the instance name, else 400 → 202 {jobId}.
 * `force` skips remote cleanup entirely (only valid from `error` status,
 * else 409) — for an instance whose server can never be reached.
 */
export async function removeInstance(
  id: string,
  confirmName: string,
  force?: boolean,
): Promise<JobAcceptedDto> {
  return apiFetch<JobAcceptedDto>(
    `/api/db-instances/${id}`,
    jsonInit("DELETE", { confirmName, ...(force ? { force: true } : {}) }),
  );
}

/** Audited on the server; never cached. */
export async function fetchInstanceSecrets(
  id: string,
): Promise<InstanceSecretsDto> {
  return apiFetch<InstanceSecretsDto>(`/api/db-instances/${id}/secrets`, {
    cache: "no-store",
  });
}

export async function checkSlugAvailable(
  slug: string,
): Promise<SlugAvailabilityDto> {
  return apiFetch<SlugAvailabilityDto>(
    `/api/db-instances/slug-available?slug=${encodeURIComponent(slug)}`,
    { cache: "no-store" },
  );
}

/**
 * SSE endpoint for the instance's current (or most recent) job.
 *
 * The contract lists exactly one instance-scoped stream route, so provision,
 * retry (`provision:{id}`) and teardown (`remove:{id}`) all replay through it.
 * Kept as a single helper so a future dedicated remove-log route is a one-line
 * change.
 */
export function instanceLogUrl(id: string): string {
  return `/api/db-instances/${id}/provision-log`;
}

/** Slug rules from contract §7. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SLUG_MAX = 40;

/** Best-effort slugification of a display name (mirrors the prototype). */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

/** `12 Jun 2026` */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
