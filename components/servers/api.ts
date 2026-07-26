/**
 * Servers module — client-side fetch helpers + wire DTOs (/026/027).
 *
 * Mirrors docs/api.md: GET /api/servers returns a BARE array of serialized
 * servers (an envelope is tolerated defensively); secrets are never echoed
 * back; DELETE 409s while children exist; POST /:id/check is rate limited
 * (429); POST /:id/keypair 409s without {confirm:true} when a key exists.
 */

export interface ServerDto {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: "password" | "private_key";
  linkedPanelUrl: string | null;
  hasPanelCredential: boolean;
  bootstrapped: boolean;
  reachable: boolean;
  hostKeyFingerprint: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  counts?: { websites: number; dbInstances: number };
}

export interface CheckResultDto {
  ok: boolean;
  ms?: number;
  error?: string;
  reachable: boolean;
}

export interface PanelCredentialDto {
  username: string | null;
  password: string | null;
}

/** Wire payload for POST/PATCH — validated client-side via lib/servers/schema. */
export interface ServerPayload {
  name?: string;
  host?: string;
  sshPort?: number;
  sshUser?: string;
  authMethod?: "password" | "private_key";
  sshPassword?: string;
  sshPrivateKey?: string;
  linkedPanelUrl?: string;
  panelUser?: string;
  panelPass?: string;
  tags?: string[];
}

/** Error carrying the HTTP status so callers can branch on 409 / 429. */
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

export async function fetchServers(): Promise<ServerDto[]> {
  const data = await apiFetch<unknown>("/api/servers");
  if (Array.isArray(data)) return data as ServerDto[];
  // Defensive: tolerate an {servers:[...]} envelope.
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>).servers;
    if (Array.isArray(value)) return value as ServerDto[];
  }
  return [];
}

export async function fetchServer(id: string): Promise<ServerDto> {
  const data = await apiFetch<unknown>(`/api/servers/${id}`);
  // Tolerate {server: {...}} envelope; docs say bare object.
  if (data && typeof data === "object" && "server" in data) {
    return (data as { server: ServerDto }).server;
  }
  return data as ServerDto;
}

export async function createServer(payload: ServerPayload): Promise<unknown> {
  return apiFetch<unknown>("/api/servers", jsonInit("POST", payload));
}

export async function updateServer(
  id: string,
  payload: ServerPayload,
): Promise<unknown> {
  return apiFetch<unknown>(`/api/servers/${id}`, jsonInit("PATCH", payload));
}

export async function deleteServer(id: string): Promise<unknown> {
  return apiFetch<unknown>(`/api/servers/${id}`, { method: "DELETE" });
}

export async function checkServer(id: string): Promise<CheckResultDto> {
  return apiFetch<CheckResultDto>(`/api/servers/${id}/check`, {
    method: "POST",
  });
}

export async function generateKeypair(
  id: string,
  confirm: boolean,
): Promise<{ publicKey: string }> {
  return apiFetch<{ publicKey: string }>(
    `/api/servers/${id}/keypair`,
    jsonInit("POST", confirm ? { confirm: true } : {}),
  );
}

export async function fetchPanelCredential(
  id: string,
): Promise<PanelCredentialDto> {
  return apiFetch<PanelCredentialDto>(`/api/servers/${id}/panel-credential`, {
    cache: "no-store",
  });
}

/**
 * "Server still has linked resources — {"websites":2,"dbInstances":1}"
 * → "2 websites · 1 database". Falls back to the raw message.
 */
/**
 * Start the bootstrap job. 202 → {jobId}; the caller then streams
 * GET /api/servers/:id/bootstrap-log. Throws ApiError(409) when another job
 * holds the server lock, ApiError(403) for non-admins.
 */
export async function startBootstrap(id: string): Promise<{ jobId: string }> {
  return apiFetch<{ jobId: string }>(`/api/servers/${id}/bootstrap`, {
    method: "POST",
  });
}

export function formatDeleteConflict(message: string): string {
  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const counts = JSON.parse(message.slice(jsonStart)) as {
        websites?: number;
        dbInstances?: number;
      };
      const w = counts.websites ?? 0;
      const d = counts.dbInstances ?? 0;
      return `Server still hosts ${w} website${w === 1 ? "" : "s"} · ${d} database${
        d === 1 ? "" : "s"
      }. Move or remove them first.`;
    } catch {
      // fall through
    }
  }
  return message;
}
