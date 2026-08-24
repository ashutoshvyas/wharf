import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRoleMock = vi.fn();
vi.mock("@/lib/api-helpers", () => ({
  apiError: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
  withErrorHandling:
    <A extends unknown[]>(handler: (...args: A) => Promise<Response> | Response) =>
    (...args: A) =>
      handler(...args),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json" },
      }),
  },
}));

const auditMock = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const updateInstanceSslModeMock = vi.fn();
vi.mock("@/lib/provision/ssl-mode", () => ({
  updateInstanceSslMode: (...args: unknown[]) => updateInstanceSslModeMock(...args),
}));

vi.mock("@/lib/instances/serialize", () => ({
  serializeInstance: (instance: unknown) => instance,
}));

import { PATCH } from "./route";

const INSTANCE = {
  id: "inst-1",
  sslMode: "require",
};

function patch(body: unknown) {
  return PATCH(
    new Request("https://panel.example.com/api/db-instances/inst-1/ssl-mode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "inst-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireApiRoleMock.mockResolvedValue({
    session: { user: { id: "user-1", email: "admin@example.com" } },
    role: "admin",
  });
  updateInstanceSslModeMock.mockResolvedValue({ ok: true, instance: INSTANCE });
  auditMock.mockResolvedValue(undefined);
});

describe("PATCH /api/db-instances/:id/ssl-mode", () => {
  it("requires the dedicated admin permission, applies the mode, audits, and returns the DTO", async () => {
    const response = await patch({ sslMode: "require" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(INSTANCE);
    expect(requireApiRoleMock).toHaveBeenCalledWith("instance.ssl-mode.write");
    expect(updateInstanceSslModeMock).toHaveBeenCalledWith("inst-1", "require");
    expect(auditMock).toHaveBeenCalledWith({
      userId: "user-1",
      userEmail: "admin@example.com",
      action: "instance.ssl-mode.update",
      targetType: "db_instance",
      targetId: "inst-1",
      metadata: { sslMode: "require" },
    });
  });

  it("rejects unsupported PostgreSQL SSL modes", async () => {
    await expect(patch({ sslMode: "prefer" })).rejects.toThrow();
    expect(updateInstanceSslModeMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown instance", async () => {
    updateInstanceSslModeMock.mockResolvedValue({ notFound: true });

    const response = await patch({ sslMode: "require" });

    expect(response.status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 409 when another server job holds the lock", async () => {
    updateInstanceSslModeMock.mockResolvedValue({ busy: "restore" });

    const response = await patch({ sslMode: "disable" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Server is busy — a 'restore' job is running.",
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 409 when provisioning never stored a database password", async () => {
    updateInstanceSslModeMock.mockResolvedValue({ invalid: "Finish provisioning first." });

    const response = await patch({ sslMode: "require" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Finish provisioning first." });
  });
});
