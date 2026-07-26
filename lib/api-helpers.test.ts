import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ForbiddenError } from "./rbac";

// lib/auth pulls in Prisma + bcrypt — mock it; requireApiRole only needs auth().
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { apiError, requireApiRole, withErrorHandling } from "./api-helpers";

const mockAuth = vi.mocked(auth);

function session(role: "admin" | "operator" | "viewer") {
  return {
    user: { id: "u1", email: `${role}@example.com`, role },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  };
}

describe("apiError", () => {
  it("returns a JSON error response with the given status", async () => {
    const res = apiError(418, "teapot");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: "teapot" });
  });
});

describe("requireApiRole", () => {
  it("returns session and role when permitted", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue(session("admin") as any);
    const result = await requireApiRole("servers.write");
    expect(result.role).toBe("admin");
    expect(result.session.user.email).toBe("admin@example.com");
  });

  it("throws ForbiddenError for an under-privileged role", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue(session("viewer") as any);
    await expect(requireApiRole("servers.write")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("throws ForbiddenError when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(requireApiRole("servers.read")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("withErrorHandling", () => {
  it("passes through a successful response", async () => {
    const handler = withErrorHandling(async () =>
      NextResponse.json({ ok: true }, { status: 201 }),
    );
    const res = await handler();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("forwards handler arguments", async () => {
    const handler = withErrorHandling(async (a: number, b: number) =>
      NextResponse.json({ sum: a + b }),
    );
    expect(await (await handler(2, 3)).json()).toEqual({ sum: 5 });
  });

  it("maps ForbiddenError to 403", async () => {
    const handler = withErrorHandling(async () => {
      throw new ForbiddenError("servers.write");
    });
    const res = await handler();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("servers.write");
  });

  it("maps ZodError to 400 with an issue summary", async () => {
    const handler = withErrorHandling(async () => {
      z.object({ port: z.number() }).parse({ port: "not-a-number" });
      return NextResponse.json({});
    });
    const res = await handler();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/^Invalid request — /);
    expect(body.error).toContain("port");
  });

  it("maps unknown errors to 500 and hides the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withErrorHandling(async () => {
      throw new Error("secret internal detail");
    });
    const res = await handler();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
