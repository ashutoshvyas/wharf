import { beforeEach, describe, expect, it, vi } from "vitest";

// Avoid pulling in @/lib/api-helpers' real module — it imports @/lib/auth
// (next-auth), which drags in "next/server" and doesn't resolve under
// vitest's plain Node module resolution (same reason verify.test.ts avoids
// api-helpers/lib/auth entirely). This route never calls requireApiRole —
// it's public by design — so a trivial stand-in is faithful to the real
// behavior for apiError/withErrorHandling.
vi.mock("@/lib/api-helpers", () => ({
  apiError: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  withErrorHandling:
    <A extends unknown[]>(handler: (...a: A) => Promise<Response> | Response) =>
    (...a: A) =>
      handler(...a),
}));

const findUniqueMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    instanceEmailTemplate: { findUnique: (...a: unknown[]) => findUniqueMock(...a) },
  },
}));

import { GET } from "./route";

function req(id: string, flow: string) {
  return GET(new Request(`https://panel.wharf.example.com/api/db-instances/${id}/email-template/${flow}`), {
    params: Promise.resolve({ id, flow }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/db-instances/:id/email-template/:flow — public GoTrue-fetched serving route", () => {
  it("400s on an unknown flow", async () => {
    const res = await req("inst-1", "not-a-real-flow");
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("404s when no row exists for this instance/flow", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await req("inst-1", "confirmation");
    expect(res.status).toBe(404);
  });

  it("404s when the instance is soft-deleted", async () => {
    findUniqueMock.mockResolvedValue({
      bodyHtml: "<p>hi</p>",
      dbInstance: { deletedAt: new Date() },
    });
    const res = await req("inst-1", "confirmation");
    expect(res.status).toBe(404);
  });

  it("404s when the row exists but has no body configured", async () => {
    findUniqueMock.mockResolvedValue({ bodyHtml: null, dbInstance: { deletedAt: null } });
    const res = await req("inst-1", "confirmation");
    expect(res.status).toBe(404);
  });

  it("200s with the exact stored HTML and the right content type, nothing else", async () => {
    findUniqueMock.mockResolvedValue({
      bodyHtml: "<h2>Confirm your signup</h2>",
      dbInstance: { deletedAt: null },
    });
    const res = await req("inst-1", "confirmation");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toBe("<h2>Confirm your signup</h2>");
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dbInstanceId_flow: { dbInstanceId: "inst-1", flow: "confirmation" } },
        select: { bodyHtml: true, dbInstance: { select: { deletedAt: true } } },
      }),
    );
  });
});
