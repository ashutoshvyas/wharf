/**
 * request-schema bounds. The slug becomes a DNS label
 * (`{slug}.{INSTANCE_DOMAIN}`) and is globally unique, so its regex and
 * length cap are load-bearing, not cosmetic (contract §7).
 */
import { describe, expect, it } from "vitest";
import { createInstanceSchema, removeSchema, slugSchema } from "./schema";

const UUID = "4f2a1b3c-0000-4000-8000-000000000000";

function create(over: Record<string, unknown> = {}) {
  return createInstanceSchema.safeParse({
    serverId: UUID,
    name: "clienta-prod",
    slug: "clienta",
    ...over,
  });
}

describe("createInstanceSchema — slug", () => {
  it("accepts lowercase alnum with inner hyphens", () => {
    for (const slug of ["a", "0", "clienta", "client-a", "a-b-c", "sb2", "9lives"]) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it("rejects a leading hyphen (invalid DNS label)", () => {
    expect(slugSchema.safeParse("-clienta").success).toBe(false);
  });

  it("rejects uppercase, underscores, dots and spaces", () => {
    for (const slug of ["ClientA", "client_a", "client.a", "client a", "cliént"]) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it("rejects an empty slug", () => {
    expect(slugSchema.safeParse("").success).toBe(false);
  });

  it("caps the slug at 40 characters", () => {
    expect(slugSchema.safeParse("a".repeat(40)).success).toBe(true);
    expect(slugSchema.safeParse("a".repeat(41)).success).toBe(false);
  });

  it("allows a trailing hyphen (the regex only pins the first char)", () => {
    expect(slugSchema.safeParse("client-").success).toBe(true);
  });
});

describe("createInstanceSchema — name", () => {
  it("accepts 1–64 characters", () => {
    expect(create({ name: "a" }).success).toBe(true);
    expect(create({ name: "n".repeat(64) }).success).toBe(true);
  });

  it("rejects empty and over-long names", () => {
    expect(create({ name: "" }).success).toBe(false);
    expect(create({ name: "n".repeat(65) }).success).toBe(false);
  });

  it("allows spaces and mixed case in the display name", () => {
    expect(create({ name: "Client A — prod" }).success).toBe(true);
  });
});

describe("createInstanceSchema — serverId", () => {
  it("requires a UUID", () => {
    expect(create().success).toBe(true);
    expect(create({ serverId: "srv-1" }).success).toBe(false);
    expect(create({ serverId: "" }).success).toBe(false);
  });

  it("rejects a payload missing any required field", () => {
    for (const field of ["serverId", "name", "slug"]) {
      expect(create({ [field]: undefined }).success, field).toBe(false);
    }
  });

  it("returns the parsed triple on success", () => {
    const parsed = create();
    expect(parsed.success && parsed.data).toEqual({
      serverId: UUID,
      name: "clienta-prod",
      slug: "clienta",
    });
  });
});

describe("removeSchema", () => {
  it("requires a non-empty confirmName", () => {
    expect(removeSchema.safeParse({ confirmName: "clienta-prod" }).success).toBe(true);
    expect(removeSchema.safeParse({ confirmName: "" }).success).toBe(false);
    expect(removeSchema.safeParse({}).success).toBe(false);
  });

  it("does not itself compare against the instance name — that is the route's job", () => {
    // Any non-empty string parses; the equality check happens server-side in
    // the DELETE handler against the stored row.
    expect(removeSchema.safeParse({ confirmName: "not-the-name" }).success).toBe(true);
  });

  it("force is optional and boolean-typed", () => {
    expect(removeSchema.safeParse({ confirmName: "x", force: true }).success).toBe(true);
    expect(removeSchema.safeParse({ confirmName: "x" }).success).toBe(true);
    expect(removeSchema.safeParse({ confirmName: "x", force: "true" }).success).toBe(false);
  });
});
