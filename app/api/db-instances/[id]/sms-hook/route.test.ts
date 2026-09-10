import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ instance: vi.fn(), twilio: vi.fn(), msg91: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { dbInstance: { findFirst: mocks.instance } } }));
vi.mock("@/lib/sms/twilio-delivery", () => ({ deliverTwilioOtp: mocks.twilio }));
vi.mock("@/lib/sms/msg91", () => ({ sendMsg91Otp: mocks.msg91 }));
import { POST } from "./route";
import { DEFAULT_AUTH_SETTINGS } from "@/lib/provision/render";
import { deriveAncillarySecrets } from "@/lib/provision/secrets";
import { __resetKeyCacheForTests } from "@/lib/crypto";
import { sealBytes } from "@/lib/servers/seal-bytes";
const JWT = "j".repeat(80);
const context = { params: Promise.resolve({ id: "inst-1" }) };
function request(body: unknown, signatureValid = true) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { smsHookSecret } = deriveAncillarySecrets(JWT);
  const signature = createHmac("sha256", Buffer.from(smsHookSecret, "base64"))
    .update(`hook-1.${timestamp}.${raw}`).digest("base64");
  return new Request("https://wharf.example/api/db-instances/inst-1/sms-hook", {
    method: "POST", body: raw,
    headers: { "webhook-id": "hook-1", "webhook-timestamp": timestamp,
      "webhook-signature": signatureValid ? `v1,${signature}` : "v1,forged" },
  });
}
let settings: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WHARF_MASTER_KEY", Buffer.alloc(32, 3).toString("base64")); __resetKeyCacheForTests();
  vi.stubEnv("PANEL_URL", "https://wharf.example");
  settings = { ...DEFAULT_AUTH_SETTINGS, smsProvider: "twilio",
    smsTwilioAccountSid: `AC${"a".repeat(32)}`, smsTwilioAuthTokenEnc: sealBytes("secret"),
    smsTwilioMessageServiceSid: `MG${"b".repeat(32)}`,
    // An unrelated, unreadable secret must not stop phone OTPs.
    googleSecretEnc: new Uint8Array([0]) };
  mocks.instance.mockImplementation(async () => ({ jwtSecretEnc: sealBytes(JWT), authSettings: settings }));
  mocks.twilio.mockResolvedValue(true); mocks.msg91.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.unstubAllEnvs(); __resetKeyCacheForTests(); });

describe("signed phone delivery hook", () => {
  it("rejects forged signatures before contacting either provider", async () => {
    expect((await POST(request({ sms: { otp: "123456", phone: "919999999999" } }, false), context)).status).toBe(401);
    expect(mocks.twilio).not.toHaveBeenCalled(); expect(mocks.msg91).not.toHaveBeenCalled();
  });
  it("uses the new phone-change destination rather than the user's old phone", async () => {
    const res = await POST(request({ sms: { otp: "123456", phone: "919999999999" }, user: { phone: "918888888888" } }), context);
    expect(res.status).toBe(200); expect(await res.json()).toEqual({});
    expect(mocks.twilio.mock.calls[0]![0]).toMatchObject({ phone: "919999999999", otp: "123456", instanceId: "inst-1" });
  });
  it("retains MSG91 delivery and the legacy user.phone input", async () => {
    settings.smsProvider = "msg91";
    expect((await POST(request({ sms: { otp: "123456" }, user: { phone: "919999999999" } }), context)).status).toBe(200);
    expect(mocks.msg91).toHaveBeenCalledWith(expect.any(Object), "919999999999", "123456");
    expect(mocks.twilio).not.toHaveBeenCalled();
  });
  it("rejects malformed signed payloads and disabled instances", async () => {
    for (const body of [null, {}, { sms: { otp: 123456, phone: "919999999999" } }]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    settings.smsProvider = "";
    expect((await POST(request({ sms: { otp: "123456", phone: "919999999999" } }), context)).status).toBe(409);
    expect(mocks.twilio).not.toHaveBeenCalled();
  });
  it("returns a generic error on failure without disclosing credentials", async () => {
    mocks.twilio.mockResolvedValue(false);
    const res = await POST(request({ sms: { otp: "123456", phone: "919999999999" } }), context);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/secret|123456|919999999999/);
  });
});
