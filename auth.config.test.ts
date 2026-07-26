import { beforeEach, describe, expect, it } from "vitest";
import authConfig from "./auth.config";

const redirect = authConfig.callbacks!.redirect!;
const baseUrl = "https://panel.wharf.example.com";

describe("auth.config redirect callback", () => {
  beforeEach(() => {
    process.env.INSTANCE_DOMAIN = "wharf.example.com";
    process.env.PANEL_URL = baseUrl;
  });

  it("allows a same-origin relative path", async () => {
    expect(await redirect({ url: "/servers", baseUrl })).toBe(
      "https://panel.wharf.example.com/servers",
    );
  });

  it("allows a same-origin absolute URL", async () => {
    const url = "https://panel.wharf.example.com/databases";
    expect(await redirect({ url, baseUrl })).toBe(url);
  });

  it("allows an absolute returnTo pointing at a trusted Studio subdomain", async () => {
    const url = "https://studio-clienta.wharf.example.com/project/default/editor";
    expect(await redirect({ url, baseUrl })).toBe(url);
  });

  it("falls back to baseUrl for an absolute URL on an untrusted host", async () => {
    expect(
      await redirect({ url: "https://evil.example.com/", baseUrl }),
    ).toBe(baseUrl);
  });

  it("falls back to baseUrl when it can't be parsed at all", async () => {
    const brokenBase = "::not-a-url::";
    expect(await redirect({ url: "/x", baseUrl: brokenBase })).toBe(brokenBase);
  });
});
