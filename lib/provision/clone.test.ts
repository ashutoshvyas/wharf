import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  exec: vi.fn(),
  withConnection: vi.fn(),
  sftpCopyFile: vi.fn(),
  sftpWrite: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { dbInstance: {
  findFirst: mocks.findFirst,
  update: mocks.update,
} } }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/ssh", () => ({
  exec: mocks.exec,
  withConnection: mocks.withConnection,
  sftpCopyFile: mocks.sftpCopyFile,
  sftpWrite: mocks.sftpWrite,
}));

import { subscribe } from "@/lib/jobs/stream";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { acquireCloneLocks, CLONE_RUNTIME_SCHEMAS, startClone } from "./clone";

const source = {
  id: "source-id",
  name: "Production",
  serverId: "server-a",
  remotePath: "/opt/db-instances/sb_source",
  composeProjectName: "sb_source",
  status: "running",
  pgPasswordEnc: Buffer.from("source-password"),
  deletedAt: null,
};
const target = {
  id: "target-id",
  name: "Staging",
  serverId: "server-b",
  remotePath: "/opt/db-instances/sb_target",
  composeProjectName: "sb_target",
  status: "running",
  pgPasswordEnc: Buffer.from("target-password"),
  deletedAt: null,
};
const actor = { userId: "admin-id", userEmail: "admin@example.test" };

function rows(...values: Array<typeof source | typeof target>) {
  const byId = new Map(values.map((row) => [row.id, row]));
  mocks.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null);
}

