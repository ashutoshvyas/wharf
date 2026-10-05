import { describe, expect, it } from "vitest";
import { checkConfig } from "./config-check";

const asEnv = (env: Record<string, string>) => env as unknown as NodeJS.ProcessEnv;
const settings = (env: Record<string, string>) =>
  checkConfig(asEnv(env)).map((p) => p.setting);

const PROD = {
  PANEL_URL: "https://panel.wharf.example.com",
  COOKIE_DOMAIN: ".wharf.example.com",
  INSTANCE_DOMAIN: "wharf.example.com",
};

describe("checkConfig", () => {
  it("passes a correctly configured production panel", () => {
    expect(checkConfig(asEnv(PROD))).toEqual([]);
  });

  it("accepts a panel on a subdomain of the instance apex", () => {
    expect(
      settings({ ...PROD, PANEL_URL: "https://wharf.panel.wharf.example.com" }),
    ).toEqual([]);
  });

  it("flags a missing INSTANCE_DOMAIN", () => {
    expect(settings({ ...PROD, INSTANCE_DOMAIN: "" })).toContain("INSTANCE_DOMAIN");
  });

  it("flags a missing COOKIE_DOMAIN in production — the classic Studio SSO failure", () => {
    const problems = checkConfig(asEnv({ ...PROD, COOKIE_DOMAIN: "" }));
    expect(problems.map((p) => p.setting)).toContain("COOKIE_DOMAIN");
    // The message must name the fix, not just the symptom.
    expect(problems[0]!.message).toContain(".wharf.example.com");
  });

  it("flags a COOKIE_DOMAIN that does not cover INSTANCE_DOMAIN", () => {
    expect(
      settings({ ...PROD, COOKIE_DOMAIN: ".other.example.com" }),
    ).toContain("COOKIE_DOMAIN");
  });

  it("flags a panel hosted outside the cookie domain", () => {
    expect(
      settings({ ...PROD, PANEL_URL: "https://panel.other.com" }),
    ).toContain("PANEL_URL");
  });

  it("flags a non-https panel URL", () => {
    expect(settings({ ...PROD, PANEL_URL: "http://panel.wharf.example.com" })).toContain(
      "PANEL_URL",
    );
  });

  it("treats a bare apex COOKIE_DOMAIN as equivalent to a dotted one", () => {
    expect(settings({ ...PROD, COOKIE_DOMAIN: "wharf.example.com" })).toEqual([]);
  });

  it("is quiet in local development", () => {
    expect(
      checkConfig(
        asEnv({
          PANEL_URL: "http://localhost:3000",
          COOKIE_DOMAIN: "",
          INSTANCE_DOMAIN: "wharf.example.com",
        }),
      ),
    ).toEqual([]);
  });

  it("flags a domain-scoped cookie on localhost (browsers reject it)", () => {
    expect(
      settings({
        PANEL_URL: "http://localhost:3000",
        COOKIE_DOMAIN: ".wharf.example.com",
        INSTANCE_DOMAIN: "wharf.example.com",
      }),
    ).toContain("COOKIE_DOMAIN");
  });
});
