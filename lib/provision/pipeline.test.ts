import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/crypto reads (and caches) the master key on first seal; vitest does not
// load .env, so provide one before any module touches it.
process.env.WHARF_MASTER_KEY ??= randomBytes(32).toString("base64");

const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
  sftpWrite: (...a: unknown[]) => sftpWriteMock(...a),
  withConnection: (...a: unknown[]) => withConnectionMock(...a),
}));

const instanceCreate = vi.fn();
const instanceUpdate = vi.fn();
const instanceFindUnique = vi.fn();
const instanceFindFirst = vi.fn();
const serverFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dbInstance: {
      create: (...a: unknown[]) => instanceCreate(...a),
      update: (...a: unknown[]) => instanceUpdate(...a),
      findUnique: (...a: unknown[]) => instanceFindUnique(...a),
      findFirst: (...a: unknown[]) => instanceFindFirst(...a),
    },
    server: { findUnique: (...a: unknown[]) => serverFindUnique(...a) },
  },
}));

const auditMock = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

const ensurePreparedMock = vi.fn();
vi.mock("@/lib/bootstrap/prepare", () => ({
  ensureServerPrepared: (...a: unknown[]) => ensurePreparedMock(...a),
}));

const waitForHealthyMock = vi.fn();
vi.mock("./health", () => ({
  waitForHealthy: (...a: unknown[]) => waitForHealthyMock(...a),
}));

const renderMock = vi.fn();
vi.mock("./render", () => ({
  renderInstanceCompose: (...a: unknown[]) => renderMock(...a),
}));

vi.mock("./secrets", () => ({
  generateInstanceSecrets: () =>
    Promise.resolve({
      pgPassword: "PgPass123",
      jwtSecret: "jwtsecret".padEnd(40, "x"),
      anonKey: "eyJanon",
      serviceRoleKey: "eyJservice",
    }),
}));

import { startProvision, retryProvision, stopInstance } from "./pipeline";
import { provisionJobId } from "./job-ids";
import { subscribe } from "@/lib/jobs/stream";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const BASE = { serverId: "srv-1", name: "clienta-prod", slug: "clienta", userId: "u1", userEmail: "a@b.c" };

const ROW = {
  id: "inst-1",
  name: "clienta-prod",
  slug: "clienta",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  apiSubdomain: "clienta.wharf.example.com",
  studioSubdomain: "studio-clienta.wharf.example.com",
  status: "provisioning",
  deletedAt: null,
};

function watchJob(jobId: string) {
  return new Promise<{ status: string; lines: string[] }>((resolve) => {
    const lines: string[] = [];
    setTimeout(() => {
      subscribe(
        jobId,
        (ev) => lines.push(`${ev.kind}|${ev.line}`),
        (end) => resolve({ status: end.status, lines }),
      );
    }, 0);
  });
}

/** Phase ids in the order the contract (§5) prescribes. */
const phasesFrom = (lines: string[]) =>
  lines
    .map((l) => /\|[›✓✗] ([a-z]+)/.exec(l)?.[1])
    .filter((p): p is string => Boolean(p));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSTANCE_DOMAIN = "wharf.example.com";
  serverFindUnique.mockResolvedValue({ id: "srv-1", name: "db-01", bootstrapped: true });
  instanceFindFirst.mockResolvedValue(null); // slug free
  instanceCreate.mockResolvedValue({ ...ROW });
  instanceUpdate.mockResolvedValue({ ...ROW });
  instanceFindUnique.mockResolvedValue({ ...ROW });
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  execMock.mockResolvedValue(ok());
  sftpWriteMock.mockResolvedValue(undefined);
  ensurePreparedMock.mockResolvedValue(false); // already prepared
  waitForHealthyMock.mockResolvedValue(undefined);
  renderMock.mockResolvedValue({ composeYaml: "services: {}\n", envFile: "K=V\n" });
});

