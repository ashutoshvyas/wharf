import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  sftpWrite: (...args: unknown[]) => sftpWriteMock(...args),
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

vi.mock("@/lib/crypto", () => ({ open: () => "decrypted" }));

const renderMock = vi.fn();
vi.mock("./render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./render")>()),
  EMAIL_TEMPLATE_FLOWS: ["invite", "recovery"],
  renderInstanceCompose: (...args: unknown[]) => renderMock(...args),
}));

import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { applyResourceLimits, sliceUnitFile } from "./resource-limits";

const CONN = { connected: true };
const SLICE = "wharf-sb_4f2a.slice";
const LIMITS = { cpuLimit: 1.5, memoryLimitMb: 2048 };
const ROW = {
  id: "inst-1",
  slug: "production",
  serverId: "srv-1",
  composeProjectName: "sb_4f2a",
  remotePath: "/opt/db-instances/sb_4f2a",
  status: "running",
  pgPasswordEnc: Buffer.from("sealed"),
  jwtSecretEnc: Buffer.from("sealed"),
  anonKeyEnc: Buffer.from("sealed"),
  serviceRoleKeyEnc: Buffer.from("sealed"),
  authSettings: null,
  emailTemplates: [{ flow: "invite", subject: "Join us", bodyHtml: "<p>hi</p>" }],
  analyticsSettings: { enabled: true },
};

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

/** Fake server: systemd/cgroup v2, with `parents` as each container's CgroupParent. */
function server(parents: { before: string[]; after?: string[] }) {
  let inspected = 0;
  execMock.mockImplementation(async (_conn: unknown, cmd: string) => {
    if (cmd.startsWith("docker info")) return ok("systemd 2\n");
    if (cmd.includes("docker inspect")) {
      inspected += 1;
      const list = inspected === 1 ? parents.before : (parents.after ?? parents.before);
      return ok(list.map((parent) => `parent=${parent}\n`).join(""));
    }
    return ok();
  });
}

const commands = () => execMock.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue({ ...ROW });
  updateMock.mockImplementation(async ({ data }: { data: object }) => ({ ...ROW, ...data }));
  withConnectionMock.mockImplementation(
    async (_serverId: string, fn: (conn: unknown) => Promise<unknown>) => fn(CONN),
  );
  sftpWriteMock.mockResolvedValue(undefined);
  renderMock.mockResolvedValue({ composeYaml: "compose", envFile: "env" });
});

describe("sliceUnitFile", () => {
  it("writes accounting plus the limits, omitting an unlimited CPU quota", () => {
    expect(sliceUnitFile("sb_4f2a", LIMITS)).toBe(
      [
        "# Managed by WHARF (lib/provision/resource-limits.ts) — do not edit.",
        "[Unit]",
        "Description=WHARF instance sb_4f2a",
        "",
        "[Slice]",
        "CPUAccounting=yes",
        "MemoryAccounting=yes",
        "CPUQuota=150%",
        "MemoryHigh=1843M",
        "MemoryMax=2048M",
        "",
      ].join("\n"),
    );
    expect(sliceUnitFile("sb_4f2a", { cpuLimit: null, memoryLimitMb: null })).not.toContain("CPUQuota");
  });
});

describe("applyResourceLimits", () => {
  it("changes an attached instance's budget live, without touching containers", async () => {
    server({ before: [SLICE, SLICE] });

    const result = await applyResourceLimits("inst-1", LIMITS);

    expect(result).toMatchObject({ ok: true, recreated: false });
    expect(sftpWriteMock).toHaveBeenCalledWith(
      CONN, `/etc/systemd/system/${SLICE}`, sliceUnitFile("sb_4f2a", LIMITS), 0o644,
    );
    expect(commands()).toContain(
      `systemctl daemon-reload && systemctl set-property --runtime ${SLICE} 'CPUQuota=150%' 'MemoryHigh=1843M' 'MemoryMax=2048M'`,
    );
    expect(commands().some((c) => c.includes("up -d"))).toBe(false);
    expect(renderMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ...LIMITS, resourceLimitsError: null, resourceLimitsAppliedAt: expect.any(Date) }),
    }));
  });

  it("recreates a pre-slice instance once, re-rendered from all of its stored settings", async () => {
    server({ before: ["", SLICE], after: [SLICE, SLICE] });

    const result = await applyResourceLimits("inst-1", LIMITS);

    expect(result).toMatchObject({ ok: true, recreated: true });
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      analyticsSettings: { enabled: true },
      emailTemplates: [
        { flow: "invite", subject: "Join us", hasBody: true },
        { flow: "recovery", subject: "", hasBody: false },
      ],
      authSettings: expect.objectContaining({ enableEmailSignup: true }),
      instanceId: "inst-1",
    }));
    const cmds = commands();
    const sliceAt = cmds.findIndex((c) => c.includes("set-property"));
    const upAt = cmds.findIndex((c) => c.includes("docker compose -p sb_4f2a up -d"));
    expect(sliceAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(sliceAt);
  });

  it("fails and records the error when recreated containers still miss the slice", async () => {
    server({ before: [""], after: [""] });

    await expect(applyResourceLimits("inst-1", LIMITS)).rejects.toThrow(/still outside/);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ resourceLimitsAppliedAt: null, resourceLimitsError: expect.stringMatching(/still outside/) }),
    }));
  });

  it("refuses a stopped pre-slice instance instead of starting or half-applying it", async () => {
    findFirstMock.mockResolvedValue({ ...ROW, status: "stopped" });
    server({ before: [""] });

    const result = await applyResourceLimits("inst-1", LIMITS);

    expect(result).toMatchObject({ invalid: expect.stringMatching(/Start it first/) });
    expect(sftpWriteMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports an unsupported cgroup setup and keeps the requested budget as not applied", async () => {
    server({ before: [SLICE] });
    execMock.mockImplementation(async (_conn: unknown, cmd: string) =>
      cmd.startsWith("docker info") ? ok("cgroupfs 1\n") : ok(`parent=${SLICE}\n`),
    );

    await expect(applyResourceLimits("inst-1", LIMITS)).rejects.toThrow(/driver=cgroupfs cgroup=v1/);
    expect(commands().some((c) => c.includes("systemctl"))).toBe(false);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ...LIMITS, resourceLimitsAppliedAt: null }),
    }));
  });

  it("returns busy while another job holds the server", async () => {
    const release = tryAcquireServerLock("srv-1", "provision");
    try {
      const result = await applyResourceLimits("inst-1", LIMITS);
      expect(result).toEqual({ busy: serverLockHolder("srv-1") });
      expect(withConnectionMock).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("refuses an instance in a transitional state", async () => {
    findFirstMock.mockResolvedValue({ ...ROW, status: "restoring" });
    expect(await applyResourceLimits("inst-1", LIMITS)).toMatchObject({ invalid: expect.stringMatching(/restoring/) });
  });
});
