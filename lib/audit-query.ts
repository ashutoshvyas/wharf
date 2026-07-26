/**
 * Audit-log read model — filters, compound-cursor pagination and the
 * response serializer for GET /api/audit.
 *
 * READ-ONLY BY CONSTRUCTION. `audit_log` is insert-only (Postgres trigger,
 * migration 20260724000002_audit_immutable) and this module exports no
 * update/delete path — the only writer in the codebase is lib/audit.ts.
 *
 * ── Pagination ──────────────────────────────────────────────────────────────
 * Rows are ordered `(createdAt DESC, id DESC)`. A timestamp-only cursor would
 * be wrong: audit rows written inside one request share a `created_at` to the
 * microsecond, and `createdAt < cursor` would then skip the siblings while
 * `<=` would repeat them. So the cursor is COMPOUND — it carries both keys and
 * the predicate is the lexicographic "strictly after in sort order":
 *
 *     createdAt < c.createdAt
 *       OR (createdAt = c.createdAt AND id < c.id)
 *
 * which is exact for every tie. The cursor is opaque to clients (base64url of
 * `<epochMs>:<id>`) so its shape stays an implementation detail.
 */
import { z } from "zod";
import type { AuditLog, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** Action prefixes offered by the UI filter (design §5.10 + lib/audit.ts). */
export const ACTION_PREFIXES = [
  "server.",
  "website.",
  "instance.",
  "terminal.",
  "secret.",
  "auth.",
  "user.",
] as const;

/**
 * Query-string filters. Everything arrives as a string, so `from`/`to` and
 * `limit` are coerced. `limit` CLAMPS to MAX_LIMIT rather than erroring — a
 * client asking for more simply gets the maximum page.
 */
export const auditFilterSchema = z.object({
  actionPrefix: z.string().trim().max(40).optional(),
  userEmail: z.string().trim().max(160).optional(),
  targetType: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z
    .string()
    .max(200)
    .refine((v) => decodeCursor(v) !== null, "cursor is malformed")
    .optional(),
  limit: z.coerce
    .number()
    .int("must be a whole number")
    .positive("must be greater than 0")
    .optional()
    .transform((n) => Math.min(n ?? DEFAULT_LIMIT, MAX_LIMIT)),
});

export type AuditFilters = z.infer<typeof auditFilterSchema>;

/**
 * Parse `URLSearchParams` into filters, dropping empty values first so
 * `?userEmail=&limit=` behaves like "no filter" instead of failing validation.
 */
export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (value !== "") raw[key] = value;
  }
  return auditFilterSchema.parse(raw);
}

export interface CursorParts {
  createdAt: Date;
  id: string;
}

export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(
    `${parts.createdAt.getTime()}:${parts.id}`,
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(cursor: string): CursorParts | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0) return null;
  const ms = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isSafeInteger(ms) || ms < 0 || id.length === 0) return null;
  return { createdAt: new Date(ms), id };
}

/**
 * Build the Prisma `where` clause. Every filter is ANDed; the cursor
 * predicate is its own AND term so it composes with an OR-free filter set.
 */
export function buildAuditWhere(filters: AuditFilters): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];

  if (filters.actionPrefix) {
    and.push({ action: { startsWith: filters.actionPrefix } });
  }
  if (filters.userEmail) {
    and.push({
      userEmail: { contains: filters.userEmail, mode: "insensitive" },
    });
  }
  if (filters.targetType) {
    and.push({ targetType: filters.targetType });
  }
  if (filters.from || filters.to) {
    and.push({
      createdAt: {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      },
    });
  }

  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) {
    and.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
      ],
    });
  }

  return and.length === 0 ? {} : { AND: and };
}

/** Stable sort key — must match the cursor predicate exactly. */
export const AUDIT_ORDER_BY: Prisma.AuditLogOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

/**
 * Full findMany args. `take` is limit + 1: the extra row is the has-more
 * probe and is trimmed by {@link paginateAudit}.
 */
export function buildAuditFindManyArgs(filters: AuditFilters) {
  return {
    where: buildAuditWhere(filters),
    orderBy: AUDIT_ORDER_BY,
    take: filters.limit + 1,
  };
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

/** Trim the probe row and derive the cursor from the last KEPT row. */
export function paginateAudit<T extends CursorParts>(
  fetched: T[],
  limit: number,
): Page<T> {
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

/** Run the query. The only DB access in this module — and it is a read. */
export async function queryAuditLog(
  filters: AuditFilters,
): Promise<Page<AuditLog>> {
  const rows = await prisma.auditLog.findMany(buildAuditFindManyArgs(filters));
  return paginateAudit(rows, filters.limit);
}

export interface SerializedAuditEntry {
  id: string;
  userEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: AuditLog["metadata"];
  createdAt: Date;
}

/**
 * SECURITY: allowlist. `userId` is deliberately withheld — the screen shows
 * the email, and the internal id adds nothing but a cross-reference handle.
 */
export function serializeAuditEntry(entry: AuditLog): SerializedAuditEntry {
  return {
    id: entry.id,
    userEmail: entry.userEmail,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
  };
}
