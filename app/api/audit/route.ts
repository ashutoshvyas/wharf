/**
 * GET /api/audit — the read side of the insert-only trail.
 * Any authenticated role (`audit.read`). See docs/api.md.
 *
 * There is deliberately no POST/PATCH/DELETE here: rows are written only by
 * lib/audit.ts, and UPDATE/DELETE are rejected by a Postgres trigger.
 */
import { NextResponse } from "next/server";
import { requireApiRole, withErrorHandling } from "@/lib/api-helpers";
import {
  parseAuditFilters,
  queryAuditLog,
  serializeAuditEntry,
} from "@/lib/audit-query";

export const GET = withErrorHandling(async (req: Request) => {
  await requireApiRole("audit.read");
  const filters = parseAuditFilters(new URL(req.url).searchParams);
  const { rows, nextCursor } = await queryAuditLog(filters);
  return NextResponse.json({
    entries: rows.map(serializeAuditEntry),
    nextCursor,
  });
});