describe("startProvision — validation (no row created)", () => {
  it.each([
    [{ slug: "Bad_Slug" }, /Slug must be lowercase/],
    [{ slug: "-leading" }, /Slug must be lowercase/],
    [{ name: "" }, /name is required/i],
  ])("rejects %o", async (patch, msg) => {
    const res = await startProvision({ ...BASE, ...patch });
    expect(res).toHaveProperty("invalid");
    expect((res as { invalid: string }).invalid).toMatch(msg);
    expect(instanceCreate).not.toHaveBeenCalled();
  });

  it("rejects a duplicate slug, including one held by a soft-deleted row", async () => {
    instanceFindFirst.mockResolvedValue({ id: "old", slug: "clienta" });
    const res = await startProvision(BASE);
    expect(res).toHaveProperty("invalid");
    expect(instanceCreate).not.toHaveBeenCalled();
  });

  it("rejects when INSTANCE_DOMAIN is unset", async () => {
    delete process.env.INSTANCE_DOMAIN;
    const res = await startProvision(BASE);
    expect((res as { invalid: string }).invalid).toMatch(/INSTANCE_DOMAIN/);
    expect(instanceCreate).not.toHaveBeenCalled();
  });

  it("returns the lock holder when the server is busy", async () => {
    const release = tryAcquireServerLock("srv-1", "bootstrap")!;
    const res = await startProvision(BASE);
    expect(res).toEqual({ busy: "bootstrap" });
    expect(instanceCreate).not.toHaveBeenCalled();
    release();
  });
});

describe("startProvision — happy path", () => {
  it("runs every phase in contract order and persists sealed secrets", async () => {
    const res = await startProvision(BASE);
    expect(res).toHaveProperty("instanceId");
    const { status, lines } = await watchJob(provisionJobId("inst-1"));

    expect(status).toBe("ok");
    // No `prepare` phase: the server was already prepared.
    expect(phasesFrom(lines)).toEqual([
      "validate", "validate",
      "secrets", "secrets",
      "render", "render",
      "upload", "upload",
      "start", "start",
      "health", "health",
    ]);

    // Compose + .env uploaded, .env at 0600.
    const envCall = sftpWriteMock.mock.calls.find((c) => String(c[1]).endsWith(".env"));
    expect(envCall?.[3]).toBe(0o600);
    expect(sftpWriteMock.mock.calls.some((c) => String(c[1]).endsWith("docker-compose.yml"))).toBe(true);

    // Bugfix regression: db's Postgres init-scripts and Kong's declarative
    // config MUST also be uploaded, or `db` never becomes healthy and
    // everything depending on it refuses to start.
    const uploaded = sftpWriteMock.mock.calls.map((c) => String(c[1]));
    for (const f of ["volumes/db/jwt.sql", "volumes/db/roles.sql", "volumes/api/kong.yml"]) {
      expect(uploaded.some((p) => p.endsWith(f))).toBe(true);
    }
    // .gitkeep placeholders must never go through sftpWrite (untested
    // zero-byte edge case) — the three empty dirs are created via a single
    // batched `mkdir -p` exec call instead.
    expect(uploaded.some((p) => p.endsWith(".gitkeep"))).toBe(false);
    const mkdirCall = execMock.mock.calls.find((c) => String(c[1]).startsWith("mkdir -p"));
    expect(mkdirCall).toBeTruthy();
    for (const dir of ["volumes/storage", "volumes/snippets", "volumes/functions"]) {
      expect(String(mkdirCall![1])).toContain(dir);
    }

    // Secrets sealed (Uint8Array), status running.
    const final = instanceUpdate.mock.calls
      .map((c) => c[0] as { data?: Record<string, unknown> })
      .find((c) => c.data?.status === "running");
    expect(final).toBeTruthy();
    expect(final!.data!.pgPasswordEnc).toBeInstanceOf(Uint8Array);
    expect(final!.data!.anonKeyEnc).toBeInstanceOf(Uint8Array);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "instance.provision" }),
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("emits the prepare phase only when the server needs preparing", async () => {
    ensurePreparedMock.mockResolvedValue(true);
    await startProvision(BASE);
    const { lines } = await watchJob(provisionJobId("inst-1"));
    expect(ensurePreparedMock).toHaveBeenCalled();
    expect(status2(lines)).toBe("ok");
  });
});

