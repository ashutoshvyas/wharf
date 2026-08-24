import { beforeEach, describe, expect, it, vi } from "vitest";

const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  withConnection: (...args: unknown[]) => withConnectionMock(...args),
}));

const findFirstMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({ open: () => "decrypted-pg-password" }));

const refreshPoolerMock = vi.fn();
vi.mock("@/lib/bootstrap/steps", () => ({
  refreshPooler: (...args: unknown[]) => refreshPoolerMock(...args),
}));

const registerPoolerTenantMock = vi.fn();
vi.mock("./pooler", () => ({
  registerPoolerTenant: (...args: unknown[]) => registerPoolerTenantMock(...args),
}));

import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { updateInstanceSslMode } from "./ssl-mode";

const CONN = { connected: true };
const ROW = {
  id: "inst-1",
  name: "Production",
  slug: "production",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  apiSubdomain: "production.example.com",
  studioSubdomain: "studio-production.example.com",
  sslMode: "disable" as const,
  status: "running",
  lastActionLog: null,
  healthCheckedAt: null,
  createdAt: new Date("2026-08-24T00:00:00Z"),
  updatedAt: new Date("2026-08-24T00:00:00Z"),
  deletedAt: null,
  pgPasswordEnc: Buffer.from("sealed"),
  server: { id: "srv-1", name: "db-01" },
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue({ ...ROW });
  updateMock.mockImplementation(async ({ data }: { data: { sslMode: "require" | "disable" } }) => ({
    ...ROW,
    ...data,
  }));
  withConnectionMock.mockImplementation(
    async (_serverId: string, fn: (conn: unknown) => Promise<unknown>) => fn(CONN),
  );
  refreshPoolerMock.mockResolvedValue(undefined);
  registerPoolerTenantMock.mockResolvedValue(undefined);
});

describe("updateInstanceSslMode", () => {
  it("enables TLS on the shared pooler before updating the tenant and database row", async () => {
    const result = await updateInstanceSslMode("inst-1", "require");

    expect(result).toMatchObject({ ok: true, instance: { sslMode: "require" } });
    expect(refreshPoolerMock).toHaveBeenCalledWith(CONN, expect.any(Function), "srv-1");
    expect(registerPoolerTenantMock).toHaveBeenCalledWith(CONN, {
      serverId: "srv-1",
      project: "sb_4f2a",
      pgPassword: "decrypted-pg-password",
      sslMode: "require",
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inst-1" }, data: { sslMode: "require" } }),
    );
    expect(refreshPoolerMock.mock.invocationCallOrder[0]).toBeLessThan(
      registerPoolerTenantMock.mock.invocationCallOrder[0]!,
    );
    expect(registerPoolerTenantMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateMock.mock.invocationCallOrder[0]!,
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("disables tenant enforcement without unnecessarily reconciling the TLS listener", async () => {
    findFirstMock.mockResolvedValue({ ...ROW, sslMode: "require" });

    const result = await updateInstanceSslMode("inst-1", "disable");

    expect(result).toMatchObject({ ok: true, instance: { sslMode: "disable" } });
    expect(refreshPoolerMock).not.toHaveBeenCalled();
    expect(registerPoolerTenantMock).toHaveBeenCalledWith(
      CONN,
      expect.objectContaining({ sslMode: "disable" }),
    );
  });

  it("is idempotent when the requested mode is already stored", async () => {
    const result = await updateInstanceSslMode("inst-1", "disable");

    expect(result).toMatchObject({ ok: true, instance: { sslMode: "disable" } });
    expect(withConnectionMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects instances that do not have a stored database password", async () => {
    findFirstMock.mockResolvedValue({ ...ROW, pgPasswordEnc: null });

    const result = await updateInstanceSslMode("inst-1", "require");

    expect(result).toEqual({
      invalid: expect.stringContaining("finish or retry provisioning"),
    });
    expect(withConnectionMock).not.toHaveBeenCalled();
  });

  it("returns the current lock holder without touching the server", async () => {
    const release = tryAcquireServerLock("srv-1", "restore")!;

    const result = await updateInstanceSslMode("inst-1", "require");

    expect(result).toEqual({ busy: "restore" });
    expect(withConnectionMock).not.toHaveBeenCalled();
    release();
  });

  it("does not persist when the pooler rejects the tenant update", async () => {
    registerPoolerTenantMock.mockRejectedValue(new Error("pooler unavailable"));

    await expect(updateInstanceSslMode("inst-1", "require")).rejects.toThrow(
      "pooler unavailable",
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("rolls the tenant back when database persistence fails", async () => {
    updateMock.mockRejectedValue(new Error("database unavailable"));

    await expect(updateInstanceSslMode("inst-1", "require")).rejects.toThrow(
      "database unavailable",
    );
    expect(registerPoolerTenantMock).toHaveBeenCalledTimes(2);
    expect(registerPoolerTenantMock).toHaveBeenLastCalledWith(
      CONN,
      expect.objectContaining({ sslMode: "disable" }),
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });
});
