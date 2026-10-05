import { describe, expect, it } from "vitest";
import { adminSeedConfig } from "./admin-seed-config";

describe("initial administrator configuration", () => {
  it.each([undefined, "", "change-me", "change-me-now", "CHANGE-ME-NOW"])(
    "rejects missing and template passwords before seeding",
    (ADMIN_PASSWORD) => {
      expect(() =>
        adminSeedConfig({ ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD }),
      ).toThrow("ADMIN_PASSWORD");
    },
  );

  it("rejects invalid email and passwords exceeding bcrypt's byte limit", () => {
    expect(() =>
      adminSeedConfig({ ADMIN_EMAIL: "invalid", ADMIN_PASSWORD: "synthetic passphrase" }),
    ).toThrow("ADMIN_EMAIL");
    expect(() =>
      adminSeedConfig({ ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "é".repeat(40) }),
    ).toThrow("ADMIN_PASSWORD");
  });

  it("accepts a configured passphrase and normalizes the email", () => {
    expect(
      adminSeedConfig({ ADMIN_EMAIL: " Admin@Example.com ", ADMIN_PASSWORD: "synthetic passphrase" }),
    ).toEqual({ adminEmail: "admin@example.com", adminPassword: "synthetic passphrase" });
  });
});
