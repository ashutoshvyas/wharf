/**
 * Route-level tests for the Users API: RBAC gates, the invite
 * sentinel written on create/reset, the three lockout guards (self-delete,
 * self-role, last admin) counted inside a transaction, and the public
 * set-password redemption (expiry, single use, generic failure).
 *
 * lib/auth and lib/db are mocked (same style as lib/servers/routes.test.ts);
 * bcryptjs is real, because the point of several assertions is that a real
 * bcrypt hash replaces the sentinel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    panelUser: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  INVITE_PREFIX,
  createInvite,
  encodeInvite,
  hashInviteToken,
} from "@/lib/users/invite";
import { GET as listUsers, POST as createUserRoute } from "@/app/api/users/route";
import {
  DELETE as deleteUserRoute,
  PATCH as patchUserRoute,
} from "@/app/api/users/[id]/route";
import { POST as resetRoute } from "@/app/api/users/[id]/reset/route";
import { POST as setPasswordRoute } from "@/app/api/users/set-password/route";

const mockAuth = vi.mocked(auth);
const db = vi.mocked(prisma, true);

type Role = "admin" | "operator" | "viewer";

function asRole(role: Role | null, id = "usr-me") {
  const session = role
    ? {
        user: { id, email: `${role}@example.com`, role },
        expires: new Date(Date.now() + 3600_000).toISOString(),
      }
    : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockAuth.mockResolvedValue(session as any);
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: "usr-other",
    email: "ada@example.com",
    passwordHash: "$2b$12$realbcrypthashvaluegoeshereandisnotasentinel",
    role: "operator" as Role,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function jsonReq(method: string, body?: unknown) {
  return new Request("http://test/api/users", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "usr-other" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PANEL_URL = "https://panel.wharf.example.com";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.auditLog.create.mockResolvedValue({} as any);
  // Run transaction callbacks against the same mocked client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.$transaction.mockImplementation(((fn: any) => fn(db)) as any);
});

describe("GET /api/users", () => {
  it("returns serialized rows for an admin, ordered by email", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findMany.mockResolvedValue([userRow()] as any);

    const res = await listUsers();
    expect(res.status).toBe(200);
    expect(db.panelUser.findMany).toHaveBeenCalledWith({
      orderBy: { email: "asc" },
    });

    const body = await res.json();
    expect(body[0].email).toBe("ada@example.com");
    expect(JSON.stringify(body)).not.toContain("$2b$12$");
    expect(body[0]).not.toHaveProperty("passwordHash");
  });

  it("refuses operators, viewers and anonymous callers", async () => {
    for (const role of ["operator", "viewer", null] as const) {
      asRole(role);
      expect((await listUsers()).status).toBe(403);
    }
  });
});

describe("POST /api/users", () => {
  it("stores an invite sentinel, never a password, and returns the link once", async () => {
    asRole("admin");
    db.panelUser.findUnique.mockResolvedValue(null);
    db.panelUser.create.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async ({ data }: any) => userRow({ ...data, id: "usr-new" })) as any,
    );

    const res = await createUserRoute(
      jsonReq("POST", { email: " Ada@example.com ", role: "operator" }),
    );
    expect(res.status).toBe(201);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (db.panelUser.create.mock.calls[0] as any)[0].data;
    expect(created.email).toBe("ada@example.com");
    expect(created.role).toBe("operator");
    expect(created.passwordHash.startsWith(INVITE_PREFIX)).toBe(true);

    const body = await res.json();
    expect(body.inviteUrl).toMatch(
      /^https:\/\/panel\.wharf\.dev\/invite\/[A-Za-z0-9_-]{43}$/,
    );
    expect(body).not.toHaveProperty("passwordHash");
    // The URL carries the RAW token; the DB only ever saw its digest.
    const token = body.inviteUrl.split("/invite/")[1];
    expect(created.passwordHash).toContain(hashInviteToken(token));
    expect(created.passwordHash).not.toContain(token);

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.create" }),
      }),
    );
  });

  it("409s on a duplicate email", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow() as any);

    const res = await createUserRoute(
      jsonReq("POST", { email: "ada@example.com", role: "viewer" }),
    );
    expect(res.status).toBe(409);
    expect(db.panelUser.create).not.toHaveBeenCalled();
  });

  it("400s on an invalid role or email", async () => {
    asRole("admin");
    db.panelUser.findUnique.mockResolvedValue(null);
    expect(
      (await createUserRoute(jsonReq("POST", { email: "a@b.co", role: "root" })))
        .status,
    ).toBe(400);
    expect(
      (await createUserRoute(jsonReq("POST", { email: "nope", role: "admin" })))
        .status,
    ).toBe(400);
  });

  it("refuses non-admins", async () => {
    asRole("operator");
    const res = await createUserRoute(
      jsonReq("POST", { email: "a@b.co", role: "viewer" }),
    );
    expect(res.status).toBe(403);
    expect(db.panelUser.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/users/:id — role guards", () => {
  it("changes another user's role and audits it", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow() as any);
    db.panelUser.count.mockResolvedValue(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.update.mockResolvedValue(userRow({ role: "admin" }) as any);

    const res = await patchUserRoute(jsonReq("PATCH", { role: "admin" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe("admin");
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.update" }),
      }),
    );
  });

  it("409s when changing your OWN role", async () => {
    asRole("admin", "usr-me");
    db.panelUser.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ id: "usr-me", role: "admin" }) as any,
    );
    db.panelUser.count.mockResolvedValue(5);

    const res = await patchUserRoute(jsonReq("PATCH", { role: "viewer" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/own role/i);
    expect(db.panelUser.update).not.toHaveBeenCalled();
  });

  it("409s when demoting the LAST admin", async () => {
    asRole("admin", "usr-me");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow({ role: "admin" }) as any);
    db.panelUser.count.mockResolvedValue(1);

    const res = await patchUserRoute(jsonReq("PATCH", { role: "viewer" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/last admin/i);
    expect(db.panelUser.update).not.toHaveBeenCalled();
  });

  it("counts admins inside the same SERIALIZABLE transaction as the write", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow({ role: "admin" }) as any);
    db.panelUser.count.mockResolvedValue(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.update.mockResolvedValue(userRow({ role: "viewer" }) as any);

    await patchUserRoute(jsonReq("PATCH", { role: "viewer" }), ctx);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.panelUser.count).toHaveBeenCalledWith({ where: { role: "admin" } });
    // Read Committed would let two concurrent demotions both see "2 admins".
    expect(db.$transaction.mock.calls[0]![1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it("maps a serialization failure (P2034) to a retryable 409, not a 500", async () => {
    asRole("admin");
    db.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "6.0.0",
      }),
    );

    const res = await patchUserRoute(jsonReq("PATCH", { role: "viewer" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/same moment/i);
  });

  it("404s for an unknown id", async () => {
    asRole("admin");
    db.panelUser.findUnique.mockResolvedValue(null);
    db.panelUser.count.mockResolvedValue(2);
    const res = await patchUserRoute(jsonReq("PATCH", { role: "viewer" }), ctx);
    expect(res.status).toBe(404);
  });

  it("refuses non-admins", async () => {
    asRole("viewer");
    expect(
      (await patchUserRoute(jsonReq("PATCH", { role: "admin" }), ctx)).status,
    ).toBe(403);
  });
});

describe("DELETE /api/users/:id — removal guards", () => {
  it("removes another user and audits it", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow() as any);
    db.panelUser.count.mockResolvedValue(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.delete.mockResolvedValue(userRow() as any);

    const res = await deleteUserRoute(jsonReq("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(db.panelUser.delete).toHaveBeenCalledWith({
      where: { id: "usr-other" },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.delete" }),
      }),
    );
  });

  it("409s when deleting YOURSELF", async () => {
    asRole("admin", "usr-me");
    db.panelUser.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ id: "usr-me", role: "admin" }) as any,
    );
    db.panelUser.count.mockResolvedValue(4);

    const res = await deleteUserRoute(jsonReq("DELETE"), {
      params: Promise.resolve({ id: "usr-me" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/own account/i);
    expect(db.panelUser.delete).not.toHaveBeenCalled();
  });

  it("409s when deleting the LAST admin", async () => {
    asRole("admin", "usr-me");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow({ role: "admin" }) as any);
    db.panelUser.count.mockResolvedValue(1);

    const res = await deleteUserRoute(jsonReq("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/last admin/i);
    expect(db.panelUser.delete).not.toHaveBeenCalled();
    expect(db.$transaction.mock.calls[0]![1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it("refuses non-admins", async () => {
    asRole("operator");
    expect((await deleteUserRoute(jsonReq("DELETE"), ctx)).status).toBe(403);
  });
});

describe("POST /api/users/:id/reset", () => {
  it("replaces the credential with a fresh sentinel and returns the link", async () => {
    asRole("admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.findUnique.mockResolvedValue(userRow() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.update.mockResolvedValue(userRow() as any);

    const res = await resetRoute(jsonReq("POST"), ctx);
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const written = (db.panelUser.update.mock.calls[0] as any)[0].data;
    expect(written.passwordHash.startsWith(INVITE_PREFIX)).toBe(true);

    const { inviteUrl } = await res.json();
    const token = inviteUrl.split("/invite/")[1];
    expect(written.passwordHash).toContain(hashInviteToken(token));
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.reset" }),
      }),
    );
  });

  it("404s for an unknown id and refuses non-admins", async () => {
    asRole("admin");
    db.panelUser.findUnique.mockResolvedValue(null);
    expect((await resetRoute(jsonReq("POST"), ctx)).status).toBe(404);

    asRole("viewer");
    expect((await resetRoute(jsonReq("POST"), ctx)).status).toBe(403);
  });
});

describe("POST /api/users/set-password (public)", () => {
  const PASSWORD = "correct horse battery staple";

  it("redeems a live invite without any session and writes a real bcrypt hash", async () => {
    asRole(null);
    const invite = createInvite();
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: invite.passwordHash }) as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.updateMany.mockResolvedValue({ count: 1 } as any);

    const res = await setPasswordRoute(
      jsonReq("POST", { token: invite.token, password: PASSWORD }),
    );
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (db.panelUser.updateMany.mock.calls[0] as any)[0];
    // Compare-and-swap on the exact sentinel keeps redemption single-use.
    expect(call.where).toEqual({
      id: "usr-other",
      passwordHash: invite.passwordHash,
    });
    expect(call.data.passwordHash.startsWith("$2")).toBe(true);
    await expect(bcrypt.compare(PASSWORD, call.data.passwordHash)).resolves.toBe(
      true,
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "user.password_set" }),
      }),
    );
  });

  it("refuses an EXPIRED invite with the generic message", async () => {
    asRole(null);
    const stale = createInvite(Date.now() - 49 * 60 * 60 * 1000);
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: stale.passwordHash }) as any,
    ]);

    const res = await setPasswordRoute(
      jsonReq("POST", { token: stale.token, password: PASSWORD }),
    );
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/invalid, already used, or has expired/i);
    // Never names the account or says which check failed.
    expect(error).not.toContain("ada@example.com");
    expect(db.panelUser.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an unknown token with the SAME message as an expired one", async () => {
    asRole(null);
    const invite = createInvite();
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: invite.passwordHash }) as any,
    ]);

    const unknown = await setPasswordRoute(
      jsonReq("POST", { token: "not-a-real-token", password: PASSWORD }),
    );
    const expiredCopy = createInvite(Date.now() - 49 * 60 * 60 * 1000);
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: expiredCopy.passwordHash }) as any,
    ]);
    const expired = await setPasswordRoute(
      jsonReq("POST", { token: expiredCopy.token, password: PASSWORD }),
    );

    expect(unknown.status).toBe(400);
    expect(expired.status).toBe(400);
    expect((await unknown.json()).error).toBe((await expired.json()).error);
  });

  it("is single-use: a lost compare-and-swap fails generically", async () => {
    asRole(null);
    const invite = createInvite();
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: invite.passwordHash }) as any,
    ]);
    // Another request redeemed it between the read and the write.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.updateMany.mockResolvedValue({ count: 0 } as any);

    const res = await setPasswordRoute(
      jsonReq("POST", { token: invite.token, password: PASSWORD }),
    );
    expect(res.status).toBe(400);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("only ever scans rows that hold an invite sentinel", async () => {
    asRole(null);
    db.panelUser.findMany.mockResolvedValue([]);
    await setPasswordRoute(jsonReq("POST", { token: "x", password: PASSWORD }));
    expect(db.panelUser.findMany).toHaveBeenCalledWith({
      where: { passwordHash: { startsWith: INVITE_PREFIX } },
    });
  });

  it("ignores a malformed sentinel instead of matching it", async () => {
    asRole(null);
    const token = "token-abc";
    db.panelUser.findMany.mockResolvedValue([
      // Digest present but expiry corrupted → not a live invite.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: `invite$${hashInviteToken(token)}$oops` }) as any,
    ]);

    const res = await setPasswordRoute(jsonReq("POST", { token, password: PASSWORD }));
    expect(res.status).toBe(400);
    expect(db.panelUser.updateMany).not.toHaveBeenCalled();
  });

  it("400s a password shorter than 12 characters", async () => {
    asRole(null);
    const invite = createInvite();
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ passwordHash: invite.passwordHash }) as any,
    ]);

    const res = await setPasswordRoute(
      jsonReq("POST", { token: invite.token, password: "short" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 12/);
    expect(db.panelUser.updateMany).not.toHaveBeenCalled();
  });

  it("picks the right row when several invites are outstanding", async () => {
    asRole(null);
    const other = createInvite();
    const mine = createInvite();
    db.panelUser.findMany.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ id: "usr-a", passwordHash: other.passwordHash }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userRow({ id: "usr-b", passwordHash: mine.passwordHash }) as any,
      userRow({
        id: "usr-c",
        passwordHash: encodeInvite("f".repeat(64), Date.now() + 1000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.panelUser.updateMany.mockResolvedValue({ count: 1 } as any);

    const res = await setPasswordRoute(
      jsonReq("POST", { token: mine.token, password: PASSWORD }),
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db.panelUser.updateMany.mock.calls[0] as any)[0].where.id).toBe(
      "usr-b",
    );
  });
});
