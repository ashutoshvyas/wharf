/**
 * Audit module — client-side fetch helpers + wire DTOs.
 *
 * GET /api/audit answers `{entries, nextCursor}`; `nextCursor` is an opaque
 * compound cursor (createdAt + id) that the "Load more" button hands straight
 * back. There are no mutating helpers here and there never will be — the
 * table is insert-only at the database level.
 */

export interface AuditEntryDto {
  id: string;
  userEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AuditPageDto {
  entries: AuditEntryDto[];
  nextCursor: string | null;
}

export interface AuditFilterValues {
  actionPrefix: string;
  userEmail: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditFilterValues = {
  actionPrefix: "",
  userEmail: "",
  from: "",
  to: "",
};

/** Filter select options (design §5.10 + the action namespaces in lib/audit.ts). */
export const ACTION_PREFIXES: ReadonlyArray<string> = [
  "server.",
  "website.",
  "instance.",
  "terminal.",
  "secret.",
  "auth.",
  "user.",
] as const;

/** Destructive actions get the danger badge tint (design §5.10). */
const DESTRUCTIVE_RE = /remove|delete/;

export function isDestructiveAction(action: string): boolean {
  return DESTRUCTIVE_RE.test(action);
}

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

/**
 * Build the query string. `from`/`to` come from `<input type="date">`, i.e.
 * `YYYY-MM-DD` — `to` is widened to the END of that day so "from 1 Jun to
 * 1 Jun" returns that day's rows rather than nothing.
 */
export function buildAuditQuery(
  filters: AuditFilterValues,
  cursor?: string | null,
): string {
  const params = new URLSearchParams();
  if (filters.actionPrefix) params.set("actionPrefix", filters.actionPrefix);
  if (filters.userEmail.trim()) params.set("userEmail", filters.userEmail.trim());
  if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`);
  if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchAuditPage(
  filters: AuditFilterValues,
  cursor?: string | null,
): Promise<AuditPageDto> {
  const res = await fetch(`/api/audit${buildAuditQuery(filters, cursor)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
  const data = (await res.json()) as Partial<AuditPageDto>;
  return {
    entries: Array.isArray(data.entries) ? data.entries : [],
    nextCursor: data.nextCursor ?? null,
  };
}

/** `12 Jun 2026 14:32:05` — mono timestamp column (design §5.10). */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  return `${date} ${time}`;
}

/** Pretty-printed metadata for the row expansion. */
export function formatMetadata(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return "{}";
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}