function status2(lines: string[]) {
  return lines.some((l) => l.startsWith("err|")) ? "error" : "ok";
}

describe("startProvision — failure handling", () => {
  it("marks the instance error and keeps the log when health checks fail", async () => {
    waitForHealthyMock.mockRejectedValue(new Error("timed out after 300s"));
    await startProvision(BASE);
    const { status, lines } = await watchJob(provisionJobId("inst-1"));

    expect(status).toBe("error");
    expect(lines.some((l) => l.includes("✗ health"))).toBe(true);

    const errUpdate = instanceUpdate.mock.calls
      .map((c) => c[0] as { data?: Record<string, unknown> })
      .find((c) => c.data?.status === "error");
    expect(errUpdate).toBeTruthy();
    // A failed run must never be recorded as running.
    expect(
      instanceUpdate.mock.calls.some(
        (c) => (c[0] as { data?: { status?: string } }).data?.status === "running",
      ),
    ).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "instance.provision.failed" }),
    );
    expect(serverLockHolder("srv-1")).toBeNull();
  });

  it("fails the job when preparation aborts (e.g. preflight port conflict)", async () => {
    ensurePreparedMock.mockRejectedValue(
      new Error("port 80 is in use — a database server must own ports 80 and 443"),
    );
    await startProvision(BASE);
    const { status, lines } = await watchJob(provisionJobId("inst-1"));
    expect(status).toBe("error");
    expect(lines.some((l) => l.includes("port 80 is in use"))).toBe(true);
    // Never reached the point of uploading anything to the server.
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });

  it("persists a log tail so a restart still shows what happened", async () => {
    waitForHealthyMock.mockRejectedValue(new Error("boom"));
    await startProvision(BASE);
    await watchJob(provisionJobId("inst-1"));
    const withTail = instanceUpdate.mock.calls
      .map((c) => c[0] as { data?: Record<string, unknown> })
      .filter((c) => typeof c.data?.lastActionLog === "string");
    expect(withTail.length).toBeGreaterThan(0);
    expect(String(withTail.at(-1)!.data!.lastActionLog)).toContain("health");
  });
});

describe("retryProvision", () => {
  it("refuses unless the instance is in error", async () => {
    instanceFindUnique.mockResolvedValue({ ...ROW, status: "running" });
    const res = await retryProvision("inst-1", { userId: "u1", userEmail: "a@b.c" });
    expect((res as { invalid: string }).invalid).toMatch(/'error'/);
  });

  it("reuses the same compose project and paths", async () => {
    instanceFindUnique.mockResolvedValue({ ...ROW, status: "error" });
    const res = await retryProvision("inst-1", { userId: "u1", userEmail: "a@b.c" });
    expect(res).toHaveProperty("jobId");
    await watchJob(provisionJobId("inst-1"));
    // Everything uploaded under the ORIGINAL project directory.
    for (const call of sftpWriteMock.mock.calls) {
      expect(String(call[1])).toContain("/opt/db-instances/sb_4f2a");
    }
    expect(instanceCreate).not.toHaveBeenCalled();
  });
});

describe("stopInstance", () => {
  it("issues compose stop and releases the lock", async () => {
    instanceFindUnique.mockResolvedValue({ ...ROW, status: "running" });
    execMock.mockImplementation((_c: unknown, cmd: string) =>
      Promise.resolve(cmd.includes("ps") ? ok("") : ok()),
    );
    await stopInstance("inst-1", { userId: "u1", userEmail: "a@b.c" });
    expect(
      execMock.mock.calls.some((c) => String(c[1]).includes("stop")),
    ).toBe(true);
    expect(serverLockHolder("srv-1")).toBeNull();
  });
});
