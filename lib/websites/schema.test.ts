import { describe, expect, it } from "vitest";
import { websiteCreateSchema, websiteUpdateSchema } from "./schema";

const SERVER_ID = "5e1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const DB_ID = "0a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

const validCreate = {
  domain: "clientb.com",
  serverId: SERVER_ID,
  path: "/var/www/clientb",
};

describe("websiteCreateSchema", () => {
  it("accepts a minimal valid payload and applies defaults", () => {
    const parsed = websiteCreateSchema.parse(validCreate);
    expect(parsed.domain).toBe("clientb.com");
    expect(parsed.credentialLabel).toBe("Admin login");
    expect(parsed.dbInstanceId).toBeUndefined();
    expect(parsed.accessPassword).toBeUndefined();
  });

  it("accepts a full payload", () => {
    const parsed = websiteCreateSchema.parse({
      ...validCreate,
      dbInstanceId: DB_ID,
      credentialLabel: "WP admin",
      accessUsername: "clienta_admin",
      accessPassword: "W9!mK2#xL8qP",
      notes: "WordPress 6.5, daily backup via cron.",
    });
    expect(parsed.credentialLabel).toBe("WP admin");
    expect(parsed.dbInstanceId).toBe(DB_ID);
  });

  it("lowercases and trims the domain", () => {
    const parsed = websiteCreateSchema.parse({
      ...validCreate,
      domain: "  ClientB.COM  ",
    });
    expect(parsed.domain).toBe("clientb.com");
  });

  it.each([
    "https://clientb.com", // scheme
    "clientb.com/path", // path
    "clientb.com:8080", // port
    "client b.com", // whitespace
    "clientb", // single label — not a domain
    "-bad.com", // leading hyphen in label
    "bad-.com", // trailing hyphen in label
    "client_b.com", // underscore
    "", // empty
  ])("rejects invalid domain %j", (domain) => {
    expect(websiteCreateSchema.safeParse({ ...validCreate, domain }).success).toBe(
      false,
    );
  });

  it.each(["var/www/x", "relative", "", "/has space", "C:\\www"])(
    "rejects invalid path %j",
    (path) => {
      expect(websiteCreateSchema.safeParse({ ...validCreate, path }).success).toBe(
        false,
      );
    },
  );

  it("accepts root path '/'", () => {
    expect(websiteCreateSchema.safeParse({ ...validCreate, path: "/" }).success).toBe(
      true,
    );
  });

  it("rejects a non-UUID serverId", () => {
    expect(
      websiteCreateSchema.safeParse({ ...validCreate, serverId: "srv1" }).success,
    ).toBe(false);
  });

  it("rejects a non-UUID dbInstanceId but allows null", () => {
    expect(
      websiteCreateSchema.safeParse({ ...validCreate, dbInstanceId: "db1" }).success,
    ).toBe(false);
    expect(
      websiteCreateSchema.safeParse({ ...validCreate, dbInstanceId: null }).success,
    ).toBe(true);
  });

  it("rejects an over-long credential label (max 40)", () => {
    expect(
      websiteCreateSchema.safeParse({
        ...validCreate,
        credentialLabel: "x".repeat(41),
      }).success,
    ).toBe(false);
  });

  it("rejects a blank credential label", () => {
    expect(
      websiteCreateSchema.safeParse({ ...validCreate, credentialLabel: "  " })
        .success,
    ).toBe(false);
  });

  it("rejects notes over 2000 characters", () => {
    expect(
      websiteCreateSchema.safeParse({ ...validCreate, notes: "n".repeat(2001) })
        .success,
    ).toBe(false);
  });
});

describe("websiteUpdateSchema", () => {
  it("accepts a partial payload", () => {
    const parsed = websiteUpdateSchema.parse({ domain: "renamed.com" });
    expect(parsed.domain).toBe("renamed.com");
    expect(parsed.path).toBeUndefined();
    expect(parsed.credentialLabel).toBeUndefined();
  });

  it("accepts an empty object (no-op update)", () => {
    expect(websiteUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("keeps an empty accessPassword as '' (meaning: keep stored value)", () => {
    const parsed = websiteUpdateSchema.parse({ accessPassword: "" });
    expect(parsed.accessPassword).toBe("");
  });

  it("allows clearing accessUsername with null", () => {
    const parsed = websiteUpdateSchema.parse({ accessUsername: null });
    expect(parsed.accessUsername).toBeNull();
  });

  it("allows clearing dbInstanceId with null", () => {
    const parsed = websiteUpdateSchema.parse({ dbInstanceId: null });
    expect(parsed.dbInstanceId).toBeNull();
  });

  it("still validates provided fields", () => {
    expect(websiteUpdateSchema.safeParse({ domain: "http://x.com" }).success).toBe(
      false,
    );
    expect(websiteUpdateSchema.safeParse({ path: "no-slash" }).success).toBe(false);
    expect(websiteUpdateSchema.safeParse({ serverId: "nope" }).success).toBe(false);
  });
});
