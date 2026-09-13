import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { dbInstance: { findFirst: vi.fn() } } }));
vi.mock("@/lib/provision/clone", () => ({ startClone: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { startClone } from "@/lib/provision/clone";
import { endJob, publish, startJob } from "@/lib/jobs/stream";
import { POST } from "./route";
import { GET } from "../clone-log/route";

const sourceId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id: sourceId }) };
const validBody = { targetInstanceId: targetId, confirmName: "staging" };
const mockAuth = vi.mocked(auth);
const find = vi.mocked(prisma.dbInstance.findFirst);
const clone = vi.mocked(startClone);

function setRole(role: "admin" | "operator" | "viewer" | null) {
  mockAuth.mockResolvedValue((role ? {
    user: { id: "admin-id", email: "admin@example.test", role }, expires: "2099-01-01",
  } : null) as never);
}

function post(body: unknown = validBody) {
  return POST(new Request(`https://wharf.example/api/db-instances/${sourceId}/clone`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), context);
}

beforeEach(() => {
  vi.clearAllMocks();
  setRole("admin");
  find.mockImplementation((async (args: { where?: { id?: string } }) => ({
    id: args?.where?.id, name: args?.where?.id === targetId ? "staging" : "production",
  })) as never);
  clone.mockResolvedValue({ jobId: `clone:${targetId}` });
});

describe("POST managed database clone", () => {
  it("starts a job on the confirmed destination and passes the authenticated actor", async () => {
    const response = await post();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: `clone:${targetId}`, targetInstanceId: targetId });
    expect(clone).toHaveBeenCalledWith(sourceId, targetId, {
      userId: "admin-id", userEmail: "admin@example.test",
    }, "staging");
    expect(find.mock.calls.every(([args]) => args?.where?.deletedAt === null)).toBe(true);
  });

  it.each(["operator", "viewer", null] as const)("rejects %s before reading rows or starting work", async (role) => {
    setRole(role);
    expect((await post()).status).toBe(403);
    expect(find).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it.each([
    null, [], "invalid", {}, { confirmName: "staging" },
    { targetInstanceId: "not-an-id", confirmName: "staging" },
    { ...validBody, confirmName: "" }, { ...validBody, confirmName: 123 },
    { ...validBody, pgPassword: "should-not-be-accepted" },
  ])("rejects invalid request %j without side effects", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(find).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(new Request("https://wharf.example", { method: "POST", body: "{" }), context);
    expect(response.status).toBe(400);
    expect(clone).not.toHaveBeenCalled();
  });

  it("rejects a self-clone before any database lookup", async () => {
    expect((await post({ ...validBody, targetInstanceId: sourceId })).status).toBe(400);
    expect(find).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it.each([sourceId, targetId])("returns 404 for missing or soft-deleted instance %s", async (missingId) => {
    find.mockImplementation((async (args: { where?: { id?: string } }) => args?.where?.id === missingId
      ? null
      : { id: args?.where?.id, name: "staging" }) as never);
    expect((await post()).status).toBe(404);
    expect(clone).not.toHaveBeenCalled();
  });

  it.each(["production", " staging", "Staging"])("requires the exact destination name, not %s", async (confirmName) => {
    expect((await post({ ...validBody, confirmName })).status).toBe(400);
    expect(clone).not.toHaveBeenCalled();
  });

  it.each([{ busy: "clone" }, { invalid: "Destination must be running" }])("reports an engine conflict: %j", async (result) => {
    clone.mockResolvedValue(result);
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("busy" in result ? "clone" : "Destination must be running");
  });

  it("does not expose engine internals on an unexpected failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      clone.mockRejectedValue(new Error("private internal detail"));
      const response = await post();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal server error" });
    } finally { consoleError.mockRestore(); }
  });
});

describe("GET destination clone progress", () => {
  const targetContext = { params: Promise.resolve({ id: targetId }) };
  const request = () => new Request(`https://wharf.example/api/db-instances/${targetId}/clone-log`);

  it.each(["admin", "operator", "viewer"] as const)("allows %s to read completed job events", async (role) => {
    setRole(role);
    startJob(`clone:${targetId}`);
    publish(`clone:${targetId}`, "ok", "✓ restore");
    endJob(`clone:${targetId}`, "ok");
    const response = await GET(request(), targetContext);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).toContain("✓ restore");
    expect(body).toContain('"done":true,"status":"ok"');
  });

  it("denies unauthenticated access", async () => {
    setRole(null);
    expect((await GET(request(), targetContext)).status).toBe(403);
    expect(find).not.toHaveBeenCalled();
  });

  it("returns 404 for a removed destination", async () => {
    find.mockResolvedValue(null);
    expect((await GET(request(), targetContext)).status).toBe(404);
  });
});
