import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio";
import type { PhoneDelivery } from "@prisma/client";
import { DEFAULT_AUTH_SETTINGS } from "@/lib/provision/render";
import { __resetKeyCacheForTests, open } from "@/lib/crypto";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
  transaction: vi.fn(), execute: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: {
  phoneDelivery: db, $transaction: db.transaction,
} }));
const send = vi.hoisted(() => vi.fn());
vi.mock("./twilio", async (original) => ({ ...await original<typeof import("./twilio")>(), sendTwilioOtp: send }));
import { cleanupPhoneDeliveries, deliverTwilioOtp, handleTwilioStatus } from "./twilio-delivery";

const SID = `SM${"a".repeat(32)}`;
const FALLBACK_SID = `SM${"b".repeat(32)}`;
const ACCOUNT = `AC${"c".repeat(32)}`;
const TOKEN = "test-token";
let rows: Map<string, PhoneDelivery>;
let fallbackAllowed: boolean;
// A small in-memory store executes the compare-and-set predicates passed to Prisma.
// These tests exercise orchestration; database migration/locking still need staging QA.
function matches(row: PhoneDelivery, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "instance") return fallbackAllowed;
    if (key === "OR") return (value as Record<string, unknown>[]).some((w) => matches(row, w));
    const actual = row[key as keyof PhoneDelivery];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const rule = value as { in?: unknown[]; not?: unknown; gt?: Date; lt?: Date; lte?: Date };
      if (rule.in) return rule.in.includes(actual);
      if ("not" in rule) return actual !== rule.not;
      if (rule.gt) return (actual as Date) > rule.gt;
      if (rule.lt) return (actual as Date) < rule.lt;
      if (rule.lte) return (actual as Date) <= rule.lte;
    }
    return actual === value;
  });
}
const input = () => ({
  instanceId: "inst-1", webhookId: "hook-1", rawBody: '{"signed":"body"}', hookSecret: "test-hook-secret",
  phone: "919999999999", otp: "123456", panelUrl: "https://wharf.example",
  settings: {
    ...DEFAULT_AUTH_SETTINGS, smsProvider: "twilio" as const, smsTwilioDeliveryChannel: "whatsapp" as const,
    smsTwilioSmsFallback: true, smsTwilioAccountSid: ACCOUNT, smsTwilioAuthToken: TOKEN,
    smsTwilioMessageServiceSid: `MG${"d".repeat(32)}`, smsTwilioWhatsappSender: "+14155551234",
    smsTwilioContentSid: `HX${"e".repeat(32)}`,
  },
});
const first = () => [...rows.values()][0]!;
async function callback(status: string, leg: "primary" | "fallback" = "primary", extra: Record<string, string> = {}) {
  const row = first();
  const params = {
    AccountSid: ACCOUNT, MessageSid: leg === "primary" ? SID : FALLBACK_SID,
    To: leg === "primary" ? "whatsapp:+919999999999" : "+919999999999", MessageStatus: status, ...extra,
  };
  const url = `https://wharf.example/api/db-instances/inst-1/twilio-status/${row.id}/${leg}`;
  return handleTwilioStatus("inst-1", row.id, leg, getExpectedTwilioSignature(TOKEN, url, params), params);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WHARF_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  __resetKeyCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = new Map(); fallbackAllowed = true;
  db.findUnique.mockImplementation(async ({ where }) => {
    const row = rows.get(where.id); return row ? { ...row } : null;
  });
  db.findFirst.mockImplementation(async ({ where }) => {
    const row = [...rows.values()].find((r) => matches(r, where)); return row ? { ...row } : null;
  });
  db.create.mockImplementation(async ({ data }) => {
    const row = { primarySid: null, fallbackSid: null, createdAt: new Date(), ...data };
    rows.set(row.id, row); return { ...row };
  });
  db.updateMany.mockImplementation(async ({ where, data }) => {
    let count = 0;
    for (const [id, row] of rows) if (matches(row, where)) { rows.set(id, { ...row, ...data }); count++; }
    return { count };
  });
  db.deleteMany.mockResolvedValue({ count: 0 });
  db.transaction.mockImplementation(async (fn) => fn({ phoneDelivery: db, $executeRaw: db.execute }));
  send.mockResolvedValue({ ok: true, sid: SID, status: "queued" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); __resetKeyCacheForTests(); });

