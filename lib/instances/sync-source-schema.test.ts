import { describe, expect, it } from "vitest";
import { startSyncSchema, syncSourceSchema } from "./sync-source-schema";

const VALID = {
  kind: "supabase" as const,
  pgHost: "db.abcdefghijklm.supabase.co",
  pgPort: 5432,
  pgDatabase: "postgres",
  pgUser: "postgres.abcdefghijklm",
  pgPassword: "hunter2",
  pgSslMode: "require" as const,
  includeAuthUsers: true,
  includeStorageObjects: false,
  extraSchemas: [] as string[],
};

describe("syncSourceSchema — defaults", () => {
  it("fills in the connection defaults from a minimal body", () => {
    const parsed = syncSourceSchema.parse({ pgHost: "db.internal", pgUser: "postgres" });
    expect(parsed).toMatchObject({
      kind: "supabase",
      pgPort: 5432,
      pgDatabase: "postgres",
      pgSslMode: "require",
      includeAuthUsers: true,
      includeStorageObjects: false,
      extraSchemas: [],
    });
  });
});

describe("syncSourceSchema — secrets", () => {
  it("strips an empty password so the stored one is kept", () => {
    const parsed = syncSourceSchema.parse({ ...VALID, pgPassword: "" });
    expect("pgPassword" in parsed).toBe(false);
  });

  it("strips an empty serviceRoleKey the same way", () => {
    const parsed = syncSourceSchema.parse({ ...VALID, serviceRoleKey: "" });
    expect("serviceRoleKey" in parsed).toBe(false);
  });

  it("keeps a supplied secret", () => {
    const parsed = syncSourceSchema.parse({ ...VALID, serviceRoleKey: "eyJhbGciOi" });
    expect(parsed.serviceRoleKey).toBe("eyJhbGciOi");
  });
});

describe("syncSourceSchema — connection charset", () => {
  it.each([
    ["a shell metacharacter", "db.example.com; rm -rf /"],
    ["a subshell", "$(hostname)"],
    ["a quote", "db'example"],
    ["a newline", "db.example.com\nHOST=evil"],
    ["a space", "db example"],
  ])("rejects a host containing %s", (_label, pgHost) => {
    expect(() => syncSourceSchema.parse({ ...VALID, pgHost })).toThrow();
  });

  it("rejects a user or database with shell metacharacters", () => {
    expect(() => syncSourceSchema.parse({ ...VALID, pgUser: "post;gres" })).toThrow();
    expect(() => syncSourceSchema.parse({ ...VALID, pgDatabase: "post gres" })).toThrow();
  });

  it("accepts Supabase's dotted pooler role and a hyphenated host", () => {
    const parsed = syncSourceSchema.parse({
      ...VALID,
      pgHost: "aws-0-eu-west-2.pooler.supabase.com",
      pgUser: "postgres.abcdefghijklm",
      pgPort: 6543,
    });
    expect(parsed.pgHost).toBe("aws-0-eu-west-2.pooler.supabase.com");
    expect(parsed.pgPort).toBe(6543);
  });

  it("rejects a port outside 1–65535", () => {
    expect(() => syncSourceSchema.parse({ ...VALID, pgPort: 0 })).toThrow();
    expect(() => syncSourceSchema.parse({ ...VALID, pgPort: 70_000 })).toThrow();
  });

  it("rejects an sslmode libpq does not define", () => {
    expect(() => syncSourceSchema.parse({ ...VALID, pgSslMode: "sometimes" })).toThrow();
  });
});

describe("syncSourceSchema — storage objects", () => {
  it("requires a project URL when copying storage objects", () => {
    expect(() =>
      syncSourceSchema.parse({ ...VALID, includeStorageObjects: true }),
    ).toThrow(/projectUrl is required/);
  });

  it("rejects a non-https project URL — the key travels on it", () => {
    expect(() =>
      syncSourceSchema.parse({
        ...VALID,
        includeStorageObjects: true,
        projectUrl: "http://abcdefghijklm.supabase.co",
      }),
    ).toThrow(/https/);
  });

  it("accepts an https project URL", () => {
    const parsed = syncSourceSchema.parse({
      ...VALID,
      includeStorageObjects: true,
      projectUrl: "https://abcdefghijklm.supabase.co",
      serviceRoleKey: "eyJhbGciOi",
    });
    expect(parsed.projectUrl).toBe("https://abcdefghijklm.supabase.co");
  });
});

describe("syncSourceSchema — extra schemas", () => {
  it("rejects 'public', which is always copied anyway", () => {
    expect(() =>
      syncSourceSchema.parse({ ...VALID, extraSchemas: ["public"] }),
    ).toThrow(/always included/);
  });

  it.each(["auth", "storage"])("rejects '%s' — this instance owns that schema", (schema) => {
    expect(() =>
      syncSourceSchema.parse({ ...VALID, extraSchemas: [schema] }),
    ).toThrow(/cannot be an extra schema/);
  });

  it("rejects a schema name with shell metacharacters", () => {
    expect(() =>
      syncSourceSchema.parse({ ...VALID, extraSchemas: ["billing; drop"] }),
    ).toThrow();
  });

  it("accepts plain identifiers", () => {
    const parsed = syncSourceSchema.parse({ ...VALID, extraSchemas: ["analytics", "billing"] });
    expect(parsed.extraSchemas).toEqual(["analytics", "billing"]);
  });
});

describe("startSyncSchema", () => {
  it("requires a non-empty confirmName", () => {
    expect(() => startSyncSchema.parse({})).toThrow();
    expect(() => startSyncSchema.parse({ confirmName: "" })).toThrow();
    expect(startSyncSchema.parse({ confirmName: "clienta-prod" })).toEqual({
      confirmName: "clienta-prod",
    });
  });
});
