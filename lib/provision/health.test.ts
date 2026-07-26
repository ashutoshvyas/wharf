/**
 * server-side health checks. The backoff sleeps are stubbed through
 * the `__testing` seam so the 300s budget is exercised in milliseconds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  sftpWrite: vi.fn(),
  withConnection: vi.fn(),
}));

import { HEALTH_TIMEOUT_MS, __testing, waitForHealthy } from "./health";

// Token handle: lib/ssh is mocked, so nothing ever dereferences this. Typed
// from the function under test to avoid importing ssh2 into a test file.
const CONN = { conn: true } as unknown as Parameters<typeof waitForHealthy>[0];
const PROJECT = "sb_1a2b";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const slept: number[] = [];

function collector() {
  const lines: string[] = [];
  const emit = (kind: string, line: string) => {
    lines.push(`${kind}|${line}`);
  };
  return { lines, emit: emit as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  slept.length = 0;
  __testing.sleep = (ms: number) => {
    slept.push(ms);
    return Promise.resolve();
  };
});

describe("waitForHealthy", () => {
  it("probes postgres then kong INSIDE the server and returns on first success", async () => {
    execMock.mockResolvedValue(ok("accepting connections"));
    const { lines, emit } = collector();

    await waitForHealthy(CONN, PROJECT, emit);

    const cmds = execMock.mock.calls.map((c) => String(c[1]));
    expect(cmds[0]).toBe(`docker compose -p ${PROJECT} exec -T db pg_isready -U postgres`);
    expect(cmds[1]).toBe(`docker compose -p ${PROJECT} exec -T kong kong health`);
    // no hostname / DNS / TLS anywhere in the probes
    expect(cmds.every((c) => !c.includes("http"))).toBe(true);
    expect(lines).toEqual(["info|attempt 1: postgres accepting connections, kong healthy"]);
    expect(slept).toEqual([]);
  });

  it("backs off 5s → 10s → 15s and emits one info line per attempt", async () => {
    let attempts = 0;
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_isready")) {
        attempts += 1;
        return Promise.resolve(attempts >= 4 ? ok("accepting connections") : fail("no response"));
      }
      return Promise.resolve(ok());
    });
    const { lines, emit } = collector();

    await waitForHealthy(CONN, PROJECT, emit);

    expect(slept).toEqual([5_000, 10_000, 15_000]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("attempt 1: postgres not ready");
    expect(lines[3]).toContain("attempt 4: postgres accepting connections, kong healthy");
  });

  it("keeps repeating 15s once the schedule is exhausted", async () => {
    let attempts = 0;
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_isready")) {
        attempts += 1;
        return Promise.resolve(attempts >= 6 ? ok() : fail());
      }
      return Promise.resolve(ok());
    });
    const { emit } = collector();
    await waitForHealthy(CONN, PROJECT, emit);
    expect(slept).toEqual([5_000, 10_000, 15_000, 15_000, 15_000]);
  });

  it("treats a healthy postgres with an unhealthy kong as not ready", async () => {
    let kongAttempts = 0;
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("kong health")) {
        kongAttempts += 1;
        return Promise.resolve(kongAttempts >= 2 ? ok("Kong is healthy at /usr/local/kong") : fail("not running"));
      }
      return Promise.resolve(ok("accepting connections"));
    });
    const { lines, emit } = collector();
    await waitForHealthy(CONN, PROJECT, emit);
    expect(lines[0]).toContain("postgres ok, kong not ready");
    expect(slept).toEqual([5_000]);
  });

  it("gives up inside the 300s cap, dumps container logs, then throws", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("logs --tail")) {
        return Promise.resolve(ok("db-1  | FATAL: could not map anonymous memory"));
      }
      return Promise.resolve(fail("container is not running"));
    });
    const { lines, emit } = collector();

    await expect(waitForHealthy(CONN, PROJECT, emit)).rejects.toThrow(
      /timed out after 300s — unhealthy: db, kong/,
    );

    const total = slept.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(HEALTH_TIMEOUT_MS);
    expect(total + 15_000).toBeGreaterThanOrEqual(HEALTH_TIMEOUT_MS);

    const logCmds = execMock.mock.calls
      .map((c) => String(c[1]))
      .filter((c) => c.includes("logs --tail"));
    expect(logCmds).toContain(`docker compose -p ${PROJECT} logs --tail 20 db`);
    expect(logCmds).toContain(`docker compose -p ${PROJECT} logs --tail 20 kong`);
    expect(lines.some((l) => l.includes("last 20 log lines of db"))).toBe(true);
    expect(lines.some((l) => l.includes("could not map anonymous memory"))).toBe(true);
    // log dump lines are plain detail, never phase markers
    expect(lines.every((l) => l.startsWith("info|"))).toBe(true);
  });

  it("survives an SSH-level probe failure and reports it as unhealthy", async () => {
    let attempts = 0;
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("pg_isready")) {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("Command timed out after 20000ms"));
        return Promise.resolve(ok());
      }
      return Promise.resolve(ok());
    });
    const { lines, emit } = collector();
    await waitForHealthy(CONN, PROJECT, emit);
    expect(lines[0]).toContain("Command timed out after 20000ms");
  });
});