function successfulRemote() {
  mocks.withConnection.mockImplementation(async (serverId: string, fn: (conn: { serverId: string }) => Promise<unknown>) => fn({ serverId }));
  mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
    if (command.includes(" config --images")) return { code: 0, stdout: "image-db:17\nimage-auth:1\nimage-storage:1\nimage-realtime:2\n", stderr: "" };
    if (command.includes("SHOW server_version_num")) return { code: 0, stdout: "170006\n", stderr: "" };
    if (command.includes("ps --status running --services")) return { code: 0, stdout: "db\nauth\nstorage\nrealtime\nrest\nkong\n", stderr: "" };
    if (command.includes("SELECT nspname FROM pg_namespace")) return { code: 0, stdout: "_realtime\n_supavisor\n", stderr: "" };
    if (command.includes("SELECT count(*) FROM pg_class")) return { code: 0, stdout: "12\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
}

function waitForEnd(jobId: string): Promise<{ status: "ok" | "error"; lines: string[] }> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    subscribe(jobId, (event) => lines.push(event.line), (end) => resolve({ status: end.status, lines }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows(source, target);
  successfulRemote();
  mocks.update.mockResolvedValue({});
  mocks.audit.mockResolvedValue(undefined);
  mocks.sftpCopyFile.mockResolvedValue(undefined);
  mocks.sftpWrite.mockResolvedValue(undefined);
});

describe("startClone validation and locks", () => {
  it("refuses the same database without taking a lock", async () => {
    expect(await startClone(source.id, source.id, actor, source.name)).toEqual({ invalid: "Choose a different destination database." });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(serverLockHolder(source.serverId)).toBeNull();
  });

  it("requires two existing running databases and the exact destination name", async () => {
    rows(source);
    await expect(startClone(source.id, target.id, actor, target.name)).resolves.toHaveProperty("invalid");
    rows(source, { ...target, status: "stopped" });
    await expect(startClone(source.id, target.id, actor, target.name)).resolves.toEqual({ invalid: "Both source and destination databases must be running." });
    rows(source, target);
    await expect(startClone(source.id, target.id, actor, "staging")).resolves.toHaveProperty("invalid");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("acquires unique server locks in order and releases earlier locks on contention", () => {
    const occupied = tryAcquireServerLock("server-b", "provision");
    expect(occupied).not.toBeNull();
    const result = acquireCloneLocks(["server-b", "server-a", "server-a"]);
    expect(result).toEqual({ busy: "provision" });
    expect(serverLockHolder("server-a")).toBeNull();
    occupied!();
  });
});

describe("managed clone pipeline", () => {
  it("stages a strict full restore, atomically activates it, and retains a destination snapshot", async () => {
    const accepted = await startClone(source.id, target.id, actor, target.name);
    expect(accepted).toEqual({ jobId: `clone:${target.id}` });
    const result = await waitForEnd(`clone:${target.id}`);
    expect(result.status).toBe("ok");
    expect(result.lines.filter((line) => line.startsWith("✓ "))).toEqual([
      "✓ preflight", "✓ dump", "✓ transfer", "✓ snapshot", "✓ restore", "✓ verify", "✓ cleanup",
    ]);

    const commands = mocks.exec.mock.calls.map((call) => String(call[1]));
    const sourceDump = commands.find((command) => command.includes(" pg_dump ") && command.includes("source.dump"));
    expect(sourceDump).toContain("-Fc");
    for (const schema of CLONE_RUNTIME_SCHEMAS) expect(sourceDump).toContain(`--exclude-schema='${schema}'`);
    expect(commands.some((command) => command.includes("pg_restore") && command.includes("--exit-on-error --single-transaction"))).toBe(true);
    expect(mocks.sftpWrite.mock.calls.some((call) => String(call[2]).includes("ALTER DATABASE postgres RENAME TO"))).toBe(true);
    expect(commands.some((command) => command.includes("pre-clone-") && command.includes("chmod 600"))).toBe(true);
    expect(mocks.sftpCopyFile).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: target.id }, data: { status: "restoring" } });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: target.id }, data: expect.objectContaining({ status: "running" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "instance.clone", targetId: target.id,
      metadata: expect.objectContaining({ sourceInstanceId: source.id, activated: true, recovered: true }),
    }));
    expect(serverLockHolder(source.serverId)).toBeNull();
    expect(serverLockHolder(target.serverId)).toBeNull();
  });

  it("fails before cutover when a strict staging restore fails and leaves the live destination running", async () => {
    mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
      if (command.includes(" config --images")) return { code: 0, stdout: "db:17\nauth:1\nstorage:1\nrealtime:2\n", stderr: "" };
      if (command.includes("SHOW server_version_num")) return { code: 0, stdout: "170006\n", stderr: "" };
      if (command.includes("ps --status running --services")) return { code: 0, stdout: "db\nauth\nstorage\nrealtime\nkong\n", stderr: "" };
      if (command.includes("SELECT nspname FROM pg_namespace")) return { code: 0, stdout: "_realtime\n", stderr: "" };
      if (command.includes("pg_restore") && command.includes("source.dump") && !command.includes("--list")) return { code: 1, stdout: "", stderr: "private row value must not be logged" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const accepted = await startClone(source.id, target.id, actor, target.name);
    const result = await waitForEnd((accepted as { jobId: string }).jobId);
    expect(result.status).toBe("error");
    expect(result.lines.join("\n")).toContain("No partial restore is accepted");
    expect(result.lines.join("\n")).not.toContain("private row value");
    const commands = mocks.exec.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("ALTER DATABASE postgres RENAME TO"))).toBe(false);
    expect(commands.some((command) => command.includes("DROP DATABASE IF EXISTS") && command.includes("wharf_clone_"))).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "running" }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.clone.failed" }));
  });

  it("uses a server-local file copy when both instances share a server", async () => {
    rows(source, { ...target, serverId: source.serverId });
    const accepted = await startClone(source.id, target.id, actor, target.name);
    expect((await waitForEnd((accepted as { jobId: string }).jobId)).status).toBe("ok");
    expect(mocks.sftpCopyFile).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some((call) => String(call[1]).includes("install -m 600") && String(call[1]).includes("source.dump"))).toBe(true);
  });

  it("automatically swaps the original database back when post-cutover service health fails", async () => {
    let activationRestart = true;
    mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
      if (command.includes(" config --images")) return { code: 0, stdout: "db:17\nauth:1\nstorage:1\nrealtime:2\n", stderr: "" };
      if (command.includes("SHOW server_version_num")) return { code: 0, stdout: "170006\n", stderr: "" };
      if (command.includes("ps --status running --services")) return { code: 0, stdout: "db\nauth\nstorage\nrealtime\nkong\n", stderr: "" };
      if (command.includes("SELECT nspname FROM pg_namespace")) return { code: 0, stdout: "_realtime\n", stderr: "" };
      if (command.includes(" up -d --no-deps --wait") && activationRestart) {
        activationRestart = false;
        return { code: 1, stdout: "", stderr: "service secret must stay hidden" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const accepted = await startClone(source.id, target.id, actor, target.name);
    const result = await waitForEnd((accepted as { jobId: string }).jobId);
    expect(result.status).toBe("error");
    expect(result.lines.join("\n")).toContain("Destination service health checks failed");
    expect(result.lines.join("\n")).not.toContain("service secret");
    expect(mocks.sftpWrite.mock.calls.some((call) =>
      String(call[2]).includes("ALTER DATABASE") &&
      String(call[2]).includes("wharf_previous_") &&
      String(call[2]).includes("RENAME TO postgres"),
    )).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: target.id }, data: expect.objectContaining({ status: "running" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "instance.clone.failed",
      metadata: expect.objectContaining({ activated: false, recovered: true }),
    }));
  });

  it("rejects unsafe source identity state before creating an archive", async () => {
    mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
      if (command.includes(" config --images")) return { code: 0, stdout: "db:17\nauth:1\nstorage:1\nrealtime:2\n", stderr: "" };
      if (command.includes("SHOW server_version_num")) return { code: 0, stdout: "170006\n", stderr: "" };
      if (command.includes("SELECT nspname FROM pg_namespace")) return { code: 0, stdout: "_realtime\n", stderr: "" };
      if (command.includes("DO $$")) return { code: 1, stdout: "", stderr: "vault secret" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const accepted = await startClone(source.id, target.id, actor, target.name);
    const result = await waitForEnd((accepted as { jobId: string }).jobId);
    expect(result.status).toBe("error");
    expect(result.lines.join("\n")).toContain("Vault secrets");
    expect(mocks.exec.mock.calls.some((call) => String(call[1]).includes(" pg_dump "))).toBe(false);
  });
});
