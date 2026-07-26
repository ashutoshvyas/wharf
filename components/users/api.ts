/**
 * Users module — client-side fetch helpers + wire DTOs.
 *
 * Mirrors docs/api.md: GET /api/users returns a BARE array; POST returns the
 * serialized user PLUS a one-time `inviteUrl`; the guard failures (self-edit,
 * last admin, duplicate email) all arrive as 409 so the view can surface
 * `err.message` verbatim in a danger toast.
 */

export type UserRole = "admin" | "operator" | "viewer";

export interface UserDto {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/users — the serialized user plus the once-only link. */
export interface CreatedUserDto extends UserDto {
  inviteUrl: string;
}

export interface InviteUrlDto {
  inviteUrl: string;
}

/** Error carrying the HTTP status so callers can branch on 409. */
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

export const USERS_QUERY_KEY = ["users"] as const;

export async function fetchUsers(): Promise<UserDto[]> {
  const data = await apiFetch<unknown>("/api/users");
  if (Array.isArray(data)) return data as UserDto[];
  // Defensive: tolerate a {users:[…]} envelope.
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>).users;
    if (Array.isArray(value)) return value as UserDto[];
  }
  return [];
}

export async function createUser(payload: {
  email: string;
  role: UserRole;
}): Promise<CreatedUserDto> {
  return apiFetch<CreatedUserDto>("/api/users", jsonInit("POST", payload));
}

export async function updateUserRole(
  id: string,
  role: UserRole,
): Promise<UserDto> {
  return apiFetch<UserDto>(`/api/users/${id}`, jsonInit("PATCH", { role }));
}

export async function deleteUser(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" });
}

/** Reissues the set-password link; the old one stops working immediately. */
export async function resetUserPassword(id: string): Promise<InviteUrlDto> {
  return apiFetch<InviteUrlDto>(`/api/users/${id}/reset`, { method: "POST" });
}

/**
 * Role option copy — VERBATIM from design §5.11 / prototype viewUsers():
 * "admin — full control · operator — day-to-day, no removal · viewer —
 * read-only."
 */
export const ROLE_OPTIONS: ReadonlyArray<{
  value: UserRole;
  label: string;
  description: string;
}> = [
  { value: "admin", label: "admin", description: "full control" },
  { value: "operator", label: "operator", description: "day-to-day, no removal" },
  { value: "viewer", label: "viewer", description: "read-only" },
] as const;

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
