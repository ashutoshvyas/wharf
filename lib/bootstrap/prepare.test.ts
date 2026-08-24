/**
 * lazy server preparation + preflight.
 * Mirrors lib/bootstrap/bootstrap.test.ts's style: the whole SSH surface is
 * faked, so these assert command sequencing and emitted lines, never a host.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.WHARF_MASTER_KEY ??= randomBytes(32).toString("base64");

const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();

vi.mock("@/lib/ssh", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  sftpWrite: (...args: unknown[]) => sftpWriteMock(...args),
  withConnection: (...args: unknown[]) => withConnectionMock(...args),
}));

const serverFindUnique = vi.fn();
const serverUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    server: {
      findUnique: (...a: unknown[]) => serverFindUnique(...a),
      update: (...a: unknown[]) => serverUpdate(...a),
    },
  },
}));

const auditMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

import {
  ensureServerPrepared,
  findListener,
  MIN_FREE_KB,
  parseDfAvailableKb,
  preflightServer,
  runBootstrapSteps,
} from "./prepare";
import { BOOTSTRAP_STEPS } from "./steps";

// Token handle: lib/ssh is mocked, so nothing ever dereferences this. Typed
// from the function under test to avoid importing ssh2 into a test file.
const CONN = { conn: true } as unknown as Parameters<typeof preflightServer>[0];
const CTX = { userId: "u1", userEmail: "admin@wharf.example.com" };
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const CLEAN_SS = [
  "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
  "LISTEN 0      128    0.0.0.0:22          0.0.0.0:*      users:((\"sshd\",pid=700,fd=3))",
  // An unrelated port, present to prove findListener doesn't false-positive
  // on ports outside REQUIRED_PORTS.
  "LISTEN 0      128    127.0.0.1:5433      0.0.0.0:*",
].join("\n");

const ROOMY_DF = "/dev/sda1 51475068 8000000 40000000 17% /";

/** Collect emitted lines as `kind|line`. */
function collector() {
  const lines: string[] = [];
  const emit = (kind: string, line: string) => {
    lines.push(`${kind}|${line}`);
  };
  return { lines, emit: emit as never };
}

/** Default healthy host: ports free, root, plenty of disk, everything done. */
function healthyHost(overrides: Record<string, unknown> = {}) {
  execMock.mockImplementation((_c: unknown, cmd: string) => {
    for (const [needle, value] of Object.entries(overrides)) {
      if (cmd.includes(needle)) return Promise.resolve(value);
    }
    if (cmd.startsWith("ss -ltn")) return Promise.resolve(ok(CLEAN_SS));
    if (cmd === "id -u") return Promise.resolve(ok("0\n"));
    if (cmd.includes("df -P /opt")) return Promise.resolve(ok(ROOMY_DF));
    if (cmd.includes("ps --format json")) return Promise.resolve(ok('[{"State":"running"}]'));
    if (cmd === "ufw status") {
      return Promise.resolve(ok("80/tcp ALLOW\n443/tcp ALLOW\n5432/tcp ALLOW\n6543/tcp ALLOW"));
    }
    return Promise.resolve(ok());
  });
}

/** Commands that mutate the host — none of these may run before preflight passes. */
function mutatingCommands(): string[] {
  return execMock.mock.calls
    .map((c) => String(c[1]))
    .filter(
      (cmd) =>
        cmd.includes("get.docker.com") ||
        cmd.includes("docker network create") ||
        cmd.includes("up -d") ||
        cmd.includes("ufw allow") ||
        cmd.includes("acme.json"),
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PANEL_URL = "https://panel.wharf.example.com";
  process.env.LETSENCRYPT_EMAIL = "ops@wharf.example.com";
  serverUpdate.mockResolvedValue({});
  serverFindUnique.mockResolvedValue({ id: "srv-1", bootstrapped: false });
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn(CONN),
  );
  healthyHost();
});

describe("preflight parsers", () => {
  it("findListener matches the exact port and names the process from ss -ltnp", () => {
    const busy = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))';
    expect(findListener(busy, 80)).toEqual({ found: true, process: "nginx" });
    expect(findListener(busy, 443)).toEqual({ found: false });
  });

  it("findListener does not confuse :8080 with :80", () => {
    expect(findListener("LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*", 80)).toEqual({ found: false });
  });

  it("findListener reads netstat's pid/name column", () => {
    const line = "tcp 0 0 :::443 :::* LISTEN 900/apache2";
    expect(findListener(line, 443)).toEqual({ found: true, process: "apache2" });
  });

  it("parseDfAvailableKb picks the Available column", () => {
    expect(parseDfAvailableKb(ROOMY_DF)).toBe(40000000);
    expect(parseDfAvailableKb("")).toBeNull();
  });
});

