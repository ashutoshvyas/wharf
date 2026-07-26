/**
 * Websites module — client-side fetch helpers + wire DTOs (/043).
 *
 * Defensive about response shapes from endpoints built in parallel
 * workstreams:
 *   - GET /api/servers may return {servers:[...]} or a bare array.
 *   - GET /api/db-instances does not exist until Milestone 4 — a 404 is
 *     reported as {available:false} rather than an error.
 */

export interface WebsiteDto {
  id: string;
  domain: string;
  serverId: string;
  path: string;
  dbInstanceId: string | null;
  credentialLabel: string;
  hasCredential: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  server?: { id: string; name: string };
  dbInstance?: { id: string; name: string; slug: string; status: string } | null;
}

export interface WebsiteCredentialDto {
  label: string;
  username: string | null;
  password: string;
}

export interface ServerOptionDto {
  id: string;
  name: string;
}

/** Loose shape — the db-instances API lands in M4; only id/name are relied on. */
export interface DbInstanceOptionDto {
  id: string;
  name: string;
  slug?: string;
  status?: string;
  serverId?: string;
  remotePath?: string;
  path?: string;
}

export interface WebsitePayload {
  domain: string;
  serverId: string;
  path: string;
  dbInstanceId: string | null;
  credentialLabel: string;
  accessUsername?: string;
  accessPassword?: string;
  notes?: string;
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
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Unwrap either a bare array or an {<key>: [...]} envelope. */
function asArray<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    for (const key of keys) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

export async function fetchWebsites(serverId?: string): Promise<WebsiteDto[]> {
  const qs = serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
  const data = await apiFetch<unknown>(`/api/websites${qs}`);
  return asArray<WebsiteDto>(data, "websites");
}

export async function fetchWebsiteCredential(
  id: string,
): Promise<WebsiteCredentialDto> {
  return apiFetch<WebsiteCredentialDto>(`/api/websites/${id}/credential`, {
    cache: "no-store",
  });
}

export async function createWebsite(payload: WebsitePayload): Promise<unknown> {
  return apiFetch<unknown>("/api/websites", jsonInit("POST", payload));
}

export async function updateWebsite(
  id: string,
  payload: Partial<WebsitePayload>,
): Promise<unknown> {
  return apiFetch<unknown>(`/api/websites/${id}`, jsonInit("PATCH", payload));
}

export async function deleteWebsite(id: string): Promise<unknown> {
  return apiFetch<unknown>(`/api/websites/${id}`, { method: "DELETE" });
}

/** Tolerates {servers:[...]} or a bare array; 404 (route not deployed yet) → []. */
export async function fetchServerOptions(): Promise<ServerOptionDto[]> {
  const res = await fetch("/api/servers");
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return asArray<ServerOptionDto>(await res.json(), "servers");
}

export interface DbInstancesResult {
  /** false = the /api/db-instances endpoint does not exist yet (Milestone 4). */
  available: boolean;
  instances: DbInstanceOptionDto[];
}

export async function fetchDbInstanceOptions(
  serverId?: string,
): Promise<DbInstancesResult> {
  const qs = serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
  const res = await fetch(`/api/db-instances${qs}`);
  if (res.status === 404) return { available: false, instances: [] };
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return {
    available: true,
    instances: asArray<DbInstanceOptionDto>(
      await res.json(),
      "dbInstances",
      "instances",
    ),
  };
}
