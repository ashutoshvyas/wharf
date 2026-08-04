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
  | "removing"
  | "restoring";

/** Statuses that mean "a job is in flight" — drives the 5s poll (design §6). */
const TRANSITIONAL: readonly InstanceStatus[] = [
  "provisioning",
  "removing",
  "restoring",
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
  /**
   * Which engine currently holds a live job — `restoring` alone is
   * ambiguous, since restore and sync share it but stream different logs.
   * `null` when nothing is running (including after a panel restart).
   */
  activeJob: "provision" | "remove" | "restore" | "sync" | null;
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
  /**
   * The managed server's own host/IP — the shared Supavisor pooler publishes
   * :5432/:6543 directly there (no subdomain, no Traefik routing involved).
   * Combined client-side with `pgPassword` and the instance's own
   * `composeProjectName` (InstanceDto) to build the two pooler DSNs shown in
   * the connection modal — no separate pooler secret is ever stored/revealed.
   */
  poolerHost: string;
}

export interface SlugAvailabilityDto {
  available: boolean;
}

/**
 * GET/PATCH /api/db-instances/:id/auth-settings — self-hosted-
 * configurable Auth (GoTrue) settings. Secret fields are never echoed —
 * only a `*Configured` boolean, same rule as InstanceSecretsDto.
 */
export interface AuthSettingsDto {
  disableSignup: boolean;
  enableEmailSignup: boolean;
  enableEmailAutoconfirm: boolean;
  enablePhoneSignup: boolean;
  enablePhoneAutoconfirm: boolean;
  enableAnonymousUsers: boolean;
  manualLinkingEnabled: boolean;
  jwtExpirySeconds: number;
  additionalRedirectUrls: string;
  /** Empty = fall back to this instance's own API origin. */
  siteUrl: string;
  /** Empty = fall back to `<api origin>/auth/v1/callback`. */
  oauthCallbackUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassConfigured: boolean;
  smtpSenderName: string;
  smtpAdminEmail: string;
  googleEnabled: boolean;
  /** Comma-separated: the web OAuth client plus any native/One Tap client ids. */
  googleClientId: string;
  googleSecretConfigured: boolean;
  googleSkipNonceCheck: boolean;
  googleEmailOptional: boolean;
  githubEnabled: boolean;
  githubClientId: string;
  githubSecretConfigured: boolean;
  azureEnabled: boolean;
  azureClientId: string;
  azureSecretConfigured: boolean;
  appleEnabled: boolean;
  /** A Services ID (comma-separated list allowed), not a plain client id. */
  appleClientId: string;
  appleSecretConfigured: boolean;
  appleEmailOptional: boolean;
  emailTemplates: EmailTemplateSummaryDto[];
}

/** PATCH-only: leave a secret field undefined to keep the stored value. */
export interface AuthSettingsUpdatePayload {
  disableSignup?: boolean;
  enableEmailSignup?: boolean;
  enableEmailAutoconfirm?: boolean;
  enablePhoneSignup?: boolean;
  enablePhoneAutoconfirm?: boolean;
  enableAnonymousUsers?: boolean;
  manualLinkingEnabled?: boolean;
  jwtExpirySeconds?: number;
  additionalRedirectUrls?: string;
  siteUrl?: string;
  oauthCallbackUrl?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpSenderName?: string;
  smtpAdminEmail?: string;
  googleEnabled?: boolean;
  googleClientId?: string;
  googleSecret?: string;
  googleSkipNonceCheck?: boolean;
  googleEmailOptional?: boolean;
  githubEnabled?: boolean;
  githubClientId?: string;
  githubSecret?: string;
  azureEnabled?: boolean;
  azureClientId?: string;
  azureSecret?: string;
  appleEnabled?: boolean;
  appleClientId?: string;
  /** A developer-generated ES256 JWT Apple caps at 6 months, not a long-lived secret. */
  appleSecret?: string;
  appleEmailOptional?: boolean;
  emailTemplates?: EmailTemplateUpdateEntry[];
}

/** Returned alongside the DTO on PATCH — whether the auth container restart succeeded. */
export interface AuthSettingsPatchResultDto extends AuthSettingsDto {
  applied: boolean;
  applyError?: string;
}

/** Mirrors lib/provision/render.ts's EMAIL_TEMPLATE_FLOWS. */
export type EmailTemplateFlow =
  | "confirmation"
  | "recovery"
  | "magic_link"
  | "invite"
  | "email_change"
  | "reauthentication";

/** Per-flow summary embedded in AuthSettingsDto — never the full HTML body. */
export interface EmailTemplateSummaryDto {
  flow: EmailTemplateFlow;
  subject: string;
  hasBody: boolean;
}

/** GET /api/db-instances/:id/email-template/:flow/edit — one flow's full body. */
export interface EmailTemplateEditDto {
  flow: EmailTemplateFlow;
  subject: string;
  bodyHtml: string;
}

/** PATCH entry: per-flow "omitted = keep existing, explicit = overwrite". */
export interface EmailTemplateUpdateEntry {
  flow: EmailTemplateFlow;
  subject?: string;
  bodyHtml?: string;
}

/**
 * GET/PATCH /api/db-instances/:id/analytics-settings — Storage
 * Analytics buckets (Iceberg) on/off toggle. Nothing else to configure:
 * MinIO/Lakekeeper's own secrets are all derived server-side, never
 * operator-supplied.
 */
export interface AnalyticsSettingsDto {
  enabled: boolean;
}

/** Returned alongside the DTO on PATCH — whether the compose reconcile succeeded. */
export interface AnalyticsSettingsPatchResultDto extends AnalyticsSettingsDto {
  applied: boolean;
  applyError?: string;
}

