import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), get: vi.fn(), update: vi.fn(), enable: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/provision/network-access", () => ({
  getInstanceNetworkAccess: mocks.get, updateInstanceNetworkAccess: mocks.update, enableServerNetworkAccess: mocks.enable,
}));
import { GET, PATCH } from "./route";
import { POST } from "@/app/api/servers/[id]/database-network-access/route";

const context = { params: Promise.resolve({ id: "test-id" }) };
const request = (body: unknown, method = "PATCH") => new Request("https://panel.test/api/network-access", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "admin-id", role: "admin", email: "admin@test.example" } });
  mocks.update.mockResolvedValue({ ok: true, applied: true });
  mocks.enable.mockResolvedValue({ ok: true, applied: true });
  mocks.get.mockResolvedValue({ policy: { mode: "blocked" }, server: { firewallManaged: false } });
});
describe("network access routes", () => {
  it.each(["viewer", "operator", null])("rejects writes by %s before side effects", async (role) => {
    mocks.auth.mockResolvedValue(role ? { user: { role } } : null);
    expect((await PATCH(request({ mode: "all" }), context)).status).toBe(403);
    expect((await POST(request({ confirmName: "host", baselineAllowedCidrs: ["1.2.3.4"] }, "POST"), context)).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("lets viewers inspect settings without cacheable responses", async () => {
    mocks.auth.mockResolvedValue({ user: { role: "viewer" } });
    const response = await GET(new Request("https://panel.test"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("validates and audits normalized policy changes", async () => {
    const response = await PATCH(request({ mode: "restricted", allowedCidrs: ["198.51.100.10"] }), context);
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("test-id", { mode: "restricted", allowedCidrs: ["198.51.100.10/32"] });
    expect(mocks.audit.mock.invocationCallOrder[0]!).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.network-access.update" }));
  });
  it("rejects malformed or empty restricted policies", async () => {
    for (const body of [null, [], { mode: "restricted", allowedCidrs: [] }, { mode: "restricted", allowedCidrs: ["1.2.3.4;id"] }]) {
      expect((await PATCH(request(body), context)).status).toBe(400);
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("returns conflicts and missing instances clearly", async () => {
    mocks.update.mockResolvedValueOnce({ busy: "provision" });
    expect((await PATCH(request({ mode: "blocked" }), context)).status).toBe(409);
    mocks.update.mockResolvedValueOnce({ notFound: true });
    expect((await PATCH(request({ mode: "blocked" }), context)).status).toBe(404);
  });
  it("keeps partial failure visible instead of claiming the rule is active", async () => {
    mocks.update.mockResolvedValue({ ok: true, applied: false, applyError: "Remote connection unavailable" });
    const response = await PATCH(request({ mode: "blocked" }), context);
    expect(await response.json()).toMatchObject({ applied: false, applyError: "Remote connection unavailable" });
  });
  it("audits the reviewed baseline and server setup separately", async () => {
    const response = await POST(request({ confirmName: "host", baselineAllowedCidrs: ["198.51.100.10"] }, "POST"), context);
    expect(response.status).toBe(200);
    expect(mocks.enable).toHaveBeenCalledWith("test-id", "host", ["198.51.100.10/32"]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "server.network-access.enable" }));
  });
});
