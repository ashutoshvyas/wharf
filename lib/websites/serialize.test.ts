import { describe, expect, it } from "vitest";
import { serializeWebsite, type WebsiteRecord } from "./serialize";

function record(overrides: Partial<WebsiteRecord> = {}): WebsiteRecord {
  return {
    id: "web-1",
    domain: "clienta.com",
    serverId: "srv-1",
    path: "/var/www/clienta",
    dbInstanceId: null,
    credentialLabel: "WP admin",
    accessPasswordEnc: Buffer.from("iv+ciphertext+tag"),
    notes: "WordPress 6.5",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-02-03T04:05:06.000Z"),
    ...overrides,
  };
}

describe("serializeWebsite", () => {
  it("emits exactly the allowlisted keys (no relations included)", () => {
    const out = serializeWebsite(record());
    expect(Object.keys(out).sort()).toEqual(
      [
        "createdAt",
        "credentialLabel",
        "dbInstanceId",
        "domain",
        "hasCredential",
        "id",
        "notes",
        "path",
        "serverId",
        "updatedAt",
      ].sort(),
    );
  });

  it("never leaks the encrypted password or the username", () => {
    const out = serializeWebsite(
      record({
        server: { id: "srv-1", name: "vps-01", host: "192.0.2.10" },
        dbInstance: { id: "db-1", name: "clienta-prod", slug: "clienta", status: "running" },
      }),
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain("accessPasswordEnc");
    expect(json).not.toContain("accessUsername");
    expect(json).not.toContain("iv+ciphertext+tag");
    // The serialized object also carries no Buffer/Uint8Array values at all.
    for (const value of Object.values(out)) {
      expect(value instanceof Uint8Array).toBe(false);
    }
  });

  it("derives hasCredential from accessPasswordEnc", () => {
    expect(serializeWebsite(record()).hasCredential).toBe(true);
    expect(
      serializeWebsite(record({ accessPasswordEnc: null })).hasCredential,
    ).toBe(false);
    expect(
      serializeWebsite(record({ accessPasswordEnc: Buffer.alloc(0) })).hasCredential,
    ).toBe(false);
  });

  it("serializes dates as ISO strings", () => {
    const out = serializeWebsite(record());
    expect(out.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(out.updatedAt).toBe("2026-02-03T04:05:06.000Z");
  });

  it("embeds server and dbInstance refs when the relations are included", () => {
    const out = serializeWebsite(
      record({
        dbInstanceId: "db-1",
        server: { id: "srv-1", name: "vps-01", host: "192.0.2.10" },
        dbInstance: {
          id: "db-1",
          name: "clienta-prod",
          slug: "clienta",
          status: "running",
        },
      }),
    );
    expect(out.server).toEqual({ id: "srv-1", name: "vps-01", host: "192.0.2.10" });
    expect(out.dbInstance).toEqual({
      id: "db-1",
      name: "clienta-prod",
      slug: "clienta",
      status: "running",
    });
  });

  it("embeds dbInstance as null when included but not linked", () => {
    const out = serializeWebsite(record({ dbInstance: null }));
    expect(out.dbInstance).toBeNull();
    expect("dbInstance" in out).toBe(true);
  });

  it("omits relation keys entirely when not included", () => {
    const out = serializeWebsite(record());
    expect("server" in out).toBe(false);
    expect("dbInstance" in out).toBe(false);
  });

  it("strips extra fields from embedded relation objects", () => {
    const out = serializeWebsite(
      record({
        server: {
          id: "srv-1",
          name: "vps-01",
          host: "192.0.2.10",
          sshPasswordEnc: Buffer.from("secret"),
        } as unknown as WebsiteRecord["server"],
      }),
    );
    expect(Object.keys(out.server!).sort()).toEqual(["host", "id", "name"]);
  });
});
