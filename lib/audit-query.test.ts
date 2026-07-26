/**
 * Audit read model: filter parsing, limit clamping, the COMPOUND
 * cursor predicate (the thing that stops equal timestamps from skipping or
 * repeating rows), and the GET /api/audit route contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { auditLog: { findMany: vi.fn() } },
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { AuditLog } from "@prisma/client";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  auditFilterSchema,
  buildAuditFindManyArgs,
  buildAuditWhere,
  decodeCursor,
  encodeCursor,
  paginateAudit,
  parseAuditFilters,
  queryAuditLog,
  serializeAuditEntry,
} from "./audit-query";
import { GET as getAudit } from "@/app/api/audit/route";

const mockAuth = vi.mocked(auth);
const db = vi.mocked(prisma, true);

function filters(over: Record<string, unknown> = {}) {
  return auditFilterSchema.parse(over);
}

function entry(over: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "aud-1",
    userId: "usr-1",
    userEmail: "ada@example.com",
    action: "instance.remove",
    targetType: "db_instance",
    targetId: "inst-1",
    metadata: { slug: "sb_4f2a" },
    createdAt: new Date("2026-06-12T14:32:05.000Z"),
    ...over,
  } as AuditLog;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auditFilterSchema", () => {
  it("defaults the limit to 50", () => {
    expect(filters().limit).toBe(DEFAULT_LIMIT);
  });

  it("CLAMPS an oversized limit instead of erroring", () => {
    expect(filters({ limit: "500" }).limit).toBe(MAX_LIMIT);
    expect(filters({ limit: 101 }).limit).toBe(MAX_LIMIT);
    expect(filters({ limit: MAX_LIMIT }).limit).toBe(MAX_LIMIT);
  });

  it("keeps a limit under the cap and coerces strings", () => {
    expect(filters({ limit: "7" }).limit).toBe(7);
  });

  it("rejects a zero, negative or fractional limit", () => {
    for (const bad of ["0", "-5", "2.5", "abc"]) {
      expect(auditFilterSchema.safeParse({ limit: bad }).success).toBe(false);
    }
  });

  it("coerces from/to into Dates and rejects nonsense", () => {
    const parsed = filters({ from: "2026-06-01T00:00:00.000Z" });
    expect(parsed.from).toBeInstanceOf(Date);
    expect(auditFilterSchema.safeParse({ from: "not-a-date" }).success).toBe(
      false,
    );
  });

  it("rejects a malformed cursor", () => {
    expect(auditFilterSchema.safeParse({ cursor: "!!!not-base64!!!" }).success)
      .toBe(false);
    expect(
      auditFilterSchema.safeParse({
        cursor: encodeCursor({ createdAt: new Date(), id: "x" }),
      }).success,
    ).toBe(true);
  });

  it("parseAuditFilters drops empty query values", () => {
    const parsed = parseAuditFilters(
      new URLSearchParams("userEmail=&actionPrefix=&limit="),
    );
    expect(parsed.userEmail).toBeUndefined();
    expect(parsed.actionPrefix).toBeUndefined();
    expect(parsed.limit).toBe(DEFAULT_LIMIT);
  });
});

describe("cursor encoding", () => {
  it("round-trips createdAt + id", () => {
    const parts = { createdAt: new Date("2026-06-12T14:32:05.000Z"), id: "aud-9" };
    const decoded = decodeCursor(encodeCursor(parts));
    expect(decoded?.id).toBe("aud-9");
    expect(decoded?.createdAt.getTime()).toBe(parts.createdAt.getTime());
  });

  it("is opaque (base64url), not the raw values", () => {
    const cursor = encodeCursor({ createdAt: new Date(0), id: "aud-9" });
    expect(cursor).not.toContain("aud-9");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns null for garbage rather than throwing", () => {
    for (const bad of ["", "***", Buffer.from("no-colon").toString("base64url")]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("survives an id that itself contains a colon", () => {
    const parts = { createdAt: new Date(1000), id: "weird:id:value" };
    expect(decodeCursor(encodeCursor(parts))?.id).toBe("weird:id:value");
  });
});

describe("buildAuditWhere", () => {
  it("is empty when nothing is filtered", () => {
    expect(buildAuditWhere(filters())).toEqual({});
  });

  it("matches an action prefix with startsWith", () => {
    expect(buildAuditWhere(filters({ actionPrefix: "instance." }))).toEqual({
      AND: [{ action: { startsWith: "instance." } }],
    });
  });

  it("matches user email case-insensitively as a substring", () => {
    expect(buildAuditWhere(filters({ userEmail: "Ada" }))).toEqual({
      AND: [{ userEmail: { contains: "Ada", mode: "insensitive" } }],
    });
  });

  it("matches targetType exactly", () => {
    expect(buildAuditWhere(filters({ targetType: "server" }))).toEqual({
      AND: [{ targetType: "server" }],
    });
  });

  it("builds an inclusive date range", () => {
    const from = "2026-06-01T00:00:00.000Z";
    const to = "2026-06-30T23:59:59.999Z";
    expect(buildAuditWhere(filters({ from, to }))).toEqual({
      AND: [{ createdAt: { gte: new Date(from), lte: new Date(to) } }],
    });
  });

  it("supports an open-ended range in either direction", () => {
    const from = "2026-06-01T00:00:00.000Z";
    expect(buildAuditWhere(filters({ from }))).toEqual({
      AND: [{ createdAt: { gte: new Date(from) } }],
    });
    expect(buildAuditWhere(filters({ to: from }))).toEqual({
      AND: [{ createdAt: { lte: new Date(from) } }],
    });
  });

  it("ANDs every filter together with the cursor term", () => {
    const createdAt = new Date("2026-06-12T14:32:05.000Z");
    const where = buildAuditWhere(
      filters({
        actionPrefix: "server.",
        userEmail: "ada",
        targetType: "server",
        from: "2026-06-01T00:00:00.000Z",
        cursor: encodeCursor({ createdAt, id: "aud-5" }),
      }),
    );
    expect(where.AND).toHaveLength(5);
  });

  describe("compound cursor predicate", () => {
    const createdAt = new Date("2026-06-12T14:32:05.000Z");
    const cursor = encodeCursor({ createdAt, id: "aud-5" });

    it("is strictly-after in (createdAt desc, id desc) order", () => {
      const where = buildAuditWhere(filters({ cursor }));
      expect(where.AND).toEqual([
        {
          OR: [
            { createdAt: { lt: createdAt } },
            { AND: [{ createdAt }, { id: { lt: "aud-5" } }] },
          ],
        },
      ]);
    });

    it("uses `lt` on createdAt — never `lte`, which would repeat ties", () => {
      const [term] = buildAuditWhere(filters({ cursor })).AND as [
        { OR: { createdAt?: { lt?: Date; lte?: Date } }[] },
      ];
      expect(term.OR[0]?.createdAt?.lt).toEqual(createdAt);
      expect(term.OR[0]?.createdAt).not.toHaveProperty("lte");
    });

    it("keeps same-timestamp siblings reachable via the id tiebreaker", () => {
      // Two rows share createdAt; the cursor points at the first. The second
      // is excluded by the createdAt<lt> arm but INCLUDED by the id arm —
      // which is exactly what a timestamp-only cursor would have skipped.
      const [term] = buildAuditWhere(filters({ cursor })).AND as [
        { OR: [unknown, { AND: [{ createdAt: Date }, { id: { lt: string } }] }] },
      ];
      const tiebreak = term.OR[1];
      expect(tiebreak.AND[0].createdAt).toEqual(createdAt);
      expect(tiebreak.AND[1].id.lt).toBe("aud-5");
    });
  });
});

describe("buildAuditFindManyArgs", () => {
  it("orders createdAt desc then id desc — matching the cursor predicate", () => {
    expect(buildAuditFindManyArgs(filters()).orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("takes limit + 1 as the has-more probe", () => {
    expect(buildAuditFindManyArgs(filters({ limit: "10" })).take).toBe(11);
    expect(buildAuditFindManyArgs(filters()).take).toBe(DEFAULT_LIMIT + 1);
  });
});

describe("paginateAudit", () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `aud-${i}`,
    createdAt: new Date(1000 - i),
  }));

  it("returns no cursor when the probe row is absent", () => {
    const page = paginateAudit(rows.slice(0, 3), 3);
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("trims the probe row and points the cursor at the last KEPT row", () => {
    const page = paginateAudit(rows, 3);
    expect(page.rows.map((r) => r.id)).toEqual(["aud-0", "aud-1", "aud-2"]);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      id: "aud-2",
      createdAt: rows[2]!.createdAt,
    });
  });

  it("handles an empty page", () => {
    expect(paginateAudit([], 50)).toEqual({ rows: [], nextCursor: null });
  });
});

describe("queryAuditLog", () => {
  it("passes the built args through and paginates the result", async () => {
    const rows = [entry({ id: "a" }), entry({ id: "b" })];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.auditLog.findMany.mockResolvedValue(rows as any);

    const page = await queryAuditLog(filters({ limit: "1" }));
    expect(db.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("serializeAuditEntry", () => {
  it("exposes exactly the allowlisted fields", () => {
    expect(Object.keys(serializeAuditEntry(entry())).sort()).toEqual([
      "action",
      "createdAt",
      "id",
      "metadata",
      "targetId",
      "targetType",
      "userEmail",
    ]);
  });

  it("withholds the internal userId", () => {
    expect(serializeAuditEntry(entry())).not.toHaveProperty("userId");
  });
});

describe("GET /api/audit", () => {
  function asRole(role: "admin" | "operator" | "viewer" | null) {
    const session = role
      ? {
          user: { id: "u1", email: `${role}@example.com`, role },
          expires: new Date(Date.now() + 3600_000).toISOString(),
        }
      : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue(session as any);
  }

  it("is readable by every role and answers {entries, nextCursor}", async () => {
    for (const role of ["admin", "operator", "viewer"] as const) {
      vi.clearAllMocks();
      asRole(role);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.auditLog.findMany.mockResolvedValue([entry()] as any);

      const res = await getAudit(new Request("http://test/api/audit"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
      expect(body.entries[0]).not.toHaveProperty("userId");
    }
  });

  it("refuses an anonymous caller", async () => {
    asRole(null);
    expect(
      (await getAudit(new Request("http://test/api/audit"))).status,
    ).toBe(403);
  });

  it("threads query-string filters into the where clause", async () => {
    asRole("viewer");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.auditLog.findMany.mockResolvedValue([] as any);

    await getAudit(
      new Request(
        "http://test/api/audit?actionPrefix=user.&userEmail=ada&targetType=user&limit=5",
      ),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (db.auditLog.findMany.mock.calls[0] as any)[0];
    expect(args.take).toBe(6);
    expect(args.where.AND).toContainEqual({ action: { startsWith: "user." } });
    expect(args.where.AND).toContainEqual({ targetType: "user" });
  });

  it("400s on a malformed cursor", async () => {
    asRole("viewer");
    const res = await getAudit(
      new Request("http://test/api/audit?cursor=%21%21%21"),
    );
    expect(res.status).toBe(400);
  });

  it("emits a nextCursor when more rows exist", async () => {
    asRole("admin");
    const rows = [
      entry({ id: "a", createdAt: new Date(2000) }),
      entry({ id: "b", createdAt: new Date(1000) }),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.auditLog.findMany.mockResolvedValue(rows as any);

    const res = await getAudit(new Request("http://test/api/audit?limit=1"));
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(decodeCursor(body.nextCursor)).toEqual({
      id: "a",
      createdAt: new Date(2000),
    });
  });
});
