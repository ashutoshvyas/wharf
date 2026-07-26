import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  sftpWrite: (...a: unknown[]) => sftpWriteMock(...a),
  withConnection: (...a: unknown[]) => withConnectionMock(...a),
}));

const instanceFindFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: { findFirst: (...a: unknown[]) => instanceFindFirst(...a) },
  },
}));

vi.mock("@/lib/crypto", () => ({ open: () => "decrypted-value" }));

const renderMock = vi.fn();
vi.mock("./render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render")>();
  return {
    ...actual,
    renderInstanceCompose: (...a: unknown[]) => renderMock(...a),
  };
});

import { applyAnalyticsSettings } from "./analytics-settings";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const ROW = {
  id: "inst-1",
  serverId: "srv-1",
  slug: "clienta",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  pgPasswordEnc: Buffer.from("sealed-pg"),
  jwtSecretEnc: Buffer.from("sealed-jwt"),
  anonKeyEnc: Buffer.from("sealed-anon"),
  serviceRoleKeyEnc: Buffer.from("sealed-sr"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSTANCE_DOMAIN = "wharf.example.com";
  instanceFindFirst.mockResolvedValue({ ...ROW });
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  execMock.mockResolvedValue(ok());
  sftpWriteMock.mockResolvedValue(undefined);
  renderMock.mockResolvedValue({
    composeYaml: "rendered-compose",
    envFile: "rendered-env",
  });
});

describe("applyAnalyticsSettings", () => {
  it("refuses an instance with no stored secrets", async () => {
    instanceFindFirst.mockResolvedValue({ ...ROW, pgPasswordEnc: null });
    await expect(applyAnalyticsSettings("inst-1", true)).rejects.toThrow(/no stored secrets/);
    expect(withConnectionMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown instance", async () => {
    instanceFindFirst.mockResolvedValue(null);
    await expect(applyAnalyticsSettings("inst-1", true)).rejects.toThrow(/was not found/);
  });

  it("returns the lock holder instead of applying concurrently", async () => {
    const release = tryAcquireServerLock("srv-1", "provision")!;
    const res = await applyAnalyticsSettings("inst-1", true);
    expect(res).toEqual({ busy: "provision" });
    expect(renderMock).not.toHaveBeenCalled();
    release();
  });

  it("enabling: renders with enabled=true, uploads both files, runs a bare `up -d`, and never stops the analytics services", async () => {
    const res = await applyAnalyticsSettings("inst-1", true);
    expect(res).toEqual({ ok: true });

    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "clienta",
        project: "sb_4f2a",
        remotePath: "/opt/db-instances/sb_4f2a",
        analyticsSettings: { enabled: true },
      }),
    );

    const uploadedPaths = sftpWriteMock.mock.calls.map((c) => c[1] as string);
    expect(uploadedPaths).toContain("/opt/db-instances/sb_4f2a/docker-compose.yml");
    expect(uploadedPaths).toContain("/opt/db-instances/sb_4f2a/.env");

    const commands = execMock.mock.calls.map((c) => String(c[1]));
    const upCall = commands.find((c) => c.includes("docker compose") && c.includes("up -d"));
    expect(upCall).toBe("cd /opt/db-instances/sb_4f2a && docker compose -p sb_4f2a up -d");
    // Bare `up -d`, not scoped to specific services — Compose's own config
    // diffing recreates storage and starts the newly-profiled services.
    expect(upCall).not.toMatch(/\bstop\b|\bminio\b|\blakekeeper\b/);
    expect(commands.some((c) => c.includes("stop"))).toBe(false);

    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("disabling: runs the bare `up -d`, then stops the 4 analytics-profile services by name", async () => {
    const res = await applyAnalyticsSettings("inst-1", false);
    expect(res).toEqual({ ok: true });

    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({ analyticsSettings: { enabled: false } }),
    );

    const commands = execMock.mock.calls.map((c) => String(c[1]));
    const stopCall = commands.find((c) => c.includes("stop"));
    expect(stopCall).toBe(
      "docker compose -p sb_4f2a stop minio minio-init lakekeeper lakekeeper-init",
    );
    // Stop, never remove/down — matches "Stop keeps data volumes intact".
    expect(commands.some((c) => c.includes("down"))).toBe(false);
  });

  it("releases the lock and propagates the error when the up -d fails", async () => {
    execMock.mockResolvedValue(fail("connection refused"));
    await expect(applyAnalyticsSettings("inst-1", true)).rejects.toThrow(
      /docker compose up -d failed/,
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("releases the lock and propagates the error when the disabling stop fails", async () => {
    execMock.mockImplementation(async (_conn: unknown, cmd: string) =>
      cmd.includes("stop") ? fail("still in use") : ok(),
    );
    await expect(applyAnalyticsSettings("inst-1", false)).rejects.toThrow(
      /docker compose stop \(analytics services\) failed/,
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });
});