describe("preflightServer (/ contract §6)", () => {
  it("passes on a clean host and touches nothing", async () => {
    const { lines, emit } = collector();
    await expect(preflightServer(CONN, emit)).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("ports 80, 443, 5432 and 6543 are free"))).toBe(true);
    expect(lines.some((l) => l.includes("running as root"))).toBe(true);
    expect(mutatingCommands()).toEqual([]);
  });

  it("aborts when port 80 is bound, naming the offending process", async () => {
    healthyHost({
      "ss -ltn": ok(`${CLEAN_SS}\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))`),
    });
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).rejects.toThrow(
      /port 80 is in use by nginx — a database server must own ports 80, 443, 5432 and 6543/,
    );
    await expect(preflightServer(CONN, emit)).rejects.toThrow(
      /Use a dedicated server for databases/,
    );
    expect(mutatingCommands()).toEqual([]);
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });

  it("aborts when port 443 is bound", async () => {
    healthyHost({ "ss -ltn": ok(`${CLEAN_SS}\nLISTEN 0 511 [::]:443 [::]:*`) });
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).rejects.toThrow(/port 443 is in use —/);
    expect(mutatingCommands()).toEqual([]);
  });

  it("aborts when the user is neither root nor passwordless-sudo capable", async () => {
    healthyHost({ "id -u": ok("1000"), "sudo -n true": fail("a password is required") });
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).rejects.toThrow(
      /not root and passwordless sudo is unavailable/,
    );
    expect(mutatingCommands()).toEqual([]);
  });

  it("accepts a non-root user with passwordless sudo", async () => {
    healthyHost({ "id -u": ok("1000"), "sudo -n true": ok() });
    const { lines, emit } = collector();
    await expect(preflightServer(CONN, emit)).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("passwordless sudo works"))).toBe(true);
  });

  it("aborts on low disk, quoting the actual figure", async () => {
    healthyHost({ "df -P /opt": ok("/dev/sda1 51475068 48000000 3145728 94% /") });
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).rejects.toThrow(
      /only 3\.0 GB free on \/opt — a Supabase instance needs at least 10\.0 GB/,
    );
    expect(mutatingCommands()).toEqual([]);
  });

  it("accepts exactly the 10 GB threshold", async () => {
    healthyHost({ "df -P /opt": ok(`/dev/sda1 51475068 100 ${MIN_FREE_KB} 80% /`) });
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).resolves.toBeUndefined();
  });

  it("falls back to netstat when ss is missing", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.startsWith("ss -ltn")) return Promise.reject(new Error("ss: not found"));
      if (cmd.startsWith("netstat -ltnp")) return Promise.resolve(fail("netstat: -p denied"));
      if (cmd.startsWith("netstat -ltn")) {
        return Promise.resolve(ok("tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN"));
      }
      if (cmd === "id -u") return Promise.resolve(ok("0"));
      if (cmd.includes("df -P /opt")) return Promise.resolve(ok(ROOMY_DF));
      return Promise.resolve(ok());
    });
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).resolves.toBeUndefined();
  });

  it("aborts when no socket tool is available at all", async () => {
    execMock.mockImplementation(() => Promise.resolve(fail("command not found")));
    const { emit } = collector();
    await expect(preflightServer(CONN, emit)).rejects.toThrow(
      /could not list listening sockets/,
    );
  });
});

describe("ensureServerPrepared", () => {
  it("is a silent no-op when the server is already bootstrapped", async () => {
    serverFindUnique.mockResolvedValue({ id: "srv-1", bootstrapped: true });
    const { lines, emit } = collector();

    await expect(ensureServerPrepared("srv-1", CONN, emit, CTX)).resolves.toBe(false);

    expect(lines).toEqual([]); // NO `prepare` phase — contract §5
    expect(execMock).not.toHaveBeenCalled();
    expect(serverUpdate).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("prepares, flips bootstrapped and audits {via:'provision'}", async () => {
    const { lines, emit } = collector();

    await expect(ensureServerPrepared("srv-1", CONN, emit, CTX)).resolves.toBe(true);

    expect(lines[0]).toBe("step|› prepare");
    expect(lines.at(-1)).toBe("ok|✓ prepare");
    // Everything between is nested DETAIL, never a top-level phase marker.
    const inner = lines.slice(1, -1);
    expect(inner.every((l) => l.startsWith("info|"))).toBe(true);
    for (const step of BOOTSTRAP_STEPS) {
      expect(inner.some((l) => l.includes(`› ${step.name}`))).toBe(true);
    }
    expect(serverUpdate).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: { bootstrapped: true },
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "server.bootstrap",
        targetId: "srv-1",
        metadata: expect.objectContaining({ via: "provision" }),
      }),
    );
  });

  it("runs preflight BEFORE the bootstrap steps and leaves the row untouched on failure", async () => {
    healthyHost({
      "ss -ltn": ok(`${CLEAN_SS}\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812))`),
    });
    const { lines, emit } = collector();

    await expect(ensureServerPrepared("srv-1", CONN, emit, CTX)).rejects.toThrow(
      /port 80 is in use by nginx/,
    );

    expect(lines[0]).toBe("step|› prepare");
    expect(lines.at(-1)).toMatch(/^err\|✗ prepare: port 80 is in use by nginx/);
    expect(mutatingCommands()).toEqual([]);
    expect(sftpWriteMock).not.toHaveBeenCalled();
    expect(serverUpdate).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("emits ✗ prepare and rethrows when a bootstrap step fails", async () => {
    healthyHost({ "docker compose version": fail(), "get.docker.com": fail("no network") });
    const { lines, emit } = collector();

    await expect(ensureServerPrepared("srv-1", CONN, emit, CTX)).rejects.toThrow();
    expect(lines.at(-1)).toMatch(/^err\|✗ prepare: /);
    expect(serverUpdate).not.toHaveBeenCalled();
  });

  it("throws when the server row is gone", async () => {
    serverFindUnique.mockResolvedValue(null);
    const { emit } = collector();
    await expect(ensureServerPrepared("srv-gone", CONN, emit, CTX)).rejects.toThrow(
      /Server srv-gone not found/,
    );
  });
});

describe("runBootstrapSteps (shared with the standalone route)", () => {
  it("emits the same markers the standalone bootstrap job relies on", async () => {
    const { lines, emit } = collector();
    await runBootstrapSteps(CONN, emit, "srv-1");
    expect(lines).toContain("step|› installDocker");
    expect(lines).toContain("ok|✓ installDocker: already done — skipped");
    // uploadTraefikConfig always applies → plain ✓ marker
    expect(lines).toContain("ok|✓ uploadTraefikConfig");
  });
});