describe("Twilio delivery orchestration", () => {
  it("uses the server-selected channel, encrypts payloads, and suppresses hook replay", async () => {
    expect(await deliverTwilioOtp(input())).toBe(true);
    expect(send.mock.calls[0]![1]).toBe("whatsapp");
    const row = first();
    expect(Buffer.from(row.payloadEnc!).toString()).not.toContain("123456");
    expect(JSON.parse(open(row.payloadEnc!)).otp).toBe("123456");
    expect(await deliverTwilioOtp(input())).toBe(true);
    expect(await deliverTwilioOtp({ ...input(), rawBody: "different" })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("sends directly by SMS when selected", async () => {
    const sms = input(); sms.settings = { ...sms.settings, smsTwilioSmsFallback: false };
    await deliverTwilioOtp({ ...sms, settings: { ...sms.settings, smsTwilioDeliveryChannel: "sms" } });
    expect(send.mock.calls[0]![1]).toBe("sms");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("falls back once with the identical code after immediate rejection", async () => {
    send.mockResolvedValueOnce({ ok: false, uncertain: false, code: "63024" })
      .mockResolvedValueOnce({ ok: true, sid: FALLBACK_SID, status: "accepted" });
    expect(await deliverTwilioOtp(input())).toBe(true);
    expect(send.mock.calls.map((c) => c[1])).toEqual(["whatsapp", "sms"]);
    expect(send.mock.calls.map((c) => c[3])).toEqual(["123456", "123456"]);
    expect(first().state).toBe("fallback_accepted");
  });
  it("waits for a signed failure, then deduplicates concurrent callback retries", async () => {
    await deliverTwilioOtp(input());
    send.mockResolvedValue({ ok: true, sid: FALLBACK_SID, status: "accepted" });
    expect(await callback("sent")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.all([callback("undelivered"), callback("undelivered")]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(first().state).toBe("fallback_accepted");
    await callback("delivered", "fallback");
    expect(first().state).toBe("fallback_delivered");
    expect(first().payloadEnc).toBeNull();
  });
  it("never falls back for a delivered or read WhatsApp message", async () => {
    await deliverTwilioOtp(input());
    await callback("read");
    await callback("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(first().payloadEnc).toBeNull();
  });
  it("does not send fallback when disabled, switched off later, or expired", async () => {
    await deliverTwilioOtp(input());
    fallbackAllowed = false;
    await callback("failed");
    expect(send).toHaveBeenCalledTimes(1);
    fallbackAllowed = true;
    rows.set(first().id, { ...first(), expiresAt: new Date(0) });
    await callback("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(first().state).toBe("expired");
  });
  it("rejects forged signatures, wrong accounts, recipients and message IDs", async () => {
    await deliverTwilioOtp(input());
    expect(await handleTwilioStatus("inst-1", first().id, "primary", "forged", {})).toBe(false);
    expect(await callback("failed", "primary", { AccountSid: "another-account" })).toBe(false);
    expect(await callback("failed", "primary", { To: "whatsapp:+1234" })).toBe(false);
    expect(await callback("failed", "primary", { MessageSid: FALLBACK_SID })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("accepts early delivery callbacks without overwriting their final state", async () => {
    send.mockImplementationOnce(async () => {
      await callback("delivered");
      return { ok: true, sid: SID, status: "queued" };
    });
    expect(await deliverTwilioOtp(input())).toBe(true);
    expect(first().state).toBe("primary_delivered");
    expect(first().payloadEnc).toBeNull();
  });
  it("does not resend after ambiguous acceptance but permits a later confirmed failure", async () => {
    send.mockResolvedValueOnce({ ok: false, uncertain: true, code: "request_uncertain" });
    expect(await deliverTwilioOtp(input())).toBe(true);
    expect(await deliverTwilioOtp(input())).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue({ ok: true, sid: FALLBACK_SID, status: "accepted" });
    await callback("failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("prevents an older code's late failure from sending fallback after a resend", async () => {
    await deliverTwilioOtp(input());
    await deliverTwilioOtp({ ...input(), webhookId: "hook-2", rawBody: "new signed body", otp: "654321" });
    await callback("failed");
    expect(send).toHaveBeenCalledTimes(2);
    expect(first().state).toBe("superseded");
    expect(first().payloadEnc).toBeNull();
  });
  it("reports a failed SMS fallback without looping or exposing provider text", async () => {
    send.mockResolvedValue({ ok: false, uncertain: false, code: "63024" });
    expect(await deliverTwilioOtp(input())).toBe(false);
    expect(await deliverTwilioOtp(input())).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(first().state).toBe("fallback_failed");
    expect(first().payloadEnc).toBeNull();
  });
  it("cleans expired ciphertext while retaining replay protection", async () => {
    await deliverTwilioOtp(input());
    rows.set(first().id, { ...first(), expiresAt: new Date(0) });
    await cleanupPhoneDeliveries();
    expect(first().payloadEnc).toBeNull();
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: expect.any(Date) } } });
  });
});
