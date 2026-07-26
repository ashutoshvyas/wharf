import { describe, expect, it } from "vitest";
import { authSettingsUpdateSchema } from "./auth-settings-schema";

describe("authSettingsUpdateSchema", () => {
  it("accepts a fully empty patch", () => {
    expect(authSettingsUpdateSchema.parse({})).toEqual({});
  });

  it("strips empty-string secret fields (keep existing)", () => {
    const out = authSettingsUpdateSchema.parse({
      googleEnabled: true,
      smtpPass: "",
      googleSecret: "",
      githubSecret: "",
      azureSecret: "",
    });
    expect(out).toEqual({ googleEnabled: true });
    expect("smtpPass" in out).toBe(false);
    expect("googleSecret" in out).toBe(false);
  });

  it("keeps non-empty secrets", () => {
    const out = authSettingsUpdateSchema.parse({
      googleSecret: "real-secret",
      smtpPass: "real-pass",
    });
    expect(out.googleSecret).toBe("real-secret");
    expect(out.smtpPass).toBe("real-pass");
  });

  it.each([
    "additionalRedirectUrls",
    "smtpHost",
    "smtpUser",
    "smtpSenderName",
    "smtpAdminEmail",
    "googleClientId",
    "githubClientId",
    "azureClientId",
  ])("rejects a line break in %s (.env injection guard)", (field) => {
    expect(
      authSettingsUpdateSchema.safeParse({ [field]: "line1\nEVIL=1" }).success,
    ).toBe(false);
    expect(
      authSettingsUpdateSchema.safeParse({ [field]: "line1\rEVIL=1" }).success,
    ).toBe(false);
  });

  it("validates jwtExpirySeconds bounds", () => {
    expect(authSettingsUpdateSchema.safeParse({ jwtExpirySeconds: 60 }).success).toBe(false);
    expect(
      authSettingsUpdateSchema.safeParse({ jwtExpirySeconds: 1_000_000 }).success,
    ).toBe(false);
    expect(authSettingsUpdateSchema.safeParse({ jwtExpirySeconds: 3600 }).success).toBe(
      true,
    );
  });

  it("validates smtpPort bounds", () => {
    expect(authSettingsUpdateSchema.safeParse({ smtpPort: 0 }).success).toBe(false);
    expect(authSettingsUpdateSchema.safeParse({ smtpPort: 70_000 }).success).toBe(false);
    expect(authSettingsUpdateSchema.safeParse({ smtpPort: 587 }).success).toBe(true);
  });
});
