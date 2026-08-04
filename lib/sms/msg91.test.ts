import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePhone, sendMsg91Otp } from "./msg91";

const CREDS = {
  authKey: "auth-key",
  templateId: "tmpl-1",
  senderId: "WHARFX",
  otpVariable: "OTP",
};

/** Not Partial<Response>: its `body` is a ReadableStream, and we want text. */
interface FakeResponse {
  ok?: boolean;
  status?: number;
  body?: string;
}

function mockFetch(res: FakeResponse) {
  const fn = vi.fn().mockResolvedValue({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    text: async () => res.body ?? "{}",
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("normalizePhone", () => {
  it("strips everything MSG91 will not accept", () => {
    expect(normalizePhone("+91 99999-99999")).toBe("919999999999");
    expect(normalizePhone("919999999999")).toBe("919999999999");
  });
});

describe("sendMsg91Otp", () => {
  it("posts the OTP under the template's own variable name", async () => {
    const fetchMock = mockFetch({ body: '{"type":"success"}' });
    const res = await sendMsg91Otp({ ...CREDS, otpVariable: "CODE" }, "+91 99999 99999", "123456");

    expect(res).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://control.msg91.com/api/v5/flow/");
    expect((init.headers as Record<string, string>).authkey).toBe("auth-key");
    expect(JSON.parse(init.body as string)).toEqual({
      template_id: "tmpl-1",
      short_url: "0",
      sender: "WHARFX",
      // The variable name is the template's, not ours — a mismatch delivers
      // a message with an empty code.
      recipients: [{ mobiles: "919999999999", CODE: "123456" }],
    });
  });

  it("omits sender when the template already pins one", async () => {
    const fetchMock = mockFetch({});
    await sendMsg91Otp({ ...CREDS, senderId: "" }, "919999999999", "123456");
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string))
      .not.toHaveProperty("sender");
  });

  it("treats a 200 carrying a non-success type as a failure", async () => {
    // MSG91 answers 200 for some rejections, so status alone proves nothing.
    mockFetch({ body: '{"type":"error","message":"invalid template"}' });
    const res = await sendMsg91Otp(CREDS, "919999999999", "123456");
    expect(res.ok).toBe(false);
    expect(res).toHaveProperty("error", expect.stringContaining("invalid template"));
  });

  it("accepts a 2xx whose body is not JSON", async () => {
    mockFetch({ body: "OK" });
    expect(await sendMsg91Otp(CREDS, "919999999999", "123456")).toEqual({ ok: true });
  });

  it("reports the status and body on an HTTP error", async () => {
    mockFetch({ ok: false, status: 401, body: "bad authkey" });
    const res = await sendMsg91Otp(CREDS, "919999999999", "123456");
    expect(res).toEqual({ ok: false, error: "MSG91 responded 401: bad authkey" });
  });

  it("never throws when the network fails — the caller is answering GoTrue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await sendMsg91Otp(CREDS, "919999999999", "123456");
    expect(res.ok).toBe(false);
    expect(res).toHaveProperty("error", expect.stringContaining("ECONNREFUSED"));
  });

  it("refuses to call MSG91 at all when required config is missing", async () => {
    const fetchMock = mockFetch({});
    expect((await sendMsg91Otp({ ...CREDS, authKey: "" }, "9199", "1")).ok).toBe(false);
    expect((await sendMsg91Otp({ ...CREDS, templateId: "" }, "9199", "1")).ok).toBe(false);
    expect((await sendMsg91Otp(CREDS, "", "1")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
