import { describe, expect, it } from "vitest";
import { serverCreateSchema, serverUpdateSchema } from "./schema";

const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake",
  "-----END PRIVATE KEY-----",
].join("\n");

function base(over: Record<string, unknown> = {}) {
  return {
    name: "web-1",
    host: "203.0.113.10",
    sshUser: "root",
    authMethod: "password",
    sshPassword: "hunter2",
    ...over,
  };
}

describe("serverCreateSchema", () => {
  it("accepts a password-auth server and defaults sshPort/tags", () => {
    const out = serverCreateSchema.parse(base());
    expect(out.sshPort).toBe(22);
    expect(out.tags).toEqual([]);
  });

  it("accepts a private_key server with a PEM key and a hostname host", () => {
    const out = serverCreateSchema.parse(
      base({
        host: "db.internal.example.com",
        authMethod: "private_key",
        sshPassword: undefined,
        sshPrivateKey: PEM,
      }),
    );
    expect(out.authMethod).toBe("private_key");
  });

  it("rejects when both sshPassword and sshPrivateKey are provided", () => {
    const res = serverCreateSchema.safeParse(base({ sshPrivateKey: PEM }));
    expect(res.success).toBe(false);
  });

  it("rejects a secret that does not match authMethod", () => {
    // password method but only a key
    expect(
      serverCreateSchema.safeParse(
        base({ sshPassword: undefined, sshPrivateKey: PEM }),
      ).success,
    ).toBe(false);
    // private_key method but only a password
    expect(
      serverCreateSchema.safeParse(base({ authMethod: "private_key" })).success,
    ).toBe(false);
  });

  it("rejects when no secret is provided", () => {
    expect(
      serverCreateSchema.safeParse(base({ sshPassword: undefined })).success,
    ).toBe(false);
  });

  it("rejects a non-PEM sshPrivateKey", () => {
    expect(
      serverCreateSchema.safeParse(
        base({
          authMethod: "private_key",
          sshPassword: undefined,
          sshPrivateKey: "not a pem at all",
        }),
      ).success,
    ).toBe(false);
  });

  it("enforces sshPort bounds 1-65535", () => {
    expect(serverCreateSchema.safeParse(base({ sshPort: 0 })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ sshPort: 65536 })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ sshPort: 2.5 })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ sshPort: 65535 })).success).toBe(true);
    expect(serverCreateSchema.safeParse(base({ sshPort: 1 })).success).toBe(true);
  });

  it("rejects invalid hosts", () => {
    expect(serverCreateSchema.safeParse(base({ host: "has space" })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ host: "-bad.example.com" })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ host: "" })).success).toBe(false);
  });

  it("caps tags at 8 entries of 1-24 chars", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
    expect(serverCreateSchema.safeParse(base({ tags: nine })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ tags: ["x".repeat(25)] })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ tags: [""] })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ tags: ["prod", "eu"] })).success).toBe(true);
  });

  it("rejects sshUser with spaces or over 32 chars", () => {
    expect(serverCreateSchema.safeParse(base({ sshUser: "a b" })).success).toBe(false);
    expect(serverCreateSchema.safeParse(base({ sshUser: "u".repeat(33) })).success).toBe(false);
  });

  it("accepts linkedPanelUrl as http(s) URL or empty string", () => {
    expect(
      serverCreateSchema.safeParse(base({ linkedPanelUrl: "https://panel.example.com" })).success,
    ).toBe(true);
    expect(serverCreateSchema.safeParse(base({ linkedPanelUrl: "" })).success).toBe(true);
    expect(
      serverCreateSchema.safeParse(base({ linkedPanelUrl: "ftp://nope" })).success,
    ).toBe(false);
  });
});

describe("serverUpdateSchema", () => {
  it("accepts a fully empty patch", () => {
    expect(serverUpdateSchema.parse({})).toEqual({});
  });

  it("strips empty-string secret fields (keep existing)", () => {
    const out = serverUpdateSchema.parse({
      name: "renamed",
      sshPassword: "",
      sshPrivateKey: "",
      panelUser: "",
      panelPass: "",
    });
    expect(out).toEqual({ name: "renamed" });
    expect("sshPassword" in out).toBe(false);
  });

  it("keeps non-empty secrets", () => {
    const out = serverUpdateSchema.parse({ sshPassword: "newpass", panelUser: "admin" });
    expect(out.sshPassword).toBe("newpass");
    expect(out.panelUser).toBe("admin");
  });

  it("rejects both SSH secrets non-empty at once", () => {
    expect(
      serverUpdateSchema.safeParse({ sshPassword: "x", sshPrivateKey: PEM }).success,
    ).toBe(false);
  });

  it("still validates PEM shape for a non-empty sshPrivateKey", () => {
    expect(serverUpdateSchema.safeParse({ sshPrivateKey: "junk" }).success).toBe(false);
    expect(serverUpdateSchema.safeParse({ sshPrivateKey: PEM }).success).toBe(true);
  });

  it("validates port bounds on update too", () => {
    expect(serverUpdateSchema.safeParse({ sshPort: 70000 }).success).toBe(false);
  });
});
