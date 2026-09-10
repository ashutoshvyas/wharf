import { afterEach, describe, expect, it, vi } from "vitest";
import { internationalPhone, sendTwilioOtp, smsBody, type TwilioCredentials } from "./twilio";

const CREDS: TwilioCredentials = {
  accountSid: `AC${"a".repeat(32)}`, authToken: "secret",
  messageServiceSid: `MG${"b".repeat(32)}`, whatsappSender: "+14155551234",
  contentSid: `HX${"c".repeat(32)}`, smsTemplate: "Your code is {{ .Code }}",
};
const SID = `SM${"d".repeat(32)}`;
const callback = "https://wharf.example/api/callback";
const expiry = () => new Date(Date.now() + 60_000);
const send = (channel: "sms" | "whatsapp" = "whatsapp") => sendTwilioOtp(CREDS, channel, "919999999999", "123456", callback, expiry());
function response(status: number, data: unknown) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("Twilio OTP transport", () => {
  it("sends the supplied code through an authentication template on WhatsApp", async () => {
    const fetcher = response(201, { sid: SID, status: "queued" });
    expect(await send()).toEqual({ ok: true, sid: SID, status: "queued" });
    const [url, req] = fetcher.mock.calls[0]!;
    expect(url).toContain(`/Accounts/${CREDS.accountSid}/Messages.json`);
    const body = new URLSearchParams(req.body);
    expect(body.get("To")).toBe("whatsapp:+919999999999");
    expect(body.get("From")).toBe("whatsapp:+14155551234");
    expect(body.get("ContentSid")).toBe(CREDS.contentSid);
    expect(JSON.parse(body.get("ContentVariables")!)).toEqual({ "1": "123456" });
    expect(body.has("Body")).toBe(false);
    expect(body.has("MessagingServiceSid")).toBe(false);
    expect(body.get("StatusCallback")).toBe(callback);
    expect(Number(body.get("ValidityPeriod"))).toBeLessThanOrEqual(60);
  });

  it("uses MessagingServiceSid and the same OTP for SMS", async () => {
    const fetcher = response(201, { sid: SID, status: "accepted" });
    await send("sms");
    const body = new URLSearchParams(fetcher.mock.calls[0]![1].body);
    expect(body.get("To")).toBe("+919999999999");
    expect(body.get("MessagingServiceSid")).toBe(CREDS.messageServiceSid);
    expect(body.get("Body")).toBe("Your code is 123456");
    expect(body.has("From")).toBe(false);
    expect(body.has("ContentSid")).toBe(false);
  });

  it("distinguishes explicit rejection from ambiguous server failure", async () => {
    response(400, { code: 63024, message: "private recipient and OTP" });
    expect(await send()).toEqual({ ok: false, uncertain: false, code: "63024" });
    response(503, { message: "private" });
    expect(await send()).toEqual({ ok: false, uncertain: true, code: "http_503" });
  });

  it("does not assume delivery after a timeout or malformed acceptance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private request data")));
    expect(await send()).toEqual({ ok: false, uncertain: true, code: "request_uncertain" });
    response(201, {});
    expect(await send()).toEqual({ ok: false, uncertain: true, code: "invalid_response" });
  });

  it("recognizes a terminal failure even in a successful HTTP response", async () => {
    response(201, { sid: SID, status: "failed", error_code: 63024 });
    expect(await send()).toEqual({ ok: false, uncertain: false, code: "63024" });
  });

  it("never sends an expired code or malformed recipient", async () => {
    const fetcher = response(201, { sid: SID });
    for (const phone of ["", "whatsapp:+1234", "abc919999999999", "+01234"]) {
      expect((await sendTwilioOtp(CREDS, "sms", phone, "123456", callback, expiry())).ok).toBe(false);
    }
    expect((await sendTwilioOtp(CREDS, "sms", "919999999999", "123456", callback, new Date(0))).ok).toBe(false);
    expect(await sendTwilioOtp(CREDS, "sms", "919999999999", "123456", callback, expiry(), Date.now() - 1))
      .toEqual({ ok: false, uncertain: false, code: "request_deadline" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes the international prefix and substitutes supported code expressions", () => {
    expect(internationalPhone("+919999999999")).toBe("+919999999999");
    expect(smsBody("", "123456")).toBe("Your code is 123456");
    expect(smsBody("{{.Code}} / {{ .Code }}", "123456")).toBe("123456 / 123456");
  });
});
