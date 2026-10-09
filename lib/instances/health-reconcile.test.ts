import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  withConnection: (...a: unknown[]) => withConnectionMock(...a),
}));

const findManyMock = vi.fn();
const updateManyMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      updateMany: (...a: unknown[]) => updateManyMock(...a),
    },
  },
}));

const auditMock = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

vi.mock("@/lib/provision/render", () => ({
  instanceServices: async () => ({ core: ["db", "kong"], optional: [] }),
}));

import { tryAcquireServerLock } from "@/lib/jobs/lock";
import { __resetHealthState, runHealthCheck } from "./health-reconcile";

const UPDATED = new Date("2026-10-09T09:00:00.000Z");
const row = (patch: Record<string, unknown> = {}) => ({
  id: "inst-1",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  status: "running",
  lastActionLog: null,
  updatedAt: UPDATED,
  ...patch,
});
const ps = (...lines: string[]) => ({ code: 0, stdout: lines.join("\n") + "\n", stderr: "" });
const UP = ps("sb_4f2a\tdb\trunning\tUp 1 hour (healthy)", "sb_4f2a\tkong\trunning\tUp 1 hour (healthy)");
const DOWN = ps("sb_4f2a\tdb\texited\tExited (0) 1 minute ago", "sb_4f2a\tkong\texited\tExited (0) 1 minute ago");

const statusWrites = () =>
  updateManyMock.mock.calls
    .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
    .filter((c) => "status" in c.data);

beforeEach(() => {
  vi.clearAllMocks();
  __resetHealthState();
  withConnectionMock.mockImplementation(async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({}));
  updateManyMock.mockResolvedValue({ count: 1 });
  auditMock.mockResolvedValue(undefined);
});

describe("runHealthCheck", () => {
  it("marks a running instance stopped once two passes confirm its containers were stopped by hand", async () => {
    findManyMock.mockResolvedValue([row()]);
    execMock.mockResolvedValue(DOWN);

    await runHealthCheck();
    expect(statusWrites()).toHaveLength(0);

    await runHealthCheck(new Date("2026-10-09T10:00:00.000Z"));
    expect(statusWrites()).toEqual([
      {
        where: { id: "inst-1", status: "running", updatedAt: UPDATED },
        data: { status: "stopped", lastActionLog: "Health check at 2026-10-09T10:00:00.000Z: all 2 containers are stopped" },
      },
    ]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "instance.health.status-change",
      metadata: expect.objectContaining({ from: "running", to: "stopped" }),
    }));
  });

  it("does not flip on a single odd observation", async () => {
    findManyMock.mockResolvedValue([row()]);
    execMock.mockResolvedValueOnce(DOWN).mockResolvedValueOnce(UP).mockResolvedValueOnce(DOWN);
    await runHealthCheck();
    await runHealthCheck();
    await runHealthCheck();
    expect(statusWrites()).toHaveLength(0);
  });

  it("marks running instances error when the server cannot be reached, leaving stopped ones alone", async () => {
    findManyMock.mockResolvedValue([row(), row({ id: "inst-2", composeProjectName: "sb_0b1c", status: "stopped" })]);
    withConnectionMock.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await runHealthCheck();
    await runHealthCheck();
    expect(statusWrites()).toHaveLength(1);
    expect(statusWrites()[0]).toMatchObject({
      where: { id: "inst-1" },
      data: { status: "error", lastActionLog: expect.stringContaining("server unreachable — connect ETIMEDOUT") },
    });
  });

  it("recovers its own error once the stack is healthy again, and records the check time", async () => {
    findManyMock.mockResolvedValue([row({ status: "error", lastActionLog: "Health check at x: kong exited" })]);
    execMock.mockResolvedValue(UP);
    await runHealthCheck();
    await runHealthCheck();
    expect(statusWrites()[0]?.data).toMatchObject({ status: "running" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["inst-1"] } },
      data: { healthCheckedAt: expect.any(Date) },
    });
  });

  it("never overrides an error set by a failed job", async () => {
    findManyMock.mockResolvedValue([row({ status: "error", lastActionLog: "✗ pooler: registration failed" })]);
    execMock.mockResolvedValue(UP);
    await runHealthCheck();
    await runHealthCheck();
    expect(statusWrites()).toHaveLength(0);
  });

  it("skips a server while a job holds its lock", async () => {
    findManyMock.mockResolvedValue([row()]);
    const release = tryAcquireServerLock("srv-1", "provision")!;
    try {
      await runHealthCheck();
      await runHealthCheck();
      expect(withConnectionMock).not.toHaveBeenCalled();
      expect(updateManyMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("checks each server with one read-only docker ps", async () => {
    findManyMock.mockResolvedValue([row(), row({ id: "inst-2", composeProjectName: "sb_0b1c" })]);
    execMock.mockResolvedValue(UP);
    await runHealthCheck();
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(String(execMock.mock.calls[0]![1])).toMatch(/^docker ps -a --filter label=com\.docker\.compose\.project --format /);
  });
});
