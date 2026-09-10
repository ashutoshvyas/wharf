import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  findInstance: vi.fn(), findSettings: vi.fn(), upsert: vi.fn(), findTemplates: vi.fn(),
  apply: vi.fn(), role: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(), requireApiRole: mocks.role,
}));
vi.mock("@/lib/db", () => ({ prisma: {
  dbInstance: { findFirst: mocks.findInstance },
  instanceAuthSettings: { findUnique: mocks.findSettings, upsert: mocks.upsert },
  instanceEmailTemplate: { findMany: mocks.findTemplates },
} }));
vi.mock("@/lib/provision/auth-settings", async (original) => ({
  ...await original<typeof import("@/lib/provision/auth-settings")>(), applyAuthSettings: mocks.apply,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { PATCH, GET } from "./route";
import { DEFAULT_AUTH_SETTINGS } from "@/lib/provision/render";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { __resetKeyCacheForTests } from "@/lib/crypto";
import { ForbiddenError } from "@/lib/rbac";
const context = { params: Promise.resolve({ id: "inst-1" }) };
const patch = (body: unknown) => PATCH(new Request("https://wharf.example/api/db-instances/inst-1/auth-settings", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), context);
let existing: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PANEL_URL", "https://wharf.example");
  vi.stubEnv("WHARF_MASTER_KEY", Buffer.alloc(32, 8).toString("base64")); __resetKeyCacheForTests();
  existing = {
    ...DEFAULT_AUTH_SETTINGS, id: "settings-1", dbInstanceId: "inst-1", smsProvider: "twilio",
    smsTwilioAccountSid: `AC${"a".repeat(32)}`, smsTwilioAuthTokenEnc: sealBytes("saved-auth-token"),
    smsTwilioMessageServiceSid: `MG${"b".repeat(32)}`,
  };
  mocks.role.mockResolvedValue({ session: { user: { id: "admin", email: "admin@example.test" } }, role: "admin" });
  mocks.findInstance.mockResolvedValue({ id: "inst-1" });
  mocks.findSettings.mockImplementation(async () => existing);
  mocks.findTemplates.mockResolvedValue([]);
  mocks.upsert.mockImplementation(async ({ update }) => ({ ...existing, ...update }));
  mocks.apply.mockImplementation(async (_id, _settings, _templates, persist) => { await persist(); return { ok: true }; });
});
afterEach(() => { vi.unstubAllEnvs(); __resetKeyCacheForTests(); });

describe("Twilio settings API", () => {
  it("persists WhatsApp/fallback and keeps an untouched token without exposing it", async () => {
    const res = await patch({ smsTwilioDeliveryChannel: "whatsapp", smsTwilioSmsFallback: true,
      smsTwilioWhatsappSender: "+14155551234", smsTwilioContentSid: `HX${"c".repeat(32)}`, smsTwilioAuthToken: "" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.smsTwilioDeliveryChannel).toBe("whatsapp");
    expect(data.smsTwilioSmsFallback).toBe(true);
    expect(data.smsTwilioAuthTokenConfigured).toBe(true);
    expect(JSON.stringify(data)).not.toContain("saved-auth-token");
    expect(mocks.upsert.mock.calls[0]![0].update).not.toHaveProperty("smsTwilioAuthTokenEnc");
    expect(mocks.apply.mock.calls[0]![1].smsTwilioAuthToken).toBe("saved-auth-token");
    expect(mocks.audit.mock.calls[0]![0].metadata).toMatchObject({ applied: true });
  });
  it("validates merged fields before applying or saving", async () => {
    const res = await patch({ smsTwilioDeliveryChannel: "whatsapp" });
    expect(res.status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    const invalid = await patch({ smsTwilioSmsFallback: true });
    expect(invalid.status).toBe(400);
  });
  it("makes a busy conflict side-effect free", async () => {
    mocks.apply.mockResolvedValue({ busy: "restore" });
    expect((await patch({ smsOtpExp: 120 })).status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("preserves settings and reports restart failure", async () => {
    mocks.apply.mockImplementation(async (_id, _settings, _templates, persist) => {
      await persist(); throw new Error("restart failed");
    });
    const res = await patch({ smsOtpExp: 120 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false, applyError: "restart failed", smsOtpExp: 120 });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
  it("enforces write permission and returns no credentials on reads", async () => {
    const get = await GET(new Request("https://wharf.example"), context);
    expect(JSON.stringify(await get.json())).not.toContain("saved-auth-token");
    mocks.role.mockRejectedValue(new ForbiddenError("instance.auth-settings.write"));
    expect((await patch({ smsOtpExp: 120 })).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
