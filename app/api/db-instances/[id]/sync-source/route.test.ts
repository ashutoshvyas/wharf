/**
 * PUT /api/db-instances/:id/sync-source.
 *
 * The regression these pin: `upsert` builds BOTH its `create` and `update`
 * objects eagerly in JS, so a seal call written into the `create` branch also
 * runs when the row already exists. Re-saving a stored source with the
 * password left blank (the documented "keep the stored value" convention)
 * therefore called sealBytes(undefined) and 500'd with ERR_INVALID_ARG_TYPE.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for @/lib/api-helpers — the real module imports @/lib/auth
// (next-auth → "next/server"), which does not resolve under vitest's plain
// Node module resolution. Same approach as the email-template route test.
vi.mock("@/lib/api-helpers", () => ({
  apiError: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  requireApiRole: () =>
    Promise.resolve({ session: { user: { id: "u1", email: "a@b.c" } }, role: "admin" }),
  withErrorHandling:
    <A extends unknown[]>(handler: (...a: A) => Promise<Response> | Response) =>
    (...a: A) =>
      handler(...a),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json" },
      }),
  },
}));

const instanceFindFirst = vi.fn();
const sourceFindUnique = vi.fn();
const sourceUpsert = vi.fn();
const sourceUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: { findFirst: (...a: unknown[]) => instanceFindFirst(...a) },
    instanceSyncSource: {
      findUnique: (...a: unknown[]) => sourceFindUnique(...a),
      upsert: (...a: unknown[]) => sourceUpsert(...a),
      update: (...a: unknown[]) => sourceUpdate(...a),
    },
  },
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

/** Faithful to the real thing in the one way that matters: it rejects undefined. */
const sealBytesMock = vi.fn((plaintext: string) => {
  if (typeof plaintext !== "string") {
    throw new TypeError(
      'The "data" argument must be of type string or an instance of Buffer, ' +
        `TypedArray, or DataView. Received ${typeof plaintext}`,
    );
  }
  return new Uint8Array(Buffer.from(`sealed:${plaintext}`));
});
vi.mock("@/lib/servers/seal-bytes", () => ({
  sealBytes: (p: string) => sealBytesMock(p),
}));

import { PUT } from "./route";

const STORED = {
  id: "src-1",
  dbInstanceId: "inst-1",
  kind: "supabase",
  label: null,
  pgHost: "aws-1-ap-south-1.pooler.supabase.com",
  pgPort: 5432,
  pgDatabase: "postgres",
  pgUser: "postgres.abcdefghijklm",
  pgPasswordEnc: new Uint8Array([1, 2, 3]),
  pgSslMode: "require",
  projectUrl: "https://abcdefghijklm.supabase.co",
  serviceRoleKeyEnc: new Uint8Array([4, 5, 6]),
  includeAuthUsers: true,
  includeStorageObjects: false,
  extraSchemas: [] as string[],
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastSyncSummary: null,
  createdAt: new Date("2026-07-27T10:00:00.000Z"),
  updatedAt: new Date("2026-07-27T10:00:00.000Z"),
};

const BODY = {
  kind: "supabase",
  pgHost: "aws-1-ap-south-1.pooler.supabase.com",
  pgPort: 5432,
  pgDatabase: "postgres",
  pgUser: "postgres.abcdefghijklm",
  pgSslMode: "require",
  includeAuthUsers: true,
  includeStorageObjects: false,
  extraSchemas: [] as string[],
};

function put(body: Record<string, unknown>) {
  return PUT(
    new Request("https://panel.wharf.example.com/api/db-instances/inst-1/sync-source", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "inst-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  instanceFindFirst.mockResolvedValue({ id: "inst-1" });
  sourceFindUnique.mockResolvedValue(null);
  sourceUpsert.mockResolvedValue({ ...STORED });
  sourceUpdate.mockResolvedValue({ ...STORED });
});

describe("PUT /api/db-instances/:id/sync-source", () => {
  it("re-saves an existing source with no new password, without sealing undefined", async () => {
    sourceFindUnique.mockResolvedValue({ ...STORED });

    const res = await put(BODY);

    expect(res.status).toBe(200);
    // The regression: sealBytes must never be handed an absent secret.
    for (const call of sealBytesMock.mock.calls) {
      expect(typeof call[0]).toBe("string");
    }
    // Nothing to create, so it must not go through upsert's eager create branch.
    expect(sourceUpsert).not.toHaveBeenCalled();
    expect(sourceUpdate).toHaveBeenCalledTimes(1);
    const data = sourceUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect("pgPasswordEnc" in data).toBe(false);
    expect("serviceRoleKeyEnc" in data).toBe(false);
  });

  it("creates a source when one supplies a password", async () => {
    const res = await put({ ...BODY, pgPassword: "hunter2" });

    expect(res.status).toBe(200);
    expect(sourceUpsert).toHaveBeenCalledTimes(1);
    const args = sourceUpsert.mock.calls[0]![0];
    expect(args.create.pgPasswordEnc).toBeInstanceOf(Uint8Array);
    expect(args.update.pgPasswordEnc).toBeInstanceOf(Uint8Array);
    expect(sealBytesMock).toHaveBeenCalledWith("hunter2");
  });

  it("replaces a stored password when a new one is supplied", async () => {
    sourceFindUnique.mockResolvedValue({ ...STORED });

    await put({ ...BODY, pgPassword: "rotated" });

    expect(sourceUpsert).toHaveBeenCalledTimes(1);
    expect(sealBytesMock).toHaveBeenCalledWith("rotated");
  });

  it("refuses to create a source with no password at all", async () => {
    const res = await put(BODY);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("pgPassword is required"),
    });
    expect(sourceUpsert).not.toHaveBeenCalled();
    expect(sourceUpdate).not.toHaveBeenCalled();
    expect(sealBytesMock).not.toHaveBeenCalled();
  });

  it("never echoes a secret back on the response", async () => {
    sourceFindUnique.mockResolvedValue({ ...STORED });
    const res = await put(BODY);
    const text = await res.text();

    expect(text).not.toMatch(/Enc"/);
    expect(text).toContain('"pgPasswordConfigured":true');
    expect(text).toContain('"serviceRoleKeyConfigured":true');
  });

  it("404s for an unknown instance before touching the source row", async () => {
    instanceFindFirst.mockResolvedValue(null);
    const res = await put(BODY);

    expect(res.status).toBe(404);
    expect(sourceFindUnique).not.toHaveBeenCalled();
  });
});
