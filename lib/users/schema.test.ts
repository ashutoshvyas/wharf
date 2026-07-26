import { describe, expect, it } from "vitest";
import {
  PASSWORD_MIN_LENGTH,
  createUserSchema,
  setPasswordSchema,
  updateUserSchema,
  userEmailSchema,
} from "./schema";

describe("userEmailSchema", () => {
  it("trims and lowercases before validating", () => {
    expect(userEmailSchema.parse("  Ada@example.com ")).toBe(
      "ada@example.com",
    );
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "nope", "a@", "@b.com", "a b@c.com"]) {
      expect(userEmailSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects addresses longer than 160 characters", () => {
    const long = `${"a".repeat(155)}@example.com`;
    expect(long.length).toBeGreaterThan(160);
    expect(userEmailSchema.safeParse(long).success).toBe(false);
    expect(userEmailSchema.safeParse("a@example.com").success).toBe(true);
  });
});

describe("createUserSchema", () => {
  it("accepts each valid role and normalizes the email", () => {
    for (const role of ["admin", "operator", "viewer"] as const) {
      const parsed = createUserSchema.parse({ email: "Ada@Example.COM", role });
      expect(parsed).toEqual({ email: "ada@example.com", role });
    }
  });

  it("rejects an unknown role", () => {
    const res = createUserSchema.safeParse({
      email: "ada@example.com",
      role: "superuser",
    });
    expect(res.success).toBe(false);
  });

  it("requires both fields", () => {
    expect(createUserSchema.safeParse({ email: "ada@example.com" }).success).toBe(
      false,
    );
    expect(createUserSchema.safeParse({ role: "viewer" }).success).toBe(false);
  });

  it("ignores unknown keys rather than trusting them", () => {
    const parsed = createUserSchema.parse({
      email: "ada@example.com",
      role: "viewer",
      passwordHash: "$2b$12$injected",
    });
    expect(parsed).not.toHaveProperty("passwordHash");
  });
});

describe("updateUserSchema", () => {
  it("accepts a role only", () => {
    expect(updateUserSchema.parse({ role: "operator" })).toEqual({
      role: "operator",
    });
  });

  it("cannot be used to change the email", () => {
    const parsed = updateUserSchema.parse({
      role: "admin",
      email: "other@example.com",
    });
    expect(parsed).not.toHaveProperty("email");
  });

  it("rejects a missing role", () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false);
  });
});

describe("setPasswordSchema", () => {
  it("accepts a 12-character password", () => {
    const password = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(setPasswordSchema.parse({ token: "tok", password })).toEqual({
      token: "tok",
      password,
    });
  });

  it("rejects anything shorter than 12 characters", () => {
    const res = setPasswordSchema.safeParse({
      token: "tok",
      password: "a".repeat(PASSWORD_MIN_LENGTH - 1),
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toContain("at least 12");
  });

  it("rejects a password past bcrypt's 72-byte truncation point", () => {
    expect(
      setPasswordSchema.safeParse({ token: "tok", password: "a".repeat(73) })
        .success,
    ).toBe(false);
  });

  it("requires a non-empty token", () => {
    expect(
      setPasswordSchema.safeParse({ token: "", password: "a".repeat(12) })
        .success,
    ).toBe(false);
  });
});