/**
 * GET/PUT /api/db-instances/:id/sync-source — where a live-database
 * sync pulls FROM. Secrets are never echoed, only `*Configured` booleans,
 * same rule as InstanceSecretsDto.
 */
export interface SyncSourceDto {
  kind: "supabase" | "postgres";
  label: string;
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPasswordConfigured: boolean;
  pgSslMode: string;
  projectUrl: string;
  serviceRoleKeyConfigured: boolean;
  includeAuthUsers: boolean;
  includeStorageObjects: boolean;
  extraSchemas: string[];
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncSummary: string | null;
}

/** PUT body: an omitted/empty secret keeps the stored one (required on create). */
export interface SyncSourcePayload {
  kind: "supabase" | "postgres";
  label?: string;
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword?: string;
  pgSslMode: string;
  projectUrl?: string;
  serviceRoleKey?: string;
  includeAuthUsers: boolean;
  includeStorageObjects: boolean;
  extraSchemas: string[];
}

/** POST /api/db-instances/:id/sync-source/test — read-only probe. */
export interface SyncSourceTestDto {
  ok: boolean;
  detail: string;
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

/**
 * Uploads a backup (a .zip/.backup/.dump/.sql file) for restore into an
 * existing, `running` instance. `confirmName` must equal the instance name
 * (else 400/409). The body is the raw file bytes — this is not a JSON
 * payload — so the original filename travels as a header instead.
 */
export async function restoreInstance(
  id: string,
  confirmName: string,
  file: File,
): Promise<JobAcceptedDto> {
  return apiFetch<JobAcceptedDto>(
    `/api/db-instances/${id}/restore?confirmName=${encodeURIComponent(confirmName)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Backup-Filename": file.name,
      },
      body: file,
    },
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

export async function fetchAuthSettings(id: string): Promise<AuthSettingsDto> {
  return apiFetch<AuthSettingsDto>(`/api/db-instances/${id}/auth-settings`, {
    cache: "no-store",
  });
}

/**
 * Saves settings AND attempts to apply them (re-render + restart the auth
 * container) in one call. `applied: false` in the response means the values
 * were still saved — only the server-side restart didn't take; see
 * `applyError` for why.
 */
export async function updateAuthSettings(
  id: string,
  payload: AuthSettingsUpdatePayload,
): Promise<AuthSettingsPatchResultDto> {
  return apiFetch<AuthSettingsPatchResultDto>(
    `/api/db-instances/${id}/auth-settings`,
    jsonInit("PATCH", payload),
  );
}

/**
 * Loads one flow's full stored HTML body on demand (the auth-settings GET
 * only returns `hasBody`/`subject` per flow, to keep that payload small).
 */
export async function fetchEmailTemplateBody(
  id: string,
  flow: EmailTemplateFlow,
): Promise<EmailTemplateEditDto> {
  return apiFetch<EmailTemplateEditDto>(
    `/api/db-instances/${id}/email-template/${flow}/edit`,
    { cache: "no-store" },
  );
}

export async function fetchAnalyticsSettings(id: string): Promise<AnalyticsSettingsDto> {
  return apiFetch<AnalyticsSettingsDto>(`/api/db-instances/${id}/analytics-settings`, {
    cache: "no-store",
  });
}

/**
 * Saves the toggle AND attempts to apply it (re-render + reconcile the
 * instance's containers) in one call. `applied: false` means the toggle was
 * still saved — only the server-side reconcile didn't take; see
 * `applyError` for why.
 */
export async function updateAnalyticsSettings(
  id: string,
  enabled: boolean,
): Promise<AnalyticsSettingsPatchResultDto> {
  return apiFetch<AnalyticsSettingsPatchResultDto>(
    `/api/db-instances/${id}/analytics-settings`,
    jsonInit("PATCH", { enabled }),
  );
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

/** SSE endpoint for a restore job. */
export function restoreLogUrl(id: string): string {
  return `/api/db-instances/${id}/restore-log`;
}

/** SSE endpoint for a live-source sync job. */
export function syncLogUrl(id: string): string {
  return `/api/db-instances/${id}/sync-log`;
}

export const SYNC_SOURCE_QUERY_KEY = ["db-instance-sync-source"] as const;

/** `null` when no source has been configured for this instance yet. */
export async function fetchSyncSource(id: string): Promise<SyncSourceDto | null> {
  return apiFetch<SyncSourceDto | null>(`/api/db-instances/${id}/sync-source`, {
    cache: "no-store",
  });
}

export async function saveSyncSource(
  id: string,
  payload: SyncSourcePayload,
): Promise<SyncSourceDto> {
  return apiFetch<SyncSourceDto>(
    `/api/db-instances/${id}/sync-source`,
    jsonInit("PUT", payload),
  );
}

export async function deleteSyncSource(id: string): Promise<void> {
  const res = await fetch(`/api/db-instances/${id}/sync-source`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
}

/**
 * Probes the SAVED source from the instance's own container — so save first,
 * then test. Resolves with `ok:false` for a reachable-but-refusing source;
 * only transport/permission problems reject.
 */
export async function testSyncSource(id: string): Promise<SyncSourceTestDto> {
  return apiFetch<SyncSourceTestDto>(`/api/db-instances/${id}/sync-source/test`, {
    method: "POST",
  });
}

/** `confirmName` must equal the instance name, else 400 → 202 {jobId}. */
export async function syncInstance(
  id: string,
  confirmName: string,
): Promise<JobAcceptedDto> {
  return apiFetch<JobAcceptedDto>(
    `/api/db-instances/${id}/sync`,
    jsonInit("POST", { confirmName }),
  );
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
